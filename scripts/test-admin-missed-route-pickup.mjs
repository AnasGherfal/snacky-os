import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildAdminMissedPickupRpcPayload } from "../src/lib/admin-route-pickup.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ids = {
  route: "11111111-1111-1111-1111-111111111111",
  operator: "22222222-2222-2222-2222-222222222222",
  actor: "33333333-3333-3333-3333-333333333333",
  storage: "44444444-4444-4444-4444-444444444444",
  submission: "55555555-5555-5555-5555-555555555555",
  productA: "66666666-6666-6666-6666-666666666666",
  productB: "77777777-7777-7777-7777-777777777777",
  stop: "88888888-8888-8888-8888-888888888888",
  stopItem: "99999999-9999-9999-9999-999999999999",
  pickRow: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
};

function build(overrides = {}) {
  return buildAdminMissedPickupRpcPayload({
    route: { id: ids.route, operatorId: ids.operator, status: "pickup_confirmed", startedAt: "2026-08-23T08:00:00.000Z" },
    storageLocationId: ids.storage,
    items: [
      { productId: ids.productA, productName: "Chips", quantity: 2 },
      { productId: ids.productB, productName: "Water", quantity: 4 },
    ],
    existingPickListRows: [{
      id: ids.pickRow,
      route_stop_id: ids.stop,
      route_stop_item_id: ids.stopItem,
      machine_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      product_id: ids.productA,
      planned_qty: 0,
      picked_qty: 3,
      action_type: "planned_pick",
      pickup_batch_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
      is_active: true,
      created_by: ids.operator,
    }],
    routeStopItems: [{ id: ids.stopItem, planned_quantity: 5 }],
    routeStockLines: [{ product_id: ids.productA, planned_qty: 5, picked_qty: 3 }],
    actorTeamMemberId: ids.actor,
    submissionId: ids.submission,
    reason: "Operator loaded the products but missed them during pickup confirmation.",
    recordedAt: "2026-08-23T09:00:00.000Z",
    ...overrides,
  });
}

test("missed pickup correction appends atomically without replacing the confirmed list", () => {
  const payload = build();
  assert.equal(payload.rpcArgs.p_replace_pick_list, false);
  assert.deepEqual(payload.rpcArgs.p_selected_stop_ids, []);
  assert.deepEqual(payload.rpcArgs.p_acknowledged_pickup_line_ids, [ids.stopItem]);
  assert.equal(payload.rpcArgs.p_pick_list_rows.length, 3);
  assert.equal(payload.rpcArgs.p_pick_list_rows[0].id, ids.pickRow);
  assert.equal(payload.rpcArgs.p_pick_list_rows[0].planned_qty, 5);
  assert.equal(payload.rpcArgs.p_pick_list_rows[0].is_checked, true);

  const correctionRows = payload.rpcArgs.p_pick_list_rows.filter((row) => row.action_type === "extra_product");
  assert.equal(correctionRows.length, 2);
  assert.ok(correctionRows.every((row) => row.planned_qty === 0 && row.needs_review === false));
});

test("missed pickup correction moves Storage to the assigned Operator Bag and increments route picked stock", () => {
  const payload = build();
  assert.equal(payload.rpcArgs.p_inventory_movements.length, 2);
  for (const movement of payload.rpcArgs.p_inventory_movements) {
    assert.equal(movement.from_entity_type, "storage");
    assert.equal(movement.from_entity_id, ids.storage);
    assert.equal(movement.to_entity_type, "operator_bag");
    assert.equal(movement.to_entity_id, ids.operator);
    assert.equal(movement.reason, "storage_to_operator_bag");
    assert.equal(movement.source_type, "admin_missed_route_pickup");
    assert.match(movement.idempotency_key, new RegExp(ids.submission));
  }

  const stockByProduct = new Map(payload.rpcArgs.p_stock_line_rows.map((row) => [row.product_id, row]));
  assert.deepEqual({ planned: stockByProduct.get(ids.productA).planned_qty, picked: stockByProduct.get(ids.productA).picked_qty }, { planned: 5, picked: 5 });
  assert.deepEqual({ planned: stockByProduct.get(ids.productB).planned_qty, picked: stockByProduct.get(ids.productB).picked_qty }, { planned: 0, picked: 4 });
});

test("submission identifiers make retries deterministic and duplicate products are combined", () => {
  const first = build({ items: [
    { productId: ids.productA, productName: "Chips", quantity: 1 },
    { productId: ids.productA, productName: "Chips", quantity: 2 },
  ] });
  const retry = build({ items: [
    { productId: ids.productA, productName: "Chips", quantity: 1 },
    { productId: ids.productA, productName: "Chips", quantity: 2 },
  ] });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].quantity, 3);
  assert.equal(first.pickupBatchId, retry.pickupBatchId);
  assert.deepEqual(first.correctionPickListRowIds, retry.correctionPickListRowIds);
  assert.deepEqual(first.rpcArgs.p_inventory_movements.map((row) => row.idempotency_key), retry.rpcArgs.p_inventory_movements.map((row) => row.idempotency_key));
});

test("the canonical checklist guard rejects an incomplete existing pickup", () => {
  assert.throws(() => build({ existingPickListRows: [] }), /confirmed pick list is incomplete/i);
});

test("server action enforces owner/admin and uses the canonical pickup RPC", () => {
  const actionSource = fs.readFileSync(path.join(repoRoot, "src/lib/admin-route-pickup-actions.ts"), "utf8");
  assert.match(actionSource, /isOwnerAdminRole\(profile\)/);
  assert.match(actionSource, /snacky_confirm_route_pickup_batch_v2/);
  assert.match(actionSource, /correctionAlreadyRecorded/);
  assert.doesNotMatch(actionSource, /financial_transactions|route_manual_sales/);
});
