/**
 * MegaPush house backend — Base Sepolia
 *
 * POST /game/cashout  { entryId, count, recipient, stake, multiplier }
 *   → house buys Megapot tickets for recipient (no player key)
 *
 * POST /game/refund   { entryId, stake, player }
 *   → house refunds stake USDC to player (cancel queued bet)
 *
 * POST /game/stake    { entryId, stake, tx, player }  (optional bookkeeping)
 *
 * Env: service credential */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  keccak256,
  toBytes,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

const PORT = Number(process.env.PORT || 8787);
const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
const HOUSE_KEY = process.env.service credentialconst HOUSE_ADDRESS = process.env.HOUSE_ADDRESS;

const JACKPOT = process.env.JACKPOT || '0x465dA3c859f193A3807386387bEE941B2A4c3279';
const USDC = process.env.USDC || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RANDOM_BUYER = process.env.RANDOM_BUYER || '0x53c04e7e5044B28Ea8A4F9c4b26E3Ac1aeb63746';
const BATCH = process.env.BATCH || '0x62A5D60F486D01a28071652a7951Aff1EA4c5b7c';
const REFERRER = process.env.REFERRER || '0x0000000000000000000000000000000000000001';
const PRECISE_UNIT = 1000000000000000000n;
const SOURCE = keccak256(toBytes('megapush'));

if (!HOUSE_KEY || !HOUSE_ADDRESS) {
  console.error('Set service credential');
  process.exit(1);
}

const account = privateKeyToAccount(
  /** @type {`0x${string}`} */ (HOUSE_KEY.startsWith('0x') ? HOUSE_KEY : `0x${HOUSE_KEY}`),
);
if (account.address.toLowerCase() !== HOUSE_ADDRESS.toLowerCase()) {
  console.warn(
    'Warning: HOUSE_ADDRESS does not match private key address',
    account.address,
    HOUSE_ADDRESS,
  );
}

const abi = parseAbi([
  'function ticketPrice() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function buyTickets(uint256 _count, address _recipient, address[] _referrers, uint256[] _referralSplitBps, bytes32 _source) returns (uint256[] ticketIds)',
  'function createBatchOrder(address _recipient, uint64 _dynamicTicketCount, (uint8[] normals, uint8 bonusball)[] _userStaticTickets, address[] _referrers, uint256[] _referralSplit, bytes32 _source)',
  'function hasActiveBatchOrder(address _recipient) view returns (bool)',
]);

const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const walletClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(RPC),
});

/** @type {Map<string, { status: string, tx?: string, count?: number }>} */
const cashoutLedger = new Map();
/** @type {Map<string, { player: string, stake: number, stakeTx?: string }>} */
const stakeLedger = new Map();
/** @type {Set<string>} */
const refunded = new Set();

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, chain: 'baseSepolia', house: account.address });
});

app.post('/game/stake', (req, res) => {
  const { entryId, stake, tx, player } = req.body || {};
  if (!entryId || !player) return res.status(400).json({ error: 'entryId and player required' });
  stakeLedger.set(String(entryId), {
    player: String(player).toLowerCase(),
    stake: Number(stake) || 0,
    stakeTx: tx,
  });
  res.json({ ok: true, entryId });
});

app.post('/game/refund', async (req, res) => {
  try {
    const { entryId, stake, player } = req.body || {};
    if (!entryId || !player) return res.status(400).json({ error: 'entryId and player required' });
    const id = String(entryId);
    if (refunded.has(id)) return res.json({ ok: true, already: true });
    if (cashoutLedger.has(id) && cashoutLedger.get(id)?.status === 'paid') {
      return res.status(400).json({ error: 'Already cashed out' });
    }

    const rec = stakeLedger.get(id);
    const amountUsd = Number(stake ?? rec?.stake);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res.status(400).json({ error: 'Invalid stake amount' });
    }
    if (rec && rec.player !== String(player).toLowerCase()) {
      return res.status(403).json({ error: 'Player mismatch' });
    }

    const raw = parseUnits(String(amountUsd), 6);
    const bal = await publicClient.readContract({
      address: USDC,
      abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (bal < raw) return res.status(400).json({ error: 'House treasury insufficient USDC' });

    const hash = await walletClient.writeContract({
      address: USDC,
      abi,
      functionName: 'transfer',
      args: [/** @type {`0x${string}`} */ (player), raw],
      account,
      chain: baseSepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    refunded.add(id);
    stakeLedger.delete(id);
    res.json({ ok: true, tx: hash, refunded: amountUsd });
  } catch (e) {
    console.error('refund', e);
    res.status(500).json({ error: e?.shortMessage || e?.message || String(e) });
  }
});

async function ensureApprove(spender, amount) {
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
}

app.post('/game/cashout', async (req, res) => {
  try {
    const body = req.body || {};
    const entryId = body.entryId != null ? String(body.entryId) : null;
    const count = Math.max(0, Math.floor(Number(body.count) || 0));
    const recipient = body.recipient;
    if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
      return res.status(400).json({ error: 'Valid recipient required' });
    }
    if (count <= 0) return res.json({ ok: true, count: 0 });

    if (entryId && cashoutLedger.has(entryId)) {
      const prev = cashoutLedger.get(entryId);
      return res.json({ ok: true, idempotent: true, ...prev });
    }

    let price = 1000000n;
    try {
      price = await publicClient.readContract({
        address: JACKPOT,
        abi,
        functionName: 'ticketPrice',
      });
    } catch (_) {}

    const cost = price * BigInt(count);
    const houseBal = await publicClient.readContract({
      address: USDC,
      abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (houseBal < cost) {
      return res.status(400).json({
        error: `House USDC low: have ${formatUnits(houseBal, 6)}, need ${formatUnits(cost, 6)}`,
      });
    }

    const txs = [];
    if (count <= 10) {
      const a = await ensureApprove(RANDOM_BUYER, cost);
      if (a) txs.push(a);
      const hash = await walletClient.writeContract({
        address: RANDOM_BUYER,
        abi,
        functionName: 'buyTickets',
        args: [BigInt(count), recipient, [REFERRER], [PRECISE_UNIT], SOURCE],
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
        return res.status(409).json({ error: 'Recipient has active batch order' });
      }
      const hash = await walletClient.writeContract({
        address: BATCH,
        abi,
        functionName: 'createBatchOrder',
        args: [recipient, BigInt(count), [], [REFERRER], [PRECISE_UNIT], SOURCE],
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      txs.push(hash);
    }

    const result = { status: 'paid', tx: txs[txs.length - 1], txs, count };
    if (entryId) cashoutLedger.set(entryId, result);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('cashout', e);
    res.status(500).json({ error: e?.shortMessage || e?.message || String(e) });
  }
});

// Alias if frontend posts full HOUSE_BUY_URL path variants
app.post('/megapot/house-buy', (req, res, next) => {
  req.url = '/game/cashout';
  app._router.handle(req, res, next);
});

app.listen(PORT, () => {
  console.log(`MegaPush house listening on :${PORT}`);
  console.log(`House ${account.address}`);
  console.log(`Cashout POST http://localhost:${PORT}/game/cashout`);
});
