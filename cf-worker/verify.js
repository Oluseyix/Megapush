/**
 * POST /api/verify — recompute crash point + optional settlement mult from revealed seed.
 *
 * Body:
 *   serverSeed          (required after reveal)
 *   serverSeedHash      (optional commit check)
 *   crashMult           (optional)
 *   targetBlock         (optional — future-block entropy)
 *   blockHash           (optional — revealed Base block hash)
 *   chainPrevSeed       (optional — previous revealed seed for hash-chain link)
 *   chainHead           (optional — published chain head)
 *   chainIndex          (optional — index of this seed in the chain)
 *   flyStart            (optional, ms)
 *   cashoutAt           (optional, ms — server arrival time of cashout)
 *   expectedSettlementMult (optional)
 *
 * Response includes separate booleans: commitOk, blockOk, crashOk, chainOk
 */

import { verifyRound, FAIR_SCHEME, normalizeHex } from './crash-curve.js';
import { getBlockByNumber } from './base-rpc.js';

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
      fields: [
        'serverSeed',
        'serverSeedHash',
        'crashMult',
        'targetBlock',
        'blockHash',
        'chainPrevSeed',
        'chainHead',
        'chainIndex',
      ],
      checks: ['commitOk', 'blockOk', 'crashOk', 'chainOk'],
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
    blockHash: body.blockHash,
    targetBlock: body.targetBlock,
    chainPrevSeed: body.chainPrevSeed ?? body.prevServerSeed,
    chainHead: body.chainHead,
    chainIndex: body.chainIndex,
    cashoutAt: body.cashoutAt,
    flyStart: body.flyStart,
    expectedSettlementMult: body.expectedSettlementMult ?? body.settlementMult,
  });

  // RPC check: blockHash must match the real Base block at targetBlock
  let blockOk = result.blockOk;
  let onChainBlockHash = null;
  let blockCheckError = null;

  if (body.targetBlock != null && body.blockHash) {
    try {
      const blk = await getBlockByNumber(env, body.targetBlock);
      if (!blk?.hash) {
        blockOk = false;
        blockCheckError = 'targetBlock not found on Base RPC';
      } else {
        onChainBlockHash = blk.hash;
        blockOk = normalizeHex(blk.hash) === normalizeHex(body.blockHash);
        if (!blockOk) blockCheckError = 'blockHash does not match Base block at targetBlock';
      }
    } catch (e) {
      blockOk = false;
      blockCheckError = e?.message || 'RPC block check failed';
    }
  } else if (body.blockHash || body.targetBlock != null) {
    blockOk = false;
    blockCheckError = 'both targetBlock and blockHash required for block check';
  } else {
    blockOk = true;
  }

  const chainOk = result.chainOk; // null | boolean
  const commitOk = !!result.commitOk;
  const crashOk = !!result.crashOk;
  const settlementOk = result.settlementOk !== false;

  const ok =
    commitOk &&
    crashOk &&
    blockOk &&
    settlementOk &&
    (chainOk === null || chainOk === true);

  return json({
    ...result,
    ok,
    commitOk,
    blockOk,
    crashOk,
    chainOk,
    settlementOk,
    onChainBlockHash,
    blockCheckError,
    scheme: FAIR_SCHEME,
  });
}
