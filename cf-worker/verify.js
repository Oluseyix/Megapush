/**
 * POST /api/verify — recompute crash point + optional settlement mult from revealed seed.
 *
 * Body:
 *   serverSeed          (required after reveal)
 *   serverSeedHash      (optional commit check)
 *   crashMult           (optional)
 *   flyStart            (optional, ms)
 *   cashoutAt           (optional, ms — server arrival time of cashout)
 *   expectedSettlementMult (optional)
 */

import { verifyRound, FAIR_SCHEME } from './crash-curve.js';

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

export async function handleVerify(request, env) {
  if (request.method === 'GET') {
    return json({
      ok: true,
      scheme: FAIR_SCHEME,
      method: 'POST',
      fields: ['serverSeed', 'serverSeedHash', 'crashMult'],
    });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, error: 'Use GET or POST' }, 405);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  if (!body.serverSeed) {
    return json({ ok: false, error: 'serverSeed required' }, 400);
  }

  const result = await verifyRound({
    serverSeed: body.serverSeed,
    serverSeedHash: body.serverSeedHash,
    crashMult: body.crashMult,
    cashoutAt: body.cashoutAt,
    flyStart: body.flyStart,
    expectedSettlementMult: body.expectedSettlementMult ?? body.settlementMult,
  });

  return json(result);
}
