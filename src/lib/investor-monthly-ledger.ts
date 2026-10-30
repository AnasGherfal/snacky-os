// Read-model for the owner and investor monthly table.
// This module never changes financial records or assigns a payment exchange rate
// to a month. Historic source currency is converted with the dated archived
// reference only; every real LYD payment stays at its own recorded settlement rate.
export type InvestorHistoricLedgerMonth = {
  month_start: string;
  net_profit_lyd: number | string | null;
  exchange_rate_lyd_per_usd: number | string | null;
  confirmed_payable_usd: number | string | null;
  confirmed_paid_usd: number | string | null;
  payment_confirmed_at: string | null;
};
export type InvestorGeneratedLedgerMonth = {
  month_start: string;
  operating_profit_lyd: number | string | null;
  investor_share_due_lyd: number | string | null;
  calculation_status: string;
  source_complete?: boolean | null;
};
export type InvestorLydAllocation = { payout_id: string; month_start: string; amount_lyd: number | string };
export type InvestorLydBatch = {
  id: string; payout_date: string; amount_lyd: number | string;
  credited_usd: number | string; lyd_per_usd: number | string; payment_reference: string;
};
export type InvestorUsdLegacyPayout = { month_start: string; amount_usd: number | string; lyd_equivalent: number | string };
export type InvestorLedgerMonth = {
  month: string;
  source: "historical" | "finalized" | "draft" | "in_progress";
  netProfitLyd: number | null;
  dueLyd: number | null;
  estimatedShareLyd: number | null;
  paidLyd: number | null;
  outstandingLyd: number | null;
  status: "unpaid" | "partial" | "paid" | "nothing_due" | "pending" | "in_progress" | "unverified";
};
export type InvestorLedgerResult = {
  months: InvestorLedgerMonth[];
  totalDueLyd: number;
  totalEstimatedLyd: number;
  totalPaidLyd: number;
  totalOutstandingLyd: number;
  creditedUsd: number;
  goalUsd: number;
  remainingGoalUsd: number;
  progressPercent: number;
  needsReview: boolean;
  payableMonths: Array<{ month_start: string; due_lyd: number; paid_lyd: number; remaining_lyd: number }>;
};
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const safeMoney = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? cents(number) : null;
};
const safeSigned = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? cents(number) : null;
};
const total = (values: number[]) => cents(values.reduce((sum, amount) => sum + amount, 0));

export function buildInvestorMonthlyLedger(input: {
  startDate: string;
  endDate?: string | null;
  capUsd: number | string;
  historical: InvestorHistoricLedgerMonth[];
  generated: InvestorGeneratedLedgerMonth[];
  batches: InvestorLydBatch[];
  allocations: InvestorLydAllocation[];
  legacyUsdPayouts: InvestorUsdLegacyPayout[];
}): InvestorLedgerResult {
  const withinPeriod = (month: string) => month >= input.startDate && (!input.endDate || month <= input.endDate);
  const historic = input.historical.filter(r => withinPeriod(r.month_start));
  const generated = input.generated.filter(r => withinPeriod(r.month_start));
  const history = new Map(historic.map(r => [r.month_start, r]));
  const statement = new Map(generated.map(r => [r.month_start, r]));
  const allocationByMonth = new Map<string, number>();
  const legacyByMonth = new Map<string, number>();
  let needsReview = false;

  for (const a of input.allocations) {
    const amount = safeMoney(a.amount_lyd);
    if (amount === null) { needsReview = true; continue; }
    allocationByMonth.set(a.month_start, cents((allocationByMonth.get(a.month_start) ?? 0) + amount));
  }
  for (const p of input.legacyUsdPayouts) {
    const amount = safeMoney(p.lyd_equivalent);
    if (amount === null) { needsReview = true; continue; }
    legacyByMonth.set(p.month_start, cents((legacyByMonth.get(p.month_start) ?? 0) + amount));
  }

  const months: InvestorLedgerMonth[] = [];
  for (const month of [...new Set([...history.keys(), ...statement.keys()])].sort()) {
    const h = history.get(month), s = statement.get(month);
    if (h && s) needsReview = true;
    if (h) {
      const rate = Number(h.exchange_rate_lyd_per_usd);
      const payable = safeMoney(h.confirmed_payable_usd), paidHistoric = safeMoney(h.confirmed_paid_usd);
      const verified = Boolean(h.payment_confirmed_at) && payable !== null && paidHistoric !== null &&
        Number.isFinite(rate) && rate > 0;
      if (!verified) {
        needsReview = true;
        months.push({ month, source: "historical", netProfitLyd: safeSigned(h.net_profit_lyd), dueLyd: null, estimatedShareLyd: null, paidLyd: null, outstandingLyd: null, status: "unverified" });
        continue;
      }
      const due = cents(payable * rate);
      const paid = cents(cents(paidHistoric * rate) + (allocationByMonth.get(month) ?? 0));
      if (paid > due + 0.005) needsReview = true;
      months.push({ month, source: "historical", netProfitLyd: safeSigned(h.net_profit_lyd),
        dueLyd: due, estimatedShareLyd: null, paidLyd: paid, outstandingLyd: Math.max(0, cents(due - paid)),
        status: due === 0 ? "nothing_due" : paid >= due - 0.005 ? "paid" : paid > 0 ? "partial" : "unpaid" });
    } else if (s) {
      const finalized = s.calculation_status === "finalized";
      const due = finalized ? safeMoney(s.investor_share_due_lyd) : null;
      const estimatedShareLyd = s.calculation_status === 'draft' ? safeMoney(s.investor_share_due_lyd) : null;
      if (finalized && due === null) needsReview = true;
      // Paid is a factual cash allocation, even when the month's share is
      // still a calculated draft. A draft cannot become payable from this.
      const paid = cents((allocationByMonth.get(month) ?? 0) + (legacyByMonth.get(month) ?? 0));
      if (due !== null && paid !== null && paid > due + 0.005) needsReview = true;
      months.push({ month, source: finalized ? "finalized" : s.calculation_status === "in_progress" ? "in_progress" : "draft", netProfitLyd: finalized || estimatedShareLyd !== null ? safeSigned(s.operating_profit_lyd) : null,
        dueLyd: due, estimatedShareLyd, paidLyd: paid, outstandingLyd: due === null || paid === null ? null : Math.max(0, cents(due - paid)),
        status: s.calculation_status === "in_progress" ? "in_progress" : !finalized ? "pending" : due === null ? "unverified" : due === 0 ? "nothing_due" : paid! >= due - 0.005 ? "paid" : paid! > 0 ? "partial" : "unpaid" });
    }
  }
  if (historic.length !== history.size || generated.length !== statement.size) needsReview = true;
  // Every posted allocation must point to an actual month in the agreement.
  if (input.allocations.some(a => !history.has(a.month_start) && !statement.has(a.month_start))) needsReview = true;
  if (input.allocations.some(a => !input.batches.some(batch => batch.id === a.payout_id))) needsReview = true;
  // A legacy USD payment also changed the imported confirmed-paid field. Count
  // it once, then count only payments for non-historical finalized months.
  const archivedCredit = total(historic.filter(h => h.payment_confirmed_at).map(h => safeMoney(h.confirmed_paid_usd) ?? 0));
  const earlierCredit = total(input.legacyUsdPayouts.filter(p => !history.has(p.month_start)).map(p => safeMoney(p.amount_usd) ?? 0));
  const recentCredit = total(input.batches.map(b => safeMoney(b.credited_usd) ?? 0));
  if (input.batches.some(b => safeMoney(b.credited_usd) === null)) needsReview = true;
  const creditedUsd = total([archivedCredit, earlierCredit, recentCredit]);
  const goalUsd = safeMoney(input.capUsd);
  if (goalUsd === null || goalUsd <= 0) needsReview = true;
  if (goalUsd !== null && creditedUsd > goalUsd + .005) needsReview = true;
  const confirmed = months.filter(row => row.dueLyd !== null && row.paidLyd !== null);
  const totalDueLyd = total(confirmed.map(m => m.dueLyd!));
  const totalEstimatedLyd = total(months.filter(m => m.source === 'draft' && m.estimatedShareLyd !== null).map(m => m.estimatedShareLyd!));
  const totalPaidLyd = total(confirmed.map(m => m.paidLyd!));
  const payableMonths = !needsReview && goalUsd !== null && creditedUsd < goalUsd
    ? confirmed.filter(r => r.outstandingLyd! > 0.005).map(r => ({
        month_start: r.month, due_lyd: r.dueLyd!, paid_lyd: r.paidLyd!, remaining_lyd: r.outstandingLyd!
      }))
    : [];
  return {
    months, totalDueLyd, totalEstimatedLyd, totalPaidLyd,
    totalOutstandingLyd: Math.max(0, cents(totalDueLyd - totalPaidLyd)),
    creditedUsd, goalUsd: goalUsd ?? 0,
    remainingGoalUsd: Math.max(0, cents((goalUsd ?? 0) - creditedUsd)),
    progressPercent: goalUsd && goalUsd > 0 ? Math.min(100, Math.round(creditedUsd / goalUsd * 10000) / 100) : 0,
    needsReview, payableMonths,
  };
}
