/**
 * Edge-cached Megapot prize pool for instant first paint.
 * KV + stale-while-revalidate so HTML can inject the value before JS runs.
 */

const MEGAPOT_ACTIVE = 'https://api.megapot.io/v1/rounds/active';
const KV_KEY = 'mp_pot_cache_v1';
const FRESH_MS = 45_000;
const STALE_OK_MS = 6 * 60 * 60 * 1000; // serve stale up to 6h while refreshing
/** Last-known-good seed so cold edge never shows "…" */
const SEED = { text: '$1.10M', at: 0, seeded: true };

function formatPotUsd(amountStr, decimals) {
  try {
    let s = String(amountStr || '0').replace(/[^\d]/g, '');
    if (!s) return null;
    const d = Number.isFinite(Number(decimals)) && Number(decimals) >= 0 ? Number(decimals) : 6;
    if (s.length <= d) s = s.padStart(d + 1, '0');
    const whole = s.slice(0, s.length - d) || '0';
    const n = Number(whole);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    return '$' + n.toFixed(2);
  } catch {
    return null;
  }
}

function parseDrawEndsAt(j) {
  const ended = j?.ended_at || j?.endedAt || j?.drawing_time || j?.drawingTime;
  if (ended == null) return null;
  const ms = typeof ended === 'number' ? (ended < 1e12 ? ended * 1000 : ended) : Date.parse(ended);
  return Number.isFinite(ms) ? ms : null;
}

async function fetchLivePot() {
  const r = await fetch(MEGAPOT_ACTIVE, {
    headers: { Accept: 'application/json' },
    cf: { cacheTtl: 30, cacheEverything: true },
  });
  if (!r.ok) throw new Error('megapot ' + r.status);
  const j = await r.json();
  const amt = j.prize_pool?.amount || j.prizePool?.amount;
  const dec = j.prize_pool?.decimals ?? j.prizePool?.decimals ?? 6;
  const text = formatPotUsd(amt, dec);
  if (!text) throw new Error('empty pot');
  return {
    text,
    amount: String(amt),
    decimals: Number(dec),
    drawEndsAt: parseDrawEndsAt(j),
    at: Date.now(),
    seeded: false,
  };
}

async function readKv(env) {
  try {
    if (!env?.BANK_KV) return null;
    return await env.BANK_KV.get(KV_KEY, 'json');
  } catch {
    return null;
  }
}

async function writeKv(env, data) {
  try {
    if (!env?.BANK_KV || !data?.text) return;
    await env.BANK_KV.put(KV_KEY, JSON.stringify(data), { expirationTtl: 86400 });
  } catch (_) {}
}

async function refreshAndStore(env) {
  const live = await fetchLivePot();
  await writeKv(env, live);
  return live;
}

/**
 * Prefer fresh KV, else stale + background refresh, else live fetch, else seed.
 * @param {{ allowBlock?: boolean }} opts
 *   allowBlock=false → never wait on Megapot (HTML first paint); seed/stale only + waitUntil refresh
 */
export async function getCachedPot(env, ctx, opts = {}) {
  const allowBlock = opts.allowBlock !== false;
  const cached = await readKv(env);
  const now = Date.now();

  if (cached?.text && now - Number(cached.at || 0) < FRESH_MS) {
    return cached;
  }

  if (cached?.text && now - Number(cached.at || 0) < STALE_OK_MS) {
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        refreshAndStore(env).catch((e) => console.warn('pot refresh', e?.message || e))
      );
    }
    return cached;
  }

  // HTML path: never stall page on Megapot (~1s). Seed now; warm KV in background.
  if (!allowBlock) {
    if (ctx?.waitUntil) {
      ctx.waitUntil(
        refreshAndStore(env).catch((e) => console.warn('pot refresh', e?.message || e))
      );
    }
    if (cached?.text) return cached;
    return { ...SEED, at: now };
  }

  try {
    return await refreshAndStore(env);
  } catch (e) {
    console.warn('pot live fail', e?.message || e);
    if (cached?.text) return cached;
    return { ...SEED, at: now };
  }
}

export async function handlePot(request, env, ctx) {
  const pot = await getCachedPot(env, ctx);
  return new Response(
    JSON.stringify({
      ok: true,
      text: pot.text,
      amount: pot.amount || null,
      decimals: pot.decimals ?? null,
      drawEndsAt: pot.drawEndsAt ?? null,
      at: pot.at || Date.now(),
      seeded: !!pot.seeded,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=30, stale-while-revalidate=120',
      },
    }
  );
}

/**
 * Inject pot into game HTML so first paint never shows "…" / "—".
 */
export function rewriteHtmlWithPot(response, pot) {
  if (!pot?.text) return response;
  const text = String(pot.text);
  const draw = pot.drawEndsAt != null && Number.isFinite(Number(pot.drawEndsAt))
    ? Number(pot.drawEndsAt)
    : null;
  const boot = `<script>window.__mpPotPainted=${JSON.stringify(text)};window.__mpDrawEndsAtEarly=${JSON.stringify(draw)};</script>`;

  return new HTMLRewriter()
    .on('#potFig', {
      element(el) {
        el.setInnerContent(text);
        el.removeAttribute('data-pot-loading');
      },
    })
    .on('head', {
      element(el) {
        el.append(boot, { html: true });
      },
    })
    .transform(response);
}
