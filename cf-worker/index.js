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
        if (path === '/api/round') {
          return handleRound(request, env);
        }
        if (path === '/api/verify') {
          return handleVerify(request, env);
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
        if (path === '/api/leaderboard') {
          return handleLeaderboard(request, env);
        }
        return json({ ok: false, error: 'Not found' }, 404);
      } catch (e) {
        console.error('api error', e?.message || e);
        return json({ ok: false, error: 'Internal error' }, 500);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};
