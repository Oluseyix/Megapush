/**
 * Global leaderboard + live activity feed — backed by Cloudflare KV
 * (env.MEGAPUSH_KV). Records each successful cash-out (best multiplier +
 * total tickets per player) and exposes them via GET /api/leaderboard.
 *
 * If MEGAPUSH_KV isn't bound yet (see wrangler.toml), this degrades to a
 * harmless no-op: recording is skipped and the endpoint reports
 * `configured: false` with empty lists, so the frontend can fall back
 * gracefully instead of showing fabricated data.
 */

const TOP_KEY = 'lb:top';
const ACTIVITY_KEY = 'lb:activity';
const MAX_TOP = 50;
const MAX_ACTIVITY = 20;

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

function safeArray(raw) {
  try {
    const j = raw ? JSON.parse(raw) : [];
    return Array.isArray(j) ? j : [];
  } catch (_) {
    return [];
  }
}

/** Record a successful cash-out. Never throws — best-effort only. */
export async function recordCashout(env, player, mult, tickets) {
  if (!env?.MEGAPUSH_KV) return;
  const addr = String(player || '').toLowerCase();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return;
  const m = Number(mult);
  const t = Math.max(0, Math.floor(Number(tickets) || 0));
  if (!(m > 0) || t <= 0) return;

  try {
    const list = safeArray(await env.MEGAPUSH_KV.get(TOP_KEY));
    const existing = list.find((e) => e && e.address === addr);
    if (existing) {
      existing.bestMult = Math.max(Number(existing.bestMult) || 0, m);
      existing.tickets = Math.max(0, Math.floor(Number(existing.tickets) || 0)) + t;
      existing.at = Date.now();
    } else {
      list.push({ address: addr, bestMult: m, tickets: t, at: Date.now() });
    }
    list.sort((a, b) => (Number(b.bestMult) || 0) - (Number(a.bestMult) || 0));
    await env.MEGAPUSH_KV.put(TOP_KEY, JSON.stringify(list.slice(0, MAX_TOP)));
  } catch (e) {
    console.warn('leaderboard record failed', e?.message || e);
  }

  try {
    const feed = safeArray(await env.MEGAPUSH_KV.get(ACTIVITY_KEY));
    feed.unshift({ address: addr, mult: m, tickets: t, at: Date.now() });
    await env.MEGAPUSH_KV.put(ACTIVITY_KEY, JSON.stringify(feed.slice(0, MAX_ACTIVITY)));
  } catch (e) {
    console.warn('activity record failed', e?.message || e);
  }
}

export async function handleLeaderboard(request, env) {
  if (!env?.MEGAPUSH_KV) {
    return json({ ok: true, configured: false, top: [], activity: [] });
  }
  try {
    const [topRaw, activityRaw] = await Promise.all([
      env.MEGAPUSH_KV.get(TOP_KEY),
      env.MEGAPUSH_KV.get(ACTIVITY_KEY),
    ]);
    return json({
      ok: true,
      configured: true,
      top: safeArray(topRaw),
      activity: safeArray(activityRaw),
    });
  } catch (e) {
    return json({ ok: false, error: e?.message || String(e) }, 500);
  }
}
