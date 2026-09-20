/**
 * Shared crash curve + commit-reveal helpers (one global TV per round).
 *
 * Crash point (v3): Bustabit-style from first 52 bits of
 *   SHA-256( lowercaseHex(serverSeed) || lowercaseHex(blockHash) )
 * where blockHash is the Base block at targetBlock (committed before betting ends).
 *
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

/**
 * Future-block offset for entropy.
 * Base ~2s/block; BET_MS = 5s is the max betting window (fixed).
 * Offset 5 leaves margin for block-boundary alignment and RPC latency.
 * RoundDO also checks the resolved block timestamp against the betting deadline.
 */
export const TARGET_BLOCK_OFFSET = 5;

/**
 * After betting ends, wait at most this long for targetBlock before voiding the round.
 * Must not silently fall back to server-only derivation.
 */
export const ENTROPY_WAIT_MAX_MS = 40_000;

export const FAIR_SCHEME =
  'commit-reveal + reverse hash-chain seeds + future Base block hash; Bustabit crash from SHA-256(serverSeed||blockHash); settlement mult = same curve at cashout arrival time';

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex without 0x — canonical for seed/block concat. */
export function normalizeHex(s) {
  return String(s ?? '')
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * Deterministic seed material for a hand (still secret until reveal).
 * Crash is NOT derived from this alone — needs future blockHash.
 */
export async function serverSeedForHand(masterSecret, slotId, hand) {
  return sha256Hex(`${masterSecret}:megapush:v3:slot:${slotId}:hand:${hand}`);
}

/**
 * Entropy string hashed for crash: sha256(serverSeed_hex || blockHash_hex).
 * Both sides are lowercase hex without 0x (see normalizeHex).
 */
export async function crashEntropyHex(serverSeed, blockHash) {
  const a = normalizeHex(serverSeed);
  const b = normalizeHex(blockHash);
  if (a.length < 8 || b.length < 8) {
    throw new Error('serverSeed and blockHash required for crash entropy');
  }
  return sha256Hex(a + b);
}

/**
 * Bustabit-style crash from a 64-char hex material (hash output).
 * Unchanged 52-bit / n%33 / 10_000x / edge math.
 */
export function crashFromSeed(entropyHex) {
  const h = normalizeHex(entropyHex);
  const n = parseInt(h.slice(0, 13), 16);
  if (!Number.isFinite(n)) return 1.01;
  const e = 2 ** 52;
  if (n % INSTANT_BUST_MOD === 0) return 1.0;
  const raw = Math.floor((100 * e - n) / (e - n)) / 100;
  return Math.min(MAX_CRASH_MULT, Math.max(1, Math.round(raw * 100) / 100));
}

/** Derive crash mult from serverSeed + blockHash (new fairness path). */
export async function crashFromSeedAndBlock(serverSeed, blockHash) {
  const material = await crashEntropyHex(serverSeed, blockHash);
  return {
    material,
    crashMult: crashFromSeed(material),
  };
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

/** No client-claimed backdating. Retries use a receipt already stored by RoundDO. */
export const CASHOUT_GRACE_MS = 0;

/**
 * Settlement for a cashout intent that arrived at `arrivalMs` (server clock).
 * Same curve as the TV — only differs by arrival latency.
 */
export function settlementFromArrival(timing, arrivalMs) {
  if (!timing || !Number.isFinite(timing.flyStart) || !Number.isFinite(timing.crashAt) ||
      !Number.isFinite(timing.crashMult) || !Number.isFinite(arrivalMs)) {
    return { ok: false, error: 'Invalid timing', mult: 0 };
  }
  if (timing.voided) {
    return {
      ok: false,
      error: 'Round voided — stakes returned',
      lost: false,
      voided: true,
      mult: 0,
      phase: 'voided',
    };
  }
  if (arrivalMs < timing.flyStart) {
    return {
      ok: false,
      error: 'Cashout before round flight (still in betting window)',
      lost: false,
      mult: 0,
      phase: 'betting',
    };
  }
  if (arrivalMs >= timing.crashAt) {
    return {
      ok: true,
      lost: true,
      mult: 0,
      phase: 'crashed',
      arrivalMs,
      flyStart: timing.flyStart,
    };
  }
  const mult = multOnCurve(timing, arrivalMs);
  return {
    ok: true,
    lost: false,
    mult,
    phase: 'flying',
    arrivalMs,
    flyStart: timing.flyStart,
    elapsedMs: arrivalMs - timing.flyStart,
  };
}

/**
 * Manual settlement uses only trusted server arrival time. Client values are
 * validated for compatibility but cannot select a payout or backdate a request.
 * RoundDO persists the resulting receipt for idempotent retries.
 */
export function settlementFromIntent(timing, opts = {}) {
  const arrivalMs = Number(opts.arrivalMs ?? opts.serverNow ?? Date.now());
  if (opts.claimedMult != null &&
      (!Number.isFinite(Number(opts.claimedMult)) || Number(opts.claimedMult) < 1)) {
    return { ok: false, error: 'Invalid claimed multiplier', mult: 0, arrivalMs };
  }
  const result = settlementFromArrival(timing, arrivalMs);
  return {
    ...result,
    arrivalMs,
    effectiveAt: arrivalMs,
    graceMs: 0,
    graceApplied: false,
    mode: 'arrival',
  };
}

/**
 * Verify a revealed seed matches commit, optional block entropy, and crash point.
 * Returns separate booleans for each property (not only aggregate ok).
 */
export async function verifyRound({
  serverSeed,
  serverSeedHash,
  crashMult,
  blockHash,
  targetBlock,
  chainPrevSeed,
  chainHead,
  chainIndex,
  cashoutAt,
  flyStart,
  expectedSettlementMult,
}) {
  if (serverSeed == null || String(serverSeed).length < 8) {
    return {
      ok: false,
      error: 'Invalid serverSeed',
      commitOk: false,
      blockOk: false,
      crashOk: false,
      chainOk: null,
    };
  }

  const hash = await sha256Hex(serverSeed);
  const providedHash = serverSeedHash
    ? normalizeHex(serverSeedHash)
    : null;
  const commitOk = !providedHash || hash === providedHash;

  let material;
  let computedCrash;
  let entropyMode = 'legacy_seed_only';

  if (blockHash != null && String(blockHash).length >= 8) {
    entropyMode = 'serverSeed_plus_blockHash';
    try {
      const out = await crashFromSeedAndBlock(serverSeed, blockHash);
      material = out.material;
      computedCrash = out.crashMult;
    } catch (e) {
      return {
        ok: false,
        error: e?.message || 'Entropy derivation failed',
        commitOk,
        blockOk: false,
        crashOk: false,
        chainOk: null,
        scheme: FAIR_SCHEME,
      };
    }
  } else {
    // Legacy path only for pre-upgrade rounds (no blockHash in reveal)
    material = normalizeHex(serverSeed);
    computedCrash = crashFromSeed(material);
  }

  const { flightMs, crashMult: cappedCrash } = flightFromCrash(computedCrash);
  const crashOk =
    crashMult == null ||
    Math.abs(cappedCrash - Number(crashMult)) < 0.015 ||
    Math.abs(computedCrash - Number(crashMult)) < 0.015;

  // blockOk: structural check here; RPC match is done in verify.js when env available
  let blockOk = true;
  if (entropyMode === 'serverSeed_plus_blockHash') {
    blockOk = normalizeHex(blockHash).length === 64;
  } else if (targetBlock != null || blockHash != null) {
    blockOk = false;
  }

  // chainOk: reverse hash-chain
  //  - link: sha256(seed[i]) === seed[i-1] when prev provided
  //  - head: hash seed[i] index times → published head
  // null only when no chain fields provided (legacy)
  let chainOk = null;
  let chainHeadMatch = null;
  const hasChainFields =
    (chainPrevSeed != null && String(chainPrevSeed).length >= 8) ||
    (chainHead != null && String(chainHead).length >= 8) ||
    chainIndex != null;

  if (hasChainFields) {
    if (chainIndex != null && (!Number.isSafeInteger(Number(chainIndex)) ||
        Number(chainIndex) < 0 || Number(chainIndex) > 50_000)) {
      return { ok: false, error: 'Invalid chain index', commitOk, crashOk, blockOk, chainOk: false };
    }
    const checks = [];
    if (chainPrevSeed != null && String(chainPrevSeed).length >= 8) {
      const link = await sha256Hex(normalizeHex(serverSeed));
      checks.push(normalizeHex(link) === normalizeHex(chainPrevSeed));
    } else if (chainIndex != null && Number(chainIndex) === 0) {
      // first seed: no prev link required
      checks.push(true);
    }
    if (chainHead != null && String(chainHead).length >= 8 && chainIndex != null) {
      let h = normalizeHex(serverSeed);
      const steps = Math.max(0, Math.floor(Number(chainIndex) || 0));
      for (let k = 0; k < steps; k++) h = await sha256Hex(h);
      chainHeadMatch = normalizeHex(h) === normalizeHex(chainHead);
      checks.push(chainHeadMatch);
    }
    chainOk = checks.length === 0 ? null : checks.every(Boolean);
  }

  let settlement = null;
  let settlementOk = true;
  if (cashoutAt != null && flyStart != null) {
    const timing = {
      flyStart: Number(flyStart),
      crashAt: Number(flyStart) + flightMs,
      crashMult: cappedCrash,
    };
    settlement = settlementFromArrival(timing, Number(cashoutAt));
    if (expectedSettlementMult != null) {
      settlementOk = settlement.ok && !settlement.lost &&
        Math.abs(settlement.mult - Number(expectedSettlementMult)) < 0.02;
    }
  }

  const coreOk = commitOk && crashOk && blockOk && settlementOk;
  const chainPass = chainOk === null || chainOk === true;

  return {
    ok: coreOk && chainPass,
    scheme: FAIR_SCHEME,
    entropyMode,
    commitOk,
    blockOk,
    crashOk,
    chainOk,
    chainHeadMatch,
    settlementOk,
    computedHash: hash,
    computedEntropyHex: material,
    computedCrashMult: cappedCrash,
    uncappedCrashMult: computedCrash,
    providedCrashMult: crashMult != null ? Number(crashMult) : null,
    targetBlock: targetBlock != null ? Number(targetBlock) : null,
    blockHash: blockHash != null ? String(blockHash).toLowerCase() : null,
    chainHead: chainHead != null ? normalizeHex(chainHead) : null,
    chainIndex: chainIndex != null ? Number(chainIndex) : null,
    flightMs,
    settlement,
  };
}
