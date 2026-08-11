/**
 * POST /api/cashout — tickets to PLAYER only (never cash winnings).
 * tickets = floor(stake × mult); remainder → ticket progress ledger.
 * Settlement mult is server-authoritative.
 */
import { isAddr, withHouseLock, buyTicketsForPlayer } from './house-tx.js';
import { splitPayoutToTickets } from './tickets.js';

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

async function runBuyTickets(env, { recipient, tickets, entryId, costUsdc, stake }) {
  // Prefer sequencer (nonce safety). On busy/rate-limit/failure, fall through to
  // direct house buy so cashouts still complete.
  if (env?.TX_SEQUENCER_DO) {
    try {
      const { executeHouseJob } = await import('./dos/client.js');
      const out = await executeHouseJob(env, {
        type: 'cashout',
        id: entryId || undefined,
        payload: {
          recipient,
          tickets,
          entryId,
          costUsdc,
          stake,
        },
      });
      if (out?.missingBinding) {
        // fall through
      } else if (out?.already && out?.result?.ok) {
        return { ...out.result, already: true, sequencerId: out.id };
      } else if (out?.ok && out?.result?.ok) {
        return { ...out.result, sequencerId: out.id, seq: out.seq };
      } else {
        console.warn(
          'sequencer cashout fallback',
          out?.error || out?.result?.error || out,
        );
        // fall through to direct buy
      }
    } catch (e) {
      console.warn('sequencer cashout error, direct buy', e?.message || e);
    }
  }

  return withHouseLock(() => buyTicketsForPlayer(env, { recipient, tickets }));
}

/**
 * Shared settlement buy — used by HTTP cashout and RoundDO auto-bank.
 * @param {object} opts
 * @param {string} opts.recipient
 * @param {number} opts.stake
 * @param {string|null} opts.entryId
 * @param {number} [opts.arrivalMs]
 * @param {number} [opts.clientCashoutAt] client click time (ms)
 * @param {number} [opts.claimedMult] client mult at click
 * @param {number} [opts.roundId] round being cashed
 * @param {boolean} [opts.auto] server auto-bank
 */
export async function executeCashoutSettlement(env, opts) {
  const recipient = opts.recipient;
  const stake = Number(opts.stake);
  const entryId = opts.entryId != null ? String(opts.entryId) : null;
  const arrivalMs = opts.arrivalMs != null ? Number(opts.arrivalMs) : Date.now();
  const clientCashoutAt =
    opts.clientCashoutAt != null ? Number(opts.clientCashoutAt) : null;
  const claimedMult = opts.claimedMult != null ? Number(opts.claimedMult) : null;
  const roundId = opts.roundId != null ? Number(opts.roundId) : null;
  const auto = !!opts.auto;

  if (!isAddr(recipient)) {
    return { ok: false, error: 'Valid player recipient required', status: 400 };
  }

  let settlement;
  try {
    const { settleCashoutAt } = await import('./round.js');
    settlement = await settleCashoutAt(env, {
      arrivalMs,
      clientCashoutAt,
      claimedMult,
      roundId,
    });
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not resolve round settlement', status: 500 };
  }

  if (!settlement?.ok) {
    return {
      ok: false,
      error: settlement?.error || 'Cashout not accepted in this phase',
      phase: settlement?.phase,
      roundId: settlement?.roundId,
      status: 400,
    };
  }
  if (settlement.lost) {
    if (entryId) {
      try {
        const { roundDoReleaseStake } = await import('./dos/client.js');
        await roundDoReleaseStake(env, { entryId, reason: 'lost' });
      } catch (_) {}
    }
    // Mark bank entry lost — stake not returned (tickets only rule for round play)
    try {
      await markEntryConsumed(env, recipient, entryId, 'lost');
    } catch (_) {}
    return {
      ok: false,
      error: 'Round already crashed — cashout too late',
      lost: true,
      crashMult: settlement.crashMult,
      roundId: settlement.roundId,
      arrivalMs: settlement.arrivalMs,
      status: 409,
    };
  }

  const multiplier = Number(settlement.mult);
  if (!(multiplier > 0) || !(stake > 0)) {
    return { ok: false, error: 'Invalid settlement mult or stake', status: 400 };
  }

  // Strict payout: tickets = floor(stake × mult) ONLY.
  // Remainder → progress AFTER settle is committed. NEVER refund stake for a settled win.
  // Progress free-tickets (floor(progressUsdc) ≥ 1) mint in background — buy failure must
  // NOT refund the stake (that was the "progress ticket refunds stake" bug).
  const split = splitPayoutToTickets(stake, multiplier);
  let cashoutTickets = split.tickets;
  if (cashoutTickets > 50) cashoutTickets = 50;

  const baseOk = {
    recipient,
    stake,
    multiplier,
    valueUsdc: split.valueUsdc,
    remainderUsdc: split.remainderUsdc,
    progressUsdc: null,
    settlement: {
      mult: multiplier,
      roundId: settlement.roundId,
      arrivalMs: settlement.arrivalMs,
      effectiveAt: settlement.effectiveAt,
      graceApplied: settlement.graceApplied,
    },
    payoutUnit: 'USDC_TICKETS',
    entryId: entryId || undefined,
    auto,
  };

  /**
   * Credit remainder only (always < $1). Free tickets reserved inside applyTicketProgress
   * are at most 1 per cashout — never floor(total progress) which caused $7 free mints.
   * Buy failure after this MUST never refund stake.
   */
  async function commitProgress() {
    try {
      const bankMod = await import('./bank.js');
      if (typeof bankMod.applyTicketProgress !== 'function') {
        return { progressUsdc: null, freeTickets: 0, remainderAdded: 0 };
      }
      // Always call — also sanitizes corrupt whole-dollar progress, even with 0 remainder
      const prog = await bankMod.applyTicketProgress(
        recipient,
        split.remainderUsdc,
        env,
      );
      // Hard cap: remainder maths ⇒ at most 1 free ticket per cashout
      const free = Math.min(1, Math.max(0, Math.floor(Number(prog.freeTickets) || 0)));
      return {
        progressUsdc: prog.progressUsdc,
        freeTickets: free,
        remainderAdded: prog.remainderAdded != null ? prog.remainderAdded : split.remainderUsdc,
      };
    } catch (pe) {
      console.warn('progress', pe?.message || pe);
      return { progressUsdc: null, freeTickets: 0, remainderAdded: 0 };
    }
  }

  // ── Commit win immediately (stake spent → tickets/progress only; no refund path) ──
  if (entryId) {
    try {
      const { roundDoSettleEntry } = await import('./dos/client.js');
      await roundDoSettleEntry(env, {
        entryId,
        mult: multiplier,
        tickets: cashoutTickets,
        payoutUsdc: split.valueUsdc,
      });
    } catch (_) {}
    await markEntryConsumed(env, recipient, entryId, 'settled');
  }

  const prog = await commitProgress();
  // freeTickets already reserved (debited from progress). At most 1.
  const freeToBuy = Math.min(1, Math.max(0, Math.floor(Number(prog.freeTickets) || 0)));
  // Prefer cashout tickets when hitting the 50-ticket buy cap
  const totalBuy = Math.min(50, cashoutTickets + freeToBuy);

  if (cashoutTickets > 0) {
    try {
      const { recordScore } = await import('./leaderboard.js');
      await recordScore(
        {
          player: recipient,
          multiplier,
          tickets: cashoutTickets,
          entryId: entryId || `pending:${Date.now()}`,
        },
        env,
      );
    } catch (_) {}
  }

  // Nothing to mint on-chain — progress-only win (or empty free)
  if (!(totalBuy > 0)) {
    return {
      ok: true,
      tickets: 0,
      cashoutTickets: 0,
      freeTickets: 0,
      returned: 0,
      requested: 0,
      pendingOnchain: false,
      pendingTickets: 0,
      ...baseOk,
      progressUsdc: prog.progressUsdc,
      instant: true,
      note: 'Below one ticket — remainder to progress only',
    };
  }

  const buyJob = {
    recipient,
    tickets: totalBuy,
    entryId: entryId || undefined,
    stake: Number.isFinite(stake) ? stake : undefined,
    multiplier,
    freeTickets: freeToBuy,
  };

  /**
   * Free tickets were reserved (debited) in applyTicketProgress already.
   * On success: nothing to do. On hard buy failure: return reservation to progress.
   */
  async function afterBuySuccess(_buyResult) {
    return prog.progressUsdc;
  }
  async function afterBuyFailReturnFree() {
    if (!(freeToBuy > 0)) return;
    try {
      const { returnProgressReservation } = await import('./bank.js');
      await returnProgressReservation(recipient, freeToBuy, env);
    } catch (ce) {
      console.warn('return progress reservation', ce?.message || ce);
    }
  }

  const wantSync = opts.sync === true || opts.deferBuy === false;
  if (!wantSync) {
    try {
      await queuePendingTickets(env, buyJob);
    } catch (qe) {
      console.error('queue pending tickets', qe?.message || qe);
    }

    const bgBuy = (async () => {
      try {
        const buyRes = await runBuyTickets(env, buyJob);
        try {
          await afterBuySuccess(buyRes);
        } catch (_) {}
        try {
          await removePendingTickets(env, buyJob.entryId, buyJob.recipient);
        } catch (_) {}
      } catch (e) {
        console.error('bg ticket buy', e?.shortMessage || e?.message || e);
        // NEVER refund stake — queue for retry; free reservation stays until mint or abandon
        try {
          await fulfillPendingTickets(env, { recipient, entryId });
        } catch (_) {}
      }
    })();

    if (opts.ctx && typeof opts.ctx.waitUntil === 'function') {
      opts.ctx.waitUntil(bgBuy);
    } else {
      bgBuy.catch(() => {});
    }

    return {
      ok: true,
      txHash: null,
      tickets: totalBuy,
      cashoutTickets,
      freeTickets: freeToBuy,
      returned: 0,
      requested: totalBuy,
      pendingOnchain: true,
      pendingTickets: totalBuy,
      ...baseOk,
      progressUsdc: prog.progressUsdc,
      instant: true,
      note:
        freeToBuy > 0
          ? 'Cashed out · tickets (+ progress free) buying in background'
          : 'Cashed out · tickets buying in background',
    };
  }

  // Sync path (tests / ops): await buy before responding — still never refunds stake
  try {
    const buyCash = await runBuyTickets(env, buyJob);
    const progressAfter = await afterBuySuccess(buyCash);
    const kept =
      buyCash.tickets != null && buyCash.tickets > 0
        ? Math.min(totalBuy, Math.floor(Number(buyCash.tickets)))
        : totalBuy;
    return {
      ok: true,
      txHash: buyCash.txHash || null,
      buyTxs: buyCash.buyTxs,
      tickets: kept,
      cashoutTickets: Math.min(cashoutTickets, kept),
      freeTickets: freeToBuy,
      returned: 0,
      requested: totalBuy,
      pendingOnchain: false,
      pendingTickets: 0,
      ...baseOk,
      progressUsdc: progressAfter,
      already: buyCash.already,
      instant: false,
    };
  } catch (e) {
    // Buy failed — tickets stay queued. Stake is NOT refunded (win already committed).
    try {
      await queuePendingTickets(env, buyJob);
    } catch (_) {}
    return {
      ok: true,
      txHash: null,
      tickets: totalBuy,
      cashoutTickets,
      freeTickets: freeToBuy,
      returned: 0,
      requested: totalBuy,
      pendingOnchain: true,
      pendingTickets: totalBuy,
      ...baseOk,
      progressUsdc: prog.progressUsdc,
      instant: false,
      note: 'Cashed out · tickets queued after buy error',
      buyError: e?.message || String(e),
    };
  }
}

async function removePendingTickets(env, entryId, recipient) {
  if (!env?.BANK_KV) return;
  let list = [];
  try {
    list = (await env.BANK_KV.get(PENDING_TICKETS_KEY, { type: 'json' })) || [];
  } catch (_) {
    return;
  }
  if (!Array.isArray(list)) return;
  const next = list.filter((j) => {
    if (!j) return false;
    if (entryId && String(j.entryId) === String(entryId)) return false;
    return true;
  });
  await env.BANK_KV.put(PENDING_TICKETS_KEY, JSON.stringify(next.slice(-100)));
}

const PENDING_TICKETS_KEY = 'pending_ticket_buys_v1';

async function queuePendingTickets(env, job) {
  if (!env?.BANK_KV || !(Number(job?.tickets) > 0) || !isAddr(job?.recipient)) return;
  let list = [];
  try {
    list = (await env.BANK_KV.get(PENDING_TICKETS_KEY, { type: 'json' })) || [];
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  // Dedupe by entryId
  if (job.entryId) {
    list = list.filter((x) => !x || String(x.entryId) !== String(job.entryId));
  }
  list.push({
    recipient: String(job.recipient).toLowerCase(),
    tickets: Math.floor(Number(job.tickets)),
    entryId: job.entryId || null,
    stake: job.stake != null ? Number(job.stake) : null,
    multiplier: job.multiplier != null ? Number(job.multiplier) : null,
    // freeTickets already reserved in progress ledger — at most 1
    freeTickets: Math.min(1, Math.max(0, Math.floor(Number(job.freeTickets) || 0))),
    at: Date.now(),
    tries: 0,
  });
  list = list.slice(-100);
  await env.BANK_KV.put(PENDING_TICKETS_KEY, JSON.stringify(list));
}

/** Retry queued ticket deliveries (no stake refunds — ever). */
export async function fulfillPendingTickets(env, only = null) {
  if (!env?.BANK_KV) return { ok: false, error: 'no kv' };
  let list = [];
  try {
    list = (await env.BANK_KV.get(PENDING_TICKETS_KEY, { type: 'json' })) || [];
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list) || !list.length) return { ok: true, done: 0 };

  const keep = [];
  let done = 0;
  for (const job of list) {
    if (!job || !(Number(job.tickets) > 0) || !isAddr(job.recipient)) continue;
    if (
      only?.entryId &&
      job.entryId &&
      String(only.entryId) !== String(job.entryId)
    ) {
      keep.push(job);
      continue;
    }
    if (
      only?.recipient &&
      String(only.recipient).toLowerCase() !== String(job.recipient).toLowerCase()
    ) {
      keep.push(job);
      continue;
    }
    try {
      await runBuyTickets(env, {
        recipient: job.recipient,
        tickets: job.tickets,
        entryId: job.entryId || undefined,
      });
      // Free tickets were reserved at cashout time — no second consume
      done += 1;
    } catch (e) {
      job.tries = (Number(job.tries) || 0) + 1;
      job.lastError = e?.message || String(e);
      // Keep retrying; never auto-refund stake
      if (job.tries < 20) {
        keep.push(job);
      } else {
        // Abandon free reservation → return progress only (not stake)
        const freeN = Math.min(1, Math.max(0, Math.floor(Number(job.freeTickets) || 0)));
        if (freeN > 0) {
          try {
            const { returnProgressReservation } = await import('./bank.js');
            await returnProgressReservation(job.recipient, freeN, env);
          } catch (_) {}
        }
        console.error('pending tickets abandoned after tries', job);
        // Drop job — cashout tickets may still be owed ops-side; free progress returned
      }
    }
  }
  await env.BANK_KV.put(PENDING_TICKETS_KEY, JSON.stringify(keep.slice(-100)));
  return { ok: true, done, remaining: keep.length };
}

/** Background on-chain buy after instant settle. Never refunds stake. */
export async function fulfillDeferredTicketBuy(env, job) {
  if (!job?.recipient || !(Number(job.tickets) > 0)) return;
  try {
    await runBuyTickets(env, {
      recipient: job.recipient,
      tickets: job.tickets,
      entryId: job.entryId,
      stake: job.stake,
    });
    try {
      await removePendingTickets(env, job.entryId, job.recipient);
    } catch (_) {}
  } catch (e) {
    console.error('deferred ticket buy failed', e?.message || e);
    try {
      await queuePendingTickets(env, job);
    } catch (_) {}
  }
}

async function markEntryConsumed(env, player, entryId, status) {
  if (!entryId || !isAddr(player)) return;
  try {
    const { loadBankForUpdate, saveBankForUpdate } = await import('./bank.js');
    // use internal if available — fall back soft
  } catch (_) {}
  // Soft mark via credit path only for refunded; for settled write via apply in bank module
  try {
    const bankMod = await import('./bank.js');
    if (typeof bankMod.markEntryStatus === 'function') {
      await bankMod.markEntryStatus(player, entryId, status, env);
    }
  } catch (_) {}
}

export async function handleCashout(request, env, ctx) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  // Prefer body.multiplier / claimedMult as the client's displayed mult at click
  const claimedMult =
    body.claimedMult != null
      ? Number(body.claimedMult)
      : body.multiplier != null
        ? Number(body.multiplier)
        : body.mult != null
          ? Number(body.mult)
          : null;

  const clientCashoutAt =
    body.clientCashoutAt != null
      ? Number(body.clientCashoutAt)
      : body.cashoutAt != null
        ? Number(body.cashoutAt)
        : body.clientAt != null
          ? Number(body.clientAt)
          : null;

  const roundId =
    body.roundId != null
      ? Number(body.roundId)
      : body.round_id != null
        ? Number(body.round_id)
        : null;

  const result = await executeCashoutSettlement(env, {
    recipient: body.recipient,
    stake: body.stake,
    entryId: body.entryId != null ? String(body.entryId) : null,
    arrivalMs: Date.now(),
    clientCashoutAt,
    claimedMult,
    roundId,
    auto: false,
    // Default instant: settle + return; buy tickets in waitUntil.
    // Pass sync:true only for tests/ops that need the on-chain hash in the response.
    sync: body.sync === true,
    ctx,
  });

  // Opportunistically drain older pending ticket buys for this player
  if (result.ok && isAddr(body.recipient) && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(
      fulfillPendingTickets(env, { recipient: body.recipient }).catch(() => {}),
    );
  }

  if (!result.ok) {
    return json(
      {
        ok: false,
        error: result.error,
        phase: result.phase,
        roundId: result.roundId,
        lost: result.lost,
        crashMult: result.crashMult,
        arrivalMs: result.arrivalMs,
        effectiveAt: result.effectiveAt,
        graceApplied: result.graceApplied,
        recipient: result.recipient,
        refundToBank: result.refundToBank,
        playBalance: result.playBalance,
        deposited: result.deposited,
        progressUsdc: result.progressUsdc,
      },
      result.status || 400,
    );
  }

  delete result._buyJob;
  return json(result, 200);
}
