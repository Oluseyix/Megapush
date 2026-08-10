/**
 * GET /api/round — global synchronized + provably fair crash rounds.
 *
 * Commit–reveal: serverSeedHash during betting/flying; serverSeed after crash.
 * Bustabit-style crash from SHA-256(serverSeed).
 *
 * Multiple hands per UTC slot so early crashes do NOT leave a long dead
 * "intermission" at 1.00×. Flow per hand:
 *   betting → flying → crashed (short RESULT_MS) → next hand immediately
 * Only the leftover time at the end of a slot is idle intermission.
 */

const crypto = require('crypto');

const CYCLE_MS = 48_000;
const BET_MS = 4_000;
const RESULT_MS = 2_800;
const GROWTH_PER_MS = 0.00018;
const MAX_FLIGHT_MS = 28_000;
const MAX_HANDS = 24;

function sha256Hex(input) {
  return crypto.createHash('sha256').update(String(input), 'utf8').digest('hex');
}

function serverSeedForHand(masterSecret, slotId, hand) {
  return sha256Hex(`${masterSecret}:megapush:slot:${slotId}:hand:${hand}`);
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

function handTiming(slotId, hand, handStart, slotEnd, masterSecret) {
  const serverSeed = serverSeedForHand(masterSecret, slotId, hand);
  const serverSeedHash = sha256Hex(serverSeed);
  let crashMult = crashFromSeed(serverSeed);

  let flightMs = elapsedForMult(crashMult);
  if (flightMs > MAX_FLIGHT_MS) {
    flightMs = MAX_FLIGHT_MS;
    crashMult = Math.round(multAtElapsed(flightMs) * 100) / 100;
  }

  const remaining = slotEnd - handStart;
  // Full seed-derived flight must fit — never truncate crash mult (breaks verify).
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
    crashAt,
    resultEnd,
    handEnd: resultEnd,
  };
}

function getRoundState(nowMs, masterSecret) {
  const slotId = Math.floor(nowMs / CYCLE_MS);
  const slotStart = slotId * CYCLE_MS;
  const slotEnd = slotStart + CYCLE_MS;

  let handStart = slotStart;
  let hand = 0;
  let timing = null;

  while (hand < MAX_HANDS) {
    timing = handTiming(slotId, hand, handStart, slotEnd, masterSecret);
    if (!timing.fits) {
      // Remainder of slot — idle until next slot
      return {
        ok: true,
        global: true,
        provablyFair: true,
        serverNow: nowMs,
        roundId: slotId * 1000 + hand,
        slotId,
        hand,
        phase: 'intermission',
        mult: 1,
        crashMult: null,
        serverSeedHash: timing.serverSeedHash,
        serverSeed: null,
        fair: {
          scheme: 'commit-reveal + Bustabit-style crash from SHA-256(serverSeed)',
          commit: timing.serverSeedHash,
          reveal: null,
          verify: 'Seed revealed after crash',
        },
        roundStart: handStart,
        bettingEndsAt: null,
        flyStart: null,
        crashAt: null,
        resultEnd: null,
        cycleEnd: slotEnd,
        nextRoundId: (slotId + 1) * 1000,
        nextRoundStart: slotEnd,
        growthPerMs: GROWTH_PER_MS,
        cycleMs: CYCLE_MS,
        betMs: BET_MS,
        resultMs: RESULT_MS,
      };
    }

    if (nowMs < timing.handEnd) {
      // Active hand
      break;
    }

    handStart = timing.handEnd;
    hand += 1;
  }

  if (!timing || !timing.fits) {
    // Fallback idle
    return {
      ok: true,
      global: true,
      provablyFair: true,
      serverNow: nowMs,
      roundId: slotId * 1000 + hand,
      slotId,
      hand,
      phase: 'intermission',
      mult: 1,
      crashMult: null,
      serverSeedHash: null,
      serverSeed: null,
      fair: { scheme: 'commit-reveal', commit: null, reveal: null, verify: null },
      roundStart: handStart,
      bettingEndsAt: null,
      flyStart: null,
      crashAt: null,
      resultEnd: null,
      cycleEnd: slotEnd,
      nextRoundId: (slotId + 1) * 1000,
      nextRoundStart: slotEnd,
      growthPerMs: GROWTH_PER_MS,
      cycleMs: CYCLE_MS,
      betMs: BET_MS,
      resultMs: RESULT_MS,
    };
  }

  const { serverSeed, serverSeedHash, crashMult, flyStart, crashAt, resultEnd, handStart: hs } =
    timing;
  const roundId = slotId * 1000 + hand;

  let phase;
  let mult;
  if (nowMs < flyStart) {
    phase = 'betting';
    mult = 1;
  } else if (nowMs < crashAt) {
    phase = 'flying';
    mult = Math.round(multAtElapsed(nowMs - flyStart) * 100) / 100;
  } else if (nowMs < resultEnd) {
    phase = 'crashed';
    mult = crashMult;
  } else {
    // Should not happen (we break when now < handEnd)
    phase = 'intermission';
    mult = 1;
  }

  const revealed = phase === 'crashed' || phase === 'intermission';

  // Next hand starts at resultEnd if it fits; else next slot
  const nextProbe = handTiming(slotId, hand + 1, resultEnd, slotEnd, masterSecret);
  const nextRoundStart = nextProbe.fits ? resultEnd : slotEnd;
  const nextRoundId = nextProbe.fits ? roundId + 1 : (slotId + 1) * 1000;

  return {
    ok: true,
    global: true,
    provablyFair: true,
    serverNow: nowMs,
    roundId,
    slotId,
    hand,
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
    roundStart: hs,
    bettingEndsAt: flyStart,
    flyStart,
    crashAt,
    resultEnd,
    cycleEnd: nextRoundStart, // client: end of THIS hand (not full 48s slot)
    slotEnd,
    nextRoundId,
    nextRoundStart,
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

  // crashed | intermission — reveal fair data
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

  const secret = process.env.ROUND_SECRET || '';
  if (!secret || secret.length < 16) {
    return res.status(200).json({
      ok: true,
      phase: 'intermission',
      acceptingBets: false,
      windowClosed: true,
      mult: 1,
      error: 'ROUND_SECRET not configured — betting closed',
      serverNow: Date.now(),
    });
  }

  return res.status(200).json(getRoundStateSafe(Date.now(), secret));
};

module.exports.getRoundState = getRoundState;
module.exports.getRoundStateSafe = getRoundStateSafe;
module.exports.crashFromSeed = crashFromSeed;
module.exports.sha256Hex = sha256Hex;
module.exports.CONST = { CYCLE_MS, BET_MS, RESULT_MS, GROWTH_PER_MS, MAX_FLIGHT_MS };
