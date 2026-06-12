import assert from "node:assert/strict";
import { test } from "node:test";
import {
  financeCategoryLabel,
  isFinanceRowVoided,
  isVisibleFinanceLedgerRow,
  normalizeFinanceLedgerRow,
} from "../src/lib/finance-ledger.ts";

test("null is_void is treated as active/visible", () => {
  const row = normalizeFinanceLedgerRow({
    id: "legacy-import",
    transaction_date: "2026-06-01",
    direction: "money_in",
    amount: 100,
    is_void: null,
    transaction_status: null,
  });

  assert.equal(row.is_void, false);
  assert.equal(row.transaction_status, "active");
  assert.equal(isVisibleFinanceLedgerRow(row), true);
});

test("voided rows are hidden by default", () => {
  assert.equal(isFinanceRowVoided({ is_void: true }), true);
  assert.equal(isVisibleFinanceLedgerRow({ is_void: true }), false);
  assert.equal(isFinanceRowVoided({ is_void: null, voided_at: "2026-06-01T00:00:00Z" }), true);
});

test("missing finance categories are displayed as Uncategorized", () => {
  assert.equal(financeCategoryLabel({ category: null, final_bucket: null, transaction_type: null, bucket: null }), "Uncategorized");
  assert.equal(financeCategoryLabel({ category: "", final_bucket: "Products Restocking" }), "Products Restocking");
});
