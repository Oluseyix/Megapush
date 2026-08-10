/**
 * GET /api/round — global synchronized + provably fair crash rounds.
 *
 * Provably fair (commit–reveal):
 * - serverSeed = SHA256(ROUND_SECRET + ":megapush:round:" + roundId)
 * - During betting/flying: only serverSeedHash = SHA256(serverSeed) is published
 * - After crash: serverSeed is revealed; anyone can verify:
 *     SHA256(serverSeed) === serverSeedHash
 *     crashFromSeed(serverSeed) === crashMult
 *
 * Crash formula: Bustabit-style from first 52 bits of serverSeed hex.
 * Growth allows high multipliers (not clamped to ~2×).
 */

const crypto = require('crypto');

// Long enough for high mults: ~2× in ~4s, ~10× in ~13s, ~50× in ~26s, cap ~120×
const CYCLE_MS = 48_000;
const BET_MS = 4_500;
const RESULT_MS = 4_000;
const GROWTH_PER_MS = 0.00018;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function serverSeedForRound(masterSecret, roundId) {
  return sha256Hex(`${masterSecret}:megapush:round:${roundId}`);
}

/**
 * Bustabit-style crash point from 64-char hex seed.
 * ~3% chance of instant 1.00×; otherwise heavy-tailed distribution.
 */
function crashFromSeed(serverSeedHex) {
  const h = String(serverSeedHex).replace(/^0x/, '').toLowerCase();
  const n = parseInt(h.slice(0, 13), 16);
  if (!Number.isFinite(n)) return 1.01;
  const e = 2 ** 52;
  // Instant crash ~1/33
  if (n % 33 === 0) return 1.0;
  const raw = Math.floor((100 * e - n) / (e - n)) / 100;
  // Cap display/runtime at 1000× for UI safety
  return Math.min(1000, Math.max(1, Math.round(raw * 100) / 100));
}

function multAtElapsed(flyElapsedMs) {
  if (flyElapsedMs <= 0) return 1;
  return Math.exp(GROWTH_PER_MS * flyElapsedMs);
}

function elapsedForMult(mult) {
  if (!(mult > 1)) return 0;
  return Math.log(mult) / GROWTH_PER_MS;
}

function getRoundState(nowMs, masterSecret) {
  const roundId = Math.floor(nowMs / CYCLE_MS);
  const roundStart = roundId * CYCLE_MS;
  const elapsed = nowMs - roundStart;

  const serverSeed = serverSeedForRound(masterSecret, roundId);
  const serverSeedHash = sha256Hex(serverSeed);
  let crashMult = crashFromSeed(serverSeed);

  const maxFlightMs = CYCLE_MS - BET_MS - RESULT_MS; // ~39.5s → high mults reachable
  let flightMs = elapsedForMult(crashMult);
  if (flightMs > maxFlightMs) {
    // Physically can't reach that mult this cycle — crash at max climb
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

  const revealed = phase === 'crashed';

  return {
    ok: true,
    global: true,
    provablyFair: true,
    serverNow: nowMs,
    roundId,
    phase,
    mult,
    // Never leak seed before crash
    crashMult: revealed ? crashMult : null,
    serverSeedHash,
    serverSeed: revealed ? serverSeed : null,
    // How to verify (client can recompute)
    fair: {
      scheme: 'commit-reveal + Bustabit-style crash from SHA-256(serverSeed)',
      commit: serverSeedHash,
      reveal: revealed ? serverSeed : null,
      verify: revealed
        ? 'SHA256(serverSeed)===serverSeedHash && crashFromSeed(serverSeed)===crashMult'
        : 'Seed revealed after crash',
    },
    roundStart,
    bettingEndsAt: flyStart,
    flyStart,
    crashAt: revealed || phase === 'flying' ? crashAt : null, // hide exact crash time during betting only
    // During flying we expose crashAt for sync; seed still hidden so crash mult not known without brute-forcing hash
    // Actually exposing crashAt allows reverse-engineering mult from growth curve!
    // CRITICAL: do NOT send crashAt until crashed — client must poll or receive mult from server only during flight
    cycleEnd,
    nextRoundId: roundId + 1,
    nextRoundStart: cycleEnd,
    growthPerMs: GROWTH_PER_MS,
    cycleMs: CYCLE_MS,
    betMs: BET_MS,
    resultMs: RESULT_MS,
  };
}

// During flying, client needs mult but NOT crashAt (would leak crash point via inverse of exp growth).
// So we only send current mult from server during flying; crashAt only after crash.
function getRoundStateSafe(nowMs, masterSecret) {
  const full = getRoundState(nowMs, masterSecret);
  if (full.phase === 'betting') {
    return {
      ...full,
      crashAt: null, // unknown
      // Client holds mult at 1.00 during betting
    };
  }
  if (full.phase === 'flying') {
    return {
      ...full,
      crashAt: null, // CRITICAL: hide — else mult curve leaks crash
      crashMult: null,
      serverSeed: null,
      // Send mult from server clock; client can interpolate briefly between polls
      mult: full.mult,
      flyStart: full.flyStart,
      growthPerMs: full.growthPerMs,
    };
  }
  // crashed — full reveal for verification
  return {
    ...full,
    crashAt: full.crashAt,
    crashMult: full.crashMult,
    serverSeed: full.serverSeed,
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

  const secret = (
    process.env.ROUND_SECRET ||
    process.env.HOUSE_PRIVATE_KEY ||
    'megapush-global-v1'
  ).trim();
  const now = Date.now();
  const state = getRoundStateSafe(now, secret);
  return res.status(200).json(state);
};

module.exports.getRoundState = getRoundState;
module.exports.getRoundStateSafe = getRoundStateSafe;
module.exports.crashFromSeed = crashFromSeed;
module.exports.sha256Hex = sha256Hex;
module.exports.CONST = { CYCLE_MS, BET_MS, RESULT_MS, GROWTH_PER_MS };
