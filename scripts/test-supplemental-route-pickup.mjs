import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const migration = fs.readFileSync("supabase/migrations/20260929190000_supplemental_route_pickup.sql", "utf8");
const api = fs.readFileSync("src/app/api/operator/routes/[id]/pick-list/route.ts", "utf8");
const ui = fs.readFileSync("src/app/operator/routes/[id]/pick-list/page.tsx", "utf8");
const action = fs.readFileSync("src/lib/supplemental-route-pickup-actions.ts", "utf8");
const adminEditor = fs.readFileSync("src/app/routes/[id]/edit/RouteItemEditor.tsx", "utf8");
const adminPage = fs.readFileSync("src/app/routes/[id]/edit/page.tsx", "utf8");

function compact(value) {
  return value.replace(/\s+/g, " ").trim();
}

function sqlCode(value) {
  return compact(value.replace(/--.*$/gm, ""));
}

test("supplemental pickup is append-only and does not roll route workflow state backward", () => {
  const source = sqlCode(migration);
  const raw = compact(migration);
  assert.match(source, /create or replace function public\.snacky_confirm_supplemental_route_pickup_v1/i);
  assert.match(source, /insert into public\.route_pickup_batches/i);
  assert.match(source, /insert into public\.route_pick_list_items/i);
  assert.match(source, /insert into public\.inventory_movements/i);
  assert.match(source, /action_type[^;]*'extra_product'/i);
  assert.match(raw, /Additional pickup is a stock\/custody event, not a route-state transition/i);
  assert.doesNotMatch(source, /update public\.routes\b/i);
  assert.doesNotMatch(source, /update public\.route_stops\b/i);
  assert.doesNotMatch(source, /delete from public\.route_pick_list_items/i);
});

test("supplemental pickup can never exceed planned minus already picked", () => {
  const source = compact(migration);
  assert.match(source, /v_item\.quantity > greatest\(v_item\.planned_quantity - v_item\.picked_quantity, 0\)/i);
  assert.match(source, /picked_quantity = coalesce\(route_item\.picked_quantity, 0\) \+ v_item\.quantity/i);
  assert.match(source, /picked_qty = public\.route_stock_lines\.picked_qty \+ excluded\.picked_qty/i);
  assert.match(source, /Not enough physical storage stock for additional pickup/i);
});

test("retries are idempotent by pickup batch and payload hash", () => {
  const source = compact(migration);
  assert.match(source, /confirmation_payload_hash/i);
  assert.match(source, /where batch_row\.id = p_submission_id for update/i);
  assert.match(source, /retry does not match the original submission/i);
  assert.match(source, /route-supplemental:%s:%s:%s/i);
});

test("operator API exposes only true post-pickup plan increases as supplemental", () => {
  assert.match(api, /already_picked_qty/);
  assert.match(api, /additional_pickup_qty/);
  assert.match(api, /physical_storage_available_qty/);
  assert.match(api, /originalPlannedQuantity/);
  assert.match(api, /originalPickedQuantity/);
  assert.match(api, /originalShortfallQty/);
  assert.match(api, /pickupCoveredPlanQty = alreadyPickedQty \+ originalShortfallQty/);
  assert.match(api, /plannedQty - pickupCoveredPlanQty/);
});

test("partial original pickup stays in the normal remaining-pickup flow", () => {
  assert.match(api, /remainingPickupMode = pendingStopCount > 0 && hasAnyConfirmedPickup/);
  assert.match(api, /supplementalMode = pendingStopCount === 0 && hasAnyConfirmedPickup && supplementalPendingItems\.length > 0/);
  assert.match(api, /stopGroups\.filter\(\(group: any\) => String\(group\.stop_status \?\? ""\) === ROUTE_STOP_PENDING_STATUS\)/);
  assert.match(api, /stopGroups: visibleStopGroups/);
  assert.match(api, /extraItems: remainingPickupMode \? \[\] : extraItems/);
  assert.match(api, /availableStorageQty: remainingPickupMode \|\| supplementalMode/);
  assert.match(ui, /remainingPickupMode/);
  assert.match(ui, /Continue route pickup/);
  assert.match(ui, /Confirm remaining pickup/);
  assert.match(ui, /nextSupplementalMode \|\| nextRemainingPickupMode/);
});

test("operator UI confirms supplemental quantities through the isolated action", () => {
  assert.match(ui, /confirmSupplementalRoutePickup/);
  assert.match(ui, /Already picked/);
  assert.match(ui, /Additional route pickup/);
  assert.match(ui, /item\.additional_pickup_qty/);
  assert.match(ui, /nextSupplementalMode && !isSupplemental/);
  assert.match(action, /snacky_confirm_supplemental_route_pickup_v1/);
});

test("admin route editor shows picked, new total, and exact extra amount", () => {
  assert.match(adminPage, /picked_quantity/);
  assert.match(adminPage, /pickedQuantity/);
  assert.match(adminEditor, /pickedQuantity/);
  assert.match(adminEditor, /additionalPickupQty/);
  assert.match(adminEditor, /Operator will pick only/);
});
