/**
 * POST /api/cashout — MUST mint tickets to PLAYER or refund stake.
 * Hardened: multi-RPC fallback, retries, no false failures, chunked RandomBuyer.
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isAddr(a) {
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

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RANDOM_BUYER = '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
const JACKPOT = '0x465dA3c859f193A3807386387bEE941B2A4c3279';
const TICKET_NFT = '0x45084829ac63f9dC6a3D4981A46FA896f9180ECd';
const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';
const PRECISE_UNIT = 1000000000000000000n;
const SOURCE = keccak256(toBytes('megapush'));

const usdcAbi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const megapotAbi = parseAbi([
  'function ticketPrice() view returns (uint256)',
  'function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)',
]);
const ticketReadAbi = parseAbi([
  'function currentDrawingId() view returns (uint256)',
  'function getUserTickets(address _userAddress, uint256 _drawingId) view returns ((uint256 ticketId, (uint256 drawingId, uint256 packedTicket, bytes32 referralScheme) ticket, uint8[] normals, uint8 bonusball)[])',
]);

/** Serialize all house txs in this isolate */
let houseTxChain = Promise.resolve();
function withHouseLock(fn) {
  const run = houseTxChain.then(() => fn());
  houseTxChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function makeTransport(env) {
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

function makeClients(env) {
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  if (!key) {
    const err = new Error('HOUSE_PRIVATE_KEY not configured on Cloudflare');
    err.statusCode = 500;
    throw err;
  }
  const pk = key.startsWith('0x') ? key : `0x${key}`;
  const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
  const transport = makeTransport(env);
  const publicClient = createPublicClient({ chain: baseSepolia, transport });
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
  return { account, house: account.address, publicClient, walletClient };
}

async function ensureMaxAllowance(clients, spender) {
  const { publicClient, walletClient, account, house } = clients;
  let allowance = await publicClient.readContract({
    address: USDC,
    abi: usdcAbi,
    functionName: 'allowance',
    args: [house, spender],
  });
  // Already effectively unlimited
  if (allowance > 10n ** 18n) return null;

  // Prefer single max approve. Only zero first if token requires it (non-zero and not enough).
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

async function sendAndWait(clients, buildArgs, retries = 4) {
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
      // one more try after fresh allowance if allowance error
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

async function countPlayerTickets(clients, player) {
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

async function tryRefundStake(clients, player, stakeUsd) {
  try {
    if (!isAddr(player) || !(Number(stakeUsd) > 0)) return null;
    const { publicClient, house } = clients;
    const raw = parseUnits(String(stakeUsd), 6);
    const bal = await publicClient.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [house],
    });
    if (bal < raw) return null;
    return await sendAndWait(clients, {
      address: USDC,
      abi: usdcAbi,
      functionName: 'transfer',
      args: [/** @type {`0x${string}`} */ (player), raw],
    });
  } catch (e) {
    console.error('refund failed', e?.message || e);
    return null;
  }
}

export async function handleCashout(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const recipient = body.recipient;
  if (!isAddr(recipient)) {
    return json({ ok: false, error: 'Valid player recipient required', recipient: recipient || null }, 400);
  }

  const stake = Number(body.stake);
  const multiplier = Number(body.multiplier);
  const entryId = body.entryId != null ? String(body.entryId) : null;

  let tickets = Math.floor(Number(body.tickets != null ? body.tickets : body.count));
  if (!Number.isFinite(tickets) || tickets <= 0) {
    if (Number.isFinite(stake) && Number.isFinite(multiplier) && stake > 0 && multiplier > 0) {
      tickets = Math.floor(stake * multiplier);
    }
  }
  if (!Number.isFinite(tickets) || tickets <= 0) {
    return json(
      { ok: false, error: 'tickets must be ≥ 1', recipient },
      400,
    );
  }
  // Keep buys small enough to land reliably (still chunk if larger)
  if (tickets > 50) tickets = 50;

  try {
    const result = await withHouseLock(async () => {
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

      const cost = ticketPrice * BigInt(tickets);
      const houseBal = await publicClient.readContract({
        address: USDC,
        abi: usdcAbi,
        functionName: 'balanceOf',
        args: [house],
      });
      if (houseBal < cost) {
        const err = new Error(
          `House USDC low: have ${formatUnits(houseBal, 6)}, need ${formatUnits(cost, 6)} for ${tickets} tickets`,
        );
        err.statusCode = 400;
        throw err;
      }

      // Ensure unlimited allowance for RandomBuyer
      await ensureMaxAllowance(clients, RANDOM_BUYER);

      const beforeCount = await countPlayerTickets(clients, recipient);
      const buyTxs = [];
      let remaining = tickets;

      while (remaining > 0) {
        const chunk = Math.min(10, remaining);
        // Re-ensure allowance before each chunk (prevents race / partial allowance)
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

      // Best-effort count (never fail the win if tx confirmed)
      let afterCount = beforeCount;
      for (let i = 0; i < 5; i++) {
        await sleep(400);
        afterCount = await countPlayerTickets(clients, recipient);
        if (beforeCount != null && afterCount != null && afterCount > beforeCount) break;
      }
      const delivered =
        beforeCount != null && afterCount != null
          ? Math.max(0, afterCount - beforeCount)
          : tickets;

      return {
        ok: true,
        platform: 'cloudflare-pages-worker',
        txHash,
        buyTxs,
        tickets: delivered > 0 ? delivered : tickets,
        requested: tickets,
        recipient,
        stake: Number.isFinite(stake) ? stake : undefined,
        multiplier: Number.isFinite(multiplier) ? multiplier : undefined,
        entryId: entryId || undefined,
        mode: 'randomBuyer_chunked',
        spender: RANDOM_BUYER,
        house,
        beforeCount,
        afterCount,
        delivered,
        cost: cost.toString(),
        ticketPriceUsdc: formatUnits(ticketPrice, 6),
      };
    });

    return json(result, 200);
  } catch (e) {
    console.error('cashout error', e?.shortMessage || e?.message || e);
    let refundTxHash = null;
    if (Number.isFinite(stake) && stake > 0 && isAddr(recipient)) {
      try {
        const clients = makeClients(env);
        refundTxHash = await withHouseLock(() => tryRefundStake(clients, recipient, stake));
      } catch (_) {}
    }
    return json(
      {
        ok: false,
        platform: 'cloudflare-pages-worker',
        error: e?.shortMessage || e?.message || String(e),
        recipient,
        tickets,
        stake: Number.isFinite(stake) ? stake : undefined,
        refundTxHash: refundTxHash || undefined,
      },
      e?.statusCode || 500,
    );
  }
}
