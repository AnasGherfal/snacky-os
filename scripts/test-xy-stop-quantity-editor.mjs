import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { groupMachineLayoutRows } from "../src/lib/xy-machine-layout-groups.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("Wide machine groups its exact XY selections in physical-row order", () => {
  const codes = [
    "001","003","005","007","009","011","013","015","017","019",
    "021","022","023","024","025","026","027","028","029","030",
    "031","032","033","034","035","036","037","038","039","040",
    "041","042","043","044","045","046","047","048","049","050",
  ];
  const rows = groupMachineLayoutRows(codes.map(slotCode => ({ slotCode })));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(row => [
    row.slots[0].slotCode, row.slots.at(-1).slotCode,
  ]), [["001","019"],["021","030"],["031","040"],["041","050"]]);
  assert(rows[1].slots.some(s => s.slotCode === "023"));
});

test("Standard ten-lane rows follow machine selection numbers", () => {
  const rows = groupMachineLayoutRows(["001","002","003","009","010","011","020","021","030","031","040"]
    .map(slotCode => ({ slotCode })));
  assert.deepEqual(rows.map(row => [row.rowIndex, row.slots[0].slotCode, row.slots.at(-1).slotCode]),
    [[1,"001","010"],[2,"011","020"],[3,"021","030"],[4,"031","040"]]);
});

test("Sparse machines use visible rows 001–009, 021–030, 031–040", () => {
  const slots = ["001","003","005","007","009","021","023","025","027","029","030","031","032","033","034","035","036","037","038","039","040"]
    .map(slotCode => ({ slotCode }));
  const rows = groupMachineLayoutRows(slots);
  assert.deepEqual(rows.map(row => [row.rowIndex, row.slots[0].slotCode, row.slots.at(-1).slotCode]),
    [[1,"001","009"],[2,"021","030"],[3,"031","040"]]);
});

test("Operator can fill an entire XY row then override a single selection", () => {
  const editor = read("src/components/operator/MachineStockQuickEditor.tsx");
  assert.match(editor, /setWholeRow/);
  assert.match(editor, /setWholeRow\(row\)/);
  assert.match(editor, /next\[slot.slotCode\] = parsed/);
  assert.match(editor, /updateOne\(slot, e.target.value\)/);
  assert.match(editor, /parsed > slot.capacity/);
  assert.match(editor, /Only edited selections are saved at Complete Stop/);
  assert.match(editor, /FINAL quantity physically inside each selection/);
  assert.doesNotMatch(editor, /capacity - currentQty/);
});

test("Complete Stop queues specific user-entered XY final stock, never invents allocations", () => {
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const endpoint = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-final-quantities/route.ts");
  assert.match(page, /selectionFinalQtys/);
  assert.match(page, /MachineStockQuickEditor/);
  assert.match(page, /selectionCodes = new Set/);
  assert.match(page, /Object.keys\(selectionFinalQtys\)/);
  assert.match(page, /Object.keys\(selectionPrices\)/);
  assert.match(page, /xy-final-quantities/);
  assert.match(page, /queue_exact_xy_slot_quantities/);
  assert.match(page, /Optional XY screenshots \/ technical verification/);
  assert.match(endpoint, /requested.has\(slotCode\)/);
  assert.match(endpoint, /latest_vms_stock_by_slot/);
  assert.match(endpoint, /finalQty > capacity/);
  assert.match(endpoint, /xy_pending_slot_changes/);
  assert.match(endpoint, /xy_stop_quantity_syncs/);
  assert.match(endpoint, /onConflict: "route_stop_id,slot_code"/);
  assert.doesNotMatch(endpoint, /inventory_movements|route_stock_lines|operator_bag_to_machine/);
});

test("Background sync checks stop completion, original product and stock before writing", () => {
  const worker = read("src/lib/xy-stop-quantity-sync.ts");
  const cron = read("src/app/api/cron/xy-stop-quantities/route.ts");
  const schema = read("supabase/migrations/20261008090000_xy_stop_quantity_syncs.sql");
  const schedule = read("supabase/migrations/20261008091000_xy_stop_quantity_scheduler.sql");
  const admin = read("src/app/routes/[id]/page.tsx");

  assert.match(worker, /stop.status !== "completed"/);
  assert.match(worker, /current.vmsProductId !== row.expected_vms_product_id/);
  assert.match(worker, /current.currentQty !== row.expected_xy_qty/);
  assert.match(worker, /xy_pending_slot_changes/);
  assert.match(worker, /readXyMachineLayout/);
  assert.match(worker, /verifyXySlot/);
  assert.match(worker, /setXySlotProduct/);
  assert.match(schema, /enable row level security/);
  assert.match(schema, /to service_role/);
  assert.match(cron, /SCHEDULER_SHA256/);
  assert.match(cron, /retryPendingStopXyQuantities/);
  assert.match(schedule, /enqueue_xy_stop_quantity_sync/);
  assert.match(schedule, /'\* \* \* \* \*'/);
  assert.match(admin, /xy_stop_quantity_syncs/);
  assert.match(admin, /Machine selection stock sync/);
});


test("Row action visibly confirms staged selections; hidden physical lanes are reversible", () => {
  const editor = read("src/components/operator/MachineStockQuickEditor.tsx");
  const stopApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  const visibilityApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-visibility/route.ts");
  const stopPage = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const migration = read("supabase/migrations/20261008094500_xy_physical_slots_and_price_edits.sql");
  assert.match(editor, /role="status"/);
  assert.match(editor, /aria-live="polite"/);
  assert.match(editor, /setFeedback/);
  assert.match(editor, /Press Complete Stop to sync/);
  assert.match(editor, /hiddenSelections/);
  assert.match(editor, /onRestoreSelection/);
  assert.match(editor, /onChangeProduct/);
  assert.match(stopApi, /xy_hidden_machine_selections/);
  assert.match(stopApi, /hiddenSlotCodes/);
  assert.match(stopPage, /toggleSelectionVisibility/);
  assert.match(visibilityApi, /xy_hidden_machine_selections/);
  assert.match(migration, /'002'/);
  assert.match(migration, /'036'/);
  assert.match(migration, /'040'/);
});


test("machine stop live XY source makes a direct vendor call and never calls imported stock live", () => {
  const liveApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-live-layout/route.ts");
  const stopPage = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  assert.match(liveApi, /readXyMachineLayout/);
  assert.match(liveApi, /vms_product_mappings/);
  assert.match(liveApi, /source: "xy_live"/);
  assert.match(liveApi, /Cache-Control.*no-store/);
  assert.match(liveApi, /source: "cached_import"/);
  assert.match(stopPage, /xy-live-layout/);
  assert.match(stopPage, /Last imported XY — NOT live/);
  assert.match(stopPage, /Live XY — direct read/);
  assert.match(stopPage, /refreshLiveXy/);
});

test("each selection can save product price or stock with immediate confirmation", () => {
  const editor = read("src/components/operator/MachineStockQuickEditor.tsx");
  const stopPage = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const quantityApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-final-quantities/route.ts");
  const productApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-product/route.ts");
  const worker = read("src/lib/xy-stop-quantity-sync.ts");
  const migration = read("supabase/migrations/20261009061000_xy_selection_save_before_stop.sql");

  assert.match(editor, /Current in XY/);
  assert.match(editor, /Save selection/);
  assert.match(editor, /onSelectProduct/);
  assert.match(editor, /onSaveSelection/);
  assert.match(editor, /Price \(LYD\)/);
  assert.match(editor, /role="status"/);
  assert.match(stopPage, /saveMachineSelection/);
  assert.match(stopPage, /applyImmediately: true/);
  assert.match(stopPage, /stock stays zero until physically verified/);
  assert.match(quantityApi, /apply_immediately: applyImmediately/);
  assert.match(quantityApi, /readXyMachineLayout/);
  assert.match(worker, /!row.apply_immediately && stop.status !== "completed"/);
  assert.match(migration, /add column if not exists apply_immediately/);
  assert.match(productApi, /requestedPrice/);
  assert.match(productApi, /requestedPrice === null/);
  assert.doesNotMatch(quantityApi, /insert into.*inventory_movements/);
});
