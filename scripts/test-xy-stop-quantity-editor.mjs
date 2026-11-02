import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  groupMachineLayoutRows,
  physicalMachineRowForSlot,
  unmappedMachineSelectionCodes,
} from "../src/lib/xy-machine-layout-groups.ts";
import { resolveXyProductChangeQuantity, isSafeStockPreservingQueuedRelabel } from "../src/lib/xy-product-change-quantity.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("XY odd-numbered chips belong to two separate physical shelves, numbered from zero", () => {
  const codes = [
    "001","003","005","007","009","011","013","015","017","019",
    "021","022","023","024","025","026","027","028","029","030",
    "031","032","033","034","035","036","037","038","039","040",
    "041","042","043","044","045","046","047","048","049","050",
  ];
  const rows = groupMachineLayoutRows(codes.map(slotCode => ({ slotCode })));
  assert.deepEqual(rows.map(row => [
    row.rowIndex, row.slots[0].slotCode, row.slots.at(-1).slotCode,
  ]), [
    [0,"001","009"],[1,"011","019"],[2,"021","030"],
    [3,"031","040"],[4,"041","050"],
  ]);
  assert(rows[2].slots.some(slot => slot.slotCode === "023"));
});

test("Standard ten-lane rows retain original physical row numbers 0-5", () => {
  const rows = groupMachineLayoutRows(["001","002","003","009","010","011","020","021","030","031","040"]
    .map(slotCode => ({ slotCode })));
  assert.deepEqual(rows.map(row => [row.rowIndex, row.slots[0].slotCode, row.slots.at(-1).slotCode]), [
    [0,"001","010"],[1,"011","020"],[2,"021","030"],[3,"031","040"],
  ]);
});

test("Sparse selections do not shift an empty physical row upward", () => {
  const slots = ["001","003","005","007","009","021","023","025","027","029","030","031","032","033","034","035","036","037","038","039","040"]
    .map(slotCode => ({ slotCode }));
  const rows = groupMachineLayoutRows(slots);
  assert.deepEqual(rows.map(row => [row.rowIndex, row.slots[0].slotCode, row.slots.at(-1).slotCode]), [
    [0,"001","009"],[2,"021","030"],[3,"031","040"],
  ]);
});

test("Photo-verified Istiklal has exactly six physical rows, top 0 bottom 5", () => {
  // Live XY lane codes checked against the user's Istiklal cabinet photograph:
  // 0 Mr Crunch, 1 Spuds, 2 confectionery, 3 drinks, 4 currently
  // unconfigured in XY, 5 Water. Never invent stock for missing lanes.
  const codes = [
    "001","003","005","007","009",
    "011","013","015","017","019",
    "021","022","023","024","025","026","030",
    "031","032","033","034","035","036","037","038","039","040",
    "046","047","048","049","050",
  ];
  const options = { machineCode:"SNK-2509000369" };
  const rows = groupMachineLayoutRows(codes.map(slotCode => ({ slotCode })), options);
  assert.deepEqual(rows.map(row => row.rowIndex), [0,1,2,3,4,5]);
  assert.deepEqual(rows.map(row => [row.slots[0]?.slotCode ?? null, row.slots.at(-1)?.slotCode ?? null]), [
    ["001","009"],["011","019"],["021","030"],["031","040"],
    [null,null],["046","050"],
  ]);
  assert.equal(rows.flatMap(row => row.slots).length,codes.length);
  assert.deepEqual(rows[4].slots,[],"No phantom 041-045 XY stock or edit controls");
  assert.equal(physicalMachineRowForSlot("046",{machineCode:"2509000369"}),5);
  assert.equal(physicalMachineRowForSlot("046",{machineCode:"SNK-2503000216"}),4);
});

test("No nonexistent row 6 and no synthetic VMS lane is treated as physical", () => {
  const source = ["001","011","021","031","041","051","060","061","VMS-106","", "000"]
    .map(slotCode => ({slotCode}));
  const rows=groupMachineLayoutRows(source);
  assert.deepEqual(rows.map(row=>row.rowIndex),[0,1,2,3,4,5]);
  assert.equal(rows[5].slots.length,2);
  assert.deepEqual(unmappedMachineSelectionCodes(source),["061","VMS-106","","000"]);
  for(const row of rows)assert(row.rowIndex>=0&&row.rowIndex<=5);
});

test("Selection cards and search display real product images while writes remain keyed by XY slot", () => {
  const editor = read("src/components/operator/MachineStockQuickEditor.tsx");
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const live = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-live-layout/route.ts");
  assert.match(editor,/ProductThumbnail imageUrl=\{slot.imageUrl\}/);
  assert.match(editor,/ProductThumbnail imageUrl=\{selectedImageUrl\}/);
  assert.match(editor,/ProductThumbnail imageUrl=\{product.imageUrl\}/);
  assert.match(editor,/No configured selections for this physical row|no configured selections for this physical row/);
  assert.match(page,/groupMachineLayoutRows\(stopData\?\.machineLayout \?\? \[\], \{ machineCode: stopData\?\.machineCode \}\)/);
  assert.match(page,/imageUrl: slot.imageUrl/);
  assert.match(page,/imageUrl: p.imageUrl/);
  assert.match(live,/imageByProductId/);
  assert.match(live,/from\("products"\)\.select\("id,image_url"\)/);
  assert.match(editor,/onSaveSelection\(slot.slotCode\)/);
});

test("Operator can fill an entire XY row then override a single selection", () => {
  const editor = read("src/components/operator/MachineStockQuickEditor.tsx");
  assert.match(editor, /setWholeRow/);
  assert.match(editor, /setWholeRow\(row\)/);
  assert.match(editor, /next\[slot.slotCode\] = parsed/);
  assert.match(editor, /updateOne\(slot, e.target.value\)/);
  assert.match(editor, /parsed > slot.capacity/);
  assert.match(editor, /Press Save Selection to queue that selection immediately/);
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


test("Machine selection visibility is restricted to managers and operators cannot hide lanes", () => {
  const editor = read("src/components/operator/MachineStockQuickEditor.tsx");
  const stopApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  const visibilityApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-visibility/route.ts");
  const stopPage = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const migration = read("supabase/migrations/20261008094500_xy_physical_slots_and_price_edits.sql");
  assert.match(editor, /role="status"/);
  assert.match(editor, /aria-live="polite"/);
  assert.match(editor, /setFeedback/);
  assert.match(editor, /Save Selection for each edited lane/);
  assert.match(editor, /hiddenSelections/);
  assert.doesNotMatch(editor, /onRestoreSelection/);
  assert.doesNotMatch(editor, /onHideSelection/);
  assert.doesNotMatch(editor, /Not physically present\? Hide/);
  assert.match(editor, /onChangeProduct/);
  assert.match(stopApi, /xy_hidden_machine_selections/);
  assert.match(stopApi, /hiddenSlotCodes/);
  assert.doesNotMatch(stopPage, /toggleSelectionVisibility/);
  assert.doesNotMatch(stopPage, /onHideSelection/);
  assert.match(visibilityApi, /hasPermission\(profile, "machines.manage"\)/);
  assert.match(visibilityApi, /status: 403/);
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
  assert.match(stopPage, /actualSlotQty: selectionFinalQtys\[slotCode\]/);
  assert.match(stopPage, /XY will preserve the current quantity if it still matches/);
  assert.match(quantityApi, /apply_immediately: applyImmediately/);
  assert.match(quantityApi, /readXyMachineLayout/);
  assert.match(worker, /!row.apply_immediately && stop.status !== "completed"/);
  assert.match(migration, /add column if not exists apply_immediately/);
  assert.match(productApi, /requestedPrice/);
  assert.match(productApi, /requestedPrice === null/);
  assert.doesNotMatch(quantityApi, /insert into.*inventory_movements/);
});

test("Saving a replacement product preserves the existing XY stock unless a final quantity is explicitly edited", () => {
  const original = 9;
  assert.deepEqual(resolveXyProductChangeQuantity({
    currentStockQty: original, smartRouteSwap: false,
  }), { targetStockQty: 9, quantityEdited: false, stockPreserved: true });
  assert.deepEqual(resolveXyProductChangeQuantity({
    currentStockQty: original, explicitFinalQty: 5, smartRouteSwap: false,
  }), { targetStockQty: 5, quantityEdited: true, stockPreserved: false });
  assert.deepEqual(resolveXyProductChangeQuantity({
    currentStockQty: original, explicitFinalQty: 0, smartRouteSwap: false,
  }), { targetStockQty: 0, quantityEdited: true, stockPreserved: false });
  assert.deepEqual(resolveXyProductChangeQuantity({
    currentStockQty: original, smartRouteSwap: true,
  }), { targetStockQty: 0, quantityEdited: false, stockPreserved: false });
  assert.throws(() => resolveXyProductChangeQuantity({
    currentStockQty: null, smartRouteSwap: false,
  }), /reliable current quantity/);
  assert.throws(() => resolveXyProductChangeQuantity({
    currentStockQty: 3, explicitFinalQty: -1, smartRouteSwap: false,
  }), /valid whole-number/);
});

test("Queued product relabels preserve stock only against an unchanged XY baseline", () => {
  const queued = {
    previous_stock_qty: 7,
    target_stock_qty: 7,
    smart_route_swap: false,
    physical_change_confirmed: false,
    lane_disabled_confirmed: false,
    zero_stock_relabel: false,
  };
  assert.equal(isSafeStockPreservingQueuedRelabel(queued), true);
  assert.equal(isSafeStockPreservingQueuedRelabel({ ...queued, target_stock_qty: 0 }), false);
  assert.equal(isSafeStockPreservingQueuedRelabel({ ...queued, target_stock_qty: 8 }), false);
  assert.equal(isSafeStockPreservingQueuedRelabel({ ...queued, smart_route_swap: true }), false);
  assert.equal(isSafeStockPreservingQueuedRelabel({ ...queued, physical_change_confirmed: true }), false);

  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-product/route.ts");
  const worker = read("src/lib/xy-pending-slot-changes.ts");
  const migration = read("supabase/migrations/20261018010000_xy_preserve_stock_offline_relabel.sql");
  const picker = read("src/components/operator/MachineStockQuickEditor.tsx");
  assert.match(page, /hasStock \? \{ actualSlotQty: selectionFinalQtys\[slotCode\] \} : \{\}/);
  assert.match(api, /target_stock_qty: targetStockQty/);
  assert.match(api, /const zeroStockRelabel = false/);
  assert.match(worker, /safePreserveStockRelabel/);
  assert.match(worker, /before.currentQty !== item.previous_stock_qty/);
  assert.match(migration, /target_stock_qty = previous_stock_qty/);
  assert.match(picker, /type="search"/);
  assert.match(picker, /product\.barcode/);
  assert.match(picker, /onSelectProduct\(slot.slotCode, product.id\)/);
});

test("An XY-accepted product change remains pending until direct machine readback verifies it", () => {
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-product/route.ts");
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const worker = read("src/lib/xy-pending-slot-changes.ts");
  const migration = read("supabase/migrations/20261018010000_xy_preserve_stock_offline_relabel.sql");

  assert.match(api, /if \(!verification\.verified\) \{\s*\/\/ XY's acknowledgement/);
  assert.match(api, /if \(queueOnOffline && currentStockQty !== null && beforeSlot\.vmsProductId\)/);
  assert.match(api, /code: "XY_ACCEPTED_PENDING_VERIFICATION"/);
  assert.match(api, /writeAccepted: true/);
  assert.match(api, /target_stock_qty: targetStockQty/);
  assert.match(api, /last_error: "XY acknowledged the command/);
  assert.match(page, /XY changes awaiting machine verification/);
  assert.match(page, /NOT verified yet/);
  assert.match(worker, /safePreserveStockRelabel/);
  assert.match(worker, /before\.vmsProductId === item\.target_vms_product_id/);
  assert.match(worker, /await setState\("verified", null\)/);
  assert.match(migration, /target_stock_qty = previous_stock_qty/);
});
