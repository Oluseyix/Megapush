/**
 * GET /api/health — does not expose secrets.
 * Reports whether the house key is present and which address it controls.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }

  const key = (process.env.HOUSE_PRIVATE_KEY || process.env.HOUSE_KEY || '').trim();
  const hasKey = Boolean(key);

  let house = null;
  let houseUsdc = null;
  let error = null;

  if (hasKey) {
    try {
      const { createPublicClient, http, parseAbi, formatUnits } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { baseSepolia } = await import('viem/chains');

      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      house = account.address;

      const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(process.env.RPC_URL || 'https://sepolia.base.org'),
      });
      const bal = await publicClient.readContract({
        address: USDC,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [house],
      });
      houseUsdc = formatUnits(bal, 6);
    } catch (e) {
      error = e?.shortMessage || e?.message || String(e);
    }
  }

  const expectedTreasury = '0x804BEb025844c189b72C8D810a1A7776043677FF';
  const treasuryMatch =
    house && house.toLowerCase() === expectedTreasury.toLowerCase();

  return res.status(hasKey ? 200 : 503).json({
    ok: hasKey && !error,
    hasHousePrivateKey: hasKey,
    house,
    houseUsdc,
    expectedTreasury,
    treasuryMatch: hasKey ? treasuryMatch : null,
    chain: 'baseSepolia',
    error: error || (!hasKey ? 'HOUSE_PRIVATE_KEY missing in Vercel env' : null),
    hint: !hasKey
      ? 'Vercel → Project Settings → Environment Variables → add HOUSE_PRIVATE_KEY for Production (and Preview) → Redeploy'
      : treasuryMatch === false
        ? 'Key address does not match HOUSE_TREASURY — stakes go to treasury but buys use the key wallet'
        : null,
  });
};
