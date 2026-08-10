/**
 * GET /api/health — Cloudflare Pages Function (native ESM)
 */
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { json, corsOptions, envGet } from '../_lib/json.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === 'OPTIONS') return corsOptions('GET, POST, OPTIONS');
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ ok: false, error: 'Use GET' }, 405);
  }

  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  const hasKey = Boolean(key);
  let house = null;
  let houseUsdc = null;
  let error = null;

  if (hasKey) {
    try {
      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      house = account.address;
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
      error = e?.shortMessage || e?.message || String(e);
    }
  }

  const expectedTreasury = '0x804BEb025844c189b72C8D810a1A7776043677FF';
  const treasuryMatch = house && house.toLowerCase() === expectedTreasury.toLowerCase();

  return json(
    {
      ok: hasKey && !error,
      platform: 'cloudflare-pages',
      hasHousePrivateKey: hasKey,
      house,
      houseUsdc,
      expectedTreasury,
      treasuryMatch: hasKey ? treasuryMatch : null,
      chain: 'baseSepolia',
      error: error || (!hasKey ? 'HOUSE_PRIVATE_KEY missing in Cloudflare env (Secret)' : null),
      hint: !hasKey
        ? 'Pages → Settings → Environment variables → HOUSE_PRIVATE_KEY as Secret (Production) → Redeploy'
        : treasuryMatch === false
          ? 'Key address does not match HOUSE_TREASURY'
          : null,
    },
    hasKey ? 200 : 503,
  );
}
