/**
 * Play bank — deposit USDC once, stake many times without wallet popups.
 *
 * Durable storage: Cloudflare KV (BANK_KV) with Cache API as L1 mirror.
 * Cache-only was causing "debited but balance 0" across edge isolates.
 *
 * POST /api/bank
 *   { action: 'deposit', player, txHash, amount? }
 *   { action: 'stake', player, entryId, stake }
 *   { action: 'credit', player, entryId, stake, reason }
 *   { action: 'withdraw', player, amount }
 *   { action: 'balance', player }
 * GET  /api/bank?player=0x…
 */

import {
  createPublicClient,
  http,
  fallback,
  parseAbi,
  formatUnits,
  parseUnits,
  decodeEventLog,
} from 'viem';
import { baseSepolia } from 'viem/chains';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
/** Always-accepted house treasury (frontend HOUSE_TREASURY). */
const DEFAULT_HOUSE = '0x804BEb025844c189b72C8D810a1A7776043677FF';
const transferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

function envGet(env, ...keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function isAddr(a) {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bankCacheKey(player) {
  return new Request('https://megapush.bank.internal/v2/' + String(player).toLowerCase());
}

function bankKvKey(player) {
  return 'bank:v2:' + String(player).toLowerCase();
}

const FREE_DAILY_MS = 24 * 60 * 60 * 1000;

function emptyBank() {
  return {
    /** Withdrawable: deposits never staked (or stake returned before tickets). */
    deposited: 0,
    /** Legacy alias of deposited for older clients */
    balance: 0,
    /**
     * Free/bonus stake credit (e.g. free daily). Spendable on stakes only —
     * never withdrawable as USDC.
     */
    bonusUsdc: 0,
    /** Fractional ticket dollars; never withdrawable as USDC */
    progressUsdc: 0,
    /** Last free daily claim (ms) */
    lastFreeAt: null,
    usedTx: [],
    entries: {},
    history: [],
  };
}

function money2(n) {
  return Math.max(0, Math.round((Number(n) || 0) * 100) / 100);
}

function normalizeHistory(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((h) => h && typeof h === 'object')
    .map((h) => ({
      type: String(h.type || 'tx'),
      amount: money2(h.amount),
      txHash: h.txHash ? String(h.txHash).toLowerCase() : null,
      entryId: h.entryId != null ? String(h.entryId) : null,
      at: Number(h.at) || Date.now(),
      balance: h.balance != null ? money2(h.balance) : null,
      deposited: h.deposited != null ? money2(h.deposited) : null,
      progressUsdc: h.progressUsdc != null ? money2(h.progressUsdc) : null,
    }))
    .slice(0, 100);
}

function normalizeBank(j) {
  if (!j || typeof j !== 'object') return emptyBank();
  // Migrate legacy single balance → deposited (withdrawable)
  const legacy = Number(j.balance) || 0;
  const deposited = j.deposited != null ? Number(j.deposited) : legacy;
  const d = money2(deposited);
  const lastFreeAt = j.lastFreeAt != null ? Number(j.lastFreeAt) : null;
  const bonus = money2(j.bonusUsdc);
  const spendable = money2(d + bonus);
  // Progress is only the fractional bar toward the next free ticket ∈ [0, 1).
  // Strip corrupt whole dollars (e.g. $7 progress from a past bug) without minting.
  let progressUsdc = money2(j.progressUsdc);
  if (progressUsdc >= 1) {
    progressUsdc = money2(progressUsdc % 1);
  }
  return {
    deposited: d,
    bonusUsdc: bonus,
    /** Spendable for stakes = deposited + bonus (not all withdrawable) */
    balance: spendable,
    progressUsdc,
    lastFreeAt: Number.isFinite(lastFreeAt) && lastFreeAt > 0 ? lastFreeAt : null,
    freeDailyMigrated: !!j.freeDailyMigrated,
    usedTx: Array.isArray(j.usedTx) ? j.usedTx.map((t) => String(t).toLowerCase()) : [],
    entries: j.entries && typeof j.entries === 'object' ? j.entries : {},
    history: normalizeHistory(j.history),
  };
}

function syncDeposited(bank) {
  bank.deposited = money2(bank.deposited);
  bank.bonusUsdc = money2(bank.bonusUsdc);
  bank.progressUsdc = money2(bank.progressUsdc);
  // Client "balance" = what they can stake
  bank.balance = money2(bank.deposited + bank.bonusUsdc);
  return bank;
}

/** Spend stake from bonus first, then deposited. Returns false if insufficient. */
function spendForStake(bank, stake) {
  const need = Math.floor(Number(stake) || 0);
  if (!(need > 0)) return false;
  const bonus = money2(bank.bonusUsdc);
  const dep = money2(bank.deposited);
  if (bonus + dep + 1e-9 < need) return false;
  let left = need;
  if (bonus > 0) {
    const fromBonus = Math.min(bonus, left);
    bank.bonusUsdc = money2(bonus - fromBonus);
    left -= fromBonus;
  }
  if (left > 0) {
    bank.deposited = money2(dep - left);
  }
  syncDeposited(bank);
  return true;
}

function pushHistory(bank, entry) {
  if (!bank.history) bank.history = [];
  const row = {
    type: String(entry.type || 'tx'),
    amount: money2(entry.amount),
    txHash: entry.txHash ? String(entry.txHash).toLowerCase() : null,
    entryId: entry.entryId != null ? String(entry.entryId) : null,
    at: Number(entry.at) || Date.now(),
    balance: money2(bank.deposited),
    deposited: money2(bank.deposited),
    progressUsdc: money2(bank.progressUsdc),
  };
  // Dedupe same on-chain tx of same type
  if (row.txHash) {
    bank.history = bank.history.filter(
      (h) => !(h.txHash === row.txHash && h.type === row.type),
    );
  }
  bank.history.unshift(row);
  bank.history = bank.history.slice(0, 100);
  return row;
}

/** Durable read: KV first, then Cache API. */
async function loadBank(player, env) {
  const p = String(player).toLowerCase();

  // 1) KV (durable across all edges)
  try {
    const kv = env?.BANK_KV;
    if (kv && typeof kv.get === 'function') {
      const raw = await kv.get(bankKvKey(p), { type: 'json' });
      if (raw && typeof raw === 'object') return normalizeBank(raw);
    }
  } catch (e) {
    console.warn('bank kv get', e);
  }

  // 2) Cache fallback (legacy / L1)
  try {
    const hit = await caches.default.match(bankCacheKey(p));
    if (hit) {
      const j = await hit.json();
      if (j && typeof j === 'object') {
        const bank = normalizeBank(j);
        // Migrate cache → KV when possible
        try {
          const kv = env?.BANK_KV;
          if (kv && typeof kv.put === 'function') {
            await kv.put(bankKvKey(p), JSON.stringify({ ...bank, updatedAt: Date.now() }));
          }
        } catch (_) {}
        return bank;
      }
    }
  } catch (_) {}

  return emptyBank();
}

/** Durable write: KV + Cache. */
async function saveBank(player, data, env) {
  const p = String(player).toLowerCase();
  const deposited = money2(
    data.deposited != null
      ? data.deposited
      : Math.max(0, (Number(data.balance) || 0) - (Number(data.bonusUsdc) || 0)),
  );
  const bonusUsdc = money2(data.bonusUsdc);
  const lastFreeAt =
    data.lastFreeAt != null && Number(data.lastFreeAt) > 0 ? Number(data.lastFreeAt) : null;
  const body = {
    deposited,
    bonusUsdc,
    balance: money2(deposited + bonusUsdc),
    progressUsdc: money2(data.progressUsdc),
    lastFreeAt,
    freeDailyMigrated: !!data.freeDailyMigrated,
    usedTx: (data.usedTx || []).map((t) => String(t).toLowerCase()).slice(-500),
    entries: data.entries || {},
    history: normalizeHistory(data.history),
    updatedAt: Date.now(),
  };

  let kvOk = false;
  try {
    const kv = env?.BANK_KV;
    if (kv && typeof kv.put === 'function') {
      await kv.put(bankKvKey(p), JSON.stringify(body));
      kvOk = true;
    }
  } catch (e) {
    console.warn('bank kv put', e);
  }

  try {
    await caches.default.put(
      bankCacheKey(p),
      new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=2592000',
        },
      }),
    );
  } catch (e) {
    console.warn('bank cache put', e);
  }

  if (!kvOk && !env?.BANK_KV) {
    console.warn('BANK_KV not bound — balance may not persist across edges');
  }

  return body;
}

function makePublic(env) {
  const urls = [
    envGet(env, 'RPC_URL'),
    'https://sepolia.base.org',
    'https://base-sepolia-rpc.publicnode.com',
    'https://base-sepolia.gateway.tenderly.co',
  ].filter(Boolean);
  return createPublicClient({
    chain: baseSepolia,
    transport: fallback(
      urls.map((u) => http(u, { timeout: 20_000, retryCount: 2, retryDelay: 250 })),
      { rank: false },
    ),
  });
}

async function resolveHouseSet(env) {
  const set = new Set([DEFAULT_HOUSE.toLowerCase()]);
  const fromEnv = envGet(env, 'HOUSE_TREASURY', 'HOUSE_ADDRESS');
  if (isAddr(fromEnv)) set.add(fromEnv.toLowerCase());
  try {
    const { resolveHousePrivateKey } = await import('./house-tx.js');
    const key = await resolveHousePrivateKey(env);
    if (key) {
      const { privateKeyToAccount } = await import('viem/accounts');
      const pk = key.startsWith('0x') ? key : `0x${key}`;
      set.add(privateKeyToAccount(/** @type {`0x${string}`} */ (pk)).address.toLowerCase());
    }
  } catch (_) {}
  return set;
}

async function houseAddress(env) {
  const fromEnv = envGet(env, 'HOUSE_TREASURY', 'HOUSE_ADDRESS');
  if (isAddr(fromEnv)) return fromEnv;
  try {
    const { resolveHousePrivateKey } = await import('./house-tx.js');
    const key = await resolveHousePrivateKey(env);
    if (!key) return DEFAULT_HOUSE;
    const { privateKeyToAccount } = await import('viem/accounts');
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    return privateKeyToAccount(/** @type {`0x${string}`} */ (pk)).address;
  } catch {
    return DEFAULT_HOUSE;
  }
}

/**
 * Wait for receipt across RPCs — deposits must not race confirmation.
 */
async function waitForDepositReceipt(publicClient, txHash, { attempts = 24, delayMs = 500 } = {}) {
  const hash = /** @type {`0x${string}`} */ (txHash);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash });
      if (receipt) return receipt;
    } catch (e) {
      lastErr = e;
    }
    // Prefer waitForTransactionReceipt once, then poll
    if (i === 0) {
      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
          timeout: 45_000,
          pollingInterval: 400,
        });
        if (receipt) return receipt;
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(delayMs + Math.min(i * 100, 800));
  }
  const err = new Error(
    lastErr?.shortMessage || lastErr?.message || 'Deposit tx not found yet — wait for confirmation',
  );
  err.statusCode = 400;
  throw err;
}

function sumUsdcTransfersToHouse(logs, player, houseSet) {
  let credited = 0;
  const playerLc = player.toLowerCase();
  for (const log of logs || []) {
    if (String(log.address).toLowerCase() !== USDC.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({
        abi: transferAbi,
        data: log.data,
        topics: log.topics,
      });
      if (ev.eventName !== 'Transfer') continue;
      const from = String(ev.args.from).toLowerCase();
      const to = String(ev.args.to).toLowerCase();
      if (from !== playerLc) continue;
      if (!houseSet.has(to)) continue;
      credited += Number(formatUnits(ev.args.value, 6));
    } catch (_) {}
  }
  return Math.round(credited * 100) / 100;
}

async function creditFromDepositTx(env, player, txHash, expectedAmount) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, error: 'Invalid tx hash', status: 400 };
  }
  const txLc = txHash.toLowerCase();
  const bank = await loadBank(player, env);
  if (bank.usedTx.includes(txLc)) {
    // Backfill history if older deposits were credited before history existed
    const hasHist = (bank.history || []).some((h) => h.txHash === txLc && h.type === 'deposit');
    if (!hasHist) {
      let amt = Number(expectedAmount) > 0 ? Number(expectedAmount) : 0;
      if (!(amt > 0)) {
        try {
          const publicClient = makePublic(env);
          const receipt = await publicClient.getTransactionReceipt({
            hash: /** @type {`0x${string}`} */ (txHash),
          });
          if (receipt?.status === 'success') {
            const houseSet = await resolveHouseSet(env);
            amt = sumUsdcTransfersToHouse(receipt.logs, player, houseSet);
          }
        } catch (_) {}
      }
      if (amt > 0) {
        pushHistory(bank, {
          type: 'deposit',
          amount: amt,
          txHash: txLc,
          at: Date.now(),
        });
        const saved = await saveBank(player, bank, env);
        return {
          ok: true,
          balance: saved.balance,
          already: true,
          credited: 0,
          history: saved.history,
          durable: !!(env?.BANK_KV),
          historyBackfill: true,
        };
      }
    }
    return {
      ok: true,
      balance: bank.balance,
      already: true,
      credited: 0,
      history: bank.history || [],
      durable: !!(env?.BANK_KV),
    };
  }

  const publicClient = makePublic(env);
  let receipt;
  try {
    receipt = await waitForDepositReceipt(publicClient, txHash);
  } catch (e) {
    return {
      ok: false,
      error: e?.message || 'Deposit tx not found yet — wait for confirmation',
      status: e?.statusCode || 400,
      pending: true,
    };
  }
  if (!receipt || receipt.status !== 'success') {
    return { ok: false, error: 'Deposit tx failed or pending', status: 400, pending: true };
  }

  // Re-check after wait (another request may have credited)
  const bank2 = await loadBank(player, env);
  if (bank2.usedTx.includes(txLc)) {
    const hasHist = (bank2.history || []).some((h) => h.txHash === txLc && h.type === 'deposit');
    if (!hasHist) {
      const houseSet = await resolveHouseSet(env);
      const creditedAmt = sumUsdcTransfersToHouse(receipt.logs, player, houseSet);
      if (creditedAmt > 0) {
        pushHistory(bank2, {
          type: 'deposit',
          amount: creditedAmt,
          txHash: txLc,
          at: Date.now(),
        });
        const saved = await saveBank(player, bank2, env);
        return {
          ok: true,
          balance: saved.balance,
          already: true,
          credited: 0,
          history: saved.history,
          durable: !!(env?.BANK_KV),
        };
      }
    }
    return {
      ok: true,
      balance: bank2.balance,
      already: true,
      credited: 0,
      history: bank2.history || [],
      durable: !!(env?.BANK_KV),
    };
  }

  const houseSet = await resolveHouseSet(env);
  let credited = sumUsdcTransfersToHouse(receipt.logs, player, houseSet);

  // Fallback: if logs missing Transfer (rare), use expected amount when tx succeeded
  // Only when client sent expectedAmount and receipt is success + from player
  if (!(credited > 0) && Number(expectedAmount) > 0) {
    try {
      const tx = await publicClient.getTransaction({ hash: /** @type {`0x${string}`} */ (txHash) });
      if (tx && String(tx.from).toLowerCase() === player.toLowerCase()) {
        // ERC-20 transfer to USDC contract — amount still must match Transfer; skip silent credit
      }
    } catch (_) {}
  }

  if (!(credited > 0)) {
    return {
      ok: false,
      error: 'No USDC transfer to house found in that tx',
      status: 400,
      houseAccepted: Array.from(houseSet),
    };
  }

  bank2.deposited = money2(bank2.deposited + credited);
  syncDeposited(bank2);
  bank2.usedTx.push(txLc);
  const hist = pushHistory(bank2, {
    type: 'deposit',
    amount: credited,
    txHash: txLc,
    at: Date.now(),
  });
  const saved = await saveBank(player, bank2, env);
  return {
    ok: true,
    ...bankPublicView(saved),
    credited,
    already: false,
    durable: !!(env?.BANK_KV),
    historyItem: hist,
    history: saved.history,
  };
}

/**
 * Scan recent on-chain USDC transfers player → house and credit any missing deposits.
 * Idempotent: already-credited txs (usedTx) are skipped — never re-pays stakes.
 */
async function reconcileDepositsFromChain(env, player, { lookbackBlocks = 4000 } = {}) {
  const publicClient = makePublic(env);
  const houseSet = await resolveHouseSet(env);
  const houses = Array.from(houseSet);
  let head;
  try {
    head = await publicClient.getBlockNumber();
  } catch (e) {
    return { ok: false, error: e?.message || 'RPC failed', status: 502 };
  }

  const lookback = Math.min(8000, Math.max(500, Number(lookbackBlocks) || 4000));
  const chunk = 1800n;
  const start = head > BigInt(lookback) ? head - BigInt(lookback) : 0n;
  const found = [];

  const { parseAbiItem } = await import('viem');
  const event = parseAbiItem(
    'event Transfer(address indexed from, address indexed to, uint256 value)',
  );

  for (const house of houses) {
    let from = start;
    while (from <= head) {
      let to = from + chunk - 1n;
      if (to > head) to = head;
      try {
        const logs = await publicClient.getLogs({
          address: USDC,
          event,
          args: {
            from: /** @type {`0x${string}`} */ (player),
            to: /** @type {`0x${string}`} */ (house),
          },
          fromBlock: from,
          toBlock: to,
        });
        for (const log of logs || []) found.push(log);
      } catch (e) {
        console.warn('reconcile getLogs', e?.message || e);
      }
      from = to + 1n;
    }
  }

  // Dedupe by tx hash (one credit per deposit tx)
  const byTx = new Map();
  for (const log of found) {
    const tx = String(log.transactionHash || '').toLowerCase();
    if (!tx || !tx.startsWith('0x')) continue;
    if (!byTx.has(tx)) byTx.set(tx, log);
  }

  const results = [];
  let totalNew = 0;
  for (const [txHash, log] of byTx) {
    let amountHint;
    try {
      if (log.args?.value != null) amountHint = Number(formatUnits(log.args.value, 6));
    } catch (_) {}
    const r = await creditFromDepositTx(env, player, txHash, amountHint);
    results.push({
      txHash,
      amount: amountHint,
      ok: !!r.ok,
      already: !!r.already,
      credited: r.credited || 0,
      error: r.ok ? undefined : r.error,
    });
    if (r.ok && r.credited > 0) totalNew += r.credited;
  }

  const bank = await loadBank(player, env);
  return {
    ok: true,
    player: player.toLowerCase(),
    scanned: byTx.size,
    lookbackBlocks: lookback,
    totalNew: Math.round(totalNew * 100) / 100,
    ...bankPublicView(bank),
    history: bank.history || [],
    results,
    durable: !!(env?.BANK_KV),
  };
}

/**
 * Normalize entry ids so retries (…-r1, …:r2) share one refund bucket.
 * Prevents double-credit when cashout buy retries used different entryId suffixes.
 */
export function baseEntryId(entryId) {
  let e = entryId != null ? String(entryId) : '';
  if (!e) return '';
  // strip :rN / -rN retry suffixes (possibly repeated)
  e = e.replace(/(:r\d+|-\s*r\d+)$/i, '');
  e = e.replace(/(:r\d+|-r\d+)$/i, '');
  return e;
}

/**
 * Return stake to deposited (withdrawable) — cancel / failed ticket buy only.
 * Never use for cashout "winnings" (those are tickets + progress only).
 * Idempotent per base entryId — never refund the same stake twice.
 */
export async function creditPlayBank(player, stakeUsd, entryId, env) {
  if (!isAddr(player)) return { ok: false, error: 'bad player' };
  let stake = Math.floor(Number(stakeUsd) || 0);
  if (!(stake > 0)) return { ok: false, error: 'bad stake' };
  const bank = await loadBank(player, env);
  const baseId = baseEntryId(entryId);

  // Already refunded / settled / lost under base or any retry variant → no-op
  if (baseId) {
    const statuses = new Set();
    let originalStake = null;
    for (const [id, row] of Object.entries(bank.entries || {})) {
      if (!row) continue;
      if (id === baseId || baseEntryId(id) === baseId) {
        statuses.add(String(row.status || ''));
        if (row.stake != null && Number(row.stake) > 0) {
          originalStake = Math.floor(Number(row.stake));
        }
      }
    }
    // History check: any prior refund for this base entry
    const alreadyRefundedHist = (bank.history || []).some((h) => {
      if (!h || h.type !== 'refund') return false;
      const hid = baseEntryId(h.entryId);
      return hid && hid === baseId;
    });
    if (
      statuses.has('refunded') ||
      statuses.has('settled') ||
      statuses.has('lost') ||
      alreadyRefundedHist
    ) {
      return {
        ok: true,
        already: true,
        balance: bank.deposited,
        deposited: bank.deposited,
        progressUsdc: bank.progressUsdc,
        toBank: true,
      };
    }
    // Cap credit to original stake (never invent a larger refund)
    if (originalStake != null && originalStake > 0) {
      stake = Math.min(stake, originalStake);
    }
  }

  bank.deposited = money2(bank.deposited + stake);
  syncDeposited(bank);
  if (baseId) {
    bank.entries[baseId] = {
      ...(bank.entries[baseId] || {}),
      stake: bank.entries[baseId]?.stake ?? stake,
      status: 'refunded',
      at: Date.now(),
    };
    // Mark retry variants too so later -r1 paths no-op
    for (const id of Object.keys(bank.entries || {})) {
      if (id !== baseId && baseEntryId(id) === baseId) {
        bank.entries[id] = {
          ...bank.entries[id],
          status: 'refunded',
          at: Date.now(),
        };
      }
    }
    try {
      const { roundDoReleaseStake } = await import('./dos/client.js');
      await roundDoReleaseStake(env, { entryId: baseId, reason: 'cashout_refund' });
    } catch (_) {}
  }
  pushHistory(bank, {
    type: 'refund',
    amount: stake,
    entryId: baseId || entryId || null,
    at: Date.now(),
  });
  const saved = await saveBank(player, bank, env);
  return {
    ok: true,
    balance: saved.deposited,
    deposited: saved.deposited,
    progressUsdc: saved.progressUsdc,
    credited: stake,
    toBank: true,
    history: saved.history,
  };
}

/**
 * Clamp remainder to [0, 1). A single cashout can never add a whole dollar of progress
 * (whole dollars are always whole tickets from stake×mult).
 */
function clampProgressRemainder(remainderUsdc) {
  let r = money2(remainderUsdc);
  if (!(r > 0)) return 0;
  if (r >= 1) r = money2(r % 1);
  return r;
}

/**
 * Add cashout remainder to ticket progress (never withdrawable USDC).
 *
 * Correct maths:
 *   remainder = (stake × mult) − floor(stake × mult)   ∈ [0, 1)
 *   progress  += remainder
 *   freeTickets THIS call = 0 or 1 when the bar fills past $1
 *
 * Free tickets are reserved immediately (progress debited) so a later cashout
 * cannot re-mint the same whole dollars (the "$2 stake → $7 progress free" bug).
 *
 * Corrupt pre-existing whole-dollar progress (e.g. 7.00) is sanitized to the
 * fractional part only — those whole dollars are NOT minted as free tickets.
 */
export async function applyTicketProgress(player, remainderUsdc, env) {
  if (!isAddr(player)) return { ok: false, progressUsdc: 0, freeTickets: 0, remainderAdded: 0 };
  const bank = await loadBank(player, env);

  let before = money2(bank.progressUsdc);
  // Sanitize corrupt whole-dollar backlog (never mint free for it)
  const wholeBefore = Math.floor(before + 1e-9);
  if (wholeBefore > 0) {
    console.warn('progress sanitize whole dollars stripped (no free mint)', {
      player: String(player).toLowerCase(),
      before,
      stripped: wholeBefore,
    });
    before = money2(before - wholeBefore);
    bank.progressUsdc = before;
  }

  const add = clampProgressRemainder(remainderUsdc);
  bank.progressUsdc = money2(before + add);

  // At most 1 free ticket per cashout (remainder < 1 ⇒ floor can rise by at most 1)
  let freeTickets = Math.max(0, Math.floor(bank.progressUsdc + 1e-9) - Math.floor(before + 1e-9));
  if (freeTickets > 1) freeTickets = 1;

  // Reserve free tickets immediately — debit progress so they cannot re-mint
  if (freeTickets > 0) {
    bank.progressUsdc = money2(bank.progressUsdc - freeTickets);
  }

  // Final clamp: progress toward next ticket is always [0, 1)
  if (bank.progressUsdc >= 1) {
    bank.progressUsdc = money2(bank.progressUsdc % 1);
  }

  syncDeposited(bank);
  if (add > 0) {
    pushHistory(bank, {
      type: 'progress',
      amount: add,
      at: Date.now(),
    });
  }
  if (freeTickets > 0) {
    pushHistory(bank, {
      type: 'progress_ticket',
      amount: freeTickets,
      at: Date.now(),
    });
  }
  const saved = await saveBank(player, bank, env);
  return {
    ok: true,
    progressUsdc: saved.progressUsdc,
    freeTickets,
    remainderAdded: add,
    deposited: saved.deposited,
    balance: saved.deposited,
  };
}

/**
 * Re-credit reserved free-ticket dollars if on-chain mint permanently fails.
 * Only used for free progress tickets — never for stake refunds.
 */
export async function returnProgressReservation(player, freeTickets, env) {
  const n = Math.floor(Number(freeTickets) || 0);
  if (!isAddr(player) || n <= 0) return { ok: true, progressUsdc: 0 };
  const bank = await loadBank(player, env);
  // Only return fractional progress capacity — free ticket = $1 reserved
  // Putting $1 back means progress may go ≥ 1; next cashout will re-reserve (max 1).
  bank.progressUsdc = money2(bank.progressUsdc + n);
  // Keep display sensible: leave whole dollars for next free reserve
  syncDeposited(bank);
  const saved = await saveBank(player, bank, env);
  return { ok: true, progressUsdc: saved.progressUsdc, returned: n };
}

/**
 * @deprecated Free tickets are reserved in applyTicketProgress.
 * Kept for older callers — no-ops if progress already debited (floor < n).
 */
export async function consumeProgressTickets(player, freeTickets, env) {
  const n = Math.floor(Number(freeTickets) || 0);
  if (!isAddr(player) || n <= 0) {
    const bank = isAddr(player) ? await loadBank(player, env) : null;
    return { ok: true, progressUsdc: bank ? bank.progressUsdc : 0, consumed: 0 };
  }
  const bank = await loadBank(player, env);
  const available = Math.floor(bank.progressUsdc + 1e-9);
  // If already reserved (progress < 1), nothing left to consume
  if (available <= 0) {
    return { ok: true, progressUsdc: bank.progressUsdc, consumed: 0, alreadyReserved: true };
  }
  const take = Math.min(n, available);
  bank.progressUsdc = money2(bank.progressUsdc - take);
  syncDeposited(bank);
  if (take > 0) {
    pushHistory(bank, { type: 'progress_ticket', amount: take, at: Date.now() });
  }
  const saved = await saveBank(player, bank, env);
  return { ok: true, progressUsdc: saved.progressUsdc, consumed: take };
}

function freeDailyInfo(bank, nowMs = Date.now()) {
  const last = bank.lastFreeAt != null ? Number(bank.lastFreeAt) : 0;
  if (!(last > 0)) {
    return { freeDailyEligible: true, freeDailyNextAt: null, freeDailyMsLeft: 0 };
  }
  const nextAt = last + FREE_DAILY_MS;
  const msLeft = Math.max(0, nextAt - nowMs);
  return {
    freeDailyEligible: msLeft <= 0,
    freeDailyNextAt: msLeft > 0 ? nextAt : null,
    freeDailyMsLeft: msLeft,
  };
}

/** Public bank snapshot for API responses */
export function bankPublicView(bank) {
  const deposited = money2(bank.deposited);
  const bonusUsdc = money2(bank.bonusUsdc);
  const spendable = money2(deposited + bonusUsdc);
  // Progress bar is always fractional [0, 1) toward the next free ticket
  let progressUsdc = money2(bank.progressUsdc);
  if (progressUsdc >= 1) progressUsdc = money2(progressUsdc % 1);
  return {
    balance: spendable,
    deposited,
    bonusUsdc,
    withdrawable: deposited,
    progressUsdc,
    progressTowardTicket: progressUsdc,
    progressPct: Math.min(100, Math.round(progressUsdc * 100)),
    lastFreeAt: bank.lastFreeAt || null,
    ...freeDailyInfo(bank),
  };
}

/** Rate-limit free-daily attempts (bruteforce / spam). Uses BANK_KV when bound. */
async function freeDailyRateLimit(env, player, ip) {
  const kv = env?.BANK_KV;
  if (!kv || typeof kv.get !== 'function') return { ok: true };
  const p = String(player).toLowerCase();
  const now = Date.now();
  const WINDOW_MS = 60 * 60 * 1000; // 1 hour
  const MAX_PLAYER = 8; // attempts / hour / wallet
  const MAX_IP = 30; // attempts / hour / IP

  const bump = async (key, max) => {
    let row = null;
    try {
      row = await kv.get(key, { type: 'json' });
    } catch (_) {}
    if (!row || !row.start || now - Number(row.start) > WINDOW_MS) {
      row = { start: now, n: 0 };
    }
    row.n = (Number(row.n) || 0) + 1;
    try {
      await kv.put(key, JSON.stringify(row), { expirationTtl: 3600 });
    } catch (_) {}
    if (row.n > max) {
      return {
        ok: false,
        error: 'Too many free daily attempts — try again later',
        status: 429,
        retryAfterMs: WINDOW_MS - (now - Number(row.start)),
      };
    }
    return { ok: true };
  };

  const pLim = await bump(`rl:fd:p:${p}`, MAX_PLAYER);
  if (!pLim.ok) return pLim;
  if (ip && String(ip).length > 3) {
    const iLim = await bump(`rl:fd:ip:${String(ip).slice(0, 64)}`, MAX_IP);
    if (!iLim.ok) return iLim;
  }
  return { ok: true };
}

/** Short exclusive lock so concurrent claims can't double-credit. */
async function freeDailyAcquireLock(env, player) {
  const kv = env?.BANK_KV;
  if (!kv || typeof kv.put !== 'function') return { ok: true, release: async () => {} };
  const key = `lock:fd:${String(player).toLowerCase()}`;
  try {
    const existing = await kv.get(key);
    if (existing) {
      return { ok: false, error: 'Claim already in progress', status: 429 };
    }
    await kv.put(key, String(Date.now()), { expirationTtl: 20 });
  } catch (_) {
    return { ok: true, release: async () => {} };
  }
  return {
    ok: true,
    release: async () => {
      try {
        await kv.delete(key);
      } catch (_) {}
    },
  };
}

/**
 * Free daily: +$1 to play balance for staking only (once per 24h).
 * Goes to bonusUsdc — counted in play balance, never withdrawable as USDC.
 * Does NOT mint a free Megapot ticket.
 * Hard-capped: 1 success / 24h / wallet + attempt rate limits + lock.
 */
export async function claimFreeDailyTicket(player, env, opts = {}) {
  if (!isAddr(player)) return { ok: false, error: 'Valid player required', status: 400 };
  const now = Date.now();
  const ip = opts.ip ? String(opts.ip) : '';

  const rl = await freeDailyRateLimit(env, player, ip);
  if (!rl.ok) {
    return { ...rl, ...bankPublicView(await loadBank(player, env)) };
  }

  const lock = await freeDailyAcquireLock(env, player);
  if (!lock.ok) {
    return { ...lock, ...bankPublicView(await loadBank(player, env)) };
  }

  try {
    // Re-load under lock
    const bank = await loadBank(player, env);
    const info = freeDailyInfo(bank, now);

    // Any successful free_daily entry in the last 24h blocks another credit
    const recentCredit = Object.values(bank.entries || {}).some((e) => {
      if (!e || e.status !== 'free_daily') return false;
      if (!(Number(e.bonusUsdc) > 0) && e.bonusUsdc !== 1) return false;
      const at = Number(e.at) || 0;
      return at > 0 && now - at < FREE_DAILY_MS;
    });
    if (recentCredit || !info.freeDailyEligible) {
      // One-time restore for old ticket-path claimers (no bonus ever granted)
      if (
        money2(bank.bonusUsdc) === 0 &&
        !bank.freeDailyMigrated &&
        bank.lastFreeAt &&
        Object.values(bank.entries || {}).some(
          (e) => e && (e.status === 'free_daily' || e.status === 'free_daily_pending') && e.bonusUsdc == null,
        )
      ) {
        bank.bonusUsdc = 1;
        bank.freeDailyMigrated = true;
        syncDeposited(bank);
        pushHistory(bank, {
          type: 'free_daily',
          amount: 1,
          entryId: 'free-daily-migrate',
          at: now,
        });
        const saved = await saveBank(player, bank, env);
        return {
          ok: true,
          playCreditUsdc: 1,
          migrated: true,
          entryId: 'free-daily-migrate',
          ...bankPublicView(saved),
          freeDailyEligible: false,
          freeDailyNextAt: info.freeDailyNextAt || now + FREE_DAILY_MS,
          freeDailyMsLeft: info.freeDailyMsLeft || FREE_DAILY_MS,
          history: saved.history,
          note: '+$1 play balance for staking (not withdrawable)',
        };
      }
      return {
        ok: false,
        error: 'Free daily already claimed — come back in 24 hours',
        status: 429,
        ...bankPublicView(bank),
        freeDailyNextAt: info.freeDailyNextAt,
        freeDailyMsLeft: info.freeDailyMsLeft,
      };
    }

    // Stable id per wallet per 24h window (rolling epoch)
    const entryId = `free-daily:${player.toLowerCase()}:${Math.floor(now / FREE_DAILY_MS)}`;
    if (bank.entries[entryId]?.status === 'free_daily') {
      return {
        ok: false,
        error: 'Free daily already claimed — come back in 24 hours',
        status: 429,
        already: true,
        ...bankPublicView(bank),
      };
    }

    // Exactly +$1 once — never stack multiple free dailies
    bank.lastFreeAt = now;
    bank.bonusUsdc = money2(bank.bonusUsdc + 1);
    bank.freeDailyMigrated = true;
    bank.entries[entryId] = { status: 'free_daily', at: now, bonusUsdc: 1 };
    syncDeposited(bank);
    pushHistory(bank, {
      type: 'free_daily',
      amount: 1,
      entryId,
      at: now,
    });
    const saved = await saveBank(player, bank, env);
    return {
      ok: true,
      playCreditUsdc: 1,
      entryId,
      ...bankPublicView(saved),
      freeDailyEligible: false,
      freeDailyNextAt: now + FREE_DAILY_MS,
      freeDailyMsLeft: FREE_DAILY_MS,
      history: saved.history,
      note: '+$1 play balance for staking (not withdrawable). Cash out for tickets.',
    };
  } finally {
    if (lock.release) await lock.release();
  }
}

/** Mark entry status after settle/lost (stake not returned to deposited). */
export async function markEntryStatus(player, entryId, status, env) {
  if (!isAddr(player) || !entryId) return { ok: false };
  const bank = await loadBank(player, env);
  if (!bank.entries[entryId]) {
    bank.entries[entryId] = { status, at: Date.now() };
  } else {
    bank.entries[entryId] = {
      ...bank.entries[entryId],
      status: String(status || 'settled'),
      at: Date.now(),
    };
  }
  await saveBank(player, bank, env);
  return { ok: true };
}

export async function handleBank(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const player = url.searchParams.get('player') || '';
    if (!isAddr(player)) return json({ ok: false, error: 'player required' }, 400);
    const bank = await loadBank(player, env);
    const includeHistory =
      url.searchParams.get('history') === '1' ||
      url.searchParams.get('history') === 'true';
    return json({
      ok: true,
      player: player.toLowerCase(),
      ...bankPublicView(bank),
      durable: !!(env?.BANK_KV),
      history: includeHistory ? bank.history : undefined,
    });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'Use GET or POST' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const action = String(body.action || '').toLowerCase();
  const player = body.player;
  if (!isAddr(player)) return json({ ok: false, error: 'Valid player required' }, 400);

  if (action === 'balance' || action === 'history') {
    const bank = await loadBank(player, env);
    return json({
      ok: true,
      player: player.toLowerCase(),
      ...bankPublicView(bank),
      durable: !!(env?.BANK_KV),
      history: bank.history || [],
    });
  }

  if (action === 'free_daily' || action === 'daily_free' || action === 'claim_free') {
    // Optional confirm flag from UI card — still enforced server-side either way
    const ip =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      '';
    const result = await claimFreeDailyTicket(player, env, { ip });
    if (!result.ok) {
      return json(
        {
          ok: false,
          error: result.error,
          player: player.toLowerCase(),
          freeDailyEligible: result.freeDailyEligible,
          freeDailyNextAt: result.freeDailyNextAt,
          freeDailyMsLeft: result.freeDailyMsLeft,
          deposited: result.deposited,
          progressUsdc: result.progressUsdc,
          balance: result.balance,
          bonusUsdc: result.bonusUsdc,
        },
        result.status || 400,
      );
    }
    return json({
      ok: true,
      player: player.toLowerCase(),
      playCreditUsdc: result.playCreditUsdc ?? 1,
      entryId: result.entryId,
      freeDailyEligible: false,
      freeDailyNextAt: result.freeDailyNextAt,
      freeDailyMsLeft: result.freeDailyMsLeft,
      balance: result.balance,
      deposited: result.deposited,
      bonusUsdc: result.bonusUsdc,
      withdrawable: result.withdrawable,
      note: result.note,
      history: result.history,
    });
  }

  // Auto-recover missing deposits from chain (idempotent; never re-credits usedTx / stakes)
  if (action === 'reconcile') {
    const lookbackBlocks = body.lookbackBlocks != null ? Number(body.lookbackBlocks) : 4000;
    const result = await reconcileDepositsFromChain(env, player, { lookbackBlocks });
    if (!result.ok) return json(result, result.status || 500);
    return json(result);
  }

  if (action === 'deposit') {
    const txHash = body.txHash || body.tx || body.hash;
    const expectedAmount = body.amount != null ? Number(body.amount) : undefined;
    const result = await creditFromDepositTx(env, player, String(txHash || ''), expectedAmount);
    if (!result.ok) return json(result, result.status || 400);
    // already credited earlier: still return history
    if (result.already) {
      return json({
        ok: true,
        player: player.toLowerCase(),
        balance: result.balance,
        credited: result.credited,
        already: true,
        durable: result.durable ?? !!(env?.BANK_KV),
        history: result.history || [],
      });
    }
    return json({
      ok: true,
      player: player.toLowerCase(),
      balance: result.balance,
      credited: result.credited,
      already: !!result.already,
      durable: result.durable,
      history: result.history || [],
      historyItem: result.historyItem,
    });
  }

  if (action === 'stake') {
    const stake = Math.floor(Number(body.stake) || 0);
    const entryId = body.entryId != null ? String(body.entryId) : '';
    const autoMult =
      body.autoMult != null && Number(body.autoMult) > 1 ? Number(body.autoMult) : null;
    if (!(stake > 0)) return json({ ok: false, error: 'Invalid stake' }, 400);
    if (!entryId || !entryId.toLowerCase().startsWith(player.toLowerCase())) {
      return json({ ok: false, error: 'entryId must start with player address' }, 403);
    }
    const bank = await loadBank(player, env);
    if (bank.entries[entryId]) {
      return json({
        ok: true,
        already: true,
        entryId,
        stake,
        ...bankPublicView(bank),
        fromBank: true,
        history: bank.history || [],
      });
    }
    // Spendable = bonus (free daily) + deposited. Never allow stake on empty wallet.
    const spendable = money2(bank.deposited + bank.bonusUsdc);
    if (spendable + 1e-9 < stake) {
      return json(
        {
          ok: false,
          error: 'Insufficient play balance',
          ...bankPublicView(bank),
          need: stake,
        },
        400,
      );
    }

    const { roundDoRegisterStake, roundDoReleaseStake } = await import('./dos/client.js');
    const roundReg = await roundDoRegisterStake(env, {
      stake,
      entryId,
      player: player.toLowerCase(),
      autoMult,
    });
    if (roundReg && roundReg.ok === false && !roundReg.skipped) {
      return json(
        {
          ok: false,
          error: roundReg.error || 'Round rejected stake',
          phase: roundReg.phase,
          windowClosed: roundReg.windowClosed,
          exposureUsdc: roundReg.exposureUsdc,
          maxRoundExposureUsdc: roundReg.maxRoundExposureUsdc,
          remainingUsdc: roundReg.remainingUsdc,
          roundId: roundReg.roundId,
        },
        roundReg.kill ? 503 : 409,
      );
    }

    if (!spendForStake(bank, stake)) {
      // Race: re-check after RoundDO accepted
      try {
        await roundDoReleaseStake(env, { entryId, reason: 'insufficient_after_register' });
      } catch (_) {}
      return json(
        {
          ok: false,
          error: 'Insufficient play balance',
          ...bankPublicView(bank),
          need: stake,
        },
        400,
      );
    }
    bank.entries[entryId] = {
      stake,
      at: Date.now(),
      status: 'open',
      roundId: roundReg?.roundId ?? null,
      exposureAdd: roundReg?.exposureAdd ?? null,
      autoMult,
    };
    pushHistory(bank, {
      type: 'stake',
      amount: stake,
      entryId,
      at: Date.now(),
    });
    try {
      const saved = await saveBank(player, bank, env);
      return json({
        ok: true,
        entryId,
        stake,
        autoMult,
        ...bankPublicView(saved),
        fromBank: true,
        history: saved.history,
        roundId: roundReg?.roundId,
        exposureUsdc: roundReg?.exposureUsdc,
        remainingExposureUsdc: roundReg?.remainingUsdc,
      });
    } catch (e) {
      await roundDoReleaseStake(env, { entryId, reason: 'bank_save_failed' });
      throw e;
    }
  }

  if (action === 'credit') {
    // Refund stake back into play balance (cancel / failed cashout).
    // NEVER use this to "recover" deposits — that double-pays stakes already spent.
    // Deposit recovery MUST use action:deposit + on-chain txHash (idempotent via usedTx).
    const stake = Math.floor(Number(body.stake) || 0);
    const entryId = body.entryId != null ? String(body.entryId) : '';
    if (String(entryId).startsWith('recover-') || String(entryId).startsWith('admin-fund')) {
      return json({
        ok: false,
        error: 'Blind credits disabled. Re-credit deposits with action:deposit and the USDC tx hash only.',
      }, 400);
    }
    if (!(stake > 0)) return json({ ok: false, error: 'Invalid stake' }, 400);
    // Shared idempotent path (strips -r1 / :rN retry suffixes)
    const result = await creditPlayBank(player, stake, entryId, env);
    if (!result.ok) return json(result, 400);
    const bank = await loadBank(player, env);
    return json({
      ok: true,
      already: !!result.already,
      ...bankPublicView(bank),
      credited: result.already ? 0 : result.credited,
      toBank: true,
      history: bank.history || [],
    });
  }

  if (action === 'withdraw') {
    // Only deposited-unstaked USDC may leave. Progress / staked value cannot.
    let amount = Number(body.amount != null ? body.amount : body.stake);
    if (body.amount === 'max' || body.max === true) amount = Infinity;
    amount = Math.floor(Number(amount) || 0);

    const bank = await loadBank(player, env);
    if (!(bank.deposited > 0)) {
      return json({
        ok: false,
        error: 'Nothing withdrawable (only deposited funds can leave)',
        ...bankPublicView(bank),
      }, 400);
    }
    if (!(amount > 0) || amount === Infinity) {
      amount = Math.floor(bank.deposited);
    }
    if (amount > bank.deposited + 1e-9) {
      return json({
        ok: false,
        error: 'Amount exceeds withdrawable deposited balance',
        ...bankPublicView(bank),
        need: amount,
      }, 400);
    }

    {
      const { resolveHousePrivateKey } = await import('./house-tx.js');
      const key = await resolveHousePrivateKey(env);
      if (!key && !env?.TX_SEQUENCER_DO) {
        return json({
          ok: false,
          error: 'Withdraw unavailable',
        }, 503);
      }
    }

    try {
      bank.deposited = money2(bank.deposited - amount);
      syncDeposited(bank);
      await saveBank(player, bank, env);

      try {
        let hash;
        // Prefer sequencer for nonce safety; on busy/rate-limit fall through to direct
        // house transfer so withdraw never hard-fails with "House sequencer busy".
        let usedDirect = false;
        if (env?.TX_SEQUENCER_DO) {
          try {
            const { executeHouseJob } = await import('./dos/client.js');
            const out = await executeHouseJob(env, {
              type: 'usdc_transfer',
              id: `withdraw:${player.toLowerCase()}:${amount}:${Date.now()}`,
              payload: { to: player, amountUsdc: amount },
            });
            if (out?.ok && out?.result?.ok && out.result.txHash) {
              hash = out.result.txHash;
            } else {
              const errMsg = String(out?.error || out?.result?.error || '');
              if (/busy|retry|rate|503|429/i.test(errMsg) || out?.retry || out?.missingBinding) {
                usedDirect = true;
              } else {
                throw new Error(errMsg || 'Sequencer withdraw failed');
              }
            }
          } catch (seqErr) {
            const msg = String(seqErr?.message || seqErr || '');
            if (/busy|retry|rate|503|429|sequencer/i.test(msg)) usedDirect = true;
            else throw seqErr;
          }
        } else {
          usedDirect = true;
        }
        if (usedDirect || !hash) {
          const { transferUsdcFromHouse, withHouseLock } = await import('./house-tx.js');
          const tx = await withHouseLock(() =>
            transferUsdcFromHouse(env, { to: player, amountUsdc: amount }),
          );
          hash = tx.txHash;
        }
        pushHistory(bank, {
          type: 'withdraw',
          amount,
          txHash: hash,
          at: Date.now(),
        });
        const saved = await saveBank(player, bank, env);
        return json({
          ok: true,
          player: player.toLowerCase(),
          withdrawn: amount,
          ...bankPublicView(saved),
          txHash: hash,
          toWallet: true,
          history: saved.history,
        });
      } catch (txErr) {
        bank.deposited = money2(bank.deposited + amount);
        syncDeposited(bank);
        await saveBank(player, bank, env);
        return json({
          ok: false,
          error: txErr?.shortMessage || txErr?.message || String(txErr),
          ...bankPublicView(bank),
        }, 500);
      }
    } catch (e) {
      return json({
        ok: false,
        error: e?.shortMessage || e?.message || String(e),
        ...bankPublicView(bank),
      }, 500);
    }
  }

  return json(
    {
      ok: false,
      error: 'Unknown action (deposit|stake|credit|withdraw|balance|history|reconcile|free_daily)',
    },
    400,
  );
}
