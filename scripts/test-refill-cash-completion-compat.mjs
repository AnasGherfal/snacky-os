import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

test("saved sealed-bag state cannot trigger the legacy refill cash rejection", () => {
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  const action = read("src/lib/operator-actions.ts");

  assert.match(page, /if \(cashRequired && !cashReady\)/,
    "UI still gates completion until a bag or exception is saved");
  assert.match(page, /cashCollected: false/);
  assert.match(page, /cashBagId: ""/);
  assert.doesNotMatch(page, /cashCollected: cashState === "collected"/);
  assert.match(api, /CASH_RECORD_REQUIRED/);
  assert.match(api, /\["collected","exception"\]\.includes/);
  assert.match(api, /cashCollected: false/);
  assert.match(api, /cashBagId: ""/);
  assert.doesNotMatch(api, /cashCollected: Boolean\(payload\.cashCollected\)/);
  assert.match(action, /if \(cashCollected \|\| cashBagId\?\.trim\(\)\)/,
    "legacy entry point refuses a second cash record during inventory commit");
});

test("physical money remains linked to route stop, but safe deposit and count remain separate", () => {
  const cashApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/cash/route.ts");
  const complete = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  const deposit = read("src/app/api/cash-handling/deposit/route.ts");
  const count = read("src/components/cash/CashReceiveWorkspace.tsx");
  assert.match(cashApi, /record_standalone_cash_removal_group_v1/);
  assert.match(cashApi, /route_stop_cash_receipts/);
  assert.match(complete, /route_stop_cash_receipts/);
  assert.match(complete, /const result = await completeStop/);
  assert.doesNotMatch(complete, /calculate_cash_collection_expectation\(/);
  assert.match(deposit, /snacky_cash_handover_command_v1/);
  assert.match(count, /amount:amount\.trim\(\)/);
});
