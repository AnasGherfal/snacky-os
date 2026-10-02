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

test("only screenshot evidence or a recorded power-off exception makes the stop ready", () => {
  assert.equal(machineQuantityEvidenceReady("xy_screenshot_saved"), true);
  assert.equal(machineQuantityEvidenceReady("offline_pending"), true);
  assert.equal(machineQuantityEvidenceReady("owner_completed"), true);
  assert.equal(machineQuantityEvidenceReady("legacy_confirmed"), false);
  assert.equal(machineQuantityEvidenceReady(null), false);
});

test("operator checkpoint saves XY screenshots and never blocks a power-off machine", () => {
  const card = read("src/components/operator/MachineQuantityConfirmationCard.tsx");
  const page = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/quantity-confirmation/route.ts");
  const actions = read("src/lib/operator-actions.ts");
  const migration = read("supabase/migrations/20260910191149_route_stop_machine_quantity_confirmation.sql");
  const evidenceMigration = read("supabase/migrations/20260911173023_machine_quantity_evidence_and_offline_followup.sql");
  const ownerQueue = read("src/app/routes/quantity-updates/page.tsx");
  const dashboard = read("src/app/dashboard/page.tsx");

  assert.match(card, /Upload current XY inventory screenshot\(s\)/);
  assert.match(card, /Machine has no electricity/);
  assert.match(card, /uploadRefillProofPhoto/);
  assert.match(card, /multiple/);
  assert.match(card, /Add more XY screenshots/);
  assert.match(card, /add them one at a time/);
  assert.match(card, /reusableEvidenceCount/);
  assert.match(card, /machineQuantityEvidenceMatches/);
  assert.match(card, /quantity-confirmation/);
  assert.doesNotMatch(card, /type="checkbox"/);
  assert.doesNotMatch(card, /quantityChoices|tap the same number/);
  assert.match(page, /quantityReadyForSubmit/);
  assert.match(page, /Upload the current XY inventory screenshot, or save that the machine has no electricity/);
  assert.match(api, /buildOperatorRouteAccessContext/);
  assert.match(api, /xy_screenshot/);
  assert.match(api, /machine_offline/);
  assert.match(api, /owner_resolved/);
  assert.match(api, /confirmation_key/);
  assert.match(api, /enrichMachineQuantityPlanRows/);
  assert.match(actions, /enrichMachineQuantityPlanRows/);
  assert.match(actions, /legacyQuantityKey/);
  assert.match(actions, /route_stop_quantity_confirmations/);
  assert.match(actions, /expectedQuantityKey/);
  assert.match(actions, /machineQuantityEvidenceReady/);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on public\.route_stop_quantity_confirmations from public, anon, authenticated/i);
  assert.match(evidenceMigration, /verification_status/i);
  assert.match(evidenceMigration, /offline_pending/i);
  assert.match(evidenceMigration, /evidence_files/i);
  assert.match(ownerQueue, /PendingMachineQuantityUpdateCard/);
  assert.match(dashboard, /pendingMachineQuantityUpdateCount/);
  assert.doesNotMatch(migration, /delete\s+from|truncate\s+table|drop\s+table/i);
  assert.doesNotMatch(evidenceMigration, /delete\s+from|truncate\s+table|drop\s+table/i);
});
