import assert from "node:assert/strict";
import test from "node:test";
import { resolvePurchaseFinanceTransactionDate } from "../src/lib/purchase-finance-date.ts";

test("purchase finance transaction date uses purchase date instead of today", () => {
  const date = resolvePurchaseFinanceTransactionDate({ order_date: "2026-05-01" }, "2026-05-22");
  assert.equal(date, "2026-05-01");
});

test("purchase finance transaction date prefers explicit payment date", () => {
  const date = resolvePurchaseFinanceTransactionDate({ payment_date: "2026-05-03", order_date: "2026-05-01" }, "2026-05-22");
  assert.equal(date, "2026-05-03");
});

test("purchase finance transaction date accepts paid_at timestamps", () => {
  const date = resolvePurchaseFinanceTransactionDate({ paid_at: "2026-05-04T11:30:00.000Z", order_date: "2026-05-01" }, "2026-05-22");
  assert.equal(date, "2026-05-04");
});

test("purchase finance transaction date only falls back when purchase has no date", () => {
  const date = resolvePurchaseFinanceTransactionDate({}, "2026-05-22");
  assert.equal(date, "2026-05-22");
});
