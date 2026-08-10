/**
 * Play bank — deposit USDC once, stake many times without wallet popups.
 * Balance is stored in the Worker Cache API (best-effort durable for CF).
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

async function loadBank(player) {
  try {
    const hit = await caches.default.match(bankCacheKey(player));
    if (hit) {
      const j = await hit.json();
      if (j && typeof j === 'object') {
        return {
          balance: Math.max(0, Number(j.balance) || 0),
          usedTx: Array.isArray(j.usedTx) ? j.usedTx : [],
          entries: j.entries && typeof j.entries === 'object' ? j.entries : {},
        };
      }
    }
  } catch (_) {}
  return { balance: 0, usedTx: [], entries: {} };
}

async function saveBank(player, data) {
  const body = {
    balance: Math.max(0, Math.round((Number(data.balance) || 0) * 100) / 100),
    usedTx: (data.usedTx || []).slice(-200),
    entries: data.entries || {},
    updatedAt: Date.now(),
  };
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
  const bank = await loadBank(player);
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
  const saved = await saveBank(player, bank);
  return { ok: true, balance: saved.balance, credited, already: false };
}

export async function handleBank(request, env) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const player = url.searchParams.get('player') || '';
    if (!isAddr(player)) return json({ ok: false, error: 'player required' }, 400);
    const bank = await loadBank(player);
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
    const bank = await loadBank(player);
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
    const bank = await loadBank(player);
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
    const saved = await saveBank(player, bank);
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
    const bank = await loadBank(player);
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
    const saved = await saveBank(player, bank);
    return json({
      ok: true,
      balance: saved.balance,
      credited: stake,
      toBank: true,
    });
  }

  return json({ ok: false, error: 'Unknown action (deposit|stake|credit|balance)' }, 400);
}
