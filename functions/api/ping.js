/** GET /api/ping — proves Functions are live (no secrets, no deps) */
export async function onRequest() {
  return new Response(
    JSON.stringify({
      ok: true,
      platform: 'cloudflare-pages',
      route: '/api/ping',
      ts: Date.now(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    },
  );
}
