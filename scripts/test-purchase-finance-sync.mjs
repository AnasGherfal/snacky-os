import assert from "node:assert/strict";
import test from "node:test";
import { buildPurchaseFinanceDescription, resolvePurchaseFinanceAccountId } from "../src/lib/purchase-finance-sync.ts";

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
