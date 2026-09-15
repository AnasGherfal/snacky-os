"use server";

import { revalidatePath } from "next/cache";
import { getAuthAccessToken, getCurrentProfile } from "@/lib/auth";
import { canRecordPurchasePayments } from "@/lib/authz";
import { logActivity } from "@/lib/activity-log";
import { isPurchaseOperationId } from "@/lib/purchase-operation-id";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { supplierMoneyCents, supplierPaymentDate, supplierPaymentState } from "@/lib/supplier-payment-state";

export type InlineSupplierPaymentResult =
  | { ok: true; message: string; paymentId: string }
  | { ok: false; message: string; retrySameRequest: boolean };

const RECEIPT_COLUMNS = "id, purchase_order_id, amount_lyd, paid_at, payment_method, account_id, reference, note, recorded_by, voided_at, finance_transaction_id";
const text = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const failed = (message: string, retrySameRequest = false): InlineSupplierPaymentResult => ({ ok: false, message, retrySameRequest });

export async function recordInlineSupplierPayment(fd: FormData): Promise<InlineSupplierPaymentResult> {
  const profile = await getCurrentProfile();
  if (!profile || profile.active_status !== "active" || !profile.team_member_id || !canRecordPurchasePayments(profile)) {
    return failed("Only an active owner, admin, or finance user can record supplier payments.");
  }
  const accessToken = await getAuthAccessToken();
  const supabase = accessToken ? getSupabaseServerClient(accessToken) : null;
  if (!supabase) return failed("Your session could not be verified. Sign in again before recording a payment.");

  const id = text(fd, "purchase_order_id");
  const submissionId = text(fd, "client_submission_id");
  const amountCents = supplierMoneyCents(text(fd, "amount"));
  const expectedRemaining = supplierMoneyCents(text(fd, "expected_remaining"));
  const paidAt = supplierPaymentDate(text(fd, "paid_at"));
  const method = text(fd, "payment_method");
  const account = text(fd, "account_id");
  const reference = text(fd, "reference");
  const note = text(fd, "note");
  if (!isPurchaseOperationId(id) || !isPurchaseOperationId(submissionId)) return failed("Invalid purchase or payment request. Refresh the list and try again.");
  if (text(fd, "confirm_payment") !== "yes") return failed("Confirm that this supplier payment has actually been made.");
  if (amountCents === null || amountCents <= 0 || expectedRemaining === null) return failed("Enter a positive LYD amount with no more than two decimal places.");
  if (!paidAt) return failed("Enter a valid payment date.");
  if (!["cash", "bank_transfer", "card", "other"].includes(method)) return failed("Choose a valid payment method.");
  if (!["snacky_lyd", "owner_lyd"].includes(account)) return failed("Choose Snacky LYD or Owner LYD as the paying account.");
  if (reference.length > 200 || note.length > 2000) return failed("The reference or note is too long.");

  const refreshViews = () => {
    for (const path of ["/purchases", `/purchases/${id}`, "/finance", "/finance/transactions"]) revalidatePath(path);
  };
  const matches = (row: any) => String(row.purchase_order_id) === id
    && supplierMoneyCents(row.amount_lyd) === amountCents
    && new Date(row.paid_at).getTime() === new Date(paidAt).getTime()
    && row.payment_method === method && row.account_id === account
    && String(row.reference ?? "").trim() === reference && String(row.note ?? "").trim() === note
    && row.recorded_by === profile.team_member_id;
  const readReceipt = () => supabase.from("purchase_payments").select(RECEIPT_COLUMNS).eq("client_submission_id", submissionId).maybeSingle();
  const confirmReceipt = async (receipt: any): Promise<InlineSupplierPaymentResult> => {
    if (!matches(receipt)) return failed("This payment request belongs to different details. No new payment was made; review its history before trying another payment.", true);
    if (receipt.voided_at || !receipt.finance_transaction_id) return failed("This request already has a voided or incomplete payment record. Review its payment history; do not submit a new payment.", true);
    const { data: finance, error } = await supabase.from("financial_transactions")
      .select("id, source_type, source_id, amount, signed_amount, account_id, transaction_status, is_void")
      .eq("id", receipt.finance_transaction_id).maybeSingle();
    if (error || !finance || finance.transaction_status !== "active" || finance.is_void
      || finance.source_type !== "purchase_payment" || String(finance.source_id) !== String(receipt.id)
      || supplierMoneyCents(finance.amount) !== amountCents || Number(finance.signed_amount) !== -amountCents / 100 || finance.account_id !== account) {
      return failed("The payment exists, but its Finance entry could not be verified. Retry this same request or review the payment history; do not record it again.", true);
    }
    try {
      await logActivity({ profile, idempotencyKey: `purchase-payment-record:v2:${submissionId}`, action: "record_purchase_payment", entityType: "purchase", entityId: id, entityLabel: id.slice(0, 8), afterData: receipt, metadata: { amount: amountCents / 100, payment_method: method, account_id: account, origin: "purchases_table" }, summary: `Recorded supplier payment of ${(amountCents / 100).toFixed(2)} LYD` });
    } catch (error) {
      console.error("[supplier-payment] Payment committed; activity log needs follow-up", { purchase_id: id, payment_id: receipt.id, error });
    }
    try { refreshViews(); } catch (error) { console.error("[supplier-payment] Payment committed; refresh needed", error); }
    return { ok: true, paymentId: String(receipt.id), message: "Supplier payment recorded and matching Finance money-out verified." };
  };

  let attempted = false;
  try {
    // Check retries BEFORE balance validation: the successful first attempt may
    // have paid the invoice in full even when its network response was lost.
    const existing = await readReceipt();
    if (existing.error) return failed("Payment history could not be checked. Nothing new was submitted; retry the same request.", true);
    if (existing.data) return await confirmReceipt(existing.data);

    const [purchaseResult, summaryResult] = await Promise.all([
      supabase.from("purchase_orders").select("id, status, total_amount, manual_total_lyd, calculated_total_lyd, total_source").eq("id", id).maybeSingle(),
      supabase.from("purchase_payment_summary").select("purchase_order_id, total_amount_lyd, paid_amount_lyd, remaining_amount_lyd, payment_status").eq("purchase_order_id", id).maybeSingle(),
    ]);
    if (purchaseResult.error || summaryResult.error || !purchaseResult.data) return failed("Could not verify the purchase and current payment balance. Refresh and retry.");
    const state = supplierPaymentState(purchaseResult.data, summaryResult.data);
    if (!state.ready) return failed(state.reason);
    if (supplierMoneyCents(state.remaining) !== expectedRemaining) return failed("The supplier balance changed since this row was loaded. Refresh the list and confirm the new remaining amount.");
    if (amountCents > expectedRemaining) return failed("Payment is greater than the remaining supplier balance.");

    attempted = true;
    // The existing database transaction owns the payment, its Finance entry,
    // row locking, remaining-balance guard and unique submission ID. Never flip
    // payment_status or insert a separate money-out from the browser/server action.
    const { data: receipt, error } = await supabase.rpc("record_purchase_payment", {
      p_purchase_order_id: id, p_amount: amountCents / 100, p_paid_at: paidAt,
      p_payment_method: method, p_account_id: account, p_reference: reference || null,
      p_note: note || null, p_client_submission_id: submissionId,
    });
    if (!error && receipt) return await confirmReceipt(receipt);

    // A concurrent retry may hit the unique constraint after the other request
    // commits. Confirm that exact receipt instead of creating another payment.
    const recovered = await readReceipt();
    if (!recovered.error && recovered.data) return await confirmReceipt(recovered.data);
    console.error("[supplier-payment] Recording did not return a verified receipt", { purchase_id: id, error });
    if (error?.code === "23514" && !recovered.error) return failed("The purchase or remaining balance changed. Refresh the list before confirming payment again.");
    if (["42501", "28000"].includes(String(error?.code))) return failed("Your account is not permitted to record this payment. Sign in again.");
    return failed("The payment result could not be confirmed. Retry with the same saved request; do not record another payment.", true);
  } catch (error) {
    console.error("[supplier-payment] Payment result unavailable", { purchase_id: id, attempted, error });
    return failed(attempted ? "The payment result could not be confirmed. Retry the same saved request to avoid a duplicate." : "Could not check the payment. Retry the same request.", true);
  }
}
