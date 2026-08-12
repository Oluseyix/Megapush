/**
 * Shared house wallet + on-chain helpers (TxSequencerDO + in-process lock fallback).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  keccak256,
  toBytes,
  formatUnits,
  parseUnits,
  maxUint256,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const RANDOM_BUYER = '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
export const JACKPOT = '0x465dA3c859f193A3807386387bEE941B2A4c3279';
export const TICKET_NFT = '0x45084829ac63f9dC6a3D4981A46FA896f9180ECd';
export const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';
export const PRECISE_UNIT = 1000000000000000000n;
export const SOURCE = keccak256(toBytes('megapush'));

export const usdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
export const megapotAbi = parseAbi([
  'function ticketPrice() view returns (uint256)',
  'function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)',
]);
const ticketReadAbi = parseAbi([
  'function currentDrawingId() view returns (uint256)',
  'function getUserTickets(address _userAddress, uint256 _drawingId) view returns ((uint256 ticketId, (uint256 drawingId, uint256 packedTicket, bytes32 referralScheme) ticket, uint8[] normals, uint8 bonusball)[])',
]);
/** ERC-721 — mint to house, transfer only earned tickets to player; extras stay with house. */
export const ticketNftAbi = parseAbi([
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
]);
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
);

export function envGet(env, ...keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isAddr(a) {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
}

function isTransient(e) {
  const s = String(e?.shortMessage || e?.message || e || '').toLowerCase();
  return (
    s.includes('http request failed') ||
    s.includes('timeout') ||
    s.includes('429') ||
    s.includes('503') ||
    s.includes('502') ||
    s.includes('fetch failed') ||
    s.includes('network') ||
    s.includes('econnreset') ||
    s.includes('nonce')
  );
}

/**
 * A buy tx was broadcast but we could not learn whether it landed. Callers must treat this
 * as "may already be minted" and never re-buy automatically.
 */
export function unconfirmedBuyError(hash) {
  const err = new Error(`Ticket buy ${hash} broadcast but unconfirmed — not retrying`);
  err.unconfirmed = true;
  err.txHash = hash;
  return err;
}

export function isUnconfirmedBuy(e) {
  return !!e?.unconfirmed;
}

export function makeTransport(env) {
  const urls = [
    envGet(env, 'RPC_URL'),
    'https://sepolia.base.org',
    'https://base-sepolia-rpc.publicnode.com',
    'https://base-sepolia.gateway.tenderly.co',
  ].filter(Boolean);
  return fallback(
    urls.map((u) => http(u, { timeout: 25_000, retryCount: 2, retryDelay: 400 })),
    { rank: false },
  );
}

const KV_HOUSE_KEY = 'HOUSE_PRIVATE_KEY';
/** @type {string|null} */
let _houseKeyCache = null;

/**
 * Resolve house signing key: Worker secret first, then BANK_KV bootstrap copy.
 * Pages can push the key once via /api/bootstrap/house so the Worker can cash out.
 */
export async function resolveHousePrivateKey(env) {
  const fromEnv = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (fromEnv) {
    _houseKeyCache = fromEnv;
    return fromEnv;
  }
  if (_houseKeyCache) return _houseKeyCache;
  try {
    if (env?.BANK_KV) {
      const fromKv = await env.BANK_KV.get(KV_HOUSE_KEY);
      if (fromKv && String(fromKv).trim()) {
        _houseKeyCache = String(fromKv).trim();
        return _houseKeyCache;
      }
    }
  } catch (e) {
    console.warn('resolveHousePrivateKey KV', e?.message || e);
  }
  return '';
}

export async function storeHousePrivateKey(env, key) {
  const k = String(key || '').trim();
  if (!k || k.length < 64) {
    throw new Error('Invalid house private key');
  }
  if (!env?.BANK_KV) throw new Error('BANK_KV missing');
  await env.BANK_KV.put(KV_HOUSE_KEY, k.startsWith('0x') ? k : `0x${k}`);
  _houseKeyCache = k.startsWith('0x') ? k : `0x${k}`;
  return privateKeyToAccount(/** @type {`0x${string}`} */ (_houseKeyCache)).address;
}

export async function makeClients(env) {
  const key = await resolveHousePrivateKey(env);
  if (!key) {
    const err = new Error('Service unavailable — HOUSE_PRIVATE_KEY not configured');
    err.statusCode = 503;
    throw err;
  }
  const pk = key.startsWith('0x') ? key : `0x${key}`;
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
  const transport = makeTransport(env);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  return { account, house: account.address, publicClient, walletClient };
}

export async function sendAndWait(clients, buildArgs, retries = 4) {
  const { publicClient, walletClient, account, house } = clients;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const nonce = await publicClient.getTransactionCount({
        address: house,
        blockTag: 'pending',
      });
      const hash = await walletClient.writeContract({
        ...buildArgs,
        account,
        chain: baseSepolia,
        nonce,
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 90_000,
        pollingInterval: 500,
      });
      if (receipt.status !== 'success') {
        throw new Error(`Transaction reverted: ${hash}`);
      }
      return hash;
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1 && isTransient(e)) {
        await sleep(500 + attempt * 500);
        continue;
      }
      const msg = String(e?.shortMessage || e?.message || '').toLowerCase();
      if (msg.includes('allowance') && attempt < retries - 1) {
        try {
          await ensureMaxAllowance(clients, RANDOM_BUYER);
        } catch (_) {}
        await sleep(600);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export async function ensureMaxAllowance(clients, spender = RANDOM_BUYER) {
  const { publicClient, house } = clients;
  let allowance = await publicClient.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'allowance',
    args: [house, spender],
  });
  if (allowance > 10n ** 18n) return null;
  if (allowance > 0n && allowance < 10n ** 12n) {
    await sendAndWait(clients, {
      address: USDC,
      abi: usdcAbi,
      functionName: 'approve',
      args: [spender, 0n],
    });
  }
  return sendAndWait(clients, {
    address: USDC,
    abi: usdcAbi,
    functionName: 'approve',
    args: [spender, maxUint256],
  });
}

export async function countPlayerTickets(clients, player) {
  try {
    const { publicClient } = clients;
    const drawingId = await publicClient.readContract({
      address: JACKPOT,
      abi: ticketReadAbi,
      functionName: 'currentDrawingId',
    });
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const did = drawingId - BigInt(i);
      if (did < 0n) break;
      try {
        const rows = await publicClient.readContract({
          address: TICKET_NFT,
          abi: ticketReadAbi,
          functionName: 'getUserTickets',
          args: [player, did],
        });
        total += Array.isArray(rows) ? rows.length : 0;
      } catch (_) {}
    }
    return total;
  } catch (_) {
    return null;
  }
}

/**
 * Parse ticket tokenIds minted/transferred to `to` from a tx receipt.
 */
export function ticketIdsFromReceipt(receipt, toAddr) {
  const to = String(toAddr || '').toLowerCase();
  if (!receipt?.logs?.length || !to) return [];
  try {
    const events = parseEventLogs({
      abi: [TRANSFER_EVENT],
      logs: receipt.logs,
    });
    const ids = [];
    for (const ev of events) {
      if (ev.eventName !== 'Transfer') continue;
      const dest = String(ev.args?.to || '').toLowerCase();
      if (dest !== to) continue;
      if (ev.args?.tokenId != null) ids.push(ev.args.tokenId);
    }
    return ids;
  } catch (_) {
    return [];
  }
}

/**
 * Buy one chunk with simulate + generous gas. Retries on revert/transient errors.
 *
 * Duplicate safety: once a buy tx is broadcast we NEVER send another for the same chunk
 * until that tx is known to have reverted. A timed-out / errored receipt wait is not proof
 * the buy did not happen — re-sending there is what minted extra tickets.
 */
async function buyTicketChunk(clients, { recipient, chunk, maxAttempts = 4 }) {
  const { publicClient, walletClient, account, house } = clients;
  let lastErr;
  /** Hash of a broadcast buy whose outcome we have not yet resolved. */
  let sentHash = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Resolve a previous broadcast before considering another send.
      if (sentHash) {
        const prior = await publicClient
          .waitForTransactionReceipt({
            hash: sentHash,
            confirmations: 1,
            timeout: 30_000,
            pollingInterval: 500,
          })
          .catch(() => null);
        if (prior?.status === 'success') return sentHash;
        if (!prior) {
          // Still unknown — keep waiting on the same tx, never buy again.
          lastErr = unconfirmedBuyError(sentHash);
          await sleep(1000 + attempt * 500);
          continue;
        }
        sentHash = null; // confirmed reverted — safe to send a replacement
      }
      if (attempt === 1 || attempt === 3) {
        try {
          await ensureMaxAllowance(clients, RANDOM_BUYER);
        } catch (_) {}
      }
      // Megapot RandomBuyer uses ~1.1M gas / ticket; under-estimation OOGs and looks like a random revert.
      // Floor: 2.5M per ticket, cap 14M per chunk (Base Sepolia block room).
      const gasFloor = 2_500_000n * BigInt(chunk);
      let gas = gasFloor;
      try {
        const { request } = await publicClient.simulateContract({
          address: RANDOM_BUYER,
          abi: megapotAbi,
          functionName: 'buyTickets',
          args: [BigInt(chunk), recipient, [REFERRER], [PRECISE_UNIT], SOURCE],
          account,
        });
        if (request.gas != null) {
          const bumped = (request.gas * 25n) / 10n; // 2.5× estimate
          if (bumped > gas) gas = bumped;
        }
      } catch (simErr) {
        // Still try send with floor gas — sim can fail while send works after allowance
        console.warn('buyTickets sim', simErr?.shortMessage || simErr?.message || simErr);
      }
      if (gas > 14_000_000n) gas = 14_000_000n;

      const nonce = await publicClient.getTransactionCount({
        address: house,
        blockTag: 'pending',
      });
      const hash = await walletClient.writeContract({
        address: RANDOM_BUYER,
        abi: megapotAbi,
        functionName: 'buyTickets',
        args: [BigInt(chunk), recipient, [REFERRER], [PRECISE_UNIT], SOURCE],
        account,
        chain: baseSepolia,
        gas,
        nonce,
      });
      sentHash = hash;
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 90_000,
        pollingInterval: 500,
      });
      if (receipt.status !== 'success') {
        sentHash = null; // reverted on-chain — nothing minted, retry is safe
        throw new Error(`Transaction reverted: ${hash}`);
      }
      return hash;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.shortMessage || e?.message || e || '').toLowerCase();
      // Permanent config issues — don't spin
      if (msg.includes('house usdc') || msg.includes('not configured')) throw e;
      await sleep(400 + attempt * 400);
    }
  }
  throw lastErr || new Error('buyTicketChunk failed');
}

/**
 * Buy Megapot tickets for the PLAYER.
 * Adaptive chunks (5 → 1) with retries — large single chunks intermittently revert on Base Sepolia.
 * tickets = exact requested count (caller must pass floor(stake×mult) only).
 */
export async function buyTicketsForPlayer(env, { recipient, tickets }) {
  if (!isAddr(recipient)) {
    const err = new Error('Valid recipient required');
    err.statusCode = 400;
    throw err;
  }
  let n = Math.floor(Number(tickets) || 0);
  if (!(n > 0)) {
    const err = new Error('tickets must be ≥ 1');
    err.statusCode = 400;
    throw err;
  }
  if (n > 50) n = 50;

  const clients = await makeClients(env);
  const { publicClient, house } = clients;

  if (recipient.toLowerCase() === house.toLowerCase()) {
    const err = new Error('Recipient cannot be house — must be player');
    err.statusCode = 400;
    throw err;
  }

  let ticketPrice = 10000n;
  try {
    ticketPrice = await publicClient.readContract({
      address: JACKPOT,
      abi: megapotAbi,
      functionName: 'ticketPrice',
    });
  } catch (_) {}

  const cost = ticketPrice * BigInt(n);
  const houseBal = await publicClient.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [house],
  });
  if (houseBal < cost) {
    const err = new Error(
      `House USDC low: have ${formatUnits(houseBal, 6)}, need ${formatUnits(cost, 6)} for ${n} tickets`,
    );
    err.statusCode = 400;
    throw err;
  }

  await ensureMaxAllowance(clients, RANDOM_BUYER);

  const beforeCount = await countPlayerTickets(clients, recipient);
  const buyTxs = [];
  let remaining = n;
  let chunkSize = n >= 10 ? 5 : Math.min(5, n); // prefer 5; fall back to 1 on pain

  while (remaining > 0) {
    const chunk = Math.min(chunkSize, remaining);
    try {
      const hash = await buyTicketChunk(clients, { recipient, chunk });
      buyTxs.push(hash);
      remaining -= chunk;
      if (remaining > 0) await sleep(250);
    } catch (e) {
      // Broadcast but unresolved — the chunk may already be minted. Stop here rather than
      // shrink-and-retry, which is how one cashout turned into several ticket buys.
      if (isUnconfirmedBuy(e)) {
        console.error('buyTickets unconfirmed — stopping to avoid duplicate mint', {
          recipient,
          chunk,
          txHash: e.txHash,
        });
        if (buyTxs.length > 0) break;
        throw e;
      }
      if (chunkSize > 1) {
        // shrink chunk and retry same remaining
        chunkSize = 1;
        console.warn('buyTickets shrink chunk to 1', e?.shortMessage || e?.message || e);
        continue;
      }
      // chunk=1 still failing — if we already delivered some, return partial success
      if (buyTxs.length > 0) {
        console.error('buyTickets partial', { delivered: n - remaining, failed: remaining });
        break;
      }
      throw e;
    }
  }

  const delivered = n - remaining;
  if (!(delivered > 0)) {
    const err = new Error('Ticket buy failed on-chain');
    err.statusCode = 500;
    throw err;
  }

  const txHash = buyTxs[buyTxs.length - 1];
  let afterCount = beforeCount;
  try {
    await sleep(300);
    afterCount = await countPlayerTickets(clients, recipient);
  } catch (_) {}

  return {
    ok: true,
    txHash,
    buyTxs,
    tickets: delivered,
    requested: n,
    recipient,
    house,
    beforeCount,
    afterCount,
    delivered,
    kept: delivered,
    returned: Math.max(0, n - delivered),
    partial: delivered < n,
    cost: (ticketPrice * BigInt(delivered)).toString(),
    ticketPriceUsdc: formatUnits(ticketPrice, 6),
    costUsdc: Number(formatUnits(ticketPrice * BigInt(delivered), 6)),
    mode: 'adaptive_chunk_buy',
    spender: RANDOM_BUYER,
  };
}

/**
 * Claw back excess tickets from a player to house when we know they received too many.
 * Requires house to already own them OR player-approved operator (usually house owns via mint path).
 * Prefer mint-to-house path so this is rarely needed for new cashouts.
 */
export async function reclaimTicketsToHouse(env, { player, ticketIds }) {
  if (!isAddr(player)) {
    return { ok: false, error: 'Valid player required' };
  }
  const ids = (Array.isArray(ticketIds) ? ticketIds : [])
    .map((x) => {
      try {
        return BigInt(x);
      } catch {
        return null;
      }
    })
    .filter((x) => x != null);
  if (!ids.length) return { ok: false, error: 'ticketIds required' };

  const clients = await makeClients(env);
  const { publicClient, house } = clients;
  const reclaimed = [];
  const failed = [];

  for (const tokenId of ids) {
    try {
      const owner = await publicClient.readContract({
        address: TICKET_NFT,
        abi: ticketNftAbi,
        functionName: 'ownerOf',
        args: [tokenId],
      });
      if (String(owner).toLowerCase() === house.toLowerCase()) {
        reclaimed.push(tokenId.toString());
        continue; // already house
      }
      if (String(owner).toLowerCase() !== player.toLowerCase()) {
        failed.push({ id: tokenId.toString(), error: 'not owned by player' });
        continue;
      }
      // Without prior approval this will fail — caller should use mint-to-house path
      const hash = await sendAndWait(clients, {
        address: TICKET_NFT,
        abi: ticketNftAbi,
        functionName: 'transferFrom',
        args: [player, house, tokenId],
      });
      reclaimed.push(tokenId.toString());
      void hash;
    } catch (e) {
      failed.push({ id: tokenId.toString(), error: e?.shortMessage || e?.message || String(e) });
    }
  }

  return {
    ok: failed.length === 0,
    reclaimed,
    failed,
    house,
    player,
  };
}

/** Transfer USDC from house to `to` (amount in whole USDC dollars). */
export async function transferUsdcFromHouse(env, { to, amountUsdc }) {
  if (!isAddr(to)) {
    const err = new Error('Valid to address required');
    err.statusCode = 400;
    throw err;
  }
  const amount = Math.floor(Number(amountUsdc) || 0);
  if (!(amount > 0)) {
    const err = new Error('amountUsdc > 0 required');
    err.statusCode = 400;
    throw err;
  }

  const clients = await makeClients(env);
  const { publicClient, house } = clients;
  const raw = parseUnits(String(amount), 6);
  const houseBal = await publicClient.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'balanceOf',
    args: [house],
  });
  if (houseBal < raw) {
    const err = new Error(
      `House USDC low: have ${formatUnits(houseBal, 6)}, need ${formatUnits(raw, 6)}`,
    );
    err.statusCode = 400;
    throw err;
  }

  const txHash = await sendAndWait(clients, {
    address: USDC,
    abi: usdcAbi,
    functionName: 'transfer',
    args: [/** @type {`0x${string}`} */ (to), raw],
  });

  return {
    ok: true,
    txHash,
    to,
    amountUsdc: amount,
    house,
  };
}

/** Isolate-local lock for Pages fallback (no DO). */
let houseTxChain = Promise.resolve();
export function withHouseLock(fn) {
  const run = houseTxChain.then(() => fn());
  houseTxChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
