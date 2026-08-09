/**
 * POST /api/cashout — house buys Megapot tickets on Base Sepolia.
 * Private key: process.env.HOUSE_PRIVATE_KEY only (never log or return it).
 *
 * Body: { entryId, stake, multiplier, recipient, count? }
 * tickets = count || floor(stake * multiplier)
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  const key = process.env.HOUSE_PRIVATE_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: 'HOUSE_PRIVATE_KEY not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body || '{}');
    } catch {
      return res.status(400).json({ ok: false, error: 'Invalid JSON' });
    }
  }
  body = body || {};

  const recipient = body.recipient;
  if (!recipient || !/^0x[a-fA-F0-9]{40}$/.test(recipient)) {
    return res.status(400).json({ ok: false, error: 'Valid recipient required' });
  }

  const stake = Number(body.stake);
  const multiplier = Number(body.multiplier);
  let tickets = Math.floor(Number(body.count));
  if (!Number.isFinite(tickets) || tickets <= 0) {
    if (Number.isFinite(stake) && Number.isFinite(multiplier) && stake > 0 && multiplier > 0) {
      tickets = Math.floor(stake * multiplier);
    }
  }
  if (!Number.isFinite(tickets) || tickets <= 0) {
    return res.status(400).json({
      ok: false,
      error: 'tickets must be ≥ 1 (pass count or stake × multiplier)',
    });
  }

  const entryId = body.entryId != null ? String(body.entryId) : null;

  try {
    const {
      createPublicClient,
      createWalletClient,
      http,
      parseAbi,
      keccak256,
      toBytes,
      formatUnits,
    } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { baseSepolia } = await import('viem/chains');

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

    let ticketPrice = 1000000n; // 1 USDC default
    try {
      ticketPrice = await publicClient.readContract({
        address: JACKPOT,
        abi,
        functionName: 'ticketPrice',
      });
    } catch (_) {
      /* keep default */
    }

    const cost = ticketPrice * BigInt(tickets);
    const houseBal = await publicClient.readContract({
      address: USDC,
      abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (houseBal < cost) {
      return res.status(400).json({
        ok: false,
        error: `House USDC low: have ${formatUnits(houseBal, 6)}, need ${formatUnits(cost, 6)} for ${tickets} tickets`,
        tickets,
      });
    }

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

    let txHash;

    if (tickets <= 10) {
      await ensureApprove(RANDOM_BUYER, cost);
      txHash = await walletClient.writeContract({
        address: RANDOM_BUYER,
        abi,
        functionName: 'buyTickets',
        args: [BigInt(tickets), recipient, [REFERRER], [PRECISE_UNIT], SOURCE],
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    } else {
      await ensureApprove(BATCH, cost);
      const active = await publicClient.readContract({
        address: BATCH,
        abi,
        functionName: 'hasActiveBatchOrder',
        args: [recipient],
      });
      if (active) {
        return res.status(409).json({
          ok: false,
          error: 'Recipient has an active batch order',
          tickets,
        });
      }
      txHash = await walletClient.writeContract({
        address: BATCH,
        abi,
        functionName: 'createBatchOrder',
        args: [recipient, BigInt(tickets), [], [REFERRER], [PRECISE_UNIT], SOURCE],
        account,
        chain: baseSepolia,
      });
      await publicClient.waitForTransactionReceipt({ hash: txHash });
    }

    return res.status(200).json({
      ok: true,
      txHash,
      tickets,
      entryId: entryId || undefined,
      recipient,
      stake: Number.isFinite(stake) ? stake : undefined,
      multiplier: Number.isFinite(multiplier) ? multiplier : undefined,
      mode: tickets <= 10 ? 'randomBuyer' : 'batch',
      // never include private key
    });
  } catch (e) {
    console.error('cashout error', e?.shortMessage || e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.shortMessage || e?.message || String(e),
    });
  }
};
