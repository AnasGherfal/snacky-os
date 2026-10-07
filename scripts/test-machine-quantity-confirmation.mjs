import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildMachineQuantityRows,
  enrichMachineQuantityPlanRows,
  machineQuantityConfirmationKey,
  machineQuantityEvidenceMatches,
  machineQuantityEvidenceReady,
} from "../src/lib/machine-quantity-confirmation.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("machine selection targets use saved starting stock plus actual fill", () => {
  const rows = buildMachineQuantityRows([{
    productId: "product-a",
    productName: "Water",
    filledQty: 7,
    slotAllocations: [
      { machine_slot_id: "slot-a", slot_code: "11", current_qty: 2, final_take_qty: 4 },
      { machine_slot_id: "slot-b", slot_code: "12", current_qty: 5, final_take_qty: 4 },
    ],
  }]);

  assert.deepEqual(rows, [
    { productId: "product-a", productName: "Water", machineSlotId: "slot-a", slotCode: "11", previousQty: 2, addedQty: 4, finalQty: 6 },
    { productId: "product-a", productName: "Water", machineSlotId: "slot-b", slotCode: "12", previousQty: 5, addedQty: 3, finalQty: 8 },
  ]);
});

test("changing a filled quantity changes the confirmation key", () => {
  const item = {
    productId: "product-a",
    productName: "Water",
    slotAllocations: [{ machine_slot_id: "slot-a", slot_code: "11", current_qty: 2, final_take_qty: 8 }],
  };
  const first = machineQuantityConfirmationKey(buildMachineQuantityRows([{ ...item, filledQty: 5 }]));
  const changed = machineQuantityConfirmationKey(buildMachineQuantityRows([{ ...item, filledQty: 6 }]));
  assert.notEqual(first, changed);
});

test("legacy plan rows use the same deterministic machine lane everywhere", () => {
  const planRows = [{
    product_id: "product-a",
    machine_slot_id: null,
    slot_code: null,
    planned_quantity: 4,
    slot_allocations: [],
    product: { name: "Water" },
  }];
  const enriched = enrichMachineQuantityPlanRows(planRows, [
    { id: "slot-12", product_id: "product-a", slot_code: "012" },
    { id: "slot-03", product_id: "product-a", slot_code: "003" },
  ]);

  assert.equal(enriched[0].machine_slot_id, "slot-03");
  assert.equal(enriched[0].slot_code, "003");
  const sources = [{
    productId: "product-a",
    productName: "Water",
    filledQty: 4,
    slotAllocations: [{
      machine_slot_id: enriched[0].machine_slot_id,
      slot_code: enriched[0].slot_code,
      current_qty: 0,
      final_take_qty: enriched[0].planned_quantity,
    }],
  }];
  assert.match(machineQuantityConfirmationKey(buildMachineQuantityRows(sources)), /\"slot_code\":\"003\"/);

  const noCatalogLane = buildMachineQuantityRows([{
    productId: "product-b",
    productName: "Manual product",
    slotCode: "VMS item",
    filledQty: 2,
    slotAllocations: [{ machine_slot_id: null, slot_code: null, current_qty: 0, final_take_qty: 2 }],
  }]);
  assert.equal(noCatalogLane[0].slotCode, "VMS");

  const legacyGenericRow = [{ ...buildMachineQuantityRows(sources)[0], machineSlotId: null, slotCode: "VMS" }];
  assert.equal(machineQuantityEvidenceMatches(legacyGenericRow, buildMachineQuantityRows(sources)), true);
  assert.equal(machineQuantityEvidenceMatches(
    [{ ...legacyGenericRow[0], addedQty: 3, finalQty: 3 }],
    buildMachineQuantityRows(sources),
  ), false);
});

test("zero-filled products do not require a machine quantity update", () => {
  assert.deepEqual(buildMachineQuantityRows([{
    productId: "product-a",
    productName: "Water",
    filledQty: 0,
    slotAllocations: [{ slot_code: "11", current_qty: 2, final_take_qty: 8 }],
  }]), []);
});

test("verified or durably queued XY updates make the stop ready", () => {
  assert.equal(machineQuantityEvidenceReady("xy_api_verified"), true);
  assert.equal(machineQuantityEvidenceReady("xy_sync_pending"), true);
  assert.equal(machineQuantityEvidenceReady("offline_pending"), true);
  assert.equal(machineQuantityEvidenceReady("xy_screenshot_saved"), true);
  assert.equal(machineQuantityEvidenceReady("owner_completed"), true);
  assert.equal(machineQuantityEvidenceReady("legacy_confirmed"), false);
  assert.equal(machineQuantityEvidenceReady(null), false);
});

test("operator checkpoint pushes quantities through Snacky OS and queues offline retries", () => {
  const card = read("src/components/operator/MachineQuantityConfirmationCard.tsx");
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/quantity-confirmation/route.ts");
  const writer = read("src/lib/xy-refill-quantity-sync.ts");
  const pendingWorker = read("src/lib/xy-pending-quantity-sync.ts");
  const cron = read("src/app/api/cron/xy-vms/route.ts");
  const queueMigration = read("supabase/migrations/20261007110000_xy_refill_quantity_sync_queue.sql");
  const ownerQueue = read("src/app/routes/quantity-updates/page.tsx");
  const dashboard = read("src/app/dashboard/page.tsx");
  const priceRoute = read("src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-product/route.ts");

  assert.match(card, /Update XY from Snacky/);
  assert.match(card, /You do not need to open the machine settings or take screenshots/);
  assert.match(card, /Machine has no electricity/);
  assert.match(card, /Retry XY now/);
  assert.doesNotMatch(card, /Upload current XY inventory screenshot\(s\)/);
  assert.doesNotMatch(card, /uploadRefillProofPhoto/);
  assert.match(card, /machineQuantityEvidenceMatches/);
  assert.match(card, /quantity-confirmation/);

  assert.match(page, /quantityReadyForSubmit/);
  assert.match(page, /Send the refill quantities to XY from Snacky OS/);
  assert.match(page, /Selling price \(LYD\)/);
  assert.match(page, /priceLyd: requestedPriceLyd/);
  assert.match(page, /product\/price was updated in XY and verified/);

  assert.match(api, /syncMachineQuantityRowsToXy/);
  assert.match(api, /loadConfirmedXyProductIds/);
  assert.match(api, /xy_sync_pending/);
  assert.match(api, /retry_pending/);
  assert.match(api, /last_sync_error/);
  assert.match(api, /xy_api_verified/);

  assert.match(writer, /setXySlotProduct/);
  assert.match(writer, /stockQty: row\.finalQty/);
  assert.match(writer, /priceLyd/);
  assert.match(writer, /verifyXySlot/);
  assert.match(writer, /different XY product than the Snacky refill plan/);

  assert.match(pendingWorker, /offline_pending/);
  assert.match(pendingWorker, /xy_sync_pending/);
  assert.match(pendingWorker, /syncMachineQuantityRowsToXy/);
  assert.match(pendingWorker, /verification_status: "xy_api_verified"/);
  assert.match(cron, /retryPendingXyQuantitySyncs/);

  assert.match(queueMigration, /xy_api_verified/);
  assert.match(queueMigration, /xy_sync_pending/);
  assert.match(queueMigration, /sync_attempt_count/);
  assert.match(queueMigration, /last_sync_attempt_at/);
  assert.match(queueMigration, /last_sync_error/);
  assert.doesNotMatch(queueMigration, /delete\s+from|truncate\s+table|drop\s+table/i);

  assert.match(ownerQueue, /xy_sync_pending/);
  assert.match(ownerQueue, /PendingMachineQuantityUpdateCard/);
  assert.match(dashboard, /xy_sync_pending/);

  assert.match(priceRoute, /priceLyd\?: unknown/);
  assert.match(priceRoute, /requestedPriceLyd/);
  assert.match(priceRoute, /snacky_os_operator/);
  assert.match(priceRoute, /verifyXySlot/);
});
