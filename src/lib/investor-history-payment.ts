import type { InvestorHistoricalMonth } from './investor-history.ts';

export type HistoricalPaymentPosition =
  | { confirmed: false; status: 'unconfirmed' }
  | { confirmed: true; status: 'no_payout_due' | 'unpaid' | 'partially_paid' | 'paid'; dueCents: number; paidCents: number; remainingCents: number; confirmedAt: string };

function cents(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value).trim())) return null;
  const scaled = Number(value) * 100;
  const rounded = Math.round(scaled);
  return Number.isSafeInteger(rounded) && rounded >= 0 ? rounded : null;
}

/** Payment status is never inferred from missing ledger rows or signed source shares. */
export function historicalPaymentPosition(row: InvestorHistoricalMonth): HistoricalPaymentPosition {
  const dueCents = cents(row.confirmed_payable_usd);
  const paidCents = cents(row.confirmed_paid_usd);
  const at = row.payment_confirmed_at;
  if (dueCents === null || paidCents === null || paidCents > dueCents
    || !at || !Number.isFinite(Date.parse(at)) || !row.payment_confirmation_note?.trim()) {
    return { confirmed: false, status: 'unconfirmed' };
  }
  return {
    confirmed: true,
    dueCents, paidCents, remainingCents: dueCents - paidCents, confirmedAt: at,
    status: dueCents === 0 ? 'no_payout_due' : paidCents === 0 ? 'unpaid' : paidCents === dueCents ? 'paid' : 'partially_paid',
  };
}

/** Rows must belong to one investor. Unknown months are not counted as zero. */
export function historicalPaymentSummary(rows: InvestorHistoricalMonth[]) {
  const positions = rows.map(historicalPaymentPosition);
  const seen = new Set<string>();
  const investor = rows[0]?.investor_user_id;
  let validScope = true;
  let dueCents = 0, paidCents = 0, confirmedCount = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i], position = positions[i];
    if (row.investor_user_id !== investor || seen.has(row.month_start)) validScope = false;
    seen.add(row.month_start);
    if (position.confirmed) {
      confirmedCount += 1;
      dueCents += position.dueCents;
      paidCents += position.paidCents;
    }
  }
  if (!Number.isSafeInteger(dueCents) || !Number.isSafeInteger(paidCents)) validScope = false;
  return {
    positions, validScope, confirmedCount, unconfirmedCount: rows.length - confirmedCount,
    dueCents: validScope ? dueCents : null,
    paidCents: validScope ? paidCents : null,
    remainingCents: validScope ? dueCents - paidCents : null,
  };
}
