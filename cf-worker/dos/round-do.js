/**
 * RoundDO — global round lifecycle + exposure + future-block entropy.
 *
 * Single instance: idFromName('global')
 * - Opens hands with serverSeed + targetBlock (crash unknown during betting)
 * - Resolves crash from sha256(serverSeed||blockHash) once targetBlock is mined
 * - Voids + refunds if target block never appears (no server-only fallback)
 * - Enforces MAX_ROUND_EXPOSURE on stake registration
 */

import {
  masterSecret,
  hasRoundSecret,
  capsFromEnv,
  exposureForStake,
  timingFromHand,
  BET_MS,
  RESULT_MS,
  FAIR_SCHEME,
  TARGET_BLOCK_OFFSET,
  ENTROPY_WAIT_MAX_MS,
  crashFromSeedAndBlock,
  flightFromCrash,
  multOnCurve,
  settlementFromArrival,
  settlementFromIntent,
  sha256Hex,
  GROWTH_PER_MS,
  CYCLE_MS,
} from '../hand-timing.js';
import { elapsedForMult } from '../crash-curve.js';
import { getBlockNumber, getBlockByNumber } from '../base-rpc.js';
import {
  ensureChainReady,
  consumeNextSeed,
  chainPublicView,
  CHAIN_KEY,
} from '../seed-chain.js';

const KEY = {
  hand: 'hand',
  kill: 'kill',
  entries: 'entries',
  seq: 'seq',
  history: 'history',
};

const HISTORY_MAX = 40;

export class RoundDO {
  /** @param {DurableObjectState} state @param {Env} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // ctx for waitUntil (auto-bank must not run long chain buys inside storage path)
    this.ctx = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      if (request.method === 'GET' && (path === '/' || path === '/status' || path === '/state')) {
        return this.publicState();
      }
      if (request.method === 'GET' && path === '/live') {
        return this.livePublic();
      }
      if (request.method === 'GET' && path === '/history') {
        const limit = Number(url.searchParams.get('limit') || 20);
        return this.historyPublic(limit);
      }
      if (request.method === 'GET' && path === '/chain') {
        return this.chainPublic();
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
        return json({ ok: true, do: 'RoundDO', ...this.publicFields(h, now) });
      }
      if (request.method === 'POST' && path === '/settlement') {
        return this.settlementAt(request);
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
   * Advance durable hand: open → betting → waiting (entropy) → flying → crashed | voided → next.
   */
  async ensure(nowMs) {
    if (!hasRoundSecret(this.env)) {
      const hand = {
        roundId: null,
        seq: null,
        serverSeedHash: null,
        serverSeed: null,
        targetBlock: null,
        blockHash: null,
        flyStart: null,
        bettingEndsAt: null,
        crashAt: null,
        resultEnd: null,
        handStart: null,
        phase: 'intermission',
        windowClosed: true,
        exposureUsdc: 0,
        stakeCount: 0,
        updatedAt: nowMs,
        unconfigured: true,
        voided: false,
      };
      await this.state.storage.put(KEY.hand, hand);
      return hand;
    }

    let hand = (await this.state.storage.get(KEY.hand)) || null;
    let entries = (await this.state.storage.get(KEY.entries)) || {};

    // Finish previous hand → archive + open next
    if (hand && !hand.unconfigured && hand.roundId != null) {
      hand = await this.advanceHand(hand, entries, nowMs);
      entries = (await this.state.storage.get(KEY.entries)) || entries;
    }

    if (!hand || hand.unconfigured || this.handFinished(hand, nowMs)) {
      if (hand && !hand.unconfigured && this.handFinished(hand, nowMs)) {
        await this.archiveHand(hand);
        // Drop settled entries for finished round
        entries = await this.pruneEntriesForRound(entries, hand.roundId, nowMs);
      }
      hand = await this.openNewHand(nowMs, entries);
      entries = (await this.state.storage.get(KEY.entries)) || entries;
    } else {
      // Recompute exposure from open entries
      let exp = 0;
      let count = 0;
      for (const e of Object.values(entries)) {
        if (e && e.status === 'open' && e.roundId === hand.roundId) {
          exp += Number(e.exposureAdd) || 0;
          count += 1;
        }
      }
      hand.exposureUsdc = Math.round(exp * 100) / 100;
      hand.stakeCount = count;
      hand.updatedAt = nowMs;
    }

    await this.state.storage.put(KEY.hand, hand);
    await this.state.storage.put(KEY.entries, entries);
    await this.scheduleAlarm(hand, nowMs);
    return hand;
  }

  handFinished(hand, nowMs) {
    if (!hand || hand.roundId == null) return true;
    if (hand.phase === 'intermission' && !hand.handStart) return true;
    if (hand.resultEnd != null && nowMs >= hand.resultEnd) return true;
    return false;
  }

  async advanceHand(hand, entries, nowMs) {
    // Close betting window
    if (hand.phase === 'betting' && hand.bettingEndsAt != null && nowMs >= hand.bettingEndsAt) {
      hand.windowClosed = true;
      hand.phase = 'waiting';
    }

    // Resolve entropy or void
    if (
      (hand.phase === 'waiting' || hand.phase === 'betting') &&
      hand.windowClosed &&
      !hand.blockHash &&
      !hand.voided
    ) {
      const bettingEnded = hand.bettingEndsAt != null && nowMs >= hand.bettingEndsAt;
      if (bettingEnded) {
        hand.phase = 'waiting';
        const resolved = await this.tryResolveEntropy(hand, nowMs);
        hand = resolved.hand;
        if (resolved.voided) {
          entries = await this.voidAndRefund(hand, entries, nowMs);
          await this.state.storage.put(KEY.entries, entries);
        }
      }
    }

    // Flying / crash clock
    if (hand.phase === 'flying' && hand.crashAt != null && nowMs >= hand.crashAt) {
      hand.phase = 'crashed';
    }
    if (hand.phase === 'crashed' && hand.resultEnd != null && nowMs >= hand.resultEnd) {
      // ensure() will open next
    }
    if (hand.phase === 'voided' && hand.resultEnd != null && nowMs >= hand.resultEnd) {
      // ensure() will open next
    }

    // Mult helper fields
    if (hand.phase === 'flying' && hand.flyStart != null && hand.crashAt != null) {
      hand.liveMult = multOnCurve(
        { flyStart: hand.flyStart, crashAt: hand.crashAt, crashMult: hand.crashMult },
        nowMs,
      );
    } else if (hand.phase === 'crashed') {
      hand.liveMult = hand.crashMult;
    } else {
      hand.liveMult = 1;
    }

    hand.updatedAt = nowMs;
    return hand;
  }

  async tryResolveEntropy(hand, nowMs) {
    const deadline = (hand.bettingEndsAt || hand.handStart || nowMs) + ENTROPY_WAIT_MAX_MS;

    // Throttle RPC while many /api/round polls pile onto the DO — long RPC stalls freeze mult at 1×
    const lastCheck = Number(hand.lastEntropyCheckAt) || 0;
    if (lastCheck > 0 && nowMs - lastCheck < 350 && hand.phase === 'waiting' && !hand.blockHash) {
      hand.phase = 'waiting';
      hand.windowClosed = true;
      return { hand, voided: false };
    }
    hand.lastEntropyCheckAt = nowMs;

    // Short timeout + head-first skip so DO storage path stays under CF limits
    const blk = await getBlockByNumber(this.env, hand.targetBlock, { timeoutMs: 3_500 });

    if (blk?.hash) {
      try {
        const { crashMult: raw } = await crashFromSeedAndBlock(hand.serverSeed, blk.hash);
        const { flightMs, crashMult } = flightFromCrash(raw);
        // Use wall clock after RPC so flyStart isn't stuck in the past by a slow resolve
        const resolvedNow = Date.now();
        const actualFly = Math.max(hand.bettingEndsAt || resolvedNow, resolvedNow);
        hand.blockHash = blk.hash;
        hand.crashMult = crashMult;
        hand.flightMs = flightMs;
        hand.flyStart = actualFly;
        hand.crashAt = actualFly + flightMs;
        hand.resultEnd = hand.crashAt + RESULT_MS;
        hand.phase = 'flying';
        hand.windowClosed = true;
        hand.voided = false;
        hand.entropyResolvedAt = resolvedNow;
        return { hand, voided: false };
      } catch (e) {
        console.error('entropy derive', e?.message || e);
        // Fall through to void if past deadline
      }
    }

    const after = Date.now();
    if (after >= deadline) {
      console.error('VOID_ROUND', {
        reason: 'target_block_unavailable',
        roundId: hand.roundId,
        targetBlock: hand.targetBlock,
        bettingEndsAt: hand.bettingEndsAt,
        nowMs: after,
      });
      hand.voided = true;
      hand.phase = 'voided';
      hand.windowClosed = true;
      hand.blockHash = null;
      hand.crashMult = null;
      hand.flyStart = null;
      hand.crashAt = null;
      hand.resultEnd = after + RESULT_MS;
      hand.voidReason = 'target_block_unavailable';
      hand.voidedAt = after;
      return { hand, voided: true };
    }

    // Still waiting
    hand.phase = 'waiting';
    hand.windowClosed = true;
    return { hand, voided: false };
  }

  async voidAndRefund(hand, entries, nowMs) {
    const { creditPlayBank } = await import('../bank.js');
    for (const [id, e] of Object.entries(entries)) {
      if (!e || e.status !== 'open' || e.roundId !== hand.roundId) continue;
      const stake = Math.floor(Number(e.stakeUsdc) || 0);
      const player = e.player;
      e.status = 'refunded';
      e.releasedAt = nowMs;
      e.releaseReason = 'void_target_block_unavailable';
      entries[id] = e;
      if (player && stake > 0) {
        try {
          await creditPlayBank(player, stake, id, this.env);
          console.log('VOID_REFUND', { roundId: hand.roundId, entryId: id, player, stake });
        } catch (err) {
          console.error('VOID_REFUND_FAIL', id, err?.message || err);
        }
      }
    }
    hand.exposureUsdc = 0;
    hand.stakeCount = 0;
    return entries;
  }

  async openNewHand(nowMs, entries) {
    // Hash chain must be ready + on-chain anchored; refuse when exhausted (no silent re-seed)
    const ready = await ensureChainReady(this.state.storage, this.env);
    if (!ready.ok) {
      return {
        roundId: null,
        seq: null,
        phase: 'intermission',
        acceptingBets: false,
        windowClosed: true,
        mult: 1,
        error: ready.error || 'Seed chain not ready',
        unconfigured: false,
        handStart: nowMs,
        updatedAt: nowMs,
        exposureUsdc: 0,
        stakeCount: 0,
        serverSeedHash: null,
        serverSeed: null,
        targetBlock: null,
        voided: false,
        ...chainPublicView(ready.chain),
      };
    }

    let consumed;
    try {
      consumed = await consumeNextSeed(this.state.storage, ready.chain);
    } catch (e) {
      console.error('consumeNextSeed', e?.message || e);
      return {
        roundId: null,
        phase: 'intermission',
        acceptingBets: false,
        windowClosed: true,
        mult: 1,
        error: e?.message || 'Seed chain consume failed',
        unconfigured: false,
        handStart: nowMs,
        updatedAt: nowMs,
        exposureUsdc: 0,
        stakeCount: 0,
        serverSeedHash: null,
        serverSeed: null,
        targetBlock: null,
        voided: false,
        ...chainPublicView(ready.chain),
      };
    }

    const { serverSeed, chainIndex, prevSeed, chain } = consumed;
    const serverSeedHash = await sha256Hex(serverSeed);

    let seq = Number(await this.state.storage.get(KEY.seq)) || 0;
    seq += 1;
    await this.state.storage.put(KEY.seq, seq);

    let openBlock;
    try {
      openBlock = await getBlockNumber(this.env);
    } catch (e) {
      console.error('openNewHand getBlockNumber', e?.message || e);
      // Seed already consumed — do not rewind chain (would allow reuse). Hand opens as closed.
      return {
        roundId: null,
        seq,
        chainIndex,
        phase: 'intermission',
        acceptingBets: false,
        windowClosed: true,
        mult: 1,
        error: 'RPC unavailable — cannot open hand without targetBlock (chain index advanced)',
        unconfigured: false,
        handStart: nowMs,
        updatedAt: nowMs,
        exposureUsdc: 0,
        stakeCount: 0,
        serverSeedHash: null,
        serverSeed: null,
        targetBlock: null,
        voided: false,
        ...chainPublicView(chain),
      };
    }

    const targetBlock = openBlock + TARGET_BLOCK_OFFSET;
    const bettingEndsAt = nowMs + BET_MS;

    const roundId = seq;
    let exp = 0;
    let count = 0;
    const kept = {};
    for (const [id, e] of Object.entries(entries || {})) {
      if (e && e.status === 'open' && e.roundId === roundId) {
        kept[id] = e;
        exp += Number(e.exposureAdd) || 0;
        count += 1;
      } else if (e && e.status === 'open' && e.queuedNext && e.roundId == null) {
        e.roundId = roundId;
        kept[id] = e;
        exp += Number(e.exposureAdd) || 0;
        count += 1;
      }
    }
    await this.state.storage.put(KEY.entries, { ...(entries || {}), ...kept });

    const chainView = chainPublicView(chain);

    return {
      roundId,
      seq,
      slotId: Math.floor(nowMs / CYCLE_MS),
      hand: seq,
      chainIndex,
      chainPrevSeed: prevSeed,
      serverSeed,
      serverSeedHash,
      openBlockNumber: openBlock,
      targetBlock,
      blockHash: null,
      crashMult: null,
      flightMs: null,
      handStart: nowMs,
      bettingEndsAt,
      flyStart: null,
      crashAt: null,
      resultEnd: null,
      phase: 'betting',
      windowClosed: false,
      exposureUsdc: Math.round(exp * 100) / 100,
      stakeCount: count,
      updatedAt: nowMs,
      unconfigured: false,
      voided: false,
      liveMult: 1,
      targetBlockOffset: TARGET_BLOCK_OFFSET,
      chainHead: chainView.chainHead,
      chainLength: chainView.chainLength,
      chainAnchorTx: chainView.chainAnchorTx,
      chainAnchorBlock: chainView.chainAnchorBlock,
      chainRemaining: chainView.chainRemaining,
    };
  }

  async chainPublic() {
    const chain = await this.state.storage.get(CHAIN_KEY);
    return json({
      ok: true,
      serverNow: Date.now(),
      ...chainPublicView(chain),
      basescanTx: chain?.anchorTxHash
        ? `https://sepolia.basescan.org/tx/${chain.anchorTxHash}`
        : null,
    });
  }

  async archiveHand(hand) {
    if (!hand || hand.roundId == null) return;
    if (!hand.voided && hand.phase !== 'crashed' && hand.crashMult == null) return;
    // Only archive terminal hands that finished entropy or void
    if (!hand.voided && hand.crashAt != null && Date.now() < hand.crashAt) return;

    const row = {
      roundId: hand.roundId,
      seq: hand.seq,
      slotId: hand.slotId,
      hand: hand.hand,
      chainIndex: hand.chainIndex ?? null,
      chainPrevSeed: hand.chainPrevSeed ?? null,
      chainHead: hand.chainHead ?? null,
      chainAnchorTx: hand.chainAnchorTx ?? null,
      crashMult: hand.voided ? null : hand.crashMult,
      crashAt: hand.crashAt,
      flyStart: hand.flyStart,
      bettingEndsAt: hand.bettingEndsAt,
      handStart: hand.handStart,
      resultEnd: hand.resultEnd,
      serverSeedHash: hand.serverSeedHash,
      serverSeed: hand.serverSeed,
      targetBlock: hand.targetBlock,
      blockHash: hand.blockHash,
      openBlockNumber: hand.openBlockNumber,
      voided: !!hand.voided,
      voidReason: hand.voidReason || null,
      at: hand.resultEnd || hand.voidedAt || Date.now(),
    };


    let hist = (await this.state.storage.get(KEY.history)) || [];
    if (!Array.isArray(hist)) hist = [];
    // Dedupe by roundId
    hist = hist.filter((h) => h && h.roundId !== row.roundId);
    hist.unshift(row);
    if (hist.length > HISTORY_MAX) hist = hist.slice(0, HISTORY_MAX);
    await this.state.storage.put(KEY.history, hist);
  }

  async pruneEntriesForRound(entries, roundId, nowMs) {
    const next = { ...entries };
    for (const [id, e] of Object.entries(next)) {
      if (!e) continue;
      if (e.roundId === roundId && e.status !== 'open') {
        // keep briefly then drop old
        if (e.releasedAt && nowMs - e.releasedAt > 120_000) delete next[id];
        if (e.settledAt && nowMs - e.settledAt > 120_000) delete next[id];
      }
    }
    // Cap
    const ids = Object.keys(next);
    if (ids.length > 400) {
      for (const id of ids.slice(0, ids.length - 400)) delete next[id];
    }
    await this.state.storage.put(KEY.entries, next);
    return next;
  }

  async scheduleAlarm(hand, nowMs) {
    const targets = [];
    if (hand.bettingEndsAt != null && nowMs < hand.bettingEndsAt) {
      targets.push(hand.bettingEndsAt);
      targets.push(Math.min(nowMs + 1000, hand.bettingEndsAt));
    }
    if (hand.phase === 'waiting') {
      // Poll target block often — slow alarms left the game stuck at 1× for long stretches
      targets.push(nowMs + 400);
      targets.push(nowMs + 900);
      const deadline = (hand.bettingEndsAt || nowMs) + ENTROPY_WAIT_MAX_MS;
      if (deadline > nowMs) targets.push(deadline);
    }
    if (hand.flyStart != null && nowMs < hand.flyStart) targets.push(hand.flyStart);
    if (hand.crashAt != null && nowMs < hand.crashAt) targets.push(hand.crashAt);
    if (hand.resultEnd != null && nowMs < hand.resultEnd + 50) targets.push(hand.resultEnd + 50);

    if (hand.phase === 'flying' && hand.crashAt != null) {
      targets.push(Math.min(nowMs + 2000, hand.crashAt));
    }
    // Auto-bank alarms
    try {
      const entries = (await this.state.storage.get(KEY.entries)) || {};
      if (hand.flyStart != null && hand.phase === 'flying') {
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

  async processAutoBanks(nowMs) {
    const hand = (await this.state.storage.get(KEY.hand)) || {};
    if (hand.phase !== 'flying' || hand.flyStart == null || hand.voided) return;
    let entries = (await this.state.storage.get(KEY.entries)) || {};

    // Collect due auto-banks, mark pending, persist, then run cashouts OUTSIDE the
    // storage critical path via waitUntil — long on-chain buys inside the DO caused
    // "Durable Object storage operation exceeded timeout which caused object to be reset".
    const due = [];
    for (const id of Object.keys(entries)) {
      const e = entries[id];
      if (!e || e.status !== 'open' || !(Number(e.autoMult) > 1) || !e.player) continue;
      const targetAt = hand.flyStart + elapsedForMult(Number(e.autoMult));
      if (nowMs + 50 < targetAt) continue;
      if (hand.crashAt != null && nowMs >= hand.crashAt) continue;
      e.status = 'auto_pending';
      entries[id] = e;
      due.push({
        id,
        e,
        targetAt,
        settleAt: Math.min(nowMs, Math.max(targetAt, hand.flyStart + 1)),
        roundId: hand.roundId,
      });
    }
    if (!due.length) return;
    await this.state.storage.put(KEY.entries, entries);

    const run = async () => {
      const { executeCashoutSettlement } = await import('../cashout.js');
      for (const { id, e, settleAt, targetAt, roundId } of due) {
        try {
          const result = await executeCashoutSettlement(this.env, {
            recipient: e.player,
            stake: e.stakeUsdc,
            entryId: e.entryId || id,
            arrivalMs: settleAt,
            clientCashoutAt: targetAt,
            claimedMult: Number(e.autoMult),
            roundId,
            auto: true,
            // Instant settle inside auto-bank too — don't hold the DO on ticket buys
            sync: false,
          });
          if (!(result?.ok || result?.lost)) {
            const cur = (await this.state.storage.get(KEY.entries)) || {};
            if (cur[id] && cur[id].status === 'auto_pending') {
              cur[id] = { ...cur[id], status: 'open' };
              await this.state.storage.put(KEY.entries, cur);
            }
          }
        } catch (err) {
          console.error('auto-bank', err?.message || err);
          try {
            const cur = (await this.state.storage.get(KEY.entries)) || {};
            if (cur[id] && cur[id].status === 'auto_pending') {
              cur[id] = { ...cur[id], status: 'open' };
              await this.state.storage.put(KEY.entries, cur);
            }
          } catch (_) {}
        }
      }
    };

    // Prefer waitUntil so alarm/fetch can finish storage quickly
    if (this.ctx && typeof this.ctx.waitUntil === 'function') {
      this.ctx.waitUntil(run());
    } else if (this.state && typeof this.state.waitUntil === 'function') {
      this.state.waitUntil(run());
    } else {
      // Last resort — still don't block the caller for multi-minute chain work
      run().catch((e) => console.error('auto-bank run', e?.message || e));
    }
  }

  /**
   * Public fields — never leak serverSeed until crashed/voided reveal window.
   */
  publicFields(hand, nowMs = Date.now()) {
    const caps = capsFromEnv(this.env);
    const phase = hand?.phase || 'intermission';
    const revealed = phase === 'crashed' || phase === 'voided';
    // Never publish crashMult / crashAt / blockHash / serverSeed until reveal (after crash)
    const showReveal = revealed;

    let mult = 1;
    if (phase === 'flying' && hand.flyStart != null && hand.crashAt != null && hand.crashMult != null) {
      mult = multOnCurve(
        { flyStart: hand.flyStart, crashAt: hand.crashAt, crashMult: hand.crashMult },
        nowMs,
      );
    } else if (phase === 'crashed' && hand.crashMult != null) {
      mult = hand.crashMult;
    }

    return {
      step: 4,
      scaffold: false,
      roundId: hand?.roundId ?? null,
      slotId: hand?.slotId ?? null,
      hand: hand?.hand ?? null,
      seq: hand?.seq ?? null,
      chainIndex: hand?.chainIndex ?? null,
      // prev seed is public once prior round revealed; safe to expose after our reveal too
      chainPrevSeed: showReveal ? hand?.chainPrevSeed ?? null : null,
      chainHead: hand?.chainHead ?? null,
      chainLength: hand?.chainLength ?? null,
      chainAnchorTx: hand?.chainAnchorTx ?? null,
      chainAnchorBlock: hand?.chainAnchorBlock ?? null,
      chainRemaining: hand?.chainRemaining ?? null,
      phase,
      acceptingBets: !hand?.unconfigured && phase === 'betting' && !hand?.windowClosed,
      windowClosed: !!hand?.windowClosed || !!hand?.unconfigured || phase !== 'betting',
      mult,
      crashMult: showReveal && !hand?.voided ? hand?.crashMult ?? null : null,
      serverSeedHash: hand?.serverSeedHash ?? null,
      serverSeed: showReveal ? hand?.serverSeed ?? null : null,
      targetBlock: hand?.targetBlock ?? null,
      // blockHash only at reveal — knowing it + seed = crash during flight
      blockHash: showReveal ? hand?.blockHash ?? null : null,
      openBlockNumber: hand?.openBlockNumber ?? null,
      targetBlockOffset: hand?.targetBlockOffset ?? TARGET_BLOCK_OFFSET,
      voided: !!hand?.voided,
      voidReason: hand?.voided ? hand?.voidReason || null : null,
      flyStart: hand?.flyStart ?? null,
      bettingEndsAt: hand?.bettingEndsAt ?? null,
      // Hide crashAt until reveal (otherwise clients can infer crash mult from curve)
      crashAt: showReveal && !hand?.voided ? hand?.crashAt ?? null : null,
      resultEnd: showReveal ? hand?.resultEnd ?? null : (phase === 'flying' ? null : hand?.resultEnd ?? null),

      handStart: hand?.handStart ?? null,
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
      resultMs: RESULT_MS,
      growthPerMs: GROWTH_PER_MS,
      cycleMs: CYCLE_MS,
      error: hand?.error || null,
    };
  }

  async publicState() {
    const now = Date.now();
    const hand = await this.ensure(now);
    const kill = !!(await this.state.storage.get(KEY.kill));
    const fields = this.publicFields(hand, now);
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
      targetBlock: fields.targetBlock,
      flyStart: fields.flyStart,
      bettingEndsAt: fields.bettingEndsAt,
    });
  }

  async livePublic() {
    const now = Date.now();
    if (!hasRoundSecret(this.env)) {
      return json({
        ok: true,
        global: true,
        provablyFair: false,
        serverNow: now,
        phase: 'intermission',
        acceptingBets: false,
        windowClosed: true,
        mult: 1,
        error: 'ROUND_SECRET not configured — betting closed',
      });
    }
    const hand = await this.ensure(now);
    const kill = !!(await this.state.storage.get(KEY.kill));
    const f = this.publicFields(hand, now);
    const revealed = f.phase === 'crashed' || f.phase === 'voided';
    // Always attach live chain status (public)
    const chainStored = await this.state.storage.get(CHAIN_KEY);
    const chainView = chainPublicView(chainStored);

    return json({
      ok: true,
      global: true,
      provablyFair: true,
      serverNow: now,
      kill,
      roundId: f.roundId,
      slotId: f.slotId,
      hand: f.hand,
      seq: f.seq,
      chainIndex: f.chainIndex ?? chainView.chainNextIndex,
      chainHead: f.chainHead || chainView.chainHead,
      chainLength: f.chainLength ?? chainView.chainLength,
      chainAnchorTx: f.chainAnchorTx || chainView.chainAnchorTx,
      chainAnchorBlock: f.chainAnchorBlock ?? chainView.chainAnchorBlock,
      chainRemaining: f.chainRemaining ?? chainView.chainRemaining,
      chainExhausted: chainView.chainExhausted,
      chainPrevSeed: f.chainPrevSeed,
      phase: f.phase,
      acceptingBets: f.acceptingBets && !kill,
      windowClosed: f.windowClosed || kill,
      mult: f.mult,
      crashMult: f.crashMult,
      serverSeedHash: f.serverSeedHash,
      serverSeed: f.serverSeed,
      targetBlock: f.targetBlock,
      blockHash: f.blockHash,
      openBlockNumber: f.openBlockNumber,
      targetBlockOffset: f.targetBlockOffset,
      voided: f.voided,
      voidReason: f.voidReason,
      fair: {
        scheme: FAIR_SCHEME,
        commit: f.serverSeedHash,
        targetBlock: f.targetBlock,
        chainHead: f.chainHead || chainView.chainHead,
        chainAnchorTx: f.chainAnchorTx || chainView.chainAnchorTx,
        reveal: revealed ? f.serverSeed : null,
        blockHash: revealed ? f.blockHash : null,
        verify: revealed
          ? 'POST /api/verify { serverSeed, serverSeedHash, crashMult, targetBlock, blockHash, chainPrevSeed, chainHead, chainIndex }'
          : 'Commit + targetBlock published during betting; seed+blockHash revealed after crash; chain head on-chain',
      },
      roundStart: f.handStart,
      handStart: f.handStart,
      bettingEndsAt: f.bettingEndsAt,
      flyStart: f.flyStart,
      crashAt: f.crashAt,
      resultEnd: f.resultEnd,
      nextRoundStart: f.resultEnd,
      cycleEnd: f.resultEnd,
      growthPerMs: f.growthPerMs,
      cycleMs: f.cycleMs,
      betMs: f.betMs,
      resultMs: f.resultMs,
      exposureUsdc: f.exposureUsdc,
      remainingExposureUsdc: f.remainingExposureUsdc,
      maxRoundExposureUsdc: f.maxRoundExposureUsdc,
      maxPayoutMult: f.maxPayoutMult,
      maxPayoutPerEntryUsdc: f.maxPayoutPerEntryUsdc,
      stakeCount: f.stakeCount,
      error: f.error,
    });
  }

  async historyPublic(limit = 20) {
    const max = Math.min(50, Math.max(1, Math.floor(Number(limit) || 20)));
    // Ensure current hand is advanced/archived if finished
    await this.ensure(Date.now());
    let hist = (await this.state.storage.get(KEY.history)) || [];
    if (!Array.isArray(hist)) hist = [];
    const chainStored = await this.state.storage.get(CHAIN_KEY);
    const chainView = chainPublicView(chainStored);
    const rounds = hist.slice(0, max).map((r) => ({
      roundId: r.roundId,
      slotId: r.slotId,
      hand: r.hand,
      seq: r.seq,
      chainIndex: r.chainIndex ?? null,
      chainPrevSeed: r.chainPrevSeed ?? null,
      chainHead: r.chainHead || chainView.chainHead,
      chainAnchorTx: r.chainAnchorTx || chainView.chainAnchorTx,
      crashMult: r.crashMult,
      crashAt: r.crashAt,
      flyStart: r.flyStart,
      bettingEndsAt: r.bettingEndsAt,
      handStart: r.handStart,
      serverSeedHash: r.serverSeedHash,
      serverSeed: r.serverSeed,
      targetBlock: r.targetBlock,
      blockHash: r.blockHash,
      voided: !!r.voided,
      voidReason: r.voidReason || null,
      at: r.at,
    }));
    return json({
      ok: true,
      serverNow: Date.now(),
      count: rounds.length,
      rounds,
      chain: chainView,
    });
  }


  /**
   * Resolve the hand a cashout should settle against.
   * Critical: do NOT open the next hand — late cashouts after resultEnd must still
   * hit the round the user played (current advanced phase or history by roundId).
   */
  async resolveSettlementHand(serverNow, roundId) {
    let hand = (await this.state.storage.get(KEY.hand)) || null;
    let entries = (await this.state.storage.get(KEY.entries)) || {};

    if (hand && !hand.unconfigured && hand.roundId != null) {
      // Advance phase (betting→waiting→flying→crashed) but never open next hand here
      hand = await this.advanceHand(hand, entries, serverNow);
      await this.state.storage.put(KEY.hand, hand);
    }

    const wantId = roundId != null && Number.isFinite(Number(roundId)) ? Number(roundId) : null;
    const hist = (await this.state.storage.get(KEY.history)) || [];
    const fromHist = (id) => {
      if (id == null || !Array.isArray(hist)) return null;
      const archived = hist.find((h) => h && Number(h.roundId) === Number(id));
      if (!archived || archived.flyStart == null) return null;
      return {
        ...archived,
        phase: archived.voided ? 'voided' : 'crashed',
        windowClosed: true,
        unconfigured: false,
        crashAt: archived.crashAt,
        crashMult: archived.crashMult,
        flyStart: archived.flyStart,
      };
    };

    // Preferred: exact round the player cashed (may already be archived)
    if (wantId != null) {
      if (hand && Number(hand.roundId) === wantId && hand.flyStart != null && hand.crashAt != null) {
        return hand;
      }
      const archived = fromHist(wantId);
      if (archived) return archived;
    }

    // Current hand still in flight / just crashed
    if (hand && hand.flyStart != null && hand.crashAt != null && !hand.voided) {
      return hand;
    }

    // Late cashout with missing/wrong roundId — most recent archived hand within 12s
    if (Array.isArray(hist) && hist[0] && hist[0].flyStart != null) {
      const h0 = hist[0];
      const end = h0.crashAt || h0.resultEnd || h0.at || 0;
      if (serverNow - Number(end) <= 12_000) {
        return {
          ...h0,
          phase: h0.voided ? 'voided' : 'crashed',
          windowClosed: true,
          unconfigured: false,
        };
      }
    }

    return hand;
  }

  async settlementAt(request) {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    // Server clock for arrival — never trust client Date.now as authority
    const arrivalMs = Date.now();
    const clientCashoutAt =
      body.clientCashoutAt != null ? Number(body.clientCashoutAt) : null;
    const claimedMult = body.claimedMult != null ? Number(body.claimedMult) : null;
    const roundId =
      body.roundId != null && body.roundId !== ''
        ? Number(body.roundId)
        : null;

    const hand = await this.resolveSettlementHand(arrivalMs, roundId);
    const kill = !!(await this.state.storage.get(KEY.kill));
    if (kill) {
      return json({
        ok: false,
        error: 'Round kill switch active',
        phase: hand?.phase || 'intermission',
      });
    }
    if (!hand || hand.unconfigured) {
      return json({
        ok: false,
        error: 'No active round to settle',
        phase: 'intermission',
      });
    }
    if (hand.voided) {
      return json({
        ok: false,
        error: 'Round voided — stakes returned',
        voided: true,
        phase: 'voided',
        roundId: hand.roundId,
      });
    }
    if (
      hand.phase === 'waiting' ||
      hand.phase === 'betting' ||
      hand.phase === 'intermission' ||
      !hand.flyStart ||
      !hand.crashAt
    ) {
      return json({
        ok: false,
        error:
          hand.phase === 'waiting'
            ? 'Waiting for target block entropy'
            : 'Cashout before round flight',
        phase: hand.phase,
        roundId: hand.roundId,
      });
    }
    const timing = timingFromHand(hand);
    const settlement = settlementFromIntent(timing, {
      arrivalMs,
      clientCashoutAt,
      claimedMult,
    });
    return json({
      ...settlement,
      roundId: hand.roundId,
      slotId: hand.slotId,
      hand: hand.hand,
      serverSeedHash: hand.serverSeedHash,
      serverSeed:
        hand.phase === 'crashed' || hand.phase === 'voided' ? hand.serverSeed : null,
      targetBlock: hand.targetBlock,
      blockHash: hand.phase === 'crashed' || hand.phase === 'voided' ? hand.blockHash : null,
      serverNow: arrivalMs,
      acceptingBets: false,
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
    if (hand.unconfigured || hand.error) {
      return json(
        {
          ok: false,
          error: hand.error || 'ROUND_SECRET not configured — betting closed',
          windowClosed: true,
        },
        503,
      );
    }

    let targetRoundId = hand.roundId;
    let targetFlyStart = hand.flyStart || hand.bettingEndsAt;
    let exposureBase = Number(hand.exposureUsdc) || 0;
    let queuedNext = false;

    if (hand.phase === 'betting' && !hand.windowClosed) {
      // join live hand
    } else {
      // Queue onto next sequential hand
      queuedNext = true;
      const seq = Number(await this.state.storage.get(KEY.seq)) || 0;
      targetRoundId = seq + 1;
      targetFlyStart = null;
      const entriesNow = (await this.state.storage.get(KEY.entries)) || {};
      exposureBase = 0;
      for (const e of Object.values(entriesNow)) {
        if (e && e.status === 'open' && e.roundId === targetRoundId) {
          exposureBase += Number(e.exposureAdd) || 0;
        }
      }
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
        roundId: prev.roundId,
        exposureUsdc: hand.exposureUsdc,
      });
    }

    const caps = capsFromEnv(this.env);
    let exposureAdd = exposureForStake(stake, this.env);
    if (Number(body.maxMultCap) > 0) {
      exposureAdd = Math.min(stake * Number(body.maxMultCap), caps.maxPayoutPerEntryUsdc);
    }
    exposureAdd = Math.round(exposureAdd * 100) / 100;

    if (exposureBase + exposureAdd > caps.maxRoundExposureUsdc + 1e-9) {
      return json(
        {
          ok: false,
          error: 'MAX_ROUND_EXPOSURE would be exceeded',
          exposureUsdc: exposureBase,
          maxRoundExposureUsdc: caps.maxRoundExposureUsdc,
          requestedAdd: exposureAdd,
          remainingUsdc: Math.max(0, caps.maxRoundExposureUsdc - exposureBase),
          roundId: targetRoundId,
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
      roundId: targetRoundId,
      autoMult,
      queuedNext,
      at: now,
    };
    const ids = Object.keys(entries);
    if (ids.length > 400) {
      const drop = ids.slice(0, ids.length - 400);
      for (const id of drop) delete entries[id];
    }

    if (targetRoundId === hand.roundId) {
      hand.exposureUsdc = Math.round((exposureBase + exposureAdd) * 100) / 100;
      hand.stakeCount = (hand.stakeCount || 0) + 1;
      hand.updatedAt = now;
      await this.state.storage.put(KEY.hand, hand);
    }
    await this.state.storage.put(KEY.entries, entries);
    await this.scheduleAlarm(hand, now);

    return json({
      ok: true,
      do: 'RoundDO',
      entryId,
      stake,
      exposureAdd,
      autoMult,
      roundId: targetRoundId,
      phase: hand.phase,
      queuedNext,
      exposureUsdc:
        targetRoundId === hand.roundId ? hand.exposureUsdc : exposureBase + exposureAdd,
      maxRoundExposureUsdc: caps.maxRoundExposureUsdc,
      remainingUsdc: Math.max(
        0,
        caps.maxRoundExposureUsdc -
          (targetRoundId === hand.roundId ? hand.exposureUsdc : exposureBase + exposureAdd),
      ),
      flyStart: targetFlyStart,
      targetBlock: targetRoundId === hand.roundId ? hand.targetBlock : null,
    });
  }

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

    const wasOpen = row.status === 'open' || row.status === 'auto_pending';
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
    if (hand.phase === 'betting') hand.phase = 'waiting';
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
 * Admin routes: 404 when ADMIN_TOKEN unset; 403 when set but Authorization mismatch.
 * @returns {Response|null}
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
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}
