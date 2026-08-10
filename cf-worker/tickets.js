/**
 * Ticket economics — whole tickets only, $1 each.
 * tickets = floor(stake × mult); remainder → progress ledger (not withdrawable).
 */

/** Whole tickets from stake and settlement mult. Never fractional. */
export function wholeTicketsFromStakeMult(stake, mult) {
  const s = Number(stake);
  const m = Number(mult);
  if (!(s > 0) || !(m > 0)) return 0;
  const value = s * m;
  if (!Number.isFinite(value) || value < 1) return 0;
  return Math.floor(value);
}

/**
 * @returns {{ tickets: number, valueUsdc: number, remainderUsdc: number }}
 */
export function splitPayoutToTickets(stake, mult) {
  const s = Number(stake);
  const m = Number(mult);
  if (!(s > 0) || !(m > 0) || !Number.isFinite(s) || !Number.isFinite(m)) {
    return { tickets: 0, valueUsdc: 0, remainderUsdc: 0 };
  }
  const valueUsdc = Math.round(s * m * 100) / 100;
  const tickets = Math.floor(valueUsdc);
  const remainderUsdc = Math.round((valueUsdc - tickets) * 100) / 100;
  return { tickets, valueUsdc, remainderUsdc };
}
