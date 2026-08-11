/**
 * Provably fair global rounds — one synchronized TV curve.
 * Live authority: RoundDO (future Base block entropy + exposure).
 */

import {
  CYCLE_MS,
  BET_MS,
  RESULT_MS,
  GROWTH_PER_MS,
  FAIR_SCHEME,
  masterSecret,
  hasRoundSecret,
  unconfiguredRoundState,
  TARGET_BLOCK_OFFSET,
} from './hand-timing.js';
import { roundStub, doFetch } from './dos/client.js';

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

export { masterSecret, hasRoundSecret };

/**
 * Settlement via RoundDO (block-hash crash + client-intent grace).
 * @param {object} env
 * @param {number|object} [arrivalOrOpts] legacy arrivalMs number, or opts bag
 * @param {number} [arrivalOrOpts.arrivalMs]
 * @param {number} [arrivalOrOpts.clientCashoutAt]
 * @param {number} [arrivalOrOpts.claimedMult]
 * @param {number} [arrivalOrOpts.roundId]
 */
export async function settleCashoutAt(env, arrivalOrOpts = Date.now()) {
  if (!hasRoundSecret(env)) {
    return {
      ok: false,
      error: 'ROUND_SECRET not configured — cashout closed',
      phase: 'intermission',
    };
  }
  if (!env?.ROUND_DO) {
    return {
      ok: false,
      error: 'RoundDO binding missing',
      phase: 'intermission',
    };
  }
  const opts =
    arrivalOrOpts != null && typeof arrivalOrOpts === 'object'
      ? arrivalOrOpts
      : { arrivalMs: arrivalOrOpts };
  const out = await doFetch(roundStub(env), '/settlement', {
    method: 'POST',
    body: JSON.stringify({
      arrivalMs: opts.arrivalMs != null ? Number(opts.arrivalMs) : Date.now(),
      clientCashoutAt:
        opts.clientCashoutAt != null ? Number(opts.clientCashoutAt) : undefined,
      claimedMult: opts.claimedMult != null ? Number(opts.claimedMult) : undefined,
      roundId: opts.roundId != null ? Number(opts.roundId) : undefined,
    }),
  });
  if (!out || out.missingBinding) {
    return { ok: false, error: 'RoundDO unavailable', phase: 'intermission' };
  }
  return out;
}

/**
 * Public live state from RoundDO.
 */
export async function getLiveRound(env) {
  if (!hasRoundSecret(env)) {
    return unconfiguredRoundState(Date.now());
  }
  if (!env?.ROUND_DO) {
    return {
      ...unconfiguredRoundState(Date.now()),
      error: 'RoundDO binding missing',
    };
  }
  const live = await doFetch(roundStub(env), '/live');
  if (!live?.ok) {
    return {
      ok: false,
      global: true,
      serverNow: Date.now(),
      phase: 'intermission',
      acceptingBets: false,
      mult: 1,
      error: live?.error || 'RoundDO error',
    };
  }
  return live;
}

export async function handleRound(request, env) {
  const url = new URL(request.url);
  const histQ = url.searchParams.get('history');
  const chainQ = url.searchParams.get('chain');

  // Public chain status (no secrets in response) — works even if betting is closed
  if (chainQ === '1' || chainQ === 'true') {
    if (!env?.ROUND_DO) {
      return json({
        ok: true,
        serverNow: Date.now(),
        chainReady: false,
        chainHead: null,
        chainAnchorTx: null,
        error: 'RoundDO binding missing',
      });
    }
    const chain = await doFetch(roundStub(env), '/chain');
    return json(
      chain?.ok
        ? chain
        : {
            ok: true,
            serverNow: Date.now(),
            chainReady: false,
            chainHead: null,
            chainAnchorTx: null,
            error: chain?.error || 'chain not initialized yet',
          },
    );
  }

  if (!hasRoundSecret(env)) {
    if (histQ != null && histQ !== '0' && histQ !== 'false') {
      return json({
        ok: true,
        serverNow: Date.now(),
        count: 0,
        rounds: [],
        error: 'ROUND_SECRET not configured',
      });
    }
    return json(unconfiguredRoundState(Date.now()));
  }

  if (histQ != null && histQ !== '0' && histQ !== 'false') {
    const limit = histQ === '1' || histQ === 'true' ? 20 : Number(histQ);
    if (!env?.ROUND_DO) {
      return json({ ok: true, serverNow: Date.now(), count: 0, rounds: [] });
    }
    const hist = await doFetch(
      roundStub(env),
      `/history?limit=${encodeURIComponent(String(limit || 20))}`,
    );
    if (hist?.ok && Array.isArray(hist.rounds)) {
      return json(hist);
    }
    return json({
      ok: true,
      serverNow: Date.now(),
      count: 0,
      rounds: [],
      error: hist?.error || 'history unavailable',
    });
  }

  const live = await getLiveRound(env);
  // Annotate constants for clients
  if (live && live.ok !== false) {
    live.betMs = live.betMs ?? BET_MS;
    live.resultMs = live.resultMs ?? RESULT_MS;
    live.growthPerMs = live.growthPerMs ?? GROWTH_PER_MS;
    live.cycleMs = live.cycleMs ?? CYCLE_MS;
    live.targetBlockOffset = live.targetBlockOffset ?? TARGET_BLOCK_OFFSET;
    live.fair = live.fair || {
      scheme: FAIR_SCHEME,
      commit: live.serverSeedHash,
      targetBlock: live.targetBlock,
      chainHead: live.chainHead,
      chainAnchorTx: live.chainAnchorTx,
    };
  }
  return json(live);
}
