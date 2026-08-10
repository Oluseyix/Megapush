import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
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

export async function handleHealth(request, env) {
  const key = envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
  const hasKey = Boolean(key);
  const expectedTreasury = '0x804BEb025844c189b72C8D810a1A7776043677FF';
  let house = null;
  let houseUsdc = null;
  let error = null;
  let treasuryMatch = null;

  if (hasKey) {
    try {
      const pk = key.startsWith('0x') ? key : `0x${key}`;
      const account = privateKeyToAccount(/** @type {`0x${string}`} */ (pk));
      house = account.address;
      treasuryMatch = house.toLowerCase() === expectedTreasury.toLowerCase();
      const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(envGet(env, 'RPC_URL') || 'https://sepolia.base.org'),
      });
      const bal = await publicClient.readContract({
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [house],
      });
      houseUsdc = formatUnits(bal, 6);
    } catch (e) {
      error = e?.shortMessage || e?.message || String(e);
      try {
        if (!house) {
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
      platform: 'cloudflare-pages-worker',
      route: '/api/health',
      hasHousePrivateKey: hasKey,
      house,
      houseUsdc,
      expectedTreasury,
      treasuryMatch,
      chain: 'baseSepolia',
      error: error || (!hasKey ? 'HOUSE_PRIVATE_KEY missing' : null),
      hint: !hasKey
        ? 'Pages → Settings → Variables and Secrets → HOUSE_PRIVATE_KEY (Encrypt) → Redeploy'
        : null,
    },
    hasKey ? 200 : 503,
  );
}
