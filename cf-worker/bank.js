/**
 * Play bank — deposit USDC once, stake many times without wallet popups.
 *
 * Balance is stored in Cloudflare KV (env.MEGAPUSH_KV) when that binding is
 * configured — durable and consistent across every edge location. If the
 * binding is absent (not yet set up in the Pages dashboard), this falls back
 * to the Worker Cache API, which is best-effort and scoped per colo, so a
 * balance change made by one request may not be visible to the very next
 * request if it lands on a different edge node. Add a KV namespace binding
 * named MEGAPUSH_KV in Cloudflare Pages → Settings → Functions to upgrade.
 *
 * POST /api/bank
 *   { action: 'deposit', player, txHash }
 *   { action: 'stake', player, entryId, stake }
 *   { action: 'credit', player, entryId, stake, reason }  // cancel / refund to bank
 *   { action: 'balance', player }
 * GET  /api/bank?player=0x…
 */

import {
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  parseUnits,
  decodeEventLog,
} from 'viem';
import { baseSepolia } from 'viem/chains';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
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

function bankCacheKey(player) {
  return new Request('https://megapush.bank.internal/v1/' + String(player).toLowerCase());
}

function bankKvKey(player) {
  return 'bank:' + String(player).toLowerCase();
}

function normalizeBank(j) {
  if (!j || typeof j !== 'object') return null;
  return {
    balance: Math.max(0, Number(j.balance) || 0),
    usedTx: Array.isArray(j.usedTx) ? j.usedTx : [],
    entries: j.entries && typeof j.entries === 'object' ? j.entries : {},
  };
}

async function loadBank(env, player) {
  if (env?.MEGAPUSH_KV) {
    try {
      const raw = await env.MEGAPUSH_KV.get(bankKvKey(player));
      const parsed = raw ? normalizeBank(JSON.parse(raw)) : null;
      if (parsed) return parsed;
      if (raw == null) return { balance: 0, usedTx: [], entries: {} };
    } catch (e) {
      console.warn('bank KV load failed, falling back to cache', e?.message || e);
    }
  }
  // Cache API fallback — best-effort only, used when KV isn't bound yet.
  try {
    const hit = await caches.default.match(bankCacheKey(player));
    if (hit) {
      const parsed = normalizeBank(await hit.json());
      if (parsed) return parsed;
    }
  } catch (_) {}
  return { balance: 0, usedTx: [], entries: {} };
}

async function saveBank(env, player, data) {
  const body = {
    balance: Math.max(0, Math.round((Number(data.balance) || 0) * 100) / 100),
    usedTx: (data.usedTx || []).slice(-200),
    entries: data.entries || {},
    updatedAt: Date.now(),
  };
  if (env?.MEGAPUSH_KV) {
    try {
      await env.MEGAPUSH_KV.put(bankKvKey(player), JSON.stringify(body));
      return body;
    } catch (e) {
      console.warn('bank KV save failed, falling back to cache', e?.message || e);
    }
  }
  try {
    await caches.default.put(
      bankCacheKey(player),
      new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=2592000',
        },
      }),
    );
  } catch (e) {
    console.warn('bank save', e);
  }
  return body;
}

function makePublic(env) {
  const rpc = envGet(env, 'RPC_URL') || 'https://sepolia.base.org';
  return createPublicClient({ chain: baseSepolia, transport: http(rpc) });
}

async function houseAddress(env) {
  // Prefer configured treasury; fall back to deriving from house key
  const fromEnv = envGet(env, 'HOUSE_TREASURY', 'HOUSE_ADDRESS');
  if (isAddr(fromEnv)) return fromEnv;
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (!key) return '0x804BEb025844c189b72C8D810a1A7776043677FF';
  try {
    const { privateKeyToAccount } = await import('viem/accounts');
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    return privateKeyToAccount(/** @type {`0x${string}`} */ (pk)).address;
  } catch {
    return '0x804BEb025844c189b72C8D810a1A7776043677FF';
  }
}

async function creditFromDepositTx(env, player, txHash) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, error: 'Invalid tx hash', status: 400 };
  }
  const bank = await loadBank(env, player);
  if (bank.usedTx.includes(txHash.toLowerCase())) {
    return { ok: true, balance: bank.balance, already: true, credited: 0 };
  }

  const publicClient = makePublic(env);
  const house = (await houseAddress(env)).toLowerCase();
  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: /** @type {`0x${string}`} */ (txHash) });
  } catch {
    return { ok: false, error: 'Deposit tx not found yet — wait for confirmation', status: 400 };
  }
  if (!receipt || receipt.status !== 'success') {
    return { ok: false, error: 'Deposit tx failed or pending', status: 400 };
  }

  let credited = 0;
  for (const log of receipt.logs || []) {
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
      if (from !== player.toLowerCase() || to !== house) continue;
      credited += Number(formatUnits(ev.args.value, 6));
    } catch (_) {}
  }

  if (!(credited > 0)) {
    return {
      ok: false,
      error: 'No USDC transfer to house found in that tx',
      status: 400,
    };
  }

  credited = Math.round(credited * 100) / 100;
  bank.balance = Math.round((bank.balance + credited) * 100) / 100;
  bank.usedTx.push(txHash.toLowerCase());
  const saved = await saveBank(env, player, bank);
  return { ok: true, balance: saved.balance, credited, already: false };
}

/** Credit play balance (used by cashout/refund paths — never send USDC to wallet). */
export async function creditPlayBank(env, player, stakeUsd, entryId) {
  if (!isAddr(player)) return { ok: false, error: 'bad player' };
  const stake = Math.floor(Number(stakeUsd) || 0);
  if (!(stake > 0)) return { ok: false, error: 'bad stake' };
  const bank = await loadBank(env, player);
  if (entryId && bank.entries[entryId]?.status === 'refunded') {
    return { ok: true, already: true, balance: bank.balance, toBank: true };
  }
  bank.balance = Math.round((bank.balance + stake) * 100) / 100;
  if (entryId) {
    bank.entries[entryId] = {
      ...(bank.entries[entryId] || {}),
      stake,
      status: 'refunded',
      at: Date.now(),
    };
  }
  const saved = await saveBank(env, player, bank);
  return { ok: true, balance: saved.balance, credited: stake, toBank: true };
}

/** True once `entryId`'s stake has already been refunded to the play bank. */
export async function isEntryRefunded(env, player, entryId) {
  if (!entryId || !isAddr(player)) return false;
  try {
    const bank = await loadBank(env, player);
    return bank.entries[entryId]?.status === 'refunded';
  } catch (_) {
    return false;
  }
}

export async function handleBank(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const player = url.searchParams.get('player') || '';
    if (!isAddr(player)) return json({ ok: false, error: 'player required' }, 400);
    const bank = await loadBank(env, player);
    return json({ ok: true, player: player.toLowerCase(), balance: bank.balance });
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

  if (action === 'balance') {
    const bank = await loadBank(env, player);
    return json({ ok: true, player: player.toLowerCase(), balance: bank.balance });
  }

  if (action === 'deposit') {
    const txHash = body.txHash || body.tx || body.hash;
    const result = await creditFromDepositTx(env, player, String(txHash || ''));
    if (!result.ok) return json(result, result.status || 400);
    return json({
      ok: true,
      player: player.toLowerCase(),
      balance: result.balance,
      credited: result.credited,
      already: !!result.already,
    });
  }

  if (action === 'stake') {
    const stake = Math.floor(Number(body.stake) || 0);
    const entryId = body.entryId != null ? String(body.entryId) : '';
    if (!(stake > 0)) return json({ ok: false, error: 'Invalid stake' }, 400);
    if (!entryId || !entryId.toLowerCase().startsWith(player.toLowerCase())) {
      return json({ ok: false, error: 'entryId must start with player address' }, 403);
    }
    const bank = await loadBank(env, player);
    if (bank.entries[entryId]) {
      return json({
        ok: true,
        already: true,
        entryId,
        stake,
        balance: bank.balance,
        fromBank: true,
      });
    }
    if (bank.balance + 1e-9 < stake) {
      return json({
        ok: false,
        error: 'Insufficient play balance',
        balance: bank.balance,
        need: stake,
      }, 400);
    }
    bank.balance = Math.round((bank.balance - stake) * 100) / 100;
    bank.entries[entryId] = { stake, at: Date.now(), status: 'open' };
    const saved = await saveBank(env, player, bank);
    return json({
      ok: true,
      entryId,
      stake,
      balance: saved.balance,
      fromBank: true,
    });
  }

  if (action === 'credit') {
    // Refund stake back into play balance (cancel / failed cashout)
    const stake = Math.floor(Number(body.stake) || 0);
    const entryId = body.entryId != null ? String(body.entryId) : '';
    if (!(stake > 0)) return json({ ok: false, error: 'Invalid stake' }, 400);
    const bank = await loadBank(env, player);
    if (entryId && bank.entries[entryId]?.status === 'refunded') {
      return json({ ok: true, already: true, balance: bank.balance });
    }
    bank.balance = Math.round((bank.balance + stake) * 100) / 100;
    if (entryId) {
      bank.entries[entryId] = {
        ...(bank.entries[entryId] || {}),
        stake,
        status: 'refunded',
        at: Date.now(),
      };
    }
    const saved = await saveBank(env, player, bank);
    return json({
      ok: true,
      balance: saved.balance,
      credited: stake,
      toBank: true,
    });
  }

  if (action === 'withdraw') {
    // Send play balance USDC back to player wallet (house pays)
    let amount = Number(body.amount != null ? body.amount : body.stake);
    if (body.amount === 'max' || body.max === true) amount = Infinity;
    amount = Math.floor(Number(amount) || 0);

    const bank = await loadBank(env, player);
    if (!(bank.balance > 0)) {
      return json({ ok: false, error: 'Nothing to withdraw', balance: 0 }, 400);
    }
    if (!(amount > 0) || amount === Infinity) {
      amount = Math.floor(bank.balance);
    }
    if (amount > bank.balance + 1e-9) {
      return json({
        ok: false,
        error: 'Amount exceeds play balance',
        balance: bank.balance,
        need: amount,
      }, 400);
    }

    const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
    if (!key) {
      return json({
        ok: false,
        error: 'HOUSE_PRIVATE_KEY not configured — cannot withdraw',
      }, 500);
    }

    try {
      const { privateKeyToAccount } = await import('viem/accounts');
      const {
        createPublicClient,
        createWalletClient,
        http,
        parseAbi,
        parseUnits,
        formatUnits,
      } = await import('viem');
      const { baseSepolia } = await import('viem/chains');

      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const houseAccount = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      const RPC = envGet(env, 'RPC_URL') || 'https://sepolia.base.org';
      const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
      const walletClient = createWalletClient({
        account: houseAccount,
        chain: baseSepolia,
        transport: http(RPC),
      });
      const usdcAbi = parseAbi([
        'function balanceOf(address account) view returns (uint256)',
        'function transfer(address to, uint256 amount) returns (bool)',
      ]);
      const raw = parseUnits(String(amount), 6);
      const houseBal = await publicClient.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [houseAccount.address],
      });
      if (houseBal < raw) {
        return json({
          ok: false,
          error: `House USDC low for withdraw: have ${formatUnits(houseBal, 6)}, need ${formatUnits(raw, 6)}`,
          balance: bank.balance,
        }, 400);
      }

      // Debit first (idempotent-ish: if transfer fails, re-credit)
      bank.balance = Math.round((bank.balance - amount) * 100) / 100;
      await saveBank(env, player, bank);

      try {
        const nonce = await publicClient.getTransactionCount({
          address: houseAccount.address,
          blockTag: 'pending',
        });
        const hash = await walletClient.writeContract({
          address: USDC,
          abi: usdcAbi,
          functionName: 'transfer',
          args: [/** @type {`0x${string}`} */ (player), raw],
          account: houseAccount,
          chain: baseSepolia,
          nonce,
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });
        if (receipt.status !== 'success') {
          throw new Error('Withdraw transfer reverted');
        }
        return json({
          ok: true,
          player: player.toLowerCase(),
          withdrawn: amount,
          balance: bank.balance,
          txHash: hash,
          toWallet: true,
        });
      } catch (txErr) {
        // Restore balance if chain transfer failed
        bank.balance = Math.round((bank.balance + amount) * 100) / 100;
        await saveBank(env, player, bank);
        return json({
          ok: false,
          error: txErr?.shortMessage || txErr?.message || String(txErr),
          balance: bank.balance,
        }, 500);
      }
    } catch (e) {
      return json({
        ok: false,
        error: e?.shortMessage || e?.message || String(e),
        balance: bank.balance,
      }, 500);
    }
  }

  return json({ ok: false, error: 'Unknown action (deposit|stake|credit|withdraw|balance)' }, 400);
}
