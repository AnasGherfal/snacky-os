import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const migration = read("supabase/migrations/20260906163307_standalone_cash_removal_batches.sql");
const action = read("src/lib/cash-actions.ts");
const form = read("src/components/CashRemovalForm.tsx");
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

test("removal form accepts mixed machine boxes and never asks for money or a route", () => {
  assert.match(form, /name="machine_ids"/);
  assert.match(form, /name="removal_type"/);
  assert.match(form, /No amount is entered here/);
  assert.doesNotMatch(form, /name="route_id"/);
  assert.doesNotMatch(form, /counted_amount_lyd/);
  assert.match(action, /formData\.getAll\("machine_ids"\)/);
  assert.match(action, /p_client_submission_id/);
  assert.match(newPage, /createCashRemoval/);
});

test("route completion cannot create a cash removal", () => {
  assert.doesNotMatch(routeStop, /setCashCollected/);
  assert.doesNotMatch(routeStop, /name="cash_bag_id"/);
  assert.match(routeStop, /cashCollected: false/);
  assert.match(routeStop, /cashBagId: ""/);
  assert.match(routeStop, /Cash removal is not part of route completion/);
});
