import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const summary = readFileSync("src/app/cash-collections/page.tsx", "utf8");
const detail = readFileSync("src/app/cash-collections/[id]/page.tsx", "utf8");
const queue = readFileSync("src/app/cash-collections/action-queue/page.tsx", "utf8");

test("cash control totals require provenance for a verified expectation", () => {
  assert.ok(summary.includes("verifiedCashExpectation"));
  assert.ok(summary.includes("verifiedMissingCashAmount(row)"));
  assert.ok(summary.includes("expected_source, expected_calculated_at"));
  assert.ok(summary.includes("Net variance — verified only"));
  assert.ok(summary.includes("No verified expected-cash comparisons"));
  assert.ok(summary.includes("unverifiedCount"));
});

test("cash detail does not label a placeholder expected zero as lost money", () => {
  assert.ok(detail.includes("verifiedCashExpectation(row)"));
  assert.ok(detail.includes("verifiedMissingCashAmount(row)"));
  assert.ok(detail.includes("Missing a dated source for the expected amount"));
  assert.ok(detail.includes('tr("Not verified", "غير موثق")'));
  assert.ok(detail.includes("This historical variance flag has no dated expected-cash source"));
});

test("action queue signals unverified expectations and incomplete reads", () => {
  assert.ok(queue.includes('expected_source,expected_calculated_at'));
  assert.ok(queue.includes('{count:"exact"}'));
  assert.ok(queue.includes("incompleteRead"));
  assert.ok(queue.includes("Some current cash records were not loaded."));
  assert.ok(queue.includes('?"Unverified":money('));
  assert.ok(queue.includes("Historical variance flags may lack a dated XY comparison"));
});

test("verification screens never adjust cash, ledger, or XY source records", () => {
  for (const file of [summary, detail, queue]) {
    assert.doesNotMatch(file, /\.from\("cash_collections"\)\s*\.update\(/);
    assert.doesNotMatch(file, /\.from\("cash_collections"\)\s*\.insert\(/);
    assert.doesNotMatch(file, /\.from\("cash_collections"\)\s*\.delete\(/);
  }
});

test("owner variance approval requires a proven expected source in both screen and server action", () => {
  const actions = readFileSync("src/lib/cash-actions.ts", "utf8");
  assert.ok(detail.includes('canResolve && verifiedExpectedCash !== null'));
  assert.ok(detail.includes('canResolve && verifiedExpectedCash === null'));
  assert.ok(detail.includes('approving a shortage here is disabled'));
  const resolveAction = actions.slice(actions.indexOf('export async function resolveCashVariance('),
    actions.indexOf('export async function voidCashCollection('));
  assert.ok(resolveAction.includes('select("vms_expected_cash, expected_source, expected_calculated_at")'));
  assert.ok(resolveAction.includes('verifiedCashExpectation(expectationEvidence) === null'));
  assert.ok(resolveAction.includes('Cash expected-source evidence is missing'));
  assert.ok(resolveAction.indexOf('verifiedCashExpectation(expectationEvidence)') < resolveAction.indexOf('supabase.rpc("resolve_cash_variance"'));
});
