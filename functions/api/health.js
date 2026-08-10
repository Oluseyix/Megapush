/** Legacy Pages Functions path — minimal public health. */
export async function onRequest() {
  return new Response(JSON.stringify({ ok: true, status: 'up', chain: 'baseSepolia' }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
