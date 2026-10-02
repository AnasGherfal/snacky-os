import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const migration = read("supabase/migrations/20260906163307_standalone_cash_removal_batches.sql");
const groupedMigration = read("supabase/migrations/20261001090000_cash_removal_machine_amounts_multi_box.sql");
const action = read("src/lib/cash-actions.ts");
const form = read("src/components/CashRemovalForm.tsx");
const planner = read("src/components/CashRemovalBoxPlanner.tsx");
const newPage = read("src/app/cash-collections/new/page.tsx");
const routeStop = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");

test("cash removal is a route-independent two-stage batch", () => {
  assert.match(migration, /create table if not exists public\.cash_collection_machines/);
  assert.match(migration, /record_standalone_cash_removal/);
  assert.match(migration, /route_id,[\s\S]*?values \(\s*null,/i);
  assert.match(migration, /actual_cash_collected,[\s\S]*?'collected_pending_count'/i);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /client_submission_id/);
});

test("removal form records one amount per machine and groups machines by physical cash box", () => {
  assert.match(form, /CashRemovalBoxPlanner/);
  assert.match(form, /name="removal_type"/);
  assert.match(planner, /name="cash_removal_plan"/);
  assert.match(planner, /Amount removed · LYD/);
  assert.match(planner, /Physical cash box/);
  assert.match(planner, /Add another box/);
  assert.match(planner, /box_evidence_/);
  assert.match(planner, /One amount per machine, one custody trail per physical box/);
  assert.doesNotMatch(form, /name="route_id"/);
  assert.doesNotMatch(form, /No amount is entered here/);
  assert.match(action, /parseCashRemovalPlan/);
  assert.match(action, /record_standalone_cash_removal_group_v1/);
  assert.match(action, /box_evidence_/);
  assert.match(newPage, /createCashRemoval/);
});

test("grouped cash migration keeps custody box-scoped and stores immutable machine amounts", () => {
  assert.match(groupedMigration, /add column if not exists removed_amount_lyd numeric\(12,2\)/);
  assert.match(groupedMigration, /add column if not exists removal_group_id uuid/);
  assert.match(groupedMigration, /record_standalone_cash_removal_group_v1_impl/);
  assert.match(groupedMigration, /A machine can belong to only one physical box in one removal/);
  assert.match(groupedMigration, /cash_removal_receipt_machines[\s\S]*removed_amount_lyd/);
  assert.match(groupedMigration, /snacky_cash_collection_machine_lines_v1/);
  assert.match(groupedMigration, /'replayed',true/);
});

test("route completion cannot create a cash removal", () => {
  assert.doesNotMatch(routeStop, /setCashCollected/);
  assert.doesNotMatch(routeStop, /name="cash_bag_id"/);
  assert.match(routeStop, /cashCollected: false/);
  assert.match(routeStop, /cashBagId: ""/);
  assert.match(routeStop, /Cash removal is not part of route completion/);
});
