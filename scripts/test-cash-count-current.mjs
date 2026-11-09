import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { currentLibyaCashMonth } from "../src/lib/cash-current-period.ts";

const file = (path) => readFileSync(path, "utf8");

test("Libya cash month starts at local midnight, not UTC midnight", () => {
  const november = currentLibyaCashMonth(new Date("2026-10-31T22:30:00Z"));
  assert.equal(november.startDate, "2026-11-01");
  assert.equal(november.startTimestamp, "2026-11-01T00:00:00+02:00");
  assert.match(november.label, /November 2026/);
  const october = currentLibyaCashMonth(new Date("2026-10-31T21:59:59Z"));
  assert.equal(october.startDate, "2026-10-01");
});

test("today's cash queue is distinct from immutable older history", () => {
  const root = file("src/app/cash-collections/page.tsx");
  const queue = file("src/app/cash-collections/action-queue/page.tsx");
  const receiving = file("src/components/cash/CashReceiveWorkspace.tsx");
  assert.match(root, /defaultCurrentMonth/);
  assert.match(root, /scopeParam !== "all"/);
  assert.match(root, /effectiveDateFrom/);
  assert.match(root, /Count current cash/);
  assert.match(root, /Older \/ all records/);
  assert.match(queue, /const cutoff=currentLibyaCashMonth\(\)\.startTimestamp/);
  assert.match(receiving, /showHistory/);
  assert.match(receiving, /\/cash-collections\/count/);
});

test("simplified counting reuses the original removal and does not fake count, sales or receipt", () => {
  const page = file("src/app/cash-collections/count/page.tsx");
  const form = file("src/components/CashCustodyForms.tsx");
  assert.match(page, /\.is\("actual_cash_collected", null\)/);
  assert.match(page, /\.in\("custody_status", \["removed", "in_storage"\]\)/);
  assert.match(page, /row\.custody_status === "in_storage"/);
  assert.match(page, /CashCountForm action=\{confirmCashCollectionCount\}/);
  assert.match(page, /Record storage receipt/);
  assert.match(page, /currentLibyaCashMonth\(\)/);
  assert.match(form, /name="total_amount_lyd"/);
  assert.match(form, /Save count to this removal/);
  assert.doesNotMatch(page, /\.insert\(|\.update\(|\.delete\(/);
});

test("photos are private and allow matching removal and stored bag before count", () => {
  const page = file("src/app/cash-collections/count/page.tsx");
  const detail = file("src/app/cash-collections/[id]/page.tsx");
  assert.match(page, /privateStorageObjectUrl\(CASH_EVIDENCE_BUCKET, path\)/);
  assert.match(page, /removal_evidence_path/);
  assert.match(page, /event_type", \["removed", "stored"\]/);
  assert.match(detail, /Photo at machine removal/);
  assert.match(detail, /Photo when placed in storage/);
  assert.match(detail, /id="cash-count"/);
});
