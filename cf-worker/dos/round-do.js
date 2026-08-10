/**
 * RoundDO — global round lifecycle + exposure (step 4).
 *
 * Single instance: idFromName('global')
 * - Syncs hand to shared commit-reveal curve (hand-timing.js)
 * - Closes betting window at flyStart (lazy + alarm)
 * - Enforces MAX_ROUND_EXPOSURE on stake registration
 * - Resets exposure when hand rolls
 */

import {
  resolveLiveHand,
  masterSecret,
  hasRoundSecret,
  capsFromEnv,
  exposureForStake,
  BET_MS,
  FAIR_SCHEME,
} from '../hand-timing.js';
import { elapsedForMult } from '../crash-curve.js';

const KEY = {
  hand: 'hand', // durable snapshot of current hand + exposure
  kill: 'kill',
  entries: 'entries', // map entryId -> stake row
};

/**
 * @typedef {{
 *   roundId: number,
 *   slotId: number,
 *   hand: number,
 *   serverSeedHash: string|null,
 *   flyStart: number|null,
 *   crashAt: number|null,
 *   resultEnd: number|null,
 *   handStart: number|null,
 *   phase: string,
 *   windowClosed: boolean,
 *   exposureUsdc: number,
 *   stakeCount: number,
 *   updatedAt: number,
 * }} HandState
 */

export class RoundDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (request.method === 'GET' && (path === '/' || path === '/status' || path === '/state')) {
        return this.publicState();
      }
      if (request.method === 'GET' && path === '/exposure') {
        await this.ensure(Date.now());
        return this.getExposure();
      }
      if (request.method === 'POST' && path === '/ensure') {
        let body = {};
        try {
          body = await request.json();
        } catch {
          body = {};
        }
        const now = Number(body.now) || Date.now();
        const h = await this.ensure(now);
        return json({ ok: true, do: 'RoundDO', ...this.publicFields(h) });
      }
      if (request.method === 'POST' && path === '/stake') {
        return this.recordStake(request);
      }
      if (request.method === 'POST' && path === '/release') {
        return this.releaseStake(request);
      }
      if (request.method === 'POST' && path === '/settle-entry') {
        return this.settleEntry(request);
      }
      // Admin routes exist only when ADMIN_TOKEN is set (else 404 as if absent)
      if (request.method === 'POST' && path === '/close-window') {
        const gate = adminGate(request, this.env);
        if (gate) return gate;
        return this.forceCloseWindow();
      }
      if (request.method === 'POST' && path === '/reset-exposure') {
        const gate = adminGate(request, this.env);
        if (gate) return gate;
        return this.resetExposureOnly();
      }
      if (request.method === 'POST' && path === '/kill') {
        const gate = adminGate(request, this.env);
        if (gate) return gate;
        return this.setKill(request);
      }
      return json({ ok: false, error: 'Not found' }, 404);
    } catch (e) {
      return json({ ok: false, error: e?.message || String(e), do: 'RoundDO' }, 500);
    }
  }

  async alarm() {
    try {
      const now = Date.now();
      await this.ensure(now);
      await this.processAutoBanks(now);
      const hand = (await this.state.storage.get(KEY.hand)) || {};
      await this.scheduleAlarm(hand, Date.now());
    } catch (e) {
      console.error('RoundDO alarm', e?.message || e);
    }
  }

  /**
   * Align durable hand with global curve; reset exposure on hand change;
   * close window after flyStart; schedule next alarm.
   * @param {number} nowMs
   * @returns {Promise<HandState>}
   */
  async ensure(nowMs) {
    // No ROUND_SECRET → never open a betting window (no weak default seeds).
    if (!hasRoundSecret(this.env)) {
      const hand = {
        roundId: null,
        slotId: null,
        hand: null,
        serverSeedHash: null,
        flyStart: null,
        crashAt: null,
        resultEnd: null,
        handStart: null,
        phase: 'intermission',
        windowClosed: true,
        exposureUsdc: 0,
        stakeCount: 0,
        updatedAt: nowMs,
        unconfigured: true,
      };
      await this.state.storage.put(KEY.hand, hand);
      return hand;
    }

    const secret = masterSecret(this.env);
    const live = await resolveLiveHand(nowMs, secret);
    let hand = (await this.state.storage.get(KEY.hand)) || null;
    let entries = (await this.state.storage.get(KEY.entries)) || {};

    const rolled = !hand || hand.unconfigured || hand.roundId !== live.roundId;
    if (rolled) {
      entries = {};
      hand = {
        roundId: live.roundId,
        slotId: live.slotId,
        hand: live.hand,
        serverSeedHash: live.serverSeedHash,
        flyStart: live.flyStart ?? live.timing?.flyStart ?? null,
        crashAt: live.crashAt ?? live.timing?.crashAt ?? null,
        resultEnd: live.resultEnd ?? live.timing?.resultEnd ?? null,
        handStart: live.handStart ?? live.timing?.handStart ?? null,
        phase: live.phase,
        windowClosed: live.phase !== 'betting',
        exposureUsdc: 0,
        stakeCount: 0,
        updatedAt: nowMs,
        unconfigured: false,
      };
    } else {
      hand.phase = live.phase;
      hand.serverSeedHash = live.serverSeedHash || hand.serverSeedHash;
      hand.flyStart = live.flyStart ?? hand.flyStart;
      hand.crashAt = live.crashAt ?? hand.crashAt;
      hand.resultEnd = live.resultEnd ?? hand.resultEnd;
      hand.handStart = live.handStart ?? hand.handStart;
      if (live.phase !== 'betting') {
        hand.windowClosed = true;
      }
      // Recompute exposure from open entries (source of truth)
      let exp = 0;
      let count = 0;
      for (const e of Object.values(entries)) {
        if (e && e.status === 'open') {
          exp += Number(e.exposureAdd) || 0;
          count += 1;
        }
      }
      hand.exposureUsdc = Math.round(exp * 100) / 100;
      hand.stakeCount = count;
      hand.updatedAt = nowMs;
      hand.unconfigured = false;
    }

    await this.state.storage.put(KEY.hand, hand);
    await this.state.storage.put(KEY.entries, entries);
    await this.scheduleAlarm(hand, nowMs);
    return hand;
  }

  async scheduleAlarm(hand, nowMs) {
    const targets = [];
    if (hand.flyStart != null && nowMs < hand.flyStart) targets.push(hand.flyStart);
    if (hand.crashAt != null && nowMs < hand.crashAt) targets.push(hand.crashAt);
    if (hand.resultEnd != null && nowMs < hand.resultEnd + 50) targets.push(hand.resultEnd + 50);
    if (hand.phase === 'betting' && hand.flyStart != null) {
      targets.push(Math.min(nowMs + 1000, hand.flyStart));
    } else if (hand.phase === 'flying' && hand.crashAt != null) {
      targets.push(Math.min(nowMs + 2000, hand.crashAt));
    }
    // Server auto-bank: fire at flyStart + elapsedForMult(autoMult) for each open entry
    try {
      const entries = (await this.state.storage.get(KEY.entries)) || {};
      if (hand.flyStart != null) {
        for (const e of Object.values(entries)) {
          if (!e || e.status !== 'open' || !(Number(e.autoMult) > 1)) continue;
          const t = hand.flyStart + elapsedForMult(Number(e.autoMult));
          if (t > nowMs && (hand.crashAt == null || t < hand.crashAt)) targets.push(t);
        }
      }
    } catch (_) {}
    const next = targets.filter((t) => t > nowMs).sort((a, b) => a - b)[0];
    if (next != null) {
      try {
        await this.state.storage.setAlarm(next);
      } catch (e) {
        console.warn('setAlarm', e?.message || e);
      }
    }
  }

  /**
   * Server-side auto-bank: when curve mult reaches player's autoMult, execute cashout.
   */
  async processAutoBanks(nowMs) {
    const hand = (await this.state.storage.get(KEY.hand)) || {};
    if (hand.phase !== 'flying' || hand.flyStart == null) return;
    let entries = (await this.state.storage.get(KEY.entries)) || {};
    let changed = false;

    for (const id of Object.keys(entries)) {
      const e = entries[id];
      if (!e || e.status !== 'open' || !(Number(e.autoMult) > 1) || !e.player) continue;
      const targetAt = hand.flyStart + elapsedForMult(Number(e.autoMult));
      if (nowMs + 50 < targetAt) continue;
      if (hand.crashAt != null && nowMs >= hand.crashAt) continue;

      e.status = 'auto_pending';
      entries[id] = e;
      await this.state.storage.put(KEY.entries, entries);
      changed = true;

      try {
        const { executeCashoutSettlement } = await import('../cashout.js');
        const result = await executeCashoutSettlement(this.env, {
          recipient: e.player,
          stake: e.stakeUsdc,
          entryId: e.entryId || id,
          arrivalMs: Math.min(nowMs, Math.max(targetAt, hand.flyStart + 1)),
          auto: true,
        });
        // settle-entry / release handled inside cashout
        if (result?.ok || result?.lost) {
          // re-read entries after cashout
          entries = (await this.state.storage.get(KEY.entries)) || {};
        } else {
          e.status = 'open';
          entries[id] = e;
          await this.state.storage.put(KEY.entries, entries);
        }
      } catch (err) {
        console.error('auto-bank', err?.message || err);
        e.status = 'open';
        entries[id] = e;
        await this.state.storage.put(KEY.entries, entries);
      }
    }
    return changed;
  }

  publicFields(hand) {
    const caps = capsFromEnv(this.env);
    const kill = false; // filled in publicState
    return {
      step: 4,
      scaffold: false,
      roundId: hand?.roundId ?? null,
      slotId: hand?.slotId ?? null,
      hand: hand?.hand ?? null,
      phase: hand?.phase ?? 'intermission',
      acceptingBets:
        !hand?.unconfigured && hand?.phase === 'betting' && !hand?.windowClosed,
      windowClosed: !!hand?.windowClosed || !!hand?.unconfigured,
      serverSeedHash: hand?.serverSeedHash ?? null,
      flyStart: hand?.flyStart ?? null,
      bettingEndsAt: hand?.flyStart ?? null,
      crashAt: hand?.phase === 'crashed' || hand?.phase === 'intermission' ? hand?.crashAt : null,
      resultEnd: hand?.resultEnd ?? null,
      exposureUsdc: hand?.exposureUsdc ?? 0,
      stakeCount: hand?.stakeCount ?? 0,
      maxRoundExposureUsdc: caps.maxRoundExposureUsdc,
      maxPayoutMult: caps.maxPayoutMult,
      maxPayoutPerEntryUsdc: caps.maxPayoutPerEntryUsdc,
      remainingExposureUsdc: Math.max(
        0,
        caps.maxRoundExposureUsdc - (hand?.exposureUsdc ?? 0),
      ),
      fairScheme: FAIR_SCHEME,
      betMs: BET_MS,
    };
  }

  async publicState() {
    const now = Date.now();
    const hand = await this.ensure(now);
    const kill = !!(await this.state.storage.get(KEY.kill));
    const fields = this.publicFields(hand);
    // Public-ish status used only via server merge — omit ops notes
    return json({
      ok: true,
      kill,
      serverNow: now,
      roundId: fields.roundId,
      phase: fields.phase,
      acceptingBets: fields.acceptingBets && !kill,
      windowClosed: fields.windowClosed,
      exposureUsdc: fields.exposureUsdc,
      remainingExposureUsdc: fields.remainingExposureUsdc,
      maxRoundExposureUsdc: fields.maxRoundExposureUsdc,
      maxPayoutMult: fields.maxPayoutMult,
      maxPayoutPerEntryUsdc: fields.maxPayoutPerEntryUsdc,
      stakeCount: fields.stakeCount,
      serverSeedHash: fields.serverSeedHash,
      flyStart: fields.flyStart,
      bettingEndsAt: fields.bettingEndsAt,
    });
  }

  async getExposure() {
    const hand = (await this.state.storage.get(KEY.hand)) || { exposureUsdc: 0 };
    const caps = capsFromEnv(this.env);
    const exp = Number(hand.exposureUsdc) || 0;
    return json({
      ok: true,
      do: 'RoundDO',
      roundId: hand.roundId ?? null,
      phase: hand.phase ?? null,
      windowClosed: !!hand.windowClosed,
      exposureUsdc: exp,
      maxRoundExposureUsdc: caps.maxRoundExposureUsdc,
      remainingUsdc: Math.max(0, caps.maxRoundExposureUsdc - exp),
      atCap: exp >= caps.maxRoundExposureUsdc,
      stakeCount: hand.stakeCount || 0,
    });
  }

  /**
   * Register stake during betting window only.
   * Body: { stakeUsdc|stake, player, entryId, maxMultCap? }
   */
  async recordStake(request) {
    const now = Date.now();
    if (!hasRoundSecret(this.env)) {
      return json(
        { ok: false, error: 'ROUND_SECRET not configured — betting closed', windowClosed: true },
        503,
      );
    }
    if (await this.state.storage.get(KEY.kill)) {
      return json({ ok: false, error: 'Round kill switch active', kill: true }, 503);
    }

    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const stake = Math.floor(Number(body.stakeUsdc ?? body.stake) || 0);
    const entryId = body.entryId != null ? String(body.entryId) : '';
    const player = body.player ? String(body.player).toLowerCase() : null;
    if (!(stake > 0)) return json({ ok: false, error: 'stakeUsdc > 0 required' }, 400);
    if (!entryId) return json({ ok: false, error: 'entryId required' }, 400);

    const hand = await this.ensure(now);
    if (hand.unconfigured || hand.phase !== 'betting' || hand.windowClosed) {
      return json(
        {
          ok: false,
          error: 'Betting window closed',
          phase: hand.phase,
          windowClosed: true,
          roundId: hand.roundId,
          flyStart: hand.flyStart,
        },
        409,
      );
    }

    let entries = (await this.state.storage.get(KEY.entries)) || {};
    if (entries[entryId]) {
      const prev = entries[entryId];
      return json({
        ok: true,
        already: true,
        do: 'RoundDO',
        entryId,
        stake: prev.stakeUsdc,
        exposureAdd: prev.exposureAdd,
        roundId: hand.roundId,
        exposureUsdc: hand.exposureUsdc,
      });
    }

    const caps = capsFromEnv(this.env);
    let exposureAdd = exposureForStake(stake, this.env);
    if (Number(body.maxMultCap) > 0) {
      exposureAdd = Math.min(stake * Number(body.maxMultCap), caps.maxPayoutPerEntryUsdc);
    }
    exposureAdd = Math.round(exposureAdd * 100) / 100;

    if (hand.exposureUsdc + exposureAdd > caps.maxRoundExposureUsdc + 1e-9) {
      return json(
        {
          ok: false,
          error: 'MAX_ROUND_EXPOSURE would be exceeded',
          exposureUsdc: hand.exposureUsdc,
          maxRoundExposureUsdc: caps.maxRoundExposureUsdc,
          requestedAdd: exposureAdd,
          remainingUsdc: Math.max(0, caps.maxRoundExposureUsdc - hand.exposureUsdc),
          roundId: hand.roundId,
        },
        409,
      );
    }

    const autoMult =
      body.autoMult != null && Number(body.autoMult) > 1 ? Number(body.autoMult) : null;

    entries[entryId] = {
      entryId,
      player,
      stakeUsdc: stake,
      exposureAdd,
      status: 'open',
      roundId: hand.roundId,
      autoMult,
      at: now,
    };
    // Cap entry map
    const ids = Object.keys(entries);
    if (ids.length > 400) {
      const drop = ids.slice(0, ids.length - 400);
      for (const id of drop) delete entries[id];
    }

    hand.exposureUsdc = Math.round((hand.exposureUsdc + exposureAdd) * 100) / 100;
    hand.stakeCount = (hand.stakeCount || 0) + 1;
    hand.updatedAt = now;
    await this.state.storage.put(KEY.entries, entries);
    await this.state.storage.put(KEY.hand, hand);

    // Reschedule alarms so auto-bank fires at target mult
    await this.scheduleAlarm(hand, now);

    return json({
      ok: true,
      do: 'RoundDO',
      entryId,
      stake,
      exposureAdd,
      autoMult,
      roundId: hand.roundId,
      phase: hand.phase,
      exposureUsdc: hand.exposureUsdc,
      maxRoundExposureUsdc: caps.maxRoundExposureUsdc,
      remainingUsdc: Math.max(0, caps.maxRoundExposureUsdc - hand.exposureUsdc),
      flyStart: hand.flyStart,
    });
  }

  /**
   * Release exposure (cancel / refund / lost without settle).
   * Body: { entryId, reason? }
   */
  async releaseStake(request) {
    const now = Date.now();
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const entryId = body.entryId != null ? String(body.entryId) : '';
    if (!entryId) return json({ ok: false, error: 'entryId required' }, 400);

    await this.ensure(now);
    let entries = (await this.state.storage.get(KEY.entries)) || {};
    const row = entries[entryId];
    if (!row) {
      return json({ ok: true, already: true, missing: true, entryId });
    }
    if (row.status !== 'open') {
      return json({ ok: true, already: true, entryId, status: row.status });
    }

    row.status = body.reason === 'settled' ? 'settled' : 'released';
    row.releasedAt = now;
    row.releaseReason = body.reason || 'release';
    entries[entryId] = row;

    const hand = (await this.state.storage.get(KEY.hand)) || {};
    if (hand.roundId === row.roundId) {
      hand.exposureUsdc = Math.max(
        0,
        Math.round(((Number(hand.exposureUsdc) || 0) - (Number(row.exposureAdd) || 0)) * 100) / 100,
      );
      hand.stakeCount = Math.max(0, (hand.stakeCount || 1) - 1);
      hand.updatedAt = now;
      await this.state.storage.put(KEY.hand, hand);
    }
    await this.state.storage.put(KEY.entries, entries);

    return json({
      ok: true,
      do: 'RoundDO',
      entryId,
      status: row.status,
      exposureUsdc: hand.exposureUsdc ?? 0,
      released: row.exposureAdd,
    });
  }

  /**
   * Mark entry cashed out — release reserved exposure (actual tickets paid on-chain).
   * Body: { entryId, mult?, tickets?, payoutUsdc? }
   */
  async settleEntry(request) {
    const now = Date.now();
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const entryId = body.entryId != null ? String(body.entryId) : '';
    if (!entryId) return json({ ok: false, error: 'entryId required' }, 400);

    await this.ensure(now);
    let entries = (await this.state.storage.get(KEY.entries)) || {};
    const row = entries[entryId];
    if (!row) {
      return json({ ok: true, already: true, missing: true, entryId });
    }
    if (row.status === 'settled') {
      return json({ ok: true, already: true, entryId, status: 'settled' });
    }

    const wasOpen = row.status === 'open';
    row.status = 'settled';
    row.settledAt = now;
    row.settleMult = body.mult != null ? Number(body.mult) : null;
    row.tickets = body.tickets != null ? Number(body.tickets) : null;
    row.payoutUsdc = body.payoutUsdc != null ? Number(body.payoutUsdc) : null;
    entries[entryId] = row;

    const hand = (await this.state.storage.get(KEY.hand)) || {};
    if (wasOpen && hand.roundId === row.roundId) {
      hand.exposureUsdc = Math.max(
        0,
        Math.round(((Number(hand.exposureUsdc) || 0) - (Number(row.exposureAdd) || 0)) * 100) / 100,
      );
      hand.stakeCount = Math.max(0, (hand.stakeCount || 1) - 1);
      hand.updatedAt = now;
      await this.state.storage.put(KEY.hand, hand);
    }
    await this.state.storage.put(KEY.entries, entries);

    return json({
      ok: true,
      do: 'RoundDO',
      entryId,
      status: 'settled',
      exposureUsdc: hand.exposureUsdc ?? 0,
    });
  }

  async forceCloseWindow() {
    const hand = await this.ensure(Date.now());
    hand.windowClosed = true;
    hand.updatedAt = Date.now();
    await this.state.storage.put(KEY.hand, hand);
    return json({
      ok: true,
      do: 'RoundDO',
      windowClosed: true,
      roundId: hand.roundId,
      phase: hand.phase,
    });
  }

  async resetExposureOnly() {
    const hand = await this.ensure(Date.now());
    hand.exposureUsdc = 0;
    hand.stakeCount = 0;
    await this.state.storage.put(KEY.hand, hand);
    await this.state.storage.put(KEY.entries, {});
    return json({ ok: true, do: 'RoundDO', exposureUsdc: 0, roundId: hand.roundId });
  }

  async setKill(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const kill = body.kill !== false && body.kill !== 0 && body.kill !== '0';
    await this.state.storage.put(KEY.kill, !!kill);
    return json({ ok: true, do: 'RoundDO', kill: !!kill });
  }
}

const ADMIN_TOKEN_MIN_LEN = 16;

function adminConfigured(env) {
  const token = String(env?.ADMIN_TOKEN || '').trim();
  return token.length >= ADMIN_TOKEN_MIN_LEN;
}

/**
 * Admin routes: 404 when ADMIN_TOKEN unset (route does not exist);
 * 403 when set but Authorization does not match.
 * @returns {Response|null} error response, or null if authorized
 */
function adminGate(request, env) {
  if (!adminConfigured(env)) {
    return json({ ok: false, error: 'Not found' }, 404);
  }
  const token = String(env.ADMIN_TOKEN).trim();
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const hdr = request.headers.get('X-Admin-Token') || '';
  if (bearer !== token && hdr !== token) {
    return json({ ok: false, error: 'Forbidden' }, 403);
  }
  return null;
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
