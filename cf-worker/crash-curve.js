/**
 * Shared crash curve + commit-reveal helpers (one global TV per round).
 *
 * Crash point: Bustabit-style from SHA-256(serverSeed) first 52 bits.
 * Live mult: exp(GROWTH_PER_MS * elapsed) capped at crash point.
 * Settlement mult: same curve at server cashout-arrival timestamp.
 */

export const CYCLE_MS = 72_000;
export const BET_MS = 5_000; // betting window before rocket leaves
export const RESULT_MS = 2_800;
export const GROWTH_PER_MS = 0.00018;
export const MAX_FLIGHT_MS = 55_000;
export const MAX_HANDS = 24;
export const MAX_CRASH_MULT = 10_000;
/** Instant bust probability ≈ 1/33 (~3% house edge flavor) */
export const INSTANT_BUST_MOD = 33;

export const FAIR_SCHEME =
  'commit-reveal + Bustabit-style crash from SHA-256(serverSeed); settlement mult = same curve at cashout arrival time';

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic seed for a hand (history reconstructable offline with ROUND_SECRET).
 * Production can overlay random seeds in KV later without changing the curve.
 */
export async function serverSeedForHand(masterSecret, slotId, hand) {
  return sha256Hex(`${masterSecret}:megapush:v2:slot:${slotId}:hand:${hand}`);
}

export function crashFromSeed(serverSeedHex) {
  const h = String(serverSeedHex).replace(/^0x/, '').toLowerCase();
  const n = parseInt(h.slice(0, 13), 16);
  if (!Number.isFinite(n)) return 1.01;
  const e = 2 ** 52;
  if (n % INSTANT_BUST_MOD === 0) return 1.0;
  const raw = Math.floor((100 * e - n) / (e - n)) / 100;
  return Math.min(MAX_CRASH_MULT, Math.max(1, Math.round(raw * 100) / 100));
}

export function multAtElapsed(flyElapsedMs) {
  if (!(flyElapsedMs > 0)) return 1;
  return Math.exp(GROWTH_PER_MS * flyElapsedMs);
}

export function elapsedForMult(mult) {
  if (!(mult > 1)) return 0;
  return Math.log(mult) / GROWTH_PER_MS;
}

export function roundMult(m) {
  return Math.round(Number(m) * 100) / 100;
}

/** Build flight length + final crash mult after MAX_FLIGHT_MS cap. */
export function flightFromCrash(crashMult) {
  let flightMs = elapsedForMult(crashMult);
  let finalCrash = crashMult;
  if (flightMs > MAX_FLIGHT_MS) {
    flightMs = MAX_FLIGHT_MS;
    finalCrash = roundMult(multAtElapsed(flightMs));
  }
  if (finalCrash < 1) finalCrash = 1;
  return { flightMs, crashMult: finalCrash };
}

/**
 * Mult on the shared curve at absolute time `atMs`.
 */
export function multOnCurve(timing, atMs) {
  const { flyStart, crashAt, crashMult } = timing;
  if (atMs < flyStart) return 1;
  if (atMs >= crashAt) return crashMult;
  const m = multAtElapsed(atMs - flyStart);
  return roundMult(Math.min(m, crashMult));
}

/**
 * Settlement for a cashout intent that arrived at `arrivalMs` (server clock).
 * Same curve as the TV — only differs by arrival latency.
 */
export function settlementFromArrival(timing, arrivalMs) {
  if (!timing || timing.flyStart == null || timing.crashAt == null) {
    return { ok: false, error: 'Invalid timing', lost: true, mult: 0 };
  }
  if (arrivalMs < timing.flyStart) {
    return {
      ok: false,
      error: 'Cashout before round flight (still in betting window)',
      lost: true,
      mult: 0,
      phase: 'betting',
    };
  }
  if (arrivalMs >= timing.crashAt) {
    return {
      ok: true,
      lost: true,
      mult: 0,
      crashMult: timing.crashMult,
      phase: 'crashed',
      arrivalMs,
      flyStart: timing.flyStart,
      crashAt: timing.crashAt,
    };
  }
  const mult = multOnCurve(timing, arrivalMs);
  return {
    ok: true,
    lost: false,
    mult,
    crashMult: timing.crashMult,
    phase: 'flying',
    arrivalMs,
    flyStart: timing.flyStart,
    crashAt: timing.crashAt,
    elapsedMs: arrivalMs - timing.flyStart,
  };
}

/**
 * Verify a revealed seed matches commit and crash point; optional settlement check.
 */
export async function verifyRound({
  serverSeed,
  serverSeedHash,
  crashMult,
  cashoutAt,
  flyStart,
  expectedSettlementMult,
}) {
  if (serverSeed == null || String(serverSeed).length < 8) {
    return { ok: false, error: 'Invalid serverSeed' };
  }
  const hash = await sha256Hex(serverSeed);
  const providedHash = serverSeedHash
    ? String(serverSeedHash).replace(/^0x/, '').toLowerCase()
    : null;
  const commitOk = !providedHash || hash === providedHash;
  const computedCrash = crashFromSeed(serverSeed);
  const { flightMs, crashMult: cappedCrash } = flightFromCrash(computedCrash);
  const crashOk =
    crashMult == null ||
    Math.abs(cappedCrash - Number(crashMult)) < 0.015 ||
    Math.abs(computedCrash - Number(crashMult)) < 0.015;

  let settlement = null;
  let settlementOk = true;
  if (cashoutAt != null && flyStart != null) {
    const timing = {
      flyStart: Number(flyStart),
      crashAt: Number(flyStart) + flightMs,
      crashMult: cappedCrash,
    };
    settlement = settlementFromArrival(timing, Number(cashoutAt));
    if (expectedSettlementMult != null && settlement.ok && !settlement.lost) {
      settlementOk =
        Math.abs(settlement.mult - Number(expectedSettlementMult)) < 0.02;
    }
  }

  return {
    ok: commitOk && crashOk && settlementOk,
    scheme: FAIR_SCHEME,
    commitOk,
    crashOk,
    settlementOk,
    computedHash: hash,
    computedCrashMult: cappedCrash,
    uncappedCrashMult: computedCrash,
    providedCrashMult: crashMult != null ? Number(crashMult) : null,
    flightMs,
    settlement,
  };
}
