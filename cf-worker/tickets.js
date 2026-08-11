/**
 * Ticket economics — whole tickets only, $1 each.
 * tickets = floor(stake × mult); remainder → progress ledger (not withdrawable).
 *
 * Invariant: remainder is ALWAYS in [0, 1). A single cashout can never add ≥ $1 progress.
 * Free progress tickets (when progress fills to $1) are reserved separately — never
 * confuse freeTickets with stake×mult whole tickets.
 */

function money2(n) {
  return Math.max(0, Math.round((Number(n) || 0) * 100) / 100);
}

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
 * Fractional remainder after whole tickets — always in [0, 1).
 * e.g. stake $2 @ 3.50× → value $7 → 7 tickets + $0.00 progress
 * e.g. stake $2 @ 1.75× → value $3.50 → 3 tickets + $0.50 progress
 */
export function clampRemainderUsdc(remainderUsdc) {
  let r = money2(remainderUsdc);
  if (!(r > 0)) return 0;
  // Defensive: never allow a full dollar (or more) as "remainder"
  if (r >= 1) r = money2(r % 1);
  return r;
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
  const valueUsdc = money2(s * m);
  const tickets = Math.floor(valueUsdc + 1e-9);
  // Pure fractional part — mathematically always < 1
  const remainderUsdc = clampRemainderUsdc(valueUsdc - tickets);
  return { tickets, valueUsdc, remainderUsdc };
}
