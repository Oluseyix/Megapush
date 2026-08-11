/**
 * TxSequencerDO — serial house on-chain actions (step 5).
 *
 * Single instance: idFromName('house')
 * All house-signed txs go through POST /execute so nonces never race.
 *
 * Types:
 *   cashout       — buyTickets chunks for player
 *   usdc_transfer — house → player USDC (withdraw / rare refund)
 *   settleBatch   — reserved for escrow (payload stored; not yet on-chain)
 */

import {
  buyTicketsForPlayer,
  transferUsdcFromHouse,
  envGet,
} from '../house-tx.js';

const KEY = {
  seq: 'seq',
  lastResult: 'lastResult',
  resultsById: 'resultsById', // idempotency cache
  hourWindow: 'hourWindow', // { startMs, payoutUsdc, jobs }
  minuteWindow: 'minuteWindow', // { startMs, jobs }
  processing: 'processing',
  processingAt: 'processingAt',
};

const MAX_RESULT_CACHE = 200;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export class TxSequencerDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (request.method === 'GET' && (path === '/' || path === '/status')) {
        return this.status();
      }
      if (request.method === 'POST' && path === '/execute') {
        // DO processes one request at a time → global house lock
        return this.execute(request);
      }
      if (request.method === 'POST' && path === '/enqueue') {
        // Alias: enqueue+run immediately (same as execute for request/response path)
        return this.execute(request);
      }
      if (request.method === 'POST' && path === '/drain') {
        return json({
          ok: true,
          do: 'TxSequencerDO',
          drained: false,
          note: 'Jobs run inline on /execute; no async queue drain needed',
        });
      }
      if (request.method === 'POST' && path === '/clear') {
        // Route exists only when ADMIN_TOKEN is configured
        const token = String(this.env?.ADMIN_TOKEN || '').trim();
        if (token.length < 16) {
          return json({ ok: false, error: 'Not found' }, 404);
        }
        const auth = request.headers.get('Authorization') || '';
        const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        if (bearer !== token) {
          return json({ ok: false, error: 'Forbidden' }, 403);
        }
        await this.state.storage.put(KEY.resultsById, {});
        await this.state.storage.put(KEY.processing, false);
        return json({ ok: true, cleared: true });
      }
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (e) {
      return json(
        {
          ok: false,
          error: e?.shortMessage || e?.message || String(e),
          do: 'TxSequencerDO',
          statusCode: e?.statusCode || 500,
        },
        e?.statusCode || 500,
      );
    }
  }

  async status() {
    const seq = Number((await this.state.storage.get(KEY.seq)) || 0);
    const lastResult = (await this.state.storage.get(KEY.lastResult)) || null;
    const hour = (await this.state.storage.get(KEY.hourWindow)) || null;
    const minute = (await this.state.storage.get(KEY.minuteWindow)) || null;
    const processing = !!(await this.state.storage.get(KEY.processing));
    return json({
      ok: true,
      seq,
      processing,
      lastStatus: lastResult?.status || null,
      rateLimited: (minute?.jobs || 0) >= maxJobsPerMinute(this.env),
    });
  }

  /**
   * Body: { type, id?, payload }
   */
  async execute(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    // Support both { type, payload } and flat enqueue shape
    const type = String(body.type || 'unknown');
    const payload = body.payload != null ? body.payload : body;
    const jobId =
      body.id ||
      payload.entryId ||
      payload.id ||
      `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (!type || type === 'unknown') {
      return json({ ok: false, error: 'type required (cashout|usdc_transfer|settleBatch)' }, 400);
    }

    // Idempotency: return cached success for same id
    const cache = (await this.state.storage.get(KEY.resultsById)) || {};
    if (cache[jobId]?.status === 'completed' && cache[jobId]?.result?.ok) {
      return json({
        ok: true,
        do: 'TxSequencerDO',
        already: true,
        id: jobId,
        type,
        result: cache[jobId].result,
      });
    }

    // Rate limits
    const rateErr = await this.checkRateLimits(type, payload);
    if (rateErr) return json(rateErr, rateErr.statusCode || 429);

    // Stale "processing" lock can strand withdraws/cashouts — clear if older than 15s
    // (long RPC no longer holds the lock; 15s is enough to detect a crashed mid-job)
    const lockAt = Number((await this.state.storage.get(KEY.processingAt)) || 0);
    if ((await this.state.storage.get(KEY.processing)) && lockAt > 0 && Date.now() - lockAt > 15_000) {
      console.warn('TxSequencerDO clearing stale processing lock', { lockAt });
      await this.state.storage.put(KEY.processing, false);
      await this.state.storage.delete(KEY.processingAt);
    }
    if (await this.state.storage.get(KEY.processing)) {
      // Soft busy — callers (cashout/withdraw) fall through to direct house path
      return json({ ok: false, error: 'House sequencer busy — retry', retry: true }, 503);
    }

    // Mark busy briefly, then release storage before long RPC (avoids DO storage timeout reset)
    await this.state.storage.put(KEY.processing, true);
    await this.state.storage.put(KEY.processingAt, Date.now());
    const seq = Number((await this.state.storage.get(KEY.seq)) || 0) + 1;
    await this.state.storage.put(KEY.seq, seq);

    const startedAt = Date.now();
    let result;
    let status = 'completed';
    let error = null;

    try {
      // Clear the processing lock right before external I/O so storage isn't held open
      // for multi-second ticket buys (that was resetting the DO).
      await this.state.storage.put(KEY.processing, false);
      await this.state.storage.delete(KEY.processingAt);

      if (type === 'cashout') {
        result = await buyTicketsForPlayer(this.env, {
          recipient: payload.recipient,
          tickets: payload.tickets,
        });
        result.sequencer = { id: jobId, seq, type: 'cashout' };
      } else if (type === 'usdc_transfer' || type === 'withdraw' || type === 'refund') {
        result = await transferUsdcFromHouse(this.env, {
          to: payload.to || payload.player || payload.recipient,
          amountUsdc: payload.amountUsdc ?? payload.amount ?? payload.stake,
        });
        result.sequencer = { id: jobId, seq, type: 'usdc_transfer' };
      } else if (type === 'settleBatch') {
        result = {
          ok: true,
          pending: true,
          type: 'settleBatch',
          payload,
          note: 'Escrow settleBatch not wired — recorded only',
        };
      } else {
        const err = new Error(`Unknown job type: ${type}`);
        err.statusCode = 400;
        throw err;
      }

      await this.recordSuccess(type, payload, result);
    } catch (e) {
      status = 'failed';
      error = e?.shortMessage || e?.message || String(e);
      result = {
        ok: false,
        error,
        statusCode: e?.statusCode || 500,
      };
    } finally {
      try {
        await this.state.storage.put(KEY.processing, false);
        await this.state.storage.delete(KEY.processingAt);
      } catch (_) {}
    }

    const record = {
      id: jobId,
      seq,
      type,
      status,
      startedAt,
      completedAt: Date.now(),
      result,
      error,
    };

    await this.state.storage.put(KEY.lastResult, {
      id: jobId,
      type,
      status,
      completedAt: record.completedAt,
      result: result?.ok ? { ok: true, txHash: result.txHash } : { ok: false, error },
    });

    // Cache successes for idempotency
    if (result?.ok) {
      cache[jobId] = record;
      const ids = Object.keys(cache);
      if (ids.length > MAX_RESULT_CACHE) {
        for (const id of ids.slice(0, ids.length - MAX_RESULT_CACHE)) delete cache[id];
      }
      await this.state.storage.put(KEY.resultsById, cache);
    }

    if (!result?.ok) {
      return json(
        {
          ok: false,
          do: 'TxSequencerDO',
          id: jobId,
          type,
          seq,
          error: result.error,
          result,
        },
        result.statusCode || 500,
      );
    }

    return json({
      ok: true,
      do: 'TxSequencerDO',
      id: jobId,
      type,
      seq,
      result,
    });
  }

  async checkRateLimits(type, payload) {
    const now = Date.now();
    let minute = (await this.state.storage.get(KEY.minuteWindow)) || {
      startMs: now,
      jobs: 0,
    };
    if (now - minute.startMs > MINUTE_MS) {
      minute = { startMs: now, jobs: 0 };
    }
    const maxMin = maxJobsPerMinute(this.env);
    if (minute.jobs >= maxMin) {
      return {
        ok: false,
        error: `Rate limit: max ${maxMin} house jobs/minute`,
        statusCode: 429,
        retryAfterMs: MINUTE_MS - (now - minute.startMs),
      };
    }

    let hour = (await this.state.storage.get(KEY.hourWindow)) || {
      startMs: now,
      payoutUsdc: 0,
      jobs: 0,
    };
    if (now - hour.startMs > HOUR_MS) {
      hour = { startMs: now, payoutUsdc: 0, jobs: 0 };
    }

    if (type === 'cashout') {
      const tickets = Math.floor(Number(payload.tickets) || 0);
      // ~0.01 USDC per ticket on Megapot testnet — use payload.costUsdc or tickets * 0.01
      const est =
        Number(payload.costUsdc) > 0
          ? Number(payload.costUsdc)
          : tickets > 0
            ? tickets * 0.01
            : Number(payload.stake) || 0;
      const maxHour = maxPayoutPerHour(this.env);
      if (hour.payoutUsdc + est > maxHour + 1e-9) {
        return {
          ok: false,
          error: `MAX_PAYOUT_PER_HOUR would be exceeded (${hour.payoutUsdc.toFixed(2)}/${maxHour})`,
          statusCode: 429,
          payoutUsdcThisHour: hour.payoutUsdc,
          maxPayoutPerHour: maxHour,
        };
      }
    }

    // Reserve slot (commit after success too — count attempts for abuse)
    minute.jobs += 1;
    hour.jobs += 1;
    await this.state.storage.put(KEY.minuteWindow, minute);
    await this.state.storage.put(KEY.hourWindow, hour);
    return null;
  }

  async recordSuccess(type, payload, result) {
    const now = Date.now();
    let hour = (await this.state.storage.get(KEY.hourWindow)) || {
      startMs: now,
      payoutUsdc: 0,
      jobs: 0,
    };
    if (now - hour.startMs > HOUR_MS) {
      hour = { startMs: now, payoutUsdc: 0, jobs: 0 };
    }
    if (type === 'cashout') {
      const add =
        Number(result.costUsdc) > 0
          ? Number(result.costUsdc)
          : Number(payload.costUsdc) > 0
            ? Number(payload.costUsdc)
            : (Number(result.tickets) || 0) * 0.01;
      hour.payoutUsdc = Math.round((hour.payoutUsdc + add) * 100) / 100;
    } else if (type === 'usdc_transfer' || type === 'withdraw' || type === 'refund') {
      const add = Number(payload.amountUsdc ?? payload.amount ?? payload.stake) || 0;
      hour.payoutUsdc = Math.round((hour.payoutUsdc + add) * 100) / 100;
    }
    await this.state.storage.put(KEY.hourWindow, hour);
  }
}

function maxJobsPerMinute(env) {
  const n = Number(envGet(env, 'MAX_HOUSE_JOBS_PER_MINUTE'));
  return Number.isFinite(n) && n > 0 ? n : 40;
}

function maxPayoutPerHour(env) {
  const n = Number(envGet(env, 'MAX_PAYOUT_PER_HOUR'));
  return Number.isFinite(n) && n > 0 ? n : 2000;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
