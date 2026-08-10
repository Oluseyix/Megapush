/**
 * GET /api/health — zero-dependency so routing always works even if viem fails to bundle.
 * Optional balance check uses dynamic import when HOUSE_PRIVATE_KEY is set.
 */
import { json, corsOptions, envGet } from '../_lib/json.js';

export async function onRequestGet(context) {
  return handle(context);
}

export async function onRequestPost(context) {
  return handle(context);
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return corsOptions('GET, POST, OPTIONS');
  if (context.request.method !== 'GET' && context.request.method !== 'POST') {
    return json({ ok: false, error: 'Use GET' }, 405);
  }
  return handle(context);
}

async function handle(context) {
  const { env } = context;
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  const hasKey = Boolean(key);
  const expectedTreasury = '0x804BEb025844c189b72C8D810a1A7776043677FF';

  let house = null;
  let houseUsdc = null;
  let error = null;
  let treasuryMatch = null;

  if (hasKey) {
    try {
      const { createPublicClient, http, parseAbi, formatUnits } = await import('viem');
      const { privateKeyToAccount } = await import('viem/accounts');
      const { baseSepolia } = await import('viem/chains');

      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      house = account.address;
      treasuryMatch = house.toLowerCase() === expectedTreasury.toLowerCase();

      const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(envGet(env, 'RPC_URL') || 'https://sepolia.base.org'),
      });
      const bal = await publicClient.readContract({
        address: USDC,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [house],
      });
      houseUsdc = formatUnits(bal, 6);
    } catch (e) {
      // Key present but viem/RPC failed — still report hasKey
      error = e?.shortMessage || e?.message || String(e);
      try {
        // Derive address without RPC if possible
        if (!house && key) {
          const { privateKeyToAccount } = await import('viem/accounts');
          const pk = key.startsWith('0x') ? key : `0x${key}`;
          house = privateKeyToAccount(/** @type {`0x${string}`} */ (pk)).address;
          treasuryMatch = house.toLowerCase() === expectedTreasury.toLowerCase();
        }
      } catch (_) {}
    }
  }

  return json(
    {
      ok: hasKey && !error,
      platform: 'cloudflare-pages',
      route: '/api/health',
      hasHousePrivateKey: hasKey,
      house,
      houseUsdc,
      expectedTreasury,
      treasuryMatch,
      chain: 'baseSepolia',
      error: error || (!hasKey ? 'HOUSE_PRIVATE_KEY missing (add as Secret, then redeploy)' : null),
      hint: !hasKey
        ? 'Pages → Settings → Variables → HOUSE_PRIVATE_KEY as Encrypted/Secret → Redeploy. Root directory must be repo root (not public).'
        : null,
    },
    hasKey ? 200 : 503,
  );
}
