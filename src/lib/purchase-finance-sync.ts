import { accountCurrency, financeAccountId } from "./finance-balance.ts";

type PurchaseFinancePayloadSource = {
  id: string;
  payment_account_id?: string | null;
  account_id?: string | null;
  currency?: string | null;
  receipt_number?: string | null;
  notes?: string | null;
  supplier_name?: string | null;
  supplier?: { name?: string | null } | null;
  payment_method?: string | null;
  receipt_url?: string | null;
};

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

export function purchaseFinanceTransactionDateTime(transactionDate: string) {
  const date = String(transactionDate ?? "").trim();
  return date ? `${date}T00:00:00.000Z` : null;
}

export function buildPurchaseFinanceTransactionPayload({
  purchase,
  amount,
  transactionDate,
  supplierName,
  createdBy,
}: {
  purchase: PurchaseFinancePayloadSource;
  amount: number;
  transactionDate: string;
  supplierName?: string | null;
  createdBy?: string | null;
}) {
  const accountId = resolvePurchaseFinanceAccountId(purchase);
  const currency = accountCurrency(accountId);
  const description = buildPurchaseFinanceDescription(purchase, supplierName);
  const purchaseId = purchase.id;
  const restockingCategory = "Products Restocking";

  return {
    transaction_date: transactionDate,
    transaction_datetime: purchaseFinanceTransactionDateTime(transactionDate),
    direction: "money_out",
    transaction_kind: "product_purchase",
    transaction_type: restockingCategory,
    category: restockingCategory,
    description,
    notes: String(purchase.notes ?? "").trim() || description,
    amount: Math.abs(amount),
    signed_amount: -Math.abs(amount),
    currency,
    account_id: accountId,
    account_key: accountId,
    transaction_effect: "expense",
    source_account_id: null,
    destination_account_id: null,
    bucket: "Inventory",
    final_bucket: restockingCategory,
    review_status: "confirmed",
    needs_review: false,
    transaction_status: "active",
    is_void: false,
    voided_at: null,
    void_reason: null,
    payment_method: purchase.payment_method ?? null,
    receipt_url: purchase.receipt_url ?? null,
    payer_text: null,
    payee_text: supplierName,
    paid_to_text: supplierName,
    counterparty_text: supplierName,
    linked_purchase_id: purchaseId,
    related_purchase_id: purchaseId,
    source_type: "purchase",
    source_id: purchaseId,
    created_by: createdBy ?? null,
    updated_at: new Date().toISOString(),
  };
}
