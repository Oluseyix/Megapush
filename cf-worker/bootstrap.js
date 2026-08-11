/**
 * One-time bootstrap: copy HOUSE_PRIVATE_KEY into BANK_KV so Worker can cash out
 * when the secret was only set on Pages.
 *
 * POST /api/bootstrap/house
 * Headers: X-Bootstrap-Token: <BOOTSTRAP_TOKEN>
 * Body: { "housePrivateKey": "0x…" }
 *
 * After success, remove BOOTSTRAP_TOKEN and the temporary Pages sync function.
 */
import { storeHousePrivateKey, resolveHousePrivateKey, envGet } from './house-tx.js';
// envGet is exported from house-tx

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

export async function handleBootstrap(request, env) {
  if (request.method === 'GET') {
    const hasEnv = !!envGet(env, 'HOUSE_PRIVATE_KEY', 'HOUSE_KEY');
    let hasKv = false;
    let house = null;
    try {
      const k = await resolveHousePrivateKey(env);
      hasKv = !!k;
      if (k) {
        const { privateKeyToAccount } = await import('viem/accounts');
        const pk = k.startsWith('0x') ? k : `0x${k}`;
        house = privateKeyToAccount(/** @type {`0x${string}`} */ (pk)).address;
      }
    } catch (_) {}
    return json({
      ok: true,
      houseKeyConfigured: hasEnv || hasKv,
      fromEnv: hasEnv,
      fromKv: hasKv && !hasEnv,
      house,
      bootstrapOpen: !!envGet(env, 'BOOTSTRAP_TOKEN'),
    });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Use GET or POST' }, 405);
  }

  const expected = envGet(env, 'BOOTSTRAP_TOKEN');
  if (!expected || expected.length < 16) {
    return json({ ok: false, error: 'Bootstrap closed' }, 403);
  }

  const hdr =
    request.headers.get('X-Bootstrap-Token') ||
    request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ||
    '';
  if (hdr !== expected) {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const key = body.housePrivateKey || body.HOUSE_PRIVATE_KEY || body.key;
  if (!key) {
    return json({ ok: false, error: 'housePrivateKey required' }, 400);
  }

  try {
    const house = await storeHousePrivateKey(env, key);
    return json({ ok: true, stored: true, house });
  } catch (e) {
    return json({ ok: false, error: e?.message || 'Store failed' }, 400);
  }
}
