/**
 * Public health — no secrets, balances, wallet addresses, or binding inventory.
 */
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

export async function handleHealth(_request, env) {
  const paused =
    String(env?.KILL_SWITCH || '')
      .trim()
      .toLowerCase() === '1' ||
    String(env?.KILL_SWITCH || '')
      .trim()
      .toLowerCase() === 'true';

  return json({
    ok: !paused,
    status: paused ? 'paused' : 'up',
    chain: 'baseSepolia',
  });
}
