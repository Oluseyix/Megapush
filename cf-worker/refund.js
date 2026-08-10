/**
 * POST /api/refund — credit stake back to play bank only.
 * Never transfers house USDC to an arbitrary wallet (drain vector).
 */
import { isAddr } from './house-tx.js';

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

export async function handleRefund(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const player = body.player || body.recipient;
  const entryId = body.entryId != null ? String(body.entryId) : '';
  const stake = Math.floor(Number(body.stake) || 0);

  if (!isAddr(player)) {
    return json({ ok: false, error: 'Valid player address required' }, 400);
  }
  if (!entryId) return json({ ok: false, error: 'entryId required' }, 400);
  if (!entryId.toLowerCase().startsWith(String(player).toLowerCase())) {
    return json({ ok: false, error: 'entryId does not match player' }, 403);
  }
  if (!(stake > 0)) {
    return json({ ok: false, error: 'Invalid stake amount' }, 400);
  }

  try {
    const { creditPlayBank } = await import('./bank.js');
    const result = await creditPlayBank(player, stake, entryId, env);
    if (!result?.ok) {
      return json({ ok: false, error: result?.error || 'Refund failed' }, 400);
    }
    return json({
      ok: true,
      toBank: true,
      balance: result.balance,
      credited: result.credited ?? stake,
      entryId,
    });
  } catch (e) {
    console.error('refund', e?.message || e);
    return json({ ok: false, error: 'Refund failed' }, 500);
  }
}
