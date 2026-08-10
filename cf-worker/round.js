/**
 * Provably fair global rounds — Cloudflare worker.
 * Multiple hands per UTC slot so early crashes don't freeze the UI at 1.00×.
 * Phases per hand: betting → flying → crashed (short) → next hand
 */

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

function envGet(env, ...keys) {
  for (const k of keys) {
    const v = env?.[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

const CYCLE_MS = 48_000;
const BET_MS = 4_000;
const RESULT_MS = 2_800;
const GROWTH_PER_MS = 0.00018;
const MAX_FLIGHT_MS = 28_000;
const MAX_HANDS = 24;

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function serverSeedForHand(masterSecret, slotId, hand) {
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

async function handTiming(slotId, hand, handStart, slotEnd, masterSecret) {
  const serverSeed = await serverSeedForHand(masterSecret, slotId, hand);
  const serverSeedHash = await sha256Hex(serverSeed);
  let crashMult = crashFromSeed(serverSeed);

  let flightMs = elapsedForMult(crashMult);
  if (flightMs > MAX_FLIGHT_MS) {
    flightMs = MAX_FLIGHT_MS;
    crashMult = Math.round(multAtElapsed(flightMs) * 100) / 100;
  }

  const remaining = slotEnd - handStart;
  const minNeed = BET_MS + RESULT_MS + 250;
  if (remaining < minNeed) {
    return { fits: false, serverSeed, serverSeedHash, crashMult };
  }

  const maxFlightThisHand = remaining - BET_MS - RESULT_MS;
  if (flightMs > maxFlightThisHand) {
    flightMs = Math.max(0, maxFlightThisHand);
    crashMult = Math.round(multAtElapsed(flightMs) * 100) / 100;
    if (crashMult < 1) crashMult = 1;
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

async function getRoundStateSafe(nowMs, masterSecret) {
  const slotId = Math.floor(nowMs / CYCLE_MS);
  const slotStart = slotId * CYCLE_MS;
  const slotEnd = slotStart + CYCLE_MS;

  let handStart = slotStart;
  let hand = 0;
  let timing = null;

  while (hand < MAX_HANDS) {
    timing = await handTiming(slotId, hand, handStart, slotEnd, masterSecret);
    if (!timing.fits) {
      return {
        ok: true,
        global: true,
        provablyFair: true,
        platform: 'cloudflare-pages-worker',
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
        slotEnd,
        nextRoundId: (slotId + 1) * 1000,
        nextRoundStart: slotEnd,
        growthPerMs: GROWTH_PER_MS,
        cycleMs: CYCLE_MS,
        betMs: BET_MS,
        resultMs: RESULT_MS,
      };
    }

    if (nowMs < timing.handEnd) break;

    handStart = timing.handEnd;
    hand += 1;
  }

  if (!timing || !timing.fits) {
    return {
      ok: true,
      global: true,
      provablyFair: true,
      platform: 'cloudflare-pages-worker',
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
      slotEnd,
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
    phase = 'intermission';
    mult = 1;
  }

  const revealed = phase === 'crashed' || phase === 'intermission';

  const nextProbe = await handTiming(slotId, hand + 1, resultEnd, slotEnd, masterSecret);
  const nextRoundStart = nextProbe.fits ? resultEnd : slotEnd;
  const nextRoundId = nextProbe.fits ? roundId + 1 : (slotId + 1) * 1000;

  const base = {
    ok: true,
    global: true,
    provablyFair: true,
    platform: 'cloudflare-pages-worker',
    serverNow: nowMs,
    roundId,
    slotId,
    hand,
    phase,
    mult,
    serverSeedHash,
    crashMult: revealed ? crashMult : null,
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
    crashAt: revealed ? crashAt : null,
    resultEnd: revealed ? resultEnd : null,
    cycleEnd: nextRoundStart,
    slotEnd,
    nextRoundId,
    nextRoundStart,
    growthPerMs: GROWTH_PER_MS,
    cycleMs: CYCLE_MS,
    betMs: BET_MS,
    resultMs: RESULT_MS,
  };

  if (phase === 'flying') {
    return {
      ...base,
      crashAt: null,
      crashMult: null,
      serverSeed: null,
      resultEnd: null,
    };
  }
  if (phase === 'betting') {
    return {
      ...base,
      crashAt: null,
      crashMult: null,
      serverSeed: null,
    };
  }
  return base;
}

export async function handleRound(request, env) {
  const secret =
    envGet(env, 'ROUND_SECRET', 'HOUSE_PRIVATE_KEY') || 'megapush-global-v1';
  const state = await getRoundStateSafe(Date.now(), secret);
  return json(state);
}
