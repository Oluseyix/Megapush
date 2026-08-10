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
  return {
    deposited: d,
    bonusUsdc: bonus,
    /** Spendable for stakes = deposited + bonus (not all withdrawable) */
    balance: spendable,
    progressUsdc: money2(j.progressUsdc),
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
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (key) {
    try {
      const { privateKeyToAccount } = await import('viem/accounts');
      const pk = key.startsWith('0x') ? key : `0x${key}`;
      set.add(privateKeyToAccount(/** @type {`0x${string}`} */ (pk)).address.toLowerCase());
    } catch (_) {}
  }
  return set;
}

async function houseAddress(env) {
  const fromEnv = envGet(env, 'HOUSE_TREASURY', 'HOUSE_ADDRESS');
  if (isAddr(fromEnv)) return fromEnv;
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (!key) return DEFAULT_HOUSE;
  try {
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
 * Return stake to deposited (withdrawable) — cancel / failed ticket buy only.
 * Never use for cashout "winnings" (those are tickets + progress only).
 */
export async function creditPlayBank(player, stakeUsd, entryId, env) {
  if (!isAddr(player)) return { ok: false, error: 'bad player' };
  const stake = Math.floor(Number(stakeUsd) || 0);
  if (!(stake > 0)) return { ok: false, error: 'bad stake' };
  const bank = await loadBank(player, env);
  if (entryId && bank.entries[entryId]?.status === 'refunded') {
    return {
      ok: true,
      already: true,
      balance: bank.deposited,
      deposited: bank.deposited,
      progressUsdc: bank.progressUsdc,
      toBank: true,
    };
  }
  bank.deposited = money2(bank.deposited + stake);
  syncDeposited(bank);
  if (entryId) {
    bank.entries[entryId] = {
      ...(bank.entries[entryId] || {}),
      stake,
      status: 'refunded',
      at: Date.now(),
    };
    try {
      const { roundDoReleaseStake } = await import('./dos/client.js');
      await roundDoReleaseStake(env, { entryId: String(entryId), reason: 'cashout_refund' });
    } catch (_) {}
  }
  pushHistory(bank, {
    type: 'refund',
    amount: stake,
    entryId: entryId || null,
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
 * Add cashout remainder to ticket progress (never withdrawable USDC).
 * Does not mint tickets — use consumeProgressTickets after a successful buy.
 */
export async function applyTicketProgress(player, remainderUsdc, env) {
  if (!isAddr(player)) return { ok: false, progressUsdc: 0, freeTickets: 0 };
  const add = money2(remainderUsdc);
  const bank = await loadBank(player, env);
  bank.progressUsdc = money2(bank.progressUsdc + add);
  syncDeposited(bank);
  const freeTickets = Math.floor(bank.progressUsdc);
  if (add > 0) {
    pushHistory(bank, {
      type: 'progress',
      amount: add,
      at: Date.now(),
    });
  }
  const saved = await saveBank(player, bank, env);
  return {
    ok: true,
    progressUsdc: saved.progressUsdc,
    freeTickets,
    deposited: saved.deposited,
    balance: saved.deposited,
  };
}

/** After free tickets are bought on-chain, debit progress by whole dollars. */
export async function consumeProgressTickets(player, freeTickets, env) {
  const n = Math.floor(Number(freeTickets) || 0);
  if (!isAddr(player) || n <= 0) return { ok: true, progressUsdc: 0 };
  const bank = await loadBank(player, env);
  const take = Math.min(n, Math.floor(bank.progressUsdc));
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
  return {
    balance: spendable,
    deposited,
    bonusUsdc,
    withdrawable: deposited,
    progressUsdc: money2(bank.progressUsdc),
    progressTowardTicket: money2(bank.progressUsdc),
    lastFreeAt: bank.lastFreeAt || null,
    ...freeDailyInfo(bank),
  };
}

/**
 * Free daily: +$1 stake credit (bonus) once per 24h.
 * Spendable on stakes only — never withdrawable as USDC.
 * Cash out after staking still pays Megapot tickets (not cash).
 */
export async function claimFreeDailyTicket(player, env) {
  if (!isAddr(player)) return { ok: false, error: 'Valid player required', status: 400 };
  const now = Date.now();
  const bank = await loadBank(player, env);
  const info = freeDailyInfo(bank, now);
  if (!info.freeDailyEligible) {
    // One-time migrate: old free-daily bought a ticket / reserved claim but never gave stake credit
    const oldTicketClaim = Object.values(bank.entries || {}).some(
      (e) =>
        e &&
        (e.status === 'free_daily' || e.status === 'free_daily_pending') &&
        e.bonusUsdc == null &&
        (e.tickets != null || e.txHash),
    );
    if (oldTicketClaim && money2(bank.bonusUsdc) === 0 && !bank.freeDailyMigrated) {
      bank.bonusUsdc = money2(bank.bonusUsdc + 1);
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
        creditedBonus: 1,
        migrated: true,
        entryId: 'free-daily-migrate',
        ...bankPublicView(saved),
        freeDailyEligible: false,
        freeDailyNextAt: info.freeDailyNextAt,
        freeDailyMsLeft: info.freeDailyMsLeft,
        history: saved.history,
        note: 'Free $1 stake credit restored — stake to play; not withdrawable.',
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
    creditedBonus: 1,
    entryId,
    ...bankPublicView(saved),
    freeDailyEligible: false,
    freeDailyNextAt: now + FREE_DAILY_MS,
    freeDailyMsLeft: FREE_DAILY_MS,
    history: saved.history,
    note: 'Free $1 stake credit — use it to play; not withdrawable. Cash out for tickets.',
  };
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
    const result = await claimFreeDailyTicket(player, env);
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
        },
        result.status || 400,
      );
    }
    return json({
      ok: true,
      player: player.toLowerCase(),
      creditedBonus: result.creditedBonus,
      entryId: result.entryId,
      freeDailyEligible: false,
      freeDailyNextAt: result.freeDailyNextAt,
      freeDailyMsLeft: result.freeDailyMsLeft,
      ...bankPublicView(result),
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
    const bank = await loadBank(player, env);
    if (entryId && bank.entries[entryId]?.status === 'refunded') {
      return json({
        ok: true,
        already: true,
        ...bankPublicView(bank),
        history: bank.history || [],
      });
    }
    bank.deposited = money2(bank.deposited + stake);
    syncDeposited(bank);
    if (entryId) {
      bank.entries[entryId] = {
        ...(bank.entries[entryId] || {}),
        stake,
        status: 'refunded',
        at: Date.now(),
      };
      try {
        const { roundDoReleaseStake } = await import('./dos/client.js');
        await roundDoReleaseStake(env, { entryId, reason: body.reason || 'refund' });
      } catch (_) {}
    }
    pushHistory(bank, {
      type: 'refund',
      amount: stake,
      entryId: entryId || null,
      at: Date.now(),
    });
    const saved = await saveBank(player, bank, env);
    return json({
      ok: true,
      ...bankPublicView(saved),
      credited: stake,
      toBank: true,
      history: saved.history,
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

    const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
    if (!key && !env?.TX_SEQUENCER_DO) {
      return json({
        ok: false,
        error: 'Withdraw unavailable',
      }, 503);
    }

    try {
      bank.deposited = money2(bank.deposited - amount);
      syncDeposited(bank);
      await saveBank(player, bank, env);

      try {
        let hash;
        if (env?.TX_SEQUENCER_DO) {
          const { executeHouseJob } = await import('./dos/client.js');
          const out = await executeHouseJob(env, {
            type: 'usdc_transfer',
            id: `withdraw:${player.toLowerCase()}:${amount}:${Date.now()}`,
            payload: { to: player, amountUsdc: amount },
          });
          if (!out?.ok || !out?.result?.ok) {
            throw new Error(out?.error || out?.result?.error || 'Sequencer withdraw failed');
          }
          hash = out.result.txHash;
        } else {
          const { transferUsdcFromHouse } = await import('./house-tx.js');
          const { withHouseLock } = await import('./house-tx.js');
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
