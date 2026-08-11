/**
 * Shared hand timing constants + secret helpers.
 * Live hand lifecycle with future-block entropy lives in RoundDO (not pure time+secret).
 */
import {
  CYCLE_MS,
  BET_MS,
  RESULT_MS,
  GROWTH_PER_MS,
  MAX_HANDS,
  FAIR_SCHEME,
  TARGET_BLOCK_OFFSET,
  ENTROPY_WAIT_MAX_MS,
  serverSeedForHand,
  crashFromSeed,
  crashFromSeedAndBlock,
  multAtElapsed,
  roundMult,
  flightFromCrash,
  multOnCurve,
  settlementFromArrival,
  settlementFromIntent,
  CASHOUT_GRACE_MS,
  sha256Hex,
} from './crash-curve.js';

export {
  CYCLE_MS,
  BET_MS,
  RESULT_MS,
  GROWTH_PER_MS,
  MAX_HANDS,
  FAIR_SCHEME,
  TARGET_BLOCK_OFFSET,
  ENTROPY_WAIT_MAX_MS,
  multOnCurve,
  settlementFromArrival,
  settlementFromIntent,
  CASHOUT_GRACE_MS,
  serverSeedForHand,
  crashFromSeed,
  crashFromSeedAndBlock,
  flightFromCrash,
  sha256Hex,
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
    targetBlock: null,
    blockHash: null,
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

/**
 * Build timing object for settlement from a RoundDO hand snapshot.
 */
export function timingFromHand(hand) {
  if (!hand) return null;
  return {
    handStart: hand.handStart,
    flyStart: hand.flyStart,
    bettingEndsAt: hand.bettingEndsAt ?? hand.flyStart,
    crashAt: hand.crashAt,
    resultEnd: hand.resultEnd,
    crashMult: hand.crashMult,
    flightMs: hand.flightMs,
    serverSeed: hand.serverSeed,
    serverSeedHash: hand.serverSeedHash,
    targetBlock: hand.targetBlock,
    blockHash: hand.blockHash,
    voided: !!hand.voided,
  };
}
