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
  if (env?.TX_SEQUENCER_DO) {
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
      const err = new Error(out?.error || out?.result?.error || 'Sequencer cashout failed');
      err.statusCode = out?.result?.statusCode || (out?.status === 429 ? 429 : 500);
      throw err;
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
 * @param {boolean} [opts.auto] server auto-bank
 */
export async function executeCashoutSettlement(env, opts) {
  const recipient = opts.recipient;
  const stake = Number(opts.stake);
  const entryId = opts.entryId != null ? String(opts.entryId) : null;
  const arrivalMs = opts.arrivalMs != null ? Number(opts.arrivalMs) : Date.now();
  const auto = !!opts.auto;

  if (!isAddr(recipient)) {
    return { ok: false, error: 'Valid player recipient required', status: 400 };
  }

  let settlement;
  try {
    const { settleCashoutAt } = await import('./round.js');
    settlement = await settleCashoutAt(env, arrivalMs);
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

  // floor(stake × mult) whole tickets; remainder → progress
  const split = splitPayoutToTickets(stake, multiplier);
  let tickets = split.tickets;
  if (!(tickets > 0)) {
    // Still bank remainder into progress even if < 1 ticket
    let progress = null;
    try {
      const { applyTicketProgress } = await import('./bank.js');
      progress = await applyTicketProgress(recipient, split.remainderUsdc, env);
    } catch (_) {}
    if (entryId) {
      try {
        const { roundDoSettleEntry } = await import('./dos/client.js');
        await roundDoSettleEntry(env, {
          entryId,
          mult: multiplier,
          tickets: 0,
          payoutUsdc: split.valueUsdc,
        });
      } catch (_) {}
      await markEntryConsumed(env, recipient, entryId, 'settled');
    }
    return {
      ok: true,
      tickets: 0,
      requested: 0,
      recipient,
      stake,
      multiplier,
      remainderUsdc: split.remainderUsdc,
      progressUsdc: progress?.progressUsdc,
      freeTickets: progress?.freeTickets || 0,
      settlement: { mult: multiplier, roundId: settlement.roundId, arrivalMs: settlement.arrivalMs },
      payoutUnit: 'USDC_TICKETS',
      entryId: entryId || undefined,
      auto,
      note: 'Below one ticket — remainder to progress only',
    };
  }

  if (tickets > 50) tickets = 50;

  try {
    let freeTickets = 0;
    let progressUsdc = null;

    try {
      const { applyTicketProgress } = await import('./bank.js');
      const prog = await applyTicketProgress(recipient, split.remainderUsdc, env);
      freeTickets = prog.freeTickets || 0;
      progressUsdc = prog.progressUsdc;
    } catch (pe) {
      console.warn('progress', pe?.message || pe);
    }

    const totalBuy = tickets + freeTickets;
    const buy = await runBuyTickets(env, {
      recipient,
      tickets: totalBuy,
      entryId,
      stake: Number.isFinite(stake) ? stake : undefined,
    });

    // Only debit progress after successful on-chain free tickets
    if (freeTickets > 0) {
      try {
        const { consumeProgressTickets } = await import('./bank.js');
        const c = await consumeProgressTickets(recipient, freeTickets, env);
        progressUsdc = c.progressUsdc;
      } catch (_) {}
    }

    if (entryId) {
      try {
        const { roundDoSettleEntry } = await import('./dos/client.js');
        await roundDoSettleEntry(env, {
          entryId,
          mult: multiplier,
          tickets: buy.tickets || totalBuy,
          payoutUsdc: split.valueUsdc,
        });
      } catch (_) {}
      await markEntryConsumed(env, recipient, entryId, 'settled');
    }

    try {
      const { recordScore } = await import('./leaderboard.js');
      await recordScore(
        {
          player: recipient,
          multiplier,
          tickets: buy.tickets || totalBuy,
          entryId: entryId || buy.txHash,
        },
        env,
      );
    } catch (_) {}

    return {
      ok: true,
      txHash: buy.txHash,
      buyTxs: buy.buyTxs,
      tickets: buy.tickets || totalBuy,
      cashoutTickets: tickets,
      freeTickets,
      requested: totalBuy,
      recipient,
      stake,
      multiplier,
      valueUsdc: split.valueUsdc,
      remainderUsdc: split.remainderUsdc,
      progressUsdc,
      settlement: {
        mult: multiplier,
        roundId: settlement.roundId,
        arrivalMs: settlement.arrivalMs,
      },
      payoutUnit: 'USDC_TICKETS',
      entryId: entryId || undefined,
      already: buy.already,
      auto,
    };
  } catch (e) {
    // Ticket buy failed — return stake to deposited (never converted to tickets)
    let refundToBank = null;
    if (Number.isFinite(stake) && stake > 0 && isAddr(recipient)) {
      try {
        const { creditPlayBank } = await import('./bank.js');
        refundToBank = await creditPlayBank(recipient, stake, entryId, env);
      } catch (re) {
        console.error('bank refund failed', re?.message || re);
      }
    }
    const msg = e?.shortMessage || e?.message || String(e);
    const safe =
      /service unavailable|house usdc|rate limit|max_payout|busy|retry/i.test(msg)
        ? msg
        : 'Cashout failed';
    return {
      ok: false,
      error: safe,
      status: e?.statusCode || 500,
      recipient,
      tickets,
      stake,
      refundToBank: refundToBank?.ok ? true : false,
      playBalance: refundToBank?.balance,
      deposited: refundToBank?.deposited,
      progressUsdc: refundToBank?.progressUsdc,
    };
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

export async function handleCashout(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const result = await executeCashoutSettlement(env, {
    recipient: body.recipient,
    stake: body.stake,
    entryId: body.entryId != null ? String(body.entryId) : null,
    arrivalMs: Date.now(),
    auto: false,
  });

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
        recipient: result.recipient,
        refundToBank: result.refundToBank,
        playBalance: result.playBalance,
        deposited: result.deposited,
        progressUsdc: result.progressUsdc,
      },
      result.status || 400,
    );
  }

  return json(result, 200);
}
