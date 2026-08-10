/**
 * GET /api/round — global synchronized + provably fair crash rounds.
 *
 * Commit–reveal: serverSeedHash during betting/flying; serverSeed after crash.
 * Bustabit-style crash from SHA-256(serverSeed).
 *
 * Phases:
 *  betting → flying → crashed (short RESULT_MS) → intermission (stake / wait)
 * Never sit on "flew away" for the entire remaining cycle.
 */

const crypto = require('crypto');

const CYCLE_MS = 48_000;
const BET_MS = 4_500;
const RESULT_MS = 3_200; // how long to show "flew away" before clearing
const GROWTH_PER_MS = 0.00018;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function serverSeedForRound(masterSecret, roundId) {
  return sha256Hex(`${masterSecret}:megapush:round:${roundId}`);
}

function crashFromSeed(serverSeedHex) {
  const h = String(serverSeedHex).replace(/^0x/, '').toLowerCase();
  const n = parseInt(h.slice(0, 13), 16);
  if (!Number.isFinite(n)) return 1.01;
  const e = 2 ** 52;
  if (n % 33 === 0) return 1.0;
  const raw = Math.floor((100 * e - n) / (e - n)) / 100;
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

  const maxFlightMs = CYCLE_MS - BET_MS - RESULT_MS;
  let flightMs = elapsedForMult(crashMult);
  if (flightMs > maxFlightMs) {
    flightMs = maxFlightMs;
    crashMult = Math.round(multAtElapsed(flightMs) * 100) / 100;
  }

  const flyStart = roundStart + BET_MS;
  const crashAt = flyStart + flightMs;
  const resultEnd = Math.min(crashAt + RESULT_MS, roundStart + CYCLE_MS);
  const cycleEnd = roundStart + CYCLE_MS;

  let phase;
  let mult;
  if (elapsed < BET_MS) {
    phase = 'betting';
    mult = 1;
  } else if (nowMs < crashAt) {
    phase = 'flying';
    mult = Math.round(multAtElapsed(nowMs - flyStart) * 100) / 100;
  } else if (nowMs < resultEnd) {
    phase = 'crashed';
    mult = crashMult;
  } else {
    // After short result window — clear "flew away", accept stakes until next cycle climb
    phase = 'intermission';
    mult = 1;
  }

  const revealed = phase === 'crashed' || phase === 'intermission';

  return {
    ok: true,
    global: true,
    provablyFair: true,
    serverNow: nowMs,
    roundId,
    phase,
    mult,
    crashMult: revealed ? crashMult : null,
    serverSeedHash,
    serverSeed: revealed ? serverSeed : null,
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
    crashAt, // internal; stripped when flying in getRoundStateSafe
    resultEnd,
    cycleEnd,
    nextRoundId: roundId + 1,
    nextRoundStart: cycleEnd,
    growthPerMs: GROWTH_PER_MS,
    cycleMs: CYCLE_MS,
    betMs: BET_MS,
    resultMs: RESULT_MS,
  };
}

function getRoundStateSafe(nowMs, masterSecret) {
  const full = getRoundState(nowMs, masterSecret);

  if (full.phase === 'flying') {
    return {
      ...full,
      crashAt: null, // hide — would leak crash via inverse of exp growth
      crashMult: null,
      serverSeed: null,
      resultEnd: null,
    };
  }

  if (full.phase === 'betting') {
    return {
      ...full,
      crashAt: null,
      crashMult: null,
      serverSeed: null,
    };
  }

  // crashed | intermission — reveal fair data; client needs crashAt for timing
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
  return res.status(200).json(getRoundStateSafe(Date.now(), secret));
};

module.exports.getRoundState = getRoundState;
module.exports.getRoundStateSafe = getRoundStateSafe;
module.exports.crashFromSeed = crashFromSeed;
module.exports.sha256Hex = sha256Hex;
module.exports.CONST = { CYCLE_MS, BET_MS, RESULT_MS, GROWTH_PER_MS };
