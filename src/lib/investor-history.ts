export type InvestorHistoricalMonth = {
  id: string;
  investor_user_id: string;
  month_start: string;
  profit_lyd: number | string;
  cogs_refill_cost_lyd: number | string | null;
  other_opex_lyd: number | string;
  previous_month_lyd: number | string | null;
  net_profit_lyd: number | string;
  exchange_rate_lyd_per_usd: number | string;
  net_profit_usd: number | string;
  investor_share_percent: number | string;
  investor_share_usd: number | string;
  source_label: string;
  source_cells: Record<string, string>;
  source_note: string | null;
  confirmed_payable_usd?: number | string | null;
  confirmed_paid_usd?: number | string | null;
  payment_confirmed_at?: string | null;
  payment_confirmation_note?: string | null;
};

export const investorHistoryColumns = [
  'id', 'investor_user_id', 'month_start', 'profit_lyd', 'cogs_refill_cost_lyd',
  'other_opex_lyd', 'previous_month_lyd', 'net_profit_lyd', 'exchange_rate_lyd_per_usd',
  'net_profit_usd', 'investor_share_percent', 'investor_share_usd',
  'source_label', 'source_cells', 'source_note',
  'confirmed_payable_usd', 'confirmed_paid_usd', 'payment_confirmed_at', 'payment_confirmation_note',
].join(',');

/** Prefer the exact source text, including signed figures and intentional blanks. */
export function historicalCell(
  row: InvestorHistoricalMonth,
  originalColumn: string,
  fallback: number | string | null,
): string {
  if (Object.prototype.hasOwnProperty.call(row.source_cells, originalColumn)) {
    const source = row.source_cells[originalColumn];
    return typeof source === 'string' && source.trim() ? source : '—';
  }
  if (fallback === null || fallback === undefined || String(fallback).trim() === '') return '—';
  const value = Number(fallback);
  return Number.isFinite(value)
    ? value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';
}

export function groupInvestorHistory(rows: InvestorHistoricalMonth[]) {
  const groups = new Map<string, InvestorHistoricalMonth[]>();
  for (const row of rows) {
    const group = groups.get(row.investor_user_id) ?? [];
    group.push(row);
    groups.set(row.investor_user_id, group);
  }
  for (const group of groups.values()) group.sort((a, b) => a.month_start.localeCompare(b.month_start));
  return groups;
}
