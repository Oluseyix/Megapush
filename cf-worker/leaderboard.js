/**
 * Live cash-out leaderboard — highest cash-out multipliers (privacy-first).
 * Durable store: Cloudflare KV (BANK_KV) with Cache API as L1.
 *
 * GET  /api/leaderboard?period=today|week|month&tzOffset=<getTimezoneOffset()>
 * POST /api/leaderboard { player, multiplier, tickets, entryId?, at? }
 *
 * Scores are cash-out mult only (capped by MAX_PAYOUT_MULT). Crash-point
 * mults and timestamps must never land on the board.
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

function isAddr(a) {
  return typeof a === 'string' && /^0x[a-fA-F0-9]{40}$/.test(a);
}

/** Max cash-out mult shown/stored (matches house payout cap). */
function maxPayoutMult(env) {
  const n = Number(env?.MAX_PAYOUT_MULT);
  if (Number.isFinite(n) && n >= 1 && n <= 1000) return n;
  return 50;
}

/** Reject junk: NaN, ≤1, or above payout ceiling (e.g. 10000× crash-point posts). */
function sanitizeMult(raw, env) {
  const mult = Number(raw);
  const max = maxPayoutMult(env);
  if (!Number.isFinite(mult) || mult <= 1) return null;
  // Timestamps mistakenly used as mult are huge
  if (mult > max) return null;
  return Math.round(mult * 100) / 100;
}

/** Stable anonymous handle — not reverse-engineerable to a wallet easily. */
function privacyHandle(addr) {
  const a = String(addr || '')
    .toLowerCase()
    .replace(/^0x/, '');
  if (a.length < 6) return 'Pilot';
  const names = [
    'Ace', 'Bolt', 'Nova', 'Pulse', 'Orbit', 'Flux', 'Spark', 'Drift', 'Glow', 'Vibe',
    'Hawk', 'Echo', 'Blaze', 'Rune', 'Kite', 'Jet', 'Arc', 'Zen', 'Fox', 'Lux',
  ];
  let n = 2166136261;
  for (let i = 0; i < a.length; i++) {
    n ^= a.charCodeAt(i);
    n = Math.imul(n, 16777619);
  }
  n >>>= 0;
  return names[n % names.length] + '-' + a.slice(-3);
}

const CACHE_URL = 'https://megapush.lb.internal/v3/entries';
const KV_KEY = 'leaderboard:v3:entries';
const LEGACY_KEYS = ['leaderboard:v2:entries'];
const MAX_ENTRIES = 5000;

/**
 * @param {string} period
 * @param {number} tzOffsetMin - from Date.getTimezoneOffset()
 */
function periodStartMs(period, tzOffsetMin = 0) {
  const now = Date.now();
  const p = String(period || 'today').toLowerCase();
  if (p === 'week') return now - 7 * 24 * 60 * 60 * 1000;
  if (p === 'month') return now - 30 * 24 * 60 * 60 * 1000;
  // Local calendar day using client timezone offset
  const off = Number(tzOffsetMin);
  const offsetMs = Number.isFinite(off) ? off * 60 * 1000 : 0;
  // Shift so UTC getters read local wall-clock date
  const shifted = new Date(now - offsetMs);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth();
  const d = shifted.getUTCDate();
  // Local midnight as UTC ms
  return Date.UTC(y, m, d) + offsetMs;
}

function normalizePeriod(period) {
  const p = String(period || 'today').toLowerCase();
  if (p === 'week' || p === 'month' || p === 'today') return p;
  if (p === 'all' || p === 'alltime' || p === 'all-time') return 'month';
  return 'today';
}

function isValidEntry(e, env) {
  if (!e || !e.id || !isAddr(e.player)) return false;
  const mult = sanitizeMult(e.mult, env);
  if (mult == null) return false;
  const at = Number(e.at) || 0;
  // Drop future / absurd timestamps
  if (at > Date.now() + 120_000) return false;
  if (at > 0 && at < 1_600_000_000_000) return false; // pre-2020
  return true;
}

function normalizeEntry(e, env) {
  const mult = sanitizeMult(e.mult, env);
  if (mult == null || !isAddr(e.player)) return null;
  return {
    id: String(e.id),
    player: String(e.player).toLowerCase(),
    mult,
    tickets: Math.max(0, Math.floor(Number(e.tickets) || 0)),
    at: Number(e.at) > 0 ? Number(e.at) : Date.now(),
  };
}

async function loadEntries(env) {
  const byId = new Map();
  const absorb = (list) => {
    for (const raw of list || []) {
      const e = normalizeEntry(raw, env);
      if (!e || !isValidEntry(e, env)) continue;
      const prev = byId.get(e.id);
      if (!prev || Number(e.at) >= Number(prev.at)) byId.set(e.id, e);
    }
  };

  try {
    const kv = env?.BANK_KV;
    if (kv && typeof kv.get === 'function') {
      const raw = await kv.get(KV_KEY, { type: 'json' });
      if (raw && Array.isArray(raw.entries)) absorb(raw.entries);
      else if (Array.isArray(raw)) absorb(raw);
      // One-time absorb legacy v2 (then we only write v3)
      for (const leg of LEGACY_KEYS) {
        try {
          const old = await kv.get(leg, { type: 'json' });
          if (old && Array.isArray(old.entries)) absorb(old.entries);
          else if (Array.isArray(old)) absorb(old);
        } catch (_) {}
      }
    }
  } catch (e) {
    console.warn('lb kv get', e);
  }

  for (const url of [
    CACHE_URL,
    'https://megapush.lb.internal/v2/entries',
    'https://megapush.lb.internal/v1/entries',
  ]) {
    try {
      const hit = await caches.default.match(new Request(url));
      if (hit) {
        const j = await hit.json();
        absorb(Array.isArray(j?.entries) ? j.entries : Array.isArray(j) ? j : []);
      }
    } catch (_) {}
  }

  const entries = Array.from(byId.values()).sort(
    (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0),
  );

  // Persist cleaned set (drops junk 10000× / 5281× / etc.)
  if (entries.length) {
    try {
      await saveEntries(entries, env);
    } catch (_) {}
  } else {
    // Empty cleaned board — still overwrite legacy junk in KV
    try {
      await saveEntries([], env);
    } catch (_) {}
  }
  return entries;
}

async function saveEntries(entries, env) {
  const cleaned = (entries || [])
    .map((e) => normalizeEntry(e, env))
    .filter(Boolean)
    .slice(-MAX_ENTRIES);
  const body = {
    entries: cleaned,
    updatedAt: Date.now(),
    version: 3,
  };
  try {
    const kv = env?.BANK_KV;
    if (kv && typeof kv.put === 'function') {
      await kv.put(KV_KEY, JSON.stringify(body));
    }
  } catch (e) {
    console.warn('lb kv put', e);
  }
  try {
    await caches.default.put(
      new Request(CACHE_URL),
      new Response(JSON.stringify(body), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=2592000',
        },
      }),
    );
  } catch (e) {
    console.warn('lb cache put', e);
  }
  return body;
}

/** Record a successful cash-out (best-effort). */
export async function recordScore({ player, multiplier, tickets, entryId, at } = {}, env) {
  if (!isAddr(player)) return { ok: false, error: 'Invalid player' };
  const mult = sanitizeMult(multiplier, env);
  if (mult == null) {
    return {
      ok: false,
      error: `Invalid multiplier (must be > 1 and ≤ ${maxPayoutMult(env)}× cash-out)`,
    };
  }
  const tix = Math.max(0, Math.floor(Number(tickets) || 0));

  const entries = await loadEntries(env);
  const id =
    entryId != null && String(entryId)
      ? String(entryId)
      : `${player.toLowerCase()}-${mult}-${tix}-${at || Date.now()}`;

  if (entries.some((e) => e.id === id)) {
    return { ok: true, already: true, id };
  }

  entries.push({
    id,
    player: player.toLowerCase(),
    mult,
    tickets: tix,
    at: Number(at) > 0 && Number(at) < Date.now() + 120_000 ? Number(at) : Date.now(),
  });
  await saveEntries(entries, env);
  return { ok: true, id, mult };
}

function aggregate(entries, period, tzOffsetMin, viewer, env) {
  const start = periodStartMs(period, tzOffsetMin);
  const now = Date.now();
  const filtered = entries.filter((e) => {
    if (!isValidEntry(e, env)) return false;
    const t = Number(e.at) || 0;
    return t >= start && t <= now + 60_000;
  });
  const byPlayer = new Map();

  for (const e of filtered) {
    const key = e.player;
    let row = byPlayer.get(key);
    if (!row) {
      row = {
        player: key,
        highest: 0,
        tickets: 0,
        lastAt: 0,
      };
      byPlayer.set(key, row);
    }
    row.highest = Math.max(row.highest, Number(e.mult) || 0);
    row.tickets += Math.max(0, Math.floor(Number(e.tickets) || 0));
    row.lastAt = Math.max(row.lastAt, Number(e.at) || 0);
  }

  const rows = Array.from(byPlayer.values()).sort((a, b) => {
    if (b.highest !== a.highest) return b.highest - a.highest;
    if (b.tickets !== a.tickets) return b.tickets - a.tickets;
    return b.lastAt - a.lastAt;
  });

  let topMult = 0;
  let topAt = 0;
  for (const e of filtered) {
    if (Number(e.mult) > topMult) {
      topMult = Number(e.mult);
      topAt = e.at;
    }
  }

  const viewerLc = isAddr(viewer) ? viewer.toLowerCase() : '';

  return {
    period: normalizePeriod(period),
    since: start,
    until: now,
    events: filtered.length,
    players: rows.length,
    top: topMult > 0 ? { mult: topMult, at: topAt } : null,
    rows: rows.map((r, i) => ({
      rank: i + 1,
      handle: privacyHandle(r.player),
      isYou: !!(viewerLc && r.player === viewerLc),
      highest: Math.round(r.highest * 100) / 100,
      tickets: r.tickets,
    })),
  };
}

export async function handleLeaderboard(request, env) {
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const period = normalizePeriod(url.searchParams.get('period') || 'today');
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    const player = url.searchParams.get('player');
    const tzOffset = Number(url.searchParams.get('tzOffset'));
    const entries = await loadEntries(env);
    const agg = aggregate(entries, period, tzOffset, player, env);
    const rows = agg.rows.slice(0, limit);

    let you = null;
    if (isAddr(player)) {
      const found = agg.rows.find((r) => r.isYou);
      you = found || {
        rank: null,
        handle: privacyHandle(player),
        isYou: true,
        highest: 0,
        tickets: 0,
      };
    }

    return json({
      ok: true,
      durable: !!env?.BANK_KV,
      period: agg.period,
      since: agg.since,
      until: agg.until,
      events: agg.events,
      players: agg.players,
      top: agg.top,
      maxMult: maxPayoutMult(env),
      rows,
      you,
    });
  }

  if (request.method === 'POST') {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    // Never use body.at (timestamp) as multiplier
    const multRaw = body.multiplier ?? body.mult ?? body.cashoutMult ?? body.cashout_mult;
    const result = await recordScore(
      {
        player: body.player || body.recipient || body.address,
        multiplier: multRaw,
        tickets: body.tickets ?? body.count,
        entryId: body.entryId ?? body.id,
        at: body.at ?? body.ts,
      },
      env,
    );
    if (!result.ok) return json(result, 400);
    return json(result);
  }

  return json({ ok: false, error: 'Use GET or POST' }, 405);
}
