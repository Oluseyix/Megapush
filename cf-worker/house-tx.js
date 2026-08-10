/**
 * Shared house wallet + on-chain helpers (used by TxSequencerDO and Pages fallback).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  fallback,
  parseAbi,
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

export function makeClients(env) {
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (!key) {
    const err = new Error('Service unavailable');
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
 * Buy Megapot tickets for recipient (chunked). Caller must serialize via DO or lock.
 * @returns {{ ok: true, txHash, buyTxs, tickets, requested, house, beforeCount, afterCount, delivered, cost, ticketPriceUsdc }}
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

  const clients = makeClients(env);
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

  while (remaining > 0) {
    const chunk = Math.min(10, remaining);
    await ensureMaxAllowance(clients, RANDOM_BUYER);
    const hash = await sendAndWait(clients, {
      address: RANDOM_BUYER,
      abi: megapotAbi,
      functionName: 'buyTickets',
      args: [BigInt(chunk), recipient, [REFERRER], [PRECISE_UNIT], SOURCE],
    });
    buyTxs.push(hash);
    remaining -= chunk;
    if (remaining > 0) await sleep(400);
  }

  const txHash = buyTxs[buyTxs.length - 1];
  let afterCount = beforeCount;
  for (let i = 0; i < 5; i++) {
    await sleep(400);
    afterCount = await countPlayerTickets(clients, recipient);
    if (beforeCount != null && afterCount != null && afterCount > beforeCount) break;
  }
  const delivered =
    beforeCount != null && afterCount != null ? Math.max(0, afterCount - beforeCount) : n;

  return {
    ok: true,
    txHash,
    buyTxs,
    tickets: delivered > 0 ? delivered : n,
    requested: n,
    recipient,
    house,
    beforeCount,
    afterCount,
    delivered,
    cost: cost.toString(),
    ticketPriceUsdc: formatUnits(ticketPrice, 6),
    costUsdc: Number(formatUnits(cost, 6)),
    mode: 'randomBuyer_chunked',
    spender: RANDOM_BUYER,
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

  const clients = makeClients(env);
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
