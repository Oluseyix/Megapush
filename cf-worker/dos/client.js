/**
 * Durable Object stubs — single global round + house sequencer.
 */

/** @param {Env} env */
export function roundStub(env) {
  if (!env?.ROUND_DO) return null;
  const id = env.ROUND_DO.idFromName('global');
  return env.ROUND_DO.get(id);
}

/** @param {Env} env */
export function sequencerStub(env) {
  if (!env?.TX_SEQUENCER_DO) return null;
  const id = env.TX_SEQUENCER_DO.idFromName('house');
  return env.TX_SEQUENCER_DO.get(id);
}

/**
 * @param {DurableObjectStub|null} stub
 * @param {string} path
 * @param {RequestInit} [init]
 */
export async function doFetch(stub, path, init = {}) {
  if (!stub) {
    return {
      ok: false,
      error: 'Durable Object binding missing (deploy Workers + Static Assets, not Pages)',
      missingBinding: true,
    };
  }
  try {
    const url = `https://do.internal${path.startsWith('/') ? path : `/${path}`}`;
    const res = await stub.fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: res.ok, status: res.status, raw: text.slice(0, 200) };
    }
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Register stake on RoundDO (no-op passthrough if binding missing — Pages fallback). */
export async function roundDoRegisterStake(env, { stake, entryId, player }) {
  if (!env?.ROUND_DO) {
    return { ok: true, skipped: true, reason: 'no ROUND_DO binding' };
  }
  return doFetch(roundStub(env), '/stake', {
    method: 'POST',
    body: JSON.stringify({
      stakeUsdc: stake,
      entryId,
      player,
    }),
  });
}

/** Release stake exposure (cancel / refund). */
export async function roundDoReleaseStake(env, { entryId, reason }) {
  if (!env?.ROUND_DO || !entryId) {
    return { ok: true, skipped: true };
  }
  return doFetch(roundStub(env), '/release', {
    method: 'POST',
    body: JSON.stringify({ entryId, reason: reason || 'release' }),
  });
}

/** Mark cashout settled on RoundDO. */
export async function roundDoSettleEntry(env, { entryId, mult, tickets, payoutUsdc }) {
  if (!env?.ROUND_DO || !entryId) {
    return { ok: true, skipped: true };
  }
  return doFetch(roundStub(env), '/settle-entry', {
    method: 'POST',
    body: JSON.stringify({ entryId, mult, tickets, payoutUsdc }),
  });
}

/**
 * Run a house job on TxSequencerDO (serialized nonce-safe).
 * @param {Env} env
 * @param {{ type: string, id?: string, payload: object }} job
 */
export async function executeHouseJob(env, job) {
  if (!env?.TX_SEQUENCER_DO) {
    return { ok: false, missingBinding: true, error: 'TX_SEQUENCER_DO not bound' };
  }
  return doFetch(sequencerStub(env), '/execute', {
    method: 'POST',
    body: JSON.stringify({
      type: job.type,
      id: job.id,
      payload: job.payload,
    }),
  });
}
