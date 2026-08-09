/**
 * Vercel Serverless Function — POST /api/cashout
 * Private key stays in process.env.HOUSE_PRIVATE_KEY only.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  return res.status(200).json({
    ok: true,
    message: 'API is live',
    hasKey: Boolean(process.env.HOUSE_PRIVATE_KEY),
  });
};
