/**
 * Cloudflare Workers + Static Assets entry.
 * Public routes only — no admin probe surface.
 */
import { handleCashout } from './cashout.js';
import { handleRefund } from './refund.js';
import { handleHealth } from './health.js';
import { handleRound } from './round.js';
import { handleBank } from './bank.js';
import { handleLeaderboard } from './leaderboard.js';
import { handleVerify } from './verify.js';
import { getCachedPot, handlePot, rewriteHtmlWithPot } from './pot.js';
import { handleBootstrap } from './bootstrap.js';

export { RoundDO } from './dos/round-do.js';
export { TxSequencerDO } from './dos/tx-sequencer-do.js';

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

function cors(methods) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': methods,
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function killSwitchActive(env) {
  const v = env?.KILL_SWITCH;
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Game shell HTML that shows #potFig — inject edge pot for zero-flash first paint. */
function isGameHtmlPath(path) {
  return (
    path === '/' ||
    path === '/game' ||
    path === '/game.html' ||
    path === '/megapush' ||
    path === '/megapush.html' ||
    path === '/index.html'
  );
}

async function serveAssets(request, env, ctx) {
  if (!env.ASSETS) {
    return new Response('Not found', { status: 404 });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || '/';
  const accept = request.headers.get('Accept') || '';
  const wantsHtml =
    request.method === 'GET' &&
    (isGameHtmlPath(path) || accept.includes('text/html'));

  if (!wantsHtml) {
    return env.ASSETS.fetch(request);
  }

  // Non-blocking pot: KV/seed only — never delay HTML on Megapot RTT
  const potPromise = getCachedPot(env, ctx, { allowBlock: false }).catch(() => null);
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('Content-Type') || '';
  if (!res.ok || !ct.includes('text/html')) {
    return res;
  }

  const pot = await potPromise;
  if (!pot?.text) return res;
  return rewriteHtmlWithPot(res, pot);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (path.startsWith('/api/') || path === '/api') {
      if (request.method === 'OPTIONS') {
        return cors('GET, POST, OPTIONS');
      }

      if (
        killSwitchActive(env) &&
        (path === '/api/cashout' || path === '/api/refund' || path === '/api/bank')
      ) {
        return json({ ok: false, error: 'Service temporarily paused' }, 503);
      }

      try {
        if (path === '/api/ping') {
          return json({ ok: true, ts: Date.now() });
        }
        if (path === '/api/health') {
          return handleHealth(request, env);
        }
        if (path === '/api/pot') {
          return handlePot(request, env, ctx);
        }
        if (path === '/api/round') {
          return handleRound(request, env);
        }
        if (path === '/api/verify') {
          return handleVerify(request, env);
        }
        if (path === '/api/cashout') {
          if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
          return handleCashout(request, env, ctx);
        }
        if (path === '/api/refund') {
          if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
          return handleRefund(request, env);
        }
        if (path === '/api/bank') {
          return handleBank(request, env);
        }
        if (path === '/api/leaderboard') {
          return handleLeaderboard(request, env);
        }
        if (path === '/api/bootstrap/house') {
          return handleBootstrap(request, env);
        }
        return json({ ok: false, error: 'Not found' }, 404);
      } catch (e) {
        console.error('api error', e?.message || e);
        return json({ ok: false, error: 'Internal error' }, 500);
      }
    }

    return serveAssets(request, env, ctx);
  },
};
