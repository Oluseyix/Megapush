/**
 * Cloudflare Pages Advanced Mode entry.
 * Built into public/_worker.js — handles /api/* then falls through to static assets.
 */
import { handleCashout } from './cashout.js';
import { handleRefund } from './refund.js';
import { handleHealth } from './health.js';
import { handleRound } from './round.js';
import { handleBank } from './bank.js';

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    // API routes
    if (path.startsWith('/api/') || path === '/api') {
      if (request.method === 'OPTIONS') {
        return cors('GET, POST, OPTIONS');
      }

      try {
        if (path === '/api/ping') {
          return json({
            ok: true,
            platform: 'cloudflare-pages-worker',
            route: '/api/ping',
            ts: Date.now(),
          });
        }
        if (path === '/api/health') {
          return handleHealth(request, env);
        }
        if (path === '/api/round') {
          return handleRound(request, env);
        }
        if (path === '/api/cashout') {
          if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
          return handleCashout(request, env);
        }
        if (path === '/api/refund') {
          if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
          return handleRefund(request, env);
        }
        if (path === '/api/bank') {
          return handleBank(request, env);
        }
        return json({ ok: false, error: 'Unknown API route', path }, 404);
      } catch (e) {
        return json({ ok: false, error: e?.message || String(e), platform: 'cloudflare-pages-worker' }, 500);
      }
    }

    // Static assets (game.html, index.html, …)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
// bank 1786368165
