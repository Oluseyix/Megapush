/**
 * Live cash-out leaderboard — highest multipliers only (privacy-first).
 * Durable store: Cloudflare KV (BANK_KV) with Cache API as L1.
 *
 * GET  /api/leaderboard?period=today|week|month&tzOffset=<getTimezoneOffset()>
 * POST /api/leaderboard { player, multiplier, tickets, entryId?, at? }
 *
 * Privacy: never returns full wallet addresses. Handles only. No cash-out counts.
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

const CACHE_URL = 'https://megapush.lb.internal/v2/entries';
const KV_KEY = 'leaderboard:v2:entries';
const MAX_ENTRIES = 5000;

/**
 * @param {string} period
 * @param {number} tzOffsetMin - from Date.getTimezoneOffset() (min to add to local → UTC)
 */
function periodStartMs(period, tzOffsetMin = 0) {
  const now = Date.now();
  const p = String(period || 'today').toLowerCase();
  if (p === 'week') return now - 7 * 24 * 60 * 60 * 1000;
  if (p === 'month') return now - 30 * 24 * 60 * 60 * 1000;
  // "today" = local calendar day using client timezone offset
  const off = Number(tzOffsetMin);
  const offsetMs = Number.isFinite(off) ? off * 60 * 1000 : 0;
  const localNow = now - offsetMs;
  const d = new Date(localNow);
  const localMidnightAsUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return localMidnightAsUtc + offsetMs;
}

function normalizePeriod(period) {
  const p = String(period || 'today').toLowerCase();
  if (p === 'week' || p === 'month' || p === 'today') return p;
  if (p === 'all' || p === 'alltime' || p === 'all-time') return 'month';
  return 'today';
}

async function loadEntries(env) {
  const byId = new Map();
  const absorb = (list) => {
    for (const e of list || []) {
      if (!e || !e.id) continue;
      const prev = byId.get(e.id);
      if (!prev || Number(e.at) >= Number(prev.at)) byId.set(e.id, e);
    }
  };

  // KV (durable)
  try {
    const kv = env?.BANK_KV;
    if (kv && typeof kv.get === 'function') {
      const raw = await kv.get(KV_KEY, { type: 'json' });
      if (raw && Array.isArray(raw.entries)) absorb(raw.entries);
      else if (Array.isArray(raw)) absorb(raw);
    }
  } catch (e) {
    console.warn('lb kv get', e);
  }

  // Cache (legacy v1 + v2) — merge, then write back to KV
  for (const url of [
    CACHE_URL,
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

  // Persist merged set to KV when possible
  if (entries.length) {
    try {
      const kv = env?.BANK_KV;
      if (kv?.put) {
        await kv.put(KV_KEY, JSON.stringify({ entries, updatedAt: Date.now() }));
      }
    } catch (_) {}
  }
  return entries;
}

async function saveEntries(entries, env) {
  const body = {
    entries: (entries || []).slice(-MAX_ENTRIES),
    updatedAt: Date.now(),
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
  const mult = Number(multiplier);
  const tix = Math.max(0, Math.floor(Number(tickets) || 0));
  if (!(mult > 0) || !Number.isFinite(mult)) return { ok: false, error: 'Invalid multiplier' };

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
    mult: Math.round(mult * 100) / 100,
    tickets: tix,
    at: Number(at) > 0 ? Number(at) : Date.now(),
  });
  await saveEntries(entries, env);
  return { ok: true, id };
}

function aggregate(entries, period, tzOffsetMin, viewer) {
  const start = periodStartMs(period, tzOffsetMin);
  const now = Date.now();
  const filtered = entries.filter((e) => {
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
    // period-scoped stats only (not all-time)
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
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    const player = url.searchParams.get('player');
    const tzOffset = Number(url.searchParams.get('tzOffset'));
    const entries = await loadEntries(env);
    const agg = aggregate(entries, period, tzOffset, player);
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
      durable: !!(env?.BANK_KV),
      period: agg.period,
      since: agg.since,
      until: agg.until,
      events: agg.events,
      players: agg.players,
      top: agg.top,
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
    const result = await recordScore(
      {
        player: body.player || body.recipient || body.address,
        multiplier: body.multiplier ?? body.mult ?? body.at,
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
