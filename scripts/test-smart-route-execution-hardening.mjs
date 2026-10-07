import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildMachineQuantityRows,
  buildMachineQuantitySourcesFromPlan,
} from "../src/lib/machine-quantity-confirmation.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const planner = read("src/lib/smart-route-planner.ts");
const routeCreateApi = read("src/app/api/routes/route.ts");
const operatorSmartApi = read("src/app/api/operator/routes/[id]/smart-plan/route.ts");
const operatorStop = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
const stopApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
const smartReturnApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/smart-return/route.ts");
const xyProductApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-product/route.ts");
const quantityApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/quantity-confirmation/route.ts");
const quantityCard = read("src/components/operator/MachineQuantityConfirmationCard.tsx");
const adminRoute = read("src/app/routes/[id]/page.tsx");
const hardeningMigration = read("supabase/migrations/20261007133000_smart_route_execution_hardening.sql");
const xyWriteContract = read("src/lib/xy-slot-write-contract.ts");
const xyControl = read("src/lib/xy-vms-control.ts");

test("Smart Route preserves exact lane execution metadata through both route creation paths", () => {
  assert.match(planner, /slotAllocations: SmartRouteSlotAllocation\[\]/);
  assert.match(planner, /observed_current_qty: decision\.currentQty/);
  assert.match(planner, /capacity: decision\.capacity/);
  assert.match(planner, /transition_mode: decision\.transitionMode/);
  assert.match(planner, /from_product_id: decision\.currentProductId/);
  assert.match(planner, /return_current_qty: decision\.returnCurrentQty/);

  assert.match(operatorSmartApi, /slot_allocations: item\.slotAllocations/);
  assert.match(routeCreateApi, /slotAllocations\?: SmartRouteSlotAllocationPayload\[\]/);
  assert.match(routeCreateApi, /slot_allocations: item\.slotAllocations/);
  assert.match(hardeningMigration, /slot_allocations jsonb/);
  assert.match(hardeningMigration, /coalesce\(item\.slot_allocations, '\[\]'::jsonb\)/);
  assert.match(hardeningMigration, /'assigned'::public\.refill_status/);
});

test("operator records exact actual quantities by lane and server validates totals", () => {
  assert.match(operatorStop, /Actual quantity by lane/);
  assert.match(operatorStop, /laneFilledQtys/);
  assert.match(operatorStop, /setLaneFilledQty/);
  assert.match(operatorStop, /slotQuantities: slotQuantitiesForItem/);
  assert.match(operatorStop, /physicalLaneMaximum/);

  const rows = buildMachineQuantityRows([{
    productId: "product-a",
    productName: "Snack",
    filledQty: 8,
    slotAllocations: [
      { machine_slot_id: "slot-a", slot_code: "11", current_qty: 2, final_take_qty: 4 },
      { machine_slot_id: "slot-b", slot_code: "12", current_qty: 1, final_take_qty: 4 },
    ],
    slotQuantities: [
      { machineSlotId: "slot-a", slotCode: "11", quantity: 3 },
      { machineSlotId: "slot-b", slotCode: "12", quantity: 5 },
    ],
  }]);

  assert.deepEqual(rows, [
    { productId: "product-a", productName: "Snack", machineSlotId: "slot-a", slotCode: "11", previousQty: 2, addedQty: 3, finalQty: 5 },
    { productId: "product-a", productName: "Snack", machineSlotId: "slot-b", slotCode: "12", previousQty: 1, addedQty: 5, finalQty: 6 },
  ]);

  const sources = buildMachineQuantitySourcesFromPlan(
    [{
      product_id: "product-a",
      machine_slot_id: null,
      slot_code: "11, 12",
      planned_quantity: 8,
      slot_allocations: [
        { machine_slot_id: "slot-a", slot_code: "11", current_qty: 2, final_take_qty: 4 },
        { machine_slot_id: "slot-b", slot_code: "12", current_qty: 1, final_take_qty: 4 },
      ],
      product: { name: "Snack" },
    }],
    [{
      productId: "product-a",
      quantity: 8,
      slotQuantities: [
        { machineSlotId: "slot-a", slotCode: "11", quantity: 3 },
        { machineSlotId: "slot-b", slotCode: "12", quantity: 5 },
      ],
    }],
  );
  assert.deepEqual(sources[0].slotQuantities, [
    { machineSlotId: "slot-a", slotCode: "11", quantity: 3 },
    { machineSlotId: "slot-b", slotCode: "12", quantity: 5 },
  ]);

  assert.match(quantityApi, /Lane quantities on filled row/);
  assert.match(quantityApi, /slotTotal !== quantity/);
});

test("executed AI swaps require old-product return before XY product change", () => {
  assert.match(operatorStop, /Return old product → update XY → fill new product/);
  assert.match(operatorStop, /recordSmartRouteReturn/);
  assert.match(operatorStop, /unresolvedSmartReturnRequirements/);
  assert.match(operatorStop, /unresolvedSmartXyRequirements/);
  assert.match(operatorStop, /Set a lane's actual fill to 0 if the planned swap cannot be executed today/);

  assert.match(smartReturnApi, /\.eq\("source", "smart_ai_plan"\)/);
  assert.match(smartReturnApi, /transition_mode/);
  assert.match(smartReturnApi, /return_current_qty/);
  assert.match(smartReturnApi, /snacky_record_smart_route_return_v1/);

  assert.match(xyProductApi, /smartRouteSwapRequested/);
  assert.match(xyProductApi, /Record the/);
  assert.match(xyProductApi, /returned old units before changing this Smart Route lane in XY/);
  assert.match(xyProductApi, /String\(row\.notes \?\? ""\)\.includes/);
  assert.match(xyProductApi, /slotCode/);
  assert.match(xyProductApi, /const targetStockQty = queueOnOffline \? actualSlotQty : smartRouteSwap \? 0 : Number\(currentStockQty\)/);
  assert.match(xyProductApi, /slot_code: slotCode/);

  assert.match(stopApi, /SMART_ROUTE_RETURN_REQUIRED/);
  assert.match(stopApi, /SMART_ROUTE_XY_CHANGE_REQUIRED/);
  assert.match(stopApi, /smartSwapRequirements/);
  assert.match(stopApi, /event\?\.metadata\?\.smart_route_swap === true/);
  assert.match(stopApi, /laneActual/);
});

test("Smart Route returns remain in operator custody until normal route finalization", () => {
  const functionStart = hardeningMigration.indexOf("create or replace function public.snacky_record_smart_route_return_v1");
  assert.notEqual(functionStart, -1);
  const returnFunction = hardeningMigration.slice(functionStart);

  assert.match(returnFunction, /'machine'::public\.inventory_entity_type/);
  assert.match(returnFunction, /'operator_bag'::public\.inventory_entity_type/);
  assert.match(returnFunction, /'returned_from_machine'::public\.movement_reason/);
  assert.match(returnFunction, /storage_movement_id is null/);
  assert.match(returnFunction, /operator_route_custody_leases/);
  assert.match(returnFunction, /Confirm pickup before recording a Smart Route return/);
  assert.doesNotMatch(
    returnFunction.slice(0, returnFunction.indexOf("revoke all on function")),
    /'operator_bag_to_storage'::public\.movement_reason/,
  );
  assert.match(returnFunction, /Route finalization later returns remaining operator bag stock to physical storage/);
});

test("direct XY quantity confirmation writes each lane then reads XY back", () => {
  assert.match(quantityApi, /setXySlotProduct/);
  assert.match(quantityApi, /pendingWrites/);
  assert.match(quantityApi, /stockQty:Number\(row\.finalQty\)/);
  assert.match(quantityApi, /for\(const delayMs of \[600,1200,2200\]\)/);
  assert.match(quantityApi, /verifyMachineQuantityRowsAgainstXy/);
  assert.match(quantityApi, /XY_QUANTITY_WRITE_FAILED/);

  assert.match(quantityCard, /Update & verify with XY/);
  assert.match(quantityCard, /Snacky writes the confirmed lane quantities into XY and reads them back/);
});

test("XY product and quantity writer uses the verified vendor contract", () => {
  assert.match(xyWriteContract, /addInstructionSpxxByApi/);
  assert.match(xyWriteContract, /"shbh","jqbh","hdbh","spbh","spjg","kcsl"/);
  assert.match(xyControl, /buildXySlotProductWriteParams/);
  assert.match(xyControl, /XY_SLOT_PRODUCT_WRITE_ENDPOINT/);
  assert.match(xyControl, /expectedStockQty/);
});

test("admin route detail exposes a lane-level Smart Route execution audit", () => {
  assert.match(adminRoute, /Smart Route audit/);
  assert.match(adminRoute, /AI lane plan vs operator execution/);
  assert.match(adminRoute, /route_stop_quantity_confirmations/);
  assert.match(adminRoute, /smartRouteLaneRows/);
  assert.match(adminRoute, /returnedQty/);
  assert.match(adminRoute, /xy_slot_product_change/);
  assert.match(adminRoute, /XY synced \+ verified/);
  assert.match(adminRoute, /Power-off pending/);
});


test("XY device offline is not treated as proof of a power outage", () => {
  assert.match(xyProductApi, /设备不在线/);
  assert.match(xyProductApi, /XY_MACHINE_OFFLINE/);
  assert.match(operatorStop, /responseCode\(payload\) === "XY_MACHINE_OFFLINE"/);
  assert.match(operatorStop, /لا تختَر «لا توجد كهرباء» إلا إذا كانت الكهرباء مقطوعة فعلاً/);
  assert.match(operatorStop, /Do not put the replacement product in this lane before XY confirms the change/);
});


test("legacy product totals cannot be written into catalogue-guessed XY lanes", () => {
  const serverQuantity = read("src/app/api/operator/routes/[id]/stops/[stopId]/quantity-confirmation/route.ts");
  const stopData = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");
  const quantityCard = read("src/components/operator/MachineQuantityConfirmationCard.tsx");
  assert.match(serverQuantity, /original_exact_lane/);
  assert.match(serverQuantity, /XY_LANE_ASSIGNMENT_REQUIRED/);
  assert.match(serverQuantity, /missingOriginalAssignments/);
  assert.match(stopData, /missingExactLanePlanForProduct/);
  assert.match(stopData, /hasExactLanePlan:/);
  assert.match(operatorStop, /hasExactLanePlan: item\.hasExactLanePlan/);
  assert.match(quantityCard, /missingOriginalLanePlan/);
  assert.match(quantityCard, /!missingOriginalLanePlan/);
  assert.match(quantityCard, /Upload current XY inventory screenshot/);
  assert.match(operatorStop, /item\.hasExactLanePlan === false/);
  assert.match(operatorStop, /if \(item\.hasExactLanePlan === false\) return undefined/);
  assert.match(operatorStop, /This older route lists a product total, not exact machine lanes/);
});


test("offline XY changes are durable, gated by physical safety, and retried by secured cron", () => {
  const queueSchema = read("supabase/migrations/20261008010000_xy_offline_slot_change_queue.sql");
  const queueWorker = read("src/lib/xy-pending-slot-changes.ts");
  const xyCron = read("src/app/api/cron/xy-vms/route.ts");
  const operatorLayout = read("src/app/operator/layout.tsx");
  const homeShortcuts = read("src/components/operator/OperatorHomeShortcuts.tsx");
  const quantityCard = read("src/components/operator/MachineQuantityConfirmationCard.tsx");
  const stopApi = read("src/app/api/operator/routes/[id]/stops/[stopId]/route.ts");

  assert.match(queueSchema, /xy_pending_slot_changes/);
  assert.match(queueSchema, /xy_one_pending_change_per_lane/);
  assert.match(queueSchema, /enable row level security/);
  assert.match(queueSchema, /to service_role/);
  assert.match(xyProductApi, /physicalChangeConfirmed/);
  assert.match(xyProductApi, /laneDisabledConfirmed/);
  assert.match(xyProductApi, /queueOnOffline/);
  assert.match(xyProductApi, /queued: true/);
  assert.match(queueWorker, /stop.status !== "completed"/);
  assert.match(queueWorker, /previous_stock_qty/);
  assert.match(queueWorker, /status.*conflict/);
  assert.match(queueWorker, /verifyXySlot/);
  assert.match(xyCron, /retryPendingXySlotChanges/);
  assert.match(stopApi, /queuedWithPhysicalSafety/);
  assert.match(operatorStop, /Save and retry automatically/);
  assert.match(operatorStop, /Keep affected lanes disabled from selling/);
  assert.match(quantityCard, /saveMode\("sync_pending"\)/);
  assert.match(quantityCard, /Photos are optional/);
  assert.match(operatorLayout, /OperatorHomeShortcuts/);
  assert.match(homeShortcuts, /usePathname/);
});
