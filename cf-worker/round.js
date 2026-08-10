/**
 * Provably fair global rounds — one synchronized TV curve.
 * Public /api/round merges RoundDO lifecycle (exposure, window) when available.
 */

import {
  CYCLE_MS,
  BET_MS,
  RESULT_MS,
  GROWTH_PER_MS,
  MAX_HANDS,
  FAIR_SCHEME,
  handTiming,
  resolveLiveHand,
  masterSecret,
  hasRoundSecret,
  unconfiguredRoundState,
  settlementFromArrival,
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

export { handTiming, masterSecret, hasRoundSecret };

/**
 * Resolve public or settlement state at nowMs.
 * @param {{ revealSecrets?: boolean }} opts
 */
export async function getRoundStateSafe(nowMs, secret, opts = {}) {
  const revealSecrets = !!opts.revealSecrets;
  const live = await resolveLiveHand(nowMs, secret);

  if (!live.timing) {
    return {
      ok: true,
      global: true,
      provablyFair: true,
      serverNow: nowMs,
      roundId: live.roundId,
      slotId: live.slotId,
      hand: live.hand,
      phase: live.phase,
      acceptingBets: false,
      mult: 1,
      crashMult: null,
      serverSeedHash: live.serverSeedHash,
      serverSeed: null,
      fair: {
        scheme: FAIR_SCHEME,
        commit: live.serverSeedHash,
        reveal: null,
        verify: 'POST /api/verify after reveal',
      },
      roundStart: null,
      bettingEndsAt: null,
      flyStart: null,
      crashAt: null,
      resultEnd: null,
      cycleEnd: live.slotEnd,
      slotEnd: live.slotEnd,
      nextRoundId: live.nextRoundId,
      nextRoundStart: live.nextRoundStart,
      growthPerMs: GROWTH_PER_MS,
      cycleMs: CYCLE_MS,
      betMs: BET_MS,
      resultMs: RESULT_MS,
    };
  }

  const timing = live.timing;
  const phase = live.phase;
  const revealed = phase === 'crashed' || phase === 'intermission';
  const showCrash = revealed || revealSecrets;
  const showSeed = revealed;

  const base = {
    ok: true,
    global: true,
    provablyFair: true,
    serverNow: nowMs,
    roundId: live.roundId,
    slotId: live.slotId,
    hand: live.hand,
    phase,
    acceptingBets: phase === 'betting',
    mult: live.mult,
    serverSeedHash: live.serverSeedHash,
    crashMult: showCrash ? live.crashMult : null,
    serverSeed: showSeed ? live.serverSeed : null,
    fair: {
      scheme: FAIR_SCHEME,
      commit: live.serverSeedHash,
      reveal: showSeed ? live.serverSeed : null,
      verify: showSeed
        ? 'POST /api/verify { serverSeed, serverSeedHash, crashMult }'
        : 'Seed revealed after crash; commit published during betting',
    },
    roundStart: timing.handStart,
    bettingEndsAt: timing.flyStart,
    flyStart: timing.flyStart,
    crashAt: showCrash ? timing.crashAt : null,
    resultEnd: revealed || revealSecrets ? timing.resultEnd : null,
    cycleEnd: live.nextRoundStart,
    slotEnd: live.slotEnd,
    nextRoundId: live.nextRoundId,
    nextRoundStart: live.nextRoundStart,
    growthPerMs: GROWTH_PER_MS,
    cycleMs: CYCLE_MS,
    betMs: BET_MS,
    resultMs: RESULT_MS,
    _timing: revealSecrets ? timing : undefined,
  };

  if ((phase === 'flying' || phase === 'betting') && !revealSecrets) {
    return {
      ...base,
      crashAt: null,
      crashMult: null,
      serverSeed: null,
      resultEnd: phase === 'flying' ? null : base.resultEnd,
      _timing: undefined,
    };
  }
  return base;
}

export async function settleCashoutAt(env, arrivalMs = Date.now()) {
  if (!hasRoundSecret(env)) {
    return {
      ok: false,
      error: 'ROUND_SECRET not configured — cashout closed',
      phase: 'intermission',
    };
  }
  const secret = masterSecret(env);
  const state = await getRoundStateSafe(arrivalMs, secret, { revealSecrets: true });
  if (!state._timing) {
    return {
      ok: false,
      error: 'No active hand timing',
      phase: state.phase,
      roundId: state.roundId,
    };
  }
  const settlement = settlementFromArrival(state._timing, arrivalMs);
  return {
    ...settlement,
    roundId: state.roundId,
    slotId: state.slotId,
    hand: state.hand,
    serverSeedHash: state.serverSeedHash,
    serverSeed:
      state.phase === 'crashed' || state.phase === 'intermission' ? state.serverSeed : null,
    serverNow: arrivalMs,
    acceptingBets: state.acceptingBets,
  };
}

async function getRoundHistory(nowMs, secret, limit = 20) {
  const max = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
  const out = [];
  let slotId = Math.floor(nowMs / CYCLE_MS);

  for (let s = 0; s < 40 && out.length < max; s++) {
    const sid = slotId - s;
    if (sid < 0) break;
    const slotStart = sid * CYCLE_MS;
    const slotEnd = slotStart + CYCLE_MS;
    let handStart = slotStart;
    const completed = [];

    for (let hand = 0; hand < MAX_HANDS; hand++) {
      const timing = await handTiming(sid, hand, handStart, slotEnd, secret);
      if (!timing.fits) break;
      if (timing.crashAt != null && timing.crashAt <= nowMs) {
        completed.push({
          roundId: sid * 1000 + hand,
          slotId: sid,
          hand,
          crashMult: timing.crashMult,
          crashAt: timing.crashAt,
          flyStart: timing.flyStart,
          bettingEndsAt: timing.flyStart,
          serverSeedHash: timing.serverSeedHash,
          serverSeed: timing.serverSeed,
        });
      }
      handStart = timing.handEnd;
      if (handStart >= slotEnd) break;
    }

    for (let i = completed.length - 1; i >= 0 && out.length < max; i--) {
      out.push(completed[i]);
    }
  }

  return out;
}

/** Merge RoundDO lifecycle fields into public round payload. */
async function mergeRoundDo(env, publicState) {
  if (!env?.ROUND_DO) return publicState;
  const doState = await doFetch(roundStub(env), '/state');
  if (!doState?.ok) {
    return publicState;
  }

  // DO is authority for acceptingBets when kill or windowClosed
  const acceptingBets =
    publicState.phase === 'betting' &&
    !doState.windowClosed &&
    !doState.kill &&
    doState.acceptingBets !== false;

  return {
    ...publicState,
    acceptingBets,
    windowClosed: !!doState.windowClosed || publicState.phase !== 'betting',
    kill: !!doState.kill,
    exposureUsdc: doState.exposureUsdc,
    remainingExposureUsdc: doState.remainingExposureUsdc,
    maxRoundExposureUsdc: doState.maxRoundExposureUsdc,
    maxPayoutMult: doState.maxPayoutMult,
    maxPayoutPerEntryUsdc: doState.maxPayoutPerEntryUsdc,
    stakeCount: doState.stakeCount,
  };
}

export async function handleRound(request, env) {
  const url = new URL(request.url);
  const histQ = url.searchParams.get('history');

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

  const secret = masterSecret(env);
  if (histQ != null && histQ !== '0' && histQ !== 'false') {
    const limit = histQ === '1' || histQ === 'true' ? 20 : Number(histQ);
    const now = Date.now();
    const rounds = await getRoundHistory(now, secret, limit);
    return json({
      ok: true,
      serverNow: now,
      count: rounds.length,
      rounds,
    });
  }
  const state = await getRoundStateSafe(Date.now(), secret, { revealSecrets: false });
  const { _timing, ...publicState } = state;
  const merged = await mergeRoundDo(env, publicState);
  return json(merged);
}
