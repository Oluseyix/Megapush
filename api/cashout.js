/**
 * Vercel serverless — POST /api/cashout
 * Uses process.env.HOUSE_PRIVATE_KEY only (never commit the key).
 * Base Sepolia: house buys Megapot tickets for `recipient`.
 *
 * Body: { entryId, stake, multiplier, recipient, count? }
 * count defaults to floor(stake * multiplier)
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toBytes,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

export const config = {
  maxDuration: 60,
};

const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
const JACKPOT = '0x465dA3c859f193A3807386387bEE941B2A4c3279';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RANDOM_BUYER = '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
const BATCH = '0x62A5D60F486D01a28071652a7951Aff1EA4c5b7c';
const REFERRER = '0x804BEb025844c189b72C8D810a1A7776043677FF';
const PRECISE_UNIT = 1000000000000000000n;
const SOURCE = keccak256(toBytes('megapush'));

const abi = parseAbi([
  'function ticketPrice() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)',
  'function createBatchOrder(address _recipient, uint64 _dynamicTicketCount, (uint8[] normals, uint8 bonusball)[] _userStaticTickets, address[] _referrers, uint256[] _referralSplit, bytes32 _source)',
  'function hasActiveBatchOrder(address _recipient) view returns (bool)',
]);

/** Best-effort idempotency on warm isolates */
const paid = new Map();

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' });
  }

  const key = process.env.HOUSE_PRIVATE_KEY;
  if (!key) {
    return json(res, 500, { error: 'HOUSE_PRIVATE_KEY not configured on server' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
  }
  body = body || {};

  const recipient = body.recipient;
  if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    return json(res, 400, { error: 'Valid recipient address required' });
  }

  const stake = Number(body.stake);
  const multiplier = Number(body.multiplier);
  let count = Math.floor(Number(body.count));
  if (!Number.isFinite(count) || count <= 0) {
    if (Number.isFinite(stake) && Number.isFinite(multiplier) && stake > 0 && multiplier > 0) {
      count = Math.floor(stake * multiplier);
    }
  }
  if (!Number.isFinite(count) || count <= 0) {
    return json(res, 400, { error: 'count or stake×multiplier must be ≥ 1' });
  }

  const entryId = body.entryId != null ? String(body.entryId) : null;
  if (entryId && paid.has(entryId)) {
    return json(res, 200, { ok: true, idempotent: true, ...paid.get(entryId) });
  }

  try {
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(RPC),
    });
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(RPC),
    });

    let ticketPrice = 1000000n;
    try {
      ticketPrice = await publicClient.readContract({
        address: JACKPOT,
        abi,
        functionName: 'ticketPrice',
      });
    } catch (_) {
      /* default 1 USDC */
    }

    const cost = ticketPrice * BigInt(count);
    const houseBal = await publicClient.readContract({
      address: USDC,
      abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (houseBal < cost) {
      return json(res, 400, {
        error: `House USDC low: have ${formatUnits(houseBal, 6)}, need ${formatUnits(cost, 6)} for ${count} tickets`,
      });
    }

    const ensureApprove = async (spender, amount) => {
      const allowance = await publicClient.readContract({
        address: USDC,
        abi,
        functionName: 'allowance',
        args: [account.address, spender],
      });
      if (allowance >= amount) return null;
      const hash = await walletClient.writeContract({
        address: USDC,
        abi,
        functionName: 'approve',
        args: [spender, amount],
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    };

    const txs = [];

    if (count <= 10) {
      const a = await ensureApprove(RANDOM_BUYER, cost);
      if (a) txs.push(a);
      const hash = await walletClient.writeContract({
        address: RANDOM_BUYER,
        abi,
        functionName: 'buyTickets',
        args: [
          BigInt(count),
          recipient,
          [REFERRER],
          [PRECISE_UNIT],
          SOURCE,
        ],
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      txs.push(hash);
    } else {
      const a = await ensureApprove(BATCH, cost);
      if (a) txs.push(a);
      const active = await publicClient.readContract({
        address: BATCH,
        abi,
        functionName: 'hasActiveBatchOrder',
        args: [recipient],
      });
      if (active) {
        return json(res, 409, { error: 'Recipient has an active batch order' });
      }
      const hash = await walletClient.writeContract({
        address: BATCH,
        abi,
        functionName: 'createBatchOrder',
        args: [
          recipient,
          BigInt(count),
          [],
          [REFERRER],
          [PRECISE_UNIT],
          SOURCE,
        ],
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      txs.push(hash);
    }

    const result = {
      ok: true,
      status: 'paid',
      count,
      recipient,
      tx: txs[txs.length - 1],
      txs,
      entryId,
      stake: Number.isFinite(stake) ? stake : undefined,
      multiplier: Number.isFinite(multiplier) ? multiplier : undefined,
      referrer: REFERRER,
    };
    if (entryId) paid.set(entryId, result);
    return json(res, 200, result);
  } catch (e) {
    console.error('cashout', e);
    return json(res, 500, {
      error: e?.shortMessage || e?.message || String(e),
    });
  }
}
