/**
 * POST /api/cashout — MUST mint tickets to PLAYER or refund stake to play bank.
 * Settlement mult is server-authoritative. House txs go through TxSequencerDO when bound.
 */
import {
  isAddr,
  withHouseLock,
  buyTicketsForPlayer,
} from './house-tx.js';

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

/**
 * Run cashout buy via TxSequencerDO, or isolate lock if DO unbound.
 */
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

export async function handleCashout(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const recipient = body.recipient;
  if (!isAddr(recipient)) {
    return json({ ok: false, error: 'Valid player recipient required', recipient: recipient || null }, 400);
  }

  const stake = Number(body.stake);
  const entryId = body.entryId != null ? String(body.entryId) : null;
  const arrivalMs = Date.now();
  let settlement;
  try {
    const { settleCashoutAt } = await import('./round.js');
    settlement = await settleCashoutAt(env, arrivalMs);
  } catch (e) {
    return json(
      {
        ok: false,
        error: e?.message || 'Could not resolve round settlement',
        recipient,
      },
      500,
    );
  }

  if (!settlement?.ok) {
    return json(
      {
        ok: false,
        error: settlement?.error || 'Cashout not accepted in this phase',
        phase: settlement?.phase,
        roundId: settlement?.roundId,
        recipient,
      },
      400,
    );
  }
  if (settlement.lost) {
    if (entryId) {
      try {
        const { roundDoReleaseStake } = await import('./dos/client.js');
        await roundDoReleaseStake(env, { entryId, reason: 'lost' });
      } catch (_) {}
    }
    return json(
      {
        ok: false,
        error: 'Round already crashed — cashout too late',
        lost: true,
        crashMult: settlement.crashMult,
        roundId: settlement.roundId,
        arrivalMs: settlement.arrivalMs,
        recipient,
      },
      409,
    );
  }

  const multiplier = Number(settlement.mult);
  if (!(multiplier > 0)) {
    return json({ ok: false, error: 'Invalid settlement mult', recipient }, 400);
  }

  let tickets = Math.floor(Number(body.tickets != null ? body.tickets : body.count));
  if (!Number.isFinite(tickets) || tickets <= 0) {
    if (Number.isFinite(stake) && stake > 0 && multiplier > 0) {
      const s = Math.floor(stake);
      const m = Math.floor(multiplier);
      tickets = s > 0 && m > 0 ? s * m : 0;
    }
  } else if (Number.isFinite(stake) && stake > 0) {
    const maxTix = Math.floor(stake) * Math.floor(multiplier);
    if (maxTix > 0 && tickets > maxTix) tickets = maxTix;
  }
  tickets = Math.floor(Number(tickets) || 0);
  if (!Number.isFinite(tickets) || tickets <= 0) {
    return json(
      { ok: false, error: 'tickets must be ≥ 1', recipient, serverMult: multiplier },
      400,
    );
  }
  if (tickets > 50) tickets = 50;

  try {
    const buy = await runBuyTickets(env, {
      recipient,
      tickets,
      entryId,
      stake: Number.isFinite(stake) ? stake : undefined,
    });

    const result = {
      ok: true,
      txHash: buy.txHash,
      buyTxs: buy.buyTxs,
      tickets: buy.tickets,
      requested: buy.requested,
      recipient,
      stake: Number.isFinite(stake) ? stake : undefined,
      multiplier,
      settlement: {
        mult: multiplier,
        roundId: settlement.roundId,
        arrivalMs: settlement.arrivalMs,
      },
      payoutUnit: 'USDC_TICKETS',
      entryId: entryId || undefined,
      already: buy.already,
    };

    if (result.ok && Number.isFinite(multiplier) && multiplier > 0) {
      try {
        const { recordScore } = await import('./leaderboard.js');
        await recordScore(
          {
            player: recipient,
            multiplier,
            tickets: result.tickets || tickets,
            entryId: entryId || result.txHash,
          },
          env,
        );
      } catch (lbErr) {
        console.warn('leaderboard record', lbErr?.message || lbErr);
      }
    }

    if (result.ok && entryId) {
      try {
        const { roundDoSettleEntry } = await import('./dos/client.js');
        await roundDoSettleEntry(env, {
          entryId,
          mult: multiplier,
          tickets: result.tickets || tickets,
          payoutUsdc: Number.isFinite(stake) ? stake * multiplier : undefined,
        });
      } catch (doErr) {
        console.warn('roundDo settle', doErr?.message || doErr);
      }
    }

    return json(result, 200);
  } catch (e) {
    console.error('cashout error', e?.shortMessage || e?.message || e);
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
    return json(
      {
        ok: false,
        error: safe,
        recipient,
        tickets,
        stake: Number.isFinite(stake) ? stake : undefined,
        refundToBank: refundToBank?.ok ? true : false,
        playBalance: refundToBank?.balance,
      },
      e?.statusCode || 500,
    );
  }
}
