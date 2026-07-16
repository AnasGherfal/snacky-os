import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isCompleteClosedMonthRange,
  monthlyMachineExpectedCash,
  reconcileMonthlyCash,
  resolveMonthlyCashExpectation,
} from "../src/lib/monthly-cash-close.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const cashForm = read("src/components/CashCollectionForm.tsx");
const cashActions = read("src/lib/cash-actions.ts");
const cashList = read("src/app/cash-collections/page.tsx");
const cashDetail = read("src/app/cash-collections/[id]/page.tsx");
const financeOperations = read("src/app/finance/operations/page.tsx");

test("VMS payment split uses cash sales as monthly expected cash", () => {
  const expectation = resolveMonthlyCashExpectation({
    paymentSplitAvailable: true,
    vmsCashSales: 4250,
    vmsRevenue: 6000,
  });
  assert.equal(expectation.source, "vms_cash_split");
  assert.equal(expectation.expectedCash, 4250);
});

test("cash-only workflow uses total VMS sales when payment split is unavailable", () => {
  const expectation = resolveMonthlyCashExpectation({
    paymentSplitAvailable: false,
    vmsCashSales: 0,
    vmsRevenue: 6000,
  });
  assert.equal(expectation.source, "cash_only_total_sales");
  assert.equal(expectation.expectedCash, 6000);
  assert.match(expectation.note, /cash-only/i);
});

test("monthly shortage or overage compares the sum of pickups with monthly expectation", () => {
  const expectation = resolveMonthlyCashExpectation({
    paymentSplitAvailable: false,
    vmsCashSales: 0,
    vmsRevenue: 6000,
  });
  const close = reconcileMonthlyCash(5940, expectation);
  assert.equal(close.countedCash, 5940);
  assert.equal(close.expectedCash, 6000);
  assert.equal(close.variance, -60);
  assert.equal(close.accuracy, 0.99);
});

test("only a complete past calendar month is a closed month", () => {
  const now = new Date(2026, 6, 16);
  assert.equal(isCompleteClosedMonthRange("2026-06-01", "2026-06-30", now), true);
  assert.equal(isCompleteClosedMonthRange("2026-07-01", "2026-07-16", now), false);
  assert.equal(isCompleteClosedMonthRange("2026-06-05", "2026-06-30", now), false);
});

test("per-machine expectation is unavailable when machine-level payment split is missing", () => {
  assert.equal(monthlyMachineExpectedCash({ paymentSplitAvailable: true, vmsSalesAmount: 1000 }), null);
  assert.equal(monthlyMachineExpectedCash({ paymentSplitAvailable: false, vmsSalesAmount: 1000 }), 1000);
});

test("cash pickup forms no longer request expected cash", () => {
  assert.doesNotMatch(cashForm, /name="expected_cash_lyd"/);
  assert.doesNotMatch(cashDetail, /name="expected_cash_lyd"/);
  assert.match(cashForm, /Expected cash is reconciled for the full machine month/i);
});

test("new, confirmed, and edited pickups clear per-pickup expected cash", () => {
  const matches = cashActions.match(/const expectedCash = null;/g) ?? [];
  assert.equal(matches.length, 3);
  assert.doesNotMatch(cashActions, /formData\.get\("expected_cash_lyd"\)/);
});

test("cash list presents pickups without per-pickup expected or variance columns", () => {
  assert.match(cashList, /Monthly close/);
  assert.match(cashList, /Counted amount/);
  assert.doesNotMatch(cashList, /headers=\{\["Machine"[^\]]*"Expected cash"/);
  assert.doesNotMatch(cashList, /headers=\{\["Machine"[^\]]*"Variance"/);
});

test("Finance Operations assigns pickups by cash-removal date and reconciles monthly", () => {
  assert.match(financeOperations, /\.gte\("collected_at", startTimestamp\)/);
  assert.match(financeOperations, /\.lte\("collected_at", endTimestamp\)/);
  assert.doesNotMatch(financeOperations, /\.gte\("counted_at", startTimestamp\)/);
  assert.match(financeOperations, /Monthly VMS expected cash/);
  assert.match(financeOperations, /Monthly shortage \/ overage/);
  assert.match(financeOperations, /provisional until the month is fully closed/i);
});
