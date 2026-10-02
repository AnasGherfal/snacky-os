import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPurchaseFinanceDescription,
  buildPurchaseFinanceTransactionPayload,
  purchaseFinanceTransactionDateTime,
  resolvePurchaseFinanceAccountId,
} from "../src/lib/purchase-finance-sync.ts";

test("purchase finance sync defaults to Snacky LYD", () => {
  assert.equal(resolvePurchaseFinanceAccountId({}), "snacky_lyd");
});

test("purchase finance sync respects selected paying account", () => {
  assert.equal(resolvePurchaseFinanceAccountId({ payment_account_id: "owner_usd" }), "owner_usd");
});

test("purchase finance description includes supplier, receipt, and notes", () => {
  const description = buildPurchaseFinanceDescription(
    { receipt_number: "RCPT-42", notes: "Monthly stock top-up", supplier: { name: "ABC Supplies" } },
    null,
  );

  assert.equal(description, "Purchase from ABC Supplies - Receipt RCPT-42 - Monthly stock top-up");
});

test("purchase finance datetime uses the selected purchase date", () => {
  assert.equal(purchaseFinanceTransactionDateTime("2026-06-02"), "2026-06-02T00:00:00.000Z");
});

test("purchase finance payload links purchase and fills compatibility columns", () => {
  const payload = buildPurchaseFinanceTransactionPayload({
    purchase: {
      id: "11111111-1111-4111-8111-111111111111",
      order_date: "2026-06-02",
      payment_account_id: "owner_lyd",
      payment_method: "cash",
      receipt_number: "INV-7",
      notes: "Backfilled purchase",
    },
    amount: 123.45,
    transactionDate: "2026-06-02",
    supplierName: "Tripoli Supplier",
    createdBy: "22222222-2222-4222-8222-222222222222",
  });

  assert.equal(payload.transaction_date, "2026-06-02");
  assert.equal(payload.transaction_datetime, "2026-06-02T00:00:00.000Z");
  assert.equal(payload.direction, "money_out");
  assert.equal(payload.category, "Products Restocking");
  assert.equal(payload.account_id, "owner_lyd");
  assert.equal(payload.account_key, "owner_lyd");
  assert.equal(payload.currency, "LYD");
  assert.equal(payload.amount, 123.45);
  assert.equal(payload.signed_amount, -123.45);
  assert.equal(payload.source_type, "purchase");
  assert.equal(payload.source_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.linked_purchase_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.related_purchase_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(payload.paid_to_text, "Tripoli Supplier");
  assert.equal(payload.payee_text, "Tripoli Supplier");
  assert.equal(payload.counterparty_text, "Tripoli Supplier");
  assert.equal(payload.description, "Purchase from Tripoli Supplier - Receipt INV-7 - Backfilled purchase");
});
