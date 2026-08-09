/**
 * POST /api/refund — house returns stake USDC to player (cancel or failed cash-out).
 * Private key: process.env.HOUSE_PRIVATE_KEY only.
 *
 * Body: { entryId, stake, player }
 * entryId must start with player address (set at stake time).
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

  const player = body.player;
  const entryId = body.entryId != null ? String(body.entryId) : '';
  const stake = Number(body.stake);

  if (!player || !/^0x[a-fA-F0-9]{40}$/.test(player)) {
    return res.status(400).json({ ok: false, error: 'Valid player address required' });
  }
  if (!entryId) {
    return res.status(400).json({ ok: false, error: 'entryId required' });
  }
  // Stake entryIds are `${player.toLowerCase()}-${index}-${ts}`
  if (!entryId.toLowerCase().startsWith(player.toLowerCase())) {
    return res.status(403).json({ ok: false, error: 'entryId does not match player' });
  }
  if (!Number.isFinite(stake) || stake <= 0) {
    return res.status(400).json({ ok: false, error: 'Invalid stake amount' });
  }

  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

  try {
    const {
      createPublicClient,
      createWalletClient,
      http,
      parseAbi,
      parseUnits,
      formatUnits,
    } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { baseSepolia } = await import('viem/chains');

    const RPC = process.env.RPC_URL || 'https://sepolia.base.org';
    const pk = key.startsWith('0x') ? key : `0x${key}`;
    const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
    const house = account.address;

    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(RPC),
    });
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(RPC),
    });

    const usdcAbi = parseAbi([
      'function balanceOf(address account) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
    ]);

    const raw = parseUnits(String(stake), 6);
    const bal = await publicClient.readContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'balanceOf',
      args: [house],
    });
    if (bal < raw) {
      return res.status(400).json({
        ok: false,
        error: `House USDC low for refund: have ${formatUnits(bal, 6)}, need ${formatUnits(raw, 6)}`,
      });
    }

    const nonce = await publicClient.getTransactionCount({
      address: house,
      blockTag: 'pending',
    });

    const hash = await walletClient.writeContract({
      address: USDC,
      abi: usdcAbi,
      functionName: 'transfer',
      args: [/** @type {`0x${string}`} */ (player), raw],
      account,
      chain: baseSepolia,
      nonce,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Refund transfer reverted: ${hash}`);
    }
    await sleep(400);

    return res.status(200).json({
      ok: true,
      tx: hash,
      refunded: stake,
      player,
      entryId,
      house,
    });
  } catch (e) {
    console.error('refund error', e?.shortMessage || e?.message || e);
    return res.status(500).json({
      ok: false,
      error: e?.shortMessage || e?.message || String(e),
    });
  }
};
