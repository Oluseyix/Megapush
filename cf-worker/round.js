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

const CYCLE_MS = 18_000;
const BET_MS = 3_200;
const RESULT_MS = 2_800;
const GROWTH_PER_MS = 0.000072;

function hashRound(secret, roundId) {
  const s = String(secret) + ':' + String(roundId);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

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
    platform: 'cloudflare-pages-worker',
    serverNow: nowMs,
    roundId,
    phase,
    mult,
    crashMult: phase === 'crashed' ? crashMult : null,
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

export async function handleRound(request, env) {
  const secret = envGet(env, 'ROUND_SECRET', 'HOUSE_PRIVATE_KEY') || 'megapush-global-v1';
  return json(getRoundState(Date.now(), secret));
}
