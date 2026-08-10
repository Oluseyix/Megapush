/**
 * Shared hand timing — used by round.js (public curve) and RoundDO (lifecycle).
 */
import {
  CYCLE_MS,
  BET_MS,
  RESULT_MS,
  GROWTH_PER_MS,
  MAX_HANDS,
  FAIR_SCHEME,
  serverSeedForHand,
  crashFromSeed,
  multAtElapsed,
  roundMult,
  flightFromCrash,
  multOnCurve,
  settlementFromArrival,
  sha256Hex,
} from './crash-curve.js';

export {
  CYCLE_MS,
  BET_MS,
  RESULT_MS,
  GROWTH_PER_MS,
  MAX_HANDS,
  FAIR_SCHEME,
  multOnCurve,
  settlementFromArrival,
};

export function envGet(env, ...keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Min length for ROUND_SECRET — no house-key fallback, no weak default. */
export const ROUND_SECRET_MIN_LEN = 16;

/**
 * Required fairness secret. Returns '' if missing/too short.
 * Never falls back to HOUSE_PRIVATE_KEY or a public default.
 */
export function masterSecret(env) {
  const s = envGet(env, 'ROUND_SECRET');
  if (!s || s.length < ROUND_SECRET_MIN_LEN) return '';
  return s;
}

/** True only when a usable ROUND_SECRET is configured. */
export function hasRoundSecret(env) {
  return masterSecret(env).length >= ROUND_SECRET_MIN_LEN;
}

/** Closed-round payload when fairness secret is not configured. */
export function unconfiguredRoundState(nowMs = Date.now()) {
  return {
    ok: true,
    global: true,
    provablyFair: false,
    serverNow: nowMs,
    phase: 'intermission',
    acceptingBets: false,
    windowClosed: true,
    mult: 1,
    crashMult: null,
    serverSeedHash: null,
    serverSeed: null,
    roundId: null,
    kill: false,
    error: 'ROUND_SECRET not configured — betting closed',
    fair: {
      scheme: FAIR_SCHEME,
      commit: null,
      reveal: null,
      verify: 'POST /api/verify after seed is revealed',
    },
  };
}

/** Full hand timing including crash point. */
export async function handTiming(slotId, hand, handStart, slotEnd, secret) {
  const serverSeed = await serverSeedForHand(secret, slotId, hand);
  const serverSeedHash = await sha256Hex(serverSeed);
  let crashMult = crashFromSeed(serverSeed);
  let { flightMs, crashMult: capped } = flightFromCrash(crashMult);
  crashMult = capped;

  const remaining = slotEnd - handStart;
  // Full seed-derived flight must fit — never truncate crash mult (breaks /api/verify).
  const need = BET_MS + flightMs + RESULT_MS + 50;
  if (remaining < need) {
    return { fits: false, serverSeed, serverSeedHash, crashMult };
  }

  const flyStart = handStart + BET_MS;
  const crashAt = flyStart + flightMs;
  const resultEnd = crashAt + RESULT_MS;

  return {
    fits: true,
    serverSeed,
    serverSeedHash,
    crashMult,
    flightMs,
    handStart,
    flyStart,
    bettingEndsAt: flyStart,
    crashAt,
    resultEnd,
    handEnd: resultEnd,
  };
}

/**
 * Resolve live hand at nowMs (includes secrets — filter before public response).
 */
export async function resolveLiveHand(nowMs, secret) {
  const slotId = Math.floor(nowMs / CYCLE_MS);
  const slotStart = slotId * CYCLE_MS;
  const slotEnd = slotStart + CYCLE_MS;

  let handStart = slotStart;
  let hand = 0;
  let timing = null;

  while (hand < MAX_HANDS) {
    timing = await handTiming(slotId, hand, handStart, slotEnd, secret);
    if (!timing.fits) {
      return {
        ok: true,
        phase: 'intermission',
        acceptingBets: false,
        roundId: slotId * 1000 + hand,
        slotId,
        hand,
        mult: 1,
        timing: null,
        serverSeedHash: timing.serverSeedHash,
        serverSeed: null,
        crashMult: null,
        slotEnd,
        nextRoundStart: slotEnd,
        nextRoundId: (slotId + 1) * 1000,
      };
    }
    if (nowMs < timing.handEnd) break;
    handStart = timing.handEnd;
    hand += 1;
  }

  if (!timing || !timing.fits) {
    return {
      ok: true,
      phase: 'intermission',
      acceptingBets: false,
      roundId: slotId * 1000 + hand,
      slotId,
      hand,
      mult: 1,
      timing: null,
      serverSeedHash: null,
      serverSeed: null,
      crashMult: null,
      slotEnd,
      nextRoundStart: slotEnd,
      nextRoundId: (slotId + 1) * 1000,
    };
  }

  const { serverSeed, serverSeedHash, crashMult, flyStart, crashAt, resultEnd } = timing;
  const roundId = slotId * 1000 + hand;

  let phase;
  let mult;
  if (nowMs < flyStart) {
    phase = 'betting';
    mult = 1;
  } else if (nowMs < crashAt) {
    phase = 'flying';
    mult = multOnCurve(timing, nowMs);
  } else if (nowMs < resultEnd) {
    phase = 'crashed';
    mult = crashMult;
  } else {
    phase = 'intermission';
    mult = 1;
  }

  const nextProbe = await handTiming(slotId, hand + 1, resultEnd, slotEnd, secret);
  const nextRoundStart = nextProbe.fits ? resultEnd : slotEnd;
  const nextRoundId = nextProbe.fits ? roundId + 1 : (slotId + 1) * 1000;

  return {
    ok: true,
    phase,
    acceptingBets: phase === 'betting',
    roundId,
    slotId,
    hand,
    mult,
    timing,
    serverSeedHash,
    serverSeed,
    crashMult,
    flyStart,
    crashAt,
    resultEnd,
    handStart: timing.handStart,
    slotEnd,
    nextRoundStart,
    nextRoundId,
  };
}

export function capsFromEnv(env) {
  const maxRound = Number(env?.MAX_ROUND_EXPOSURE);
  const maxMult = Number(env?.MAX_PAYOUT_MULT);
  const maxEntry = Number(env?.MAX_PAYOUT_PER_ENTRY);
  return {
    maxRoundExposureUsdc: Number.isFinite(maxRound) && maxRound > 0 ? maxRound : 500,
    maxPayoutMult: Number.isFinite(maxMult) && maxMult > 0 ? maxMult : 50,
    maxPayoutPerEntryUsdc: Number.isFinite(maxEntry) && maxEntry > 0 ? maxEntry : 200,
  };
}

/** Potential USDC exposure for a stake before cashout. */
export function exposureForStake(stakeUsdc, env) {
  const stake = Number(stakeUsdc);
  if (!(stake > 0)) return 0;
  const { maxPayoutMult, maxPayoutPerEntryUsdc } = capsFromEnv(env);
  return Math.min(stake * maxPayoutMult, maxPayoutPerEntryUsdc);
}
