import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("refill cash collection is attached to actual route-stop machine and operator", () => {
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/cash/route.ts");
  assert.match(api, /canAccessOperatorRoute\(access, routeResult\.data\.operator_id\)/);
  assert.match(api, /stop\.route_id !== routeId/);
  assert.match(api, /operator_id: ctx\.profile\.team_member_id/);
  assert.match(api, /machines: \[\{ machine_id: ctx\.stop\.machine_id, removed_amount_lyd: null \}\]/);
  assert.match(api, /record_standalone_cash_removal_group_v1/);
  assert.match(api, /p_client_submission_id: requestId/);
  assert.match(api, /request_id/);
});

test("cash amounts are never fabricated at pickup and missing XY is not counted", () => {
  const component = read("src/components/operator/RouteStopCashCard.tsx");
  const cash = read("src/app/api/cash-handling/route.ts");
  assert.match(component, /prepareCashPhoto\(photo\)/);
  assert.match(component, /form\.set\("bag_id"/);
  assert.doesNotMatch(component, /form\.set\("expected_cash"/);
  assert.match(cash, /calculate_cash_collection_expectation/);
  assert.match(cash, /command\.action === 'count'/);
});

test("refill completion enforces cash only in an explicitly enabled pilot scope", () => {
  const complete = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  const settings = read("src/app/cash-collections/pilot/page.tsx");
  const migration = read("supabase/migrations/20261101172228_cash_refill_require_explicit_pilot_selection_20261101.sql");
  assert.match(complete, /pilotMachines\.length > 0 && pilotMachines\.includes\(machineId\)/);
  assert.match(complete, /CASH_RECORD_REQUIRED/);
  assert.match(migration, /cardinality\(v_policy\.pilot_machine_ids\),0\)>0/);
  assert.match(settings, /enabled && machineIds\.length < 1/);
});

test("operator cash step preserves standard flow when pilot disabled", () => {
  const component = read("src/components/operator/RouteStopCashCard.tsx");
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  assert.match(component, /if \(!required\) return/);
  assert.match(page, /<RouteStopCashCard/);
  assert.match(page, /cashRequired && !cashReady/);
  assert.match(page, /cashCollected: cashState === "collected"/);
});

test("storage and counting use existing custody system rather than duplicate ledger", () => {
  const handover = read("src/components/CashHandlingWorkspace.tsx");
  const cash = read("src/app/api/cash-handling/route.ts");
  assert.match(handover, /cash-handover/);
  assert.match(cash, /snacky_cash_handover_command_v1/);
  assert.match(cash, /calculate_cash_collection_expectation/);
});

test("cash pilot fails closed on status-loading errors instead of claiming cash is optional", () => {
  const card = read("src/components/operator/RouteStopCashCard.tsx");
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  assert.match(page, /const \[cashRequired, setCashRequired\] = useState\(true\)/);
  assert.match(card, /setStatusError\(true\)/);
  assert.match(card, /onReadyRef\.current\(true, false, null\)/);
  assert.match(card, /if \(statusError\) return/);
  assert.match(card, /setStatusReloadKey/);
});

test("reused cash bags have a safe recovery only when no original collection committed", () => {
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/cash/route.ts");
  const card = read("src/components/operator/RouteStopCashCard.tsx");
  assert.match(api, /code === "23505"/);
  assert.match(api, /eq\("removal_group_id", requestId\)/);
  assert.match(api, /if \(!committed\.error && !committed\.data\?\.length\)/);
  assert.match(api, /BAG_ALREADY_USED/);
  assert.match(card, /requestRef\.current = null/);
  assert.match(card, /result\.code === "BAG_ALREADY_USED"/);
});
