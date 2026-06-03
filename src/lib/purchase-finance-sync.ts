import { financeAccountId } from "./finance-balance.ts";

export function resolvePurchaseFinanceAccountId(purchase: { payment_account_id?: string | null; account_id?: string | null; currency?: string | null }) {
  return financeAccountId(purchase.payment_account_id ?? purchase.account_id ?? "", purchase.currency ?? "LYD");
}

export function buildPurchaseFinanceDescription(
  purchase: {
    receipt_number?: string | null;
    notes?: string | null;
    supplier_name?: string | null;
    supplier?: { name?: string | null } | null;
  },
  supplierName?: string | null,
) {
  const supplierLabel = String(supplierName ?? purchase.supplier_name ?? purchase.supplier?.name ?? "supplier").trim() || "supplier";
  const receiptNumber = String(purchase.receipt_number ?? "").trim();
  const notes = String(purchase.notes ?? "").trim();
  const parts = [`Purchase from ${supplierLabel}`];
  if (receiptNumber) parts.push(`Receipt ${receiptNumber}`);
  if (notes) parts.push(notes);
  return parts.join(" - ");
}
