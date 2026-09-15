export type SupplierPaymentSummary = {
  purchase_order_id: string;
  total_amount_lyd: number | string;
  paid_amount_lyd: number | string;
  remaining_amount_lyd: number | string;
  payment_status: string;
};

export type SupplierPaymentPurchase = {
  id: string;
  status: string;
  total_amount?: number | string | null;
  manual_total_lyd?: number | string | null;
  calculated_total_lyd?: number | string | null;
  total_source?: string | null;
};

export type SupplierPaymentState = {
  ready: boolean;
  reason: string;
  total: number | null;
  paid: number | null;
  remaining: number | null;
};

/** Reject missing/invalid money instead of converting null, blanks or NaN to zero. */
export function supplierMoneyCents(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents)) return null;
  if (Math.abs(amount * 100 - cents) > 0.000001) return null;
  return cents;
}

/** Supplier cash payments use the recorded invoice and payment ledger, not
 * rounded per-unit inventory valuations. Receiving/voiding retain their separate
 * accounting checks. Conflicting invoice totals or an unreadable ledger still block. */
export function supplierPaymentState(
  purchase: SupplierPaymentPurchase,
  summary: SupplierPaymentSummary | null | undefined,
): SupplierPaymentState {
  const blocked = (reason: string): SupplierPaymentState => ({ ready: false, reason, total: null, paid: null, remaining: null });
  if (purchase.status !== "received") return blocked("Receive this purchase into storage before recording a supplier payment.");
  if (!summary || String(summary.purchase_order_id) !== String(purchase.id)) return blocked("Payment totals could not be verified. Refresh the purchases list and try again.");
  if (summary.payment_status === "voided") return blocked("A voided purchase cannot be paid.");

  const invoiceValue = purchase.manual_total_lyd ?? purchase.total_amount ?? purchase.calculated_total_lyd;
  const total = supplierMoneyCents(invoiceValue);
  if (total === null || total <= 0) return blocked("This purchase needs a valid positive invoice total before a payment can be recorded.");
  if (purchase.total_source === "manual" && purchase.manual_total_lyd == null) return blocked("The manual invoice total is missing. Review the purchase total first.");
  if (purchase.total_amount != null && supplierMoneyCents(purchase.total_amount) !== total) return blocked("The recorded purchase total and invoice total disagree. Review those amounts before paying.");
  if (purchase.manual_total_lyd == null && purchase.calculated_total_lyd != null && supplierMoneyCents(purchase.calculated_total_lyd) !== total) return blocked("The calculated and recorded purchase totals disagree. Review those amounts before paying.");

  const summaryTotal = supplierMoneyCents(summary.total_amount_lyd);
  const paid = supplierMoneyCents(summary.paid_amount_lyd);
  const remaining = supplierMoneyCents(summary.remaining_amount_lyd);
  if (summaryTotal !== total || paid === null || remaining === null || paid > total || paid + remaining !== total) return blocked("The invoice and payment ledger balances disagree. Refresh; do not record another payment until they match.");
  const expectedStatus = remaining === 0 ? "paid" : paid > 0 ? "partially_paid" : "unpaid";
  if (summary.payment_status !== expectedStatus) return blocked("Payment status and ledger balance disagree. Refresh the purchases list first.");
  return {
    ready: remaining > 0,
    reason: remaining > 0 ? "" : "This purchase is already paid in full.",
    total: total / 100,
    paid: paid / 100,
    remaining: remaining / 100,
  };
}

export function supplierPaymentDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return null;
  // Record the chosen calendar day at noon in Tripoli; never shift it to yesterday.
  return `${value}T12:00:00+02:00`;
}

export function supplierPaymentToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
