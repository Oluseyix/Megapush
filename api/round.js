/**
 * GET /api/round — global synchronized crash round.
 * Same mult everywhere at the same wall-clock time (UTC).
 *
 * Deterministic: roundId = floor(serverNow / CYCLE_MS)
 * Crash point derived from ROUND_SECRET + roundId (not Math.random per client).
 */

const CYCLE_MS = 18_000;
const BET_MS = 3_200;
const RESULT_MS = 2_800;
const GROWTH_PER_MS = 0.000072; // mult = exp(GROWTH * flyElapsedMs)

function sleep() {
  /* no-op helper placeholder */
}

function hashRound(secret, roundId) {
  // FNV-1a 32-bit
  const s = String(secret) + ':' + String(roundId);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296; // [0,1)
}

/** Same distribution as the old client game */
function crashMultForRound(roundId, secret) {
  const r = hashRound(secret, roundId);
  let m;
  if (r < 0.55) m = 1.01 + (r / 0.55) * 3.5;
  else if (r < 0.85) m = 4 + ((r - 0.55) / 0.3) * 8;
  else m = Math.min(80, 8 + ((r - 0.85) / 0.15) * 40);
  return Math.round(m * 100) / 100;
}

function multAtElapsed(flyElapsedMs) {
  if (flyElapsedMs <= 0) return 1;
  return Math.exp(GROWTH_PER_MS * flyElapsedMs);
}

function elapsedForMult(mult) {
  if (!(mult > 1)) return 0;
  return Math.log(mult) / GROWTH_PER_MS;
}

function getRoundState(nowMs, secret) {
  const roundId = Math.floor(nowMs / CYCLE_MS);
  const roundStart = roundId * CYCLE_MS;
  const elapsed = nowMs - roundStart;

  const maxFlightMs = CYCLE_MS - BET_MS - RESULT_MS;
  let crashMult = crashMultForRound(roundId, secret);
  let flightMs = elapsedForMult(crashMult);
  if (flightMs > maxFlightMs) {
    flightMs = maxFlightMs;
    crashMult = Math.round(multAtElapsed(flightMs) * 100) / 100;
  }

  const flyStart = roundStart + BET_MS;
  const crashAt = flyStart + flightMs;
  const cycleEnd = roundStart + CYCLE_MS;

  let phase;
  let mult;
  if (elapsed < BET_MS) {
    phase = 'betting';
    mult = 1;
  } else if (nowMs < crashAt) {
    phase = 'flying';
    mult = Math.round(multAtElapsed(nowMs - flyStart) * 100) / 100;
  } else {
    phase = 'crashed';
    mult = crashMult;
  }

  return {
    ok: true,
    global: true,
    serverNow: nowMs,
    roundId,
    phase,
    mult,
    crashMult: phase === 'crashed' ? crashMult : null,
    // Timings (UTC ms) so every client can interpolate the same curve
    roundStart,
    bettingEndsAt: flyStart,
    flyStart,
    crashAt,
    cycleEnd,
    nextRoundId: roundId + 1,
    nextRoundStart: cycleEnd,
    growthPerMs: GROWTH_PER_MS,
    cycleMs: CYCLE_MS,
    betMs: BET_MS,
    resultMs: RESULT_MS,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET' });
  }

  const secret =
    (process.env.ROUND_SECRET || process.env.HOUSE_PRIVATE_KEY || 'megapush-global-v1').trim();
  const now = Date.now();
  const state = getRoundState(now, secret);
  return res.status(200).json(state);
};

// Exported for tests / reuse
module.exports.getRoundState = getRoundState;
module.exports.CONST = { CYCLE_MS, BET_MS, RESULT_MS, GROWTH_PER_MS };
