/** Legacy Vercel path — minimal public health. Prefer Cloudflare Worker. */
export default function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, status: 'up', chain: 'baseSepolia' });
}
