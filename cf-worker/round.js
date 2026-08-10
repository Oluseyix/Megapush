/**
 * Provably fair global rounds for Cloudflare Pages worker.
 * Commit–reveal: hash during flight, seed after crash. Bustabit-style crash.
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
const BET_MS = 4_500;
const RESULT_MS = 4_000;
const GROWTH_PER_MS = 0.00018;

async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function serverSeedForRound(masterSecret, roundId) {
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

async function getRoundStateSafe(nowMs, masterSecret) {
  const roundId = Math.floor(nowMs / CYCLE_MS);
  const roundStart = roundId * CYCLE_MS;
  const elapsed = nowMs - roundStart;

  const serverSeed = await serverSeedForRound(masterSecret, roundId);
  const serverSeedHash = await sha256Hex(serverSeed);
  let crashMult = crashFromSeed(serverSeed);

  const maxFlightMs = CYCLE_MS - BET_MS - RESULT_MS;
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

  const revealed = phase === 'crashed';
  const base = {
    ok: true,
    global: true,
    provablyFair: true,
    platform: 'cloudflare-pages-worker',
    serverNow: nowMs,
    roundId,
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
    roundStart,
    bettingEndsAt: flyStart,
    flyStart,
    // Hide crashAt until crashed — otherwise growth curve leaks the crash point
    crashAt: revealed ? crashAt : null,
    cycleEnd,
    nextRoundId: roundId + 1,
    nextRoundStart: cycleEnd,
    growthPerMs: GROWTH_PER_MS,
    cycleMs: CYCLE_MS,
    betMs: BET_MS,
    resultMs: RESULT_MS,
  };
  return base;
}

export async function handleRound(request, env) {
  const secret =
    envGet(env, 'ROUND_SECRET', 'HOUSE_PRIVATE_KEY') || 'megapush-global-v1';
  const state = await getRoundStateSafe(Date.now(), secret);
  return json(state);
}
