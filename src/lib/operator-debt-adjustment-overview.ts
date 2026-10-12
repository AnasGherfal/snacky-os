import {
  emptyTotals, summarizePurchases, text,
  type DataRow, type PurchaseOverview, type PurchaseTotals,
} from "./operator-purchase-overview.ts";

export type DebtAdjustmentHistory = {
  id: string;
  kind: "opening_balance" | "waiver" | "correction" | "repayment";
  amount: number;
  effectiveDate: string;
  note: string;
};
export type DebtAdjustedPurchaseOverview = PurchaseOverview & {
  adjustments: DebtAdjustmentHistory[];
};

export function debtAdjustmentHistory(row: DataRow): DebtAdjustmentHistory {
  const id = text(row.id);
  const kind = text(row.kind) as DebtAdjustmentHistory["kind"];
  const amount = Number(row.amount_lyd);
  const effectiveDate = text(row.effective_date);
  if (!id || !["opening_balance", "waiver", "correction", "repayment"].includes(kind)
    || !Number.isFinite(amount) || amount === 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
    || !Number.isFinite(Date.parse(`${effectiveDate}T00:00:00Z`))) {
    throw new Error("Historical balance adjustment is invalid; no partial balance is shown.");
  }
  if ((kind === "opening_balance" && amount < 0)
    || (["waiver", "repayment"].includes(kind) && amount > 0)) {
    throw new Error("Historical balance adjustment has an invalid sign.");
  }
  return { id, kind, amount: Math.round(amount * 100) / 100, effectiveDate, note: text(row.note) };
}

/** Financial-only entries remain separate from product quantities and stock proof.
 * Repayment rows allocate only the historical-balance portion of a debt payment;
 * purchase allocations have already been included by summarizePurchases.
 */
export function summarizeAdjustedPurchases(
  purchases: DataRow[], team: DataRow[], adjustments: DataRow[], month: string,
): PurchaseTotals[] {
  const totals = new Map(summarizePurchases(purchases, team, month).map(row => [row.personId, { ...row }]));
  const members = new Map(team.map(row => [text(row.id), row]));
  const seen = new Set<string>();
  for (const row of adjustments) {
    const item = debtAdjustmentHistory(row);
    if (seen.has(item.id)) throw new Error("Duplicate balance adjustment in report.");
    seen.add(item.id);
    const personId = text(row.person_id);
    if (!personId) throw new Error("Balance adjustment has no owner.");
    const member = members.get(personId);
    const total = totals.get(personId) || emptyTotals(personId, text(member?.full_name), member?.active !== false);
    const cents = Math.round(item.amount * 100);
    total.outstanding = (Math.round(total.outstanding * 100) + cents) / 100;
    const itemMonth = item.effectiveDate.slice(0, 7);
    const bucket = itemMonth === month ? "currentMonthOutstanding"
      : itemMonth < month ? "earlierOutstanding" : "otherOutstanding";
    total[bucket] = (Math.round(total[bucket] * 100) + cents) / 100;
    if (item.kind === "repayment") total.paid = (Math.round(total.paid * 100) - cents) / 100;
    totals.set(personId, total);
  }
  for (const total of totals.values()) {
    if ([total.outstanding, total.currentMonthOutstanding, total.earlierOutstanding, total.otherOutstanding].some(value => value < 0)) {
      throw new Error("Balance adjustments exceed recorded debt; review required.");
    }
  }
  return [...totals.values()].sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId));
}
