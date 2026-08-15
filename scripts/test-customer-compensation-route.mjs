import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("saved final machine photo is reusable after refresh or app close", () => {
  const source = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  assert.match(source, /const canReuseSavedProof = Boolean\(stopData\.hasCompletionPhoto\)/);
  assert.match(source, /if \(!finalPhotoFile && !canReuseSavedProof\)/);
  assert.match(source, /new CustomEvent\("snacky:open-machine-photo"\)/);
  assert.match(source, /stopExecutionSummary\.proofReady/);
  assert.doesNotMatch(source, /canReuseCompletedProof/);
});

test("machine-stop compensation reasons match the production workflow", () => {
  const source = read("src/components/operator/RouteStopQuickActions.tsx");
  for (const value of [
    "paid_no_product",
    "product_jammed",
    "wrong_product",
    "dispensing_damage",
    "previous_unresolved_issue",
    "other",
  ]) {
    assert.match(source, new RegExp(`value=\\"${value}\\"`));
  }
  assert.match(source, /compensationReasonLabel\(record\.claim_type, locale\)/);
  assert.match(source, /snacky:open-machine-photo/);
});

test("compensation API is idempotent, auditable, and separate from revenue", () => {
  const source = read("src/app/api/operator/routes/[id]/stops/[stopId]/compensations/route.ts");
  assert.match(source, /client_submission_id/);
  assert.match(source, /isDuplicate\(insertError\)/);
  assert.match(source, /idempotency_key: idempotencyKey/);
  assert.match(source, /reason: "customer_compensation"/);
  assert.match(source, /from_entity_type: "operator_bag"/);
  assert.match(source, /to_entity_type: "customer"/);
  assert.match(source, /needs_review: Boolean\(initialReviewReason\)/);
  assert.match(source, /Actual customer compensation exceeds recorded operator-bag stock/);
  assert.doesNotMatch(source, /financial_transactions/);
  assert.doesNotMatch(source, /route_manual_sales/);
});

test("route, machine, and operator histories expose compensation without a new top-level page", () => {
  const api = read("src/app/api/compensations/history/route.ts");
  const panel = read("src/components/operator/CustomerCompensationHistoryPanel.tsx");
  const shell = read("src/components/ShellChrome.tsx");

  assert.match(api, /routeId/);
  assert.match(api, /machineId/);
  assert.match(api, /operatorId/);
  assert.match(api, /inventoryValueComplete/);
  assert.match(api, /Compensation history could not be fully loaded/);
  assert.match(panel, /Route compensation by machine/);
  assert.match(panel, /Machine compensation by route/);
  assert.match(panel, /Operator compensation by machine/);
  assert.match(panel, /not sales, revenue, damage, or operator consumption/);
  assert.match(shell, /CustomerCompensationHistoryPanel/);
});

test("Supabase migration accepts the expanded reason contract", () => {
  const source = read("supabase/migrations/202608150001_customer_compensation_completion.sql");
  for (const value of [
    "paid_no_product",
    "product_jammed",
    "wrong_product",
    "dispensing_damage",
    "previous_unresolved_issue",
    "damaged_or_stuck",
    "other",
  ]) {
    assert.match(source, new RegExp(`'${value}'`));
  }
  assert.match(source, /customer_compensation/);
  assert.match(source, /idx_route_customer_compensations_review_time/);
});
