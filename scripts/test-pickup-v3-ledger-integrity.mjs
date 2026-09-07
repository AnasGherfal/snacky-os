import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = "supabase/migrations/20260905095000_operator_route_custody_lease.sql";

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function functionBody(source, name) {
  const start = source.search(new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\(`, "i"));
  assert.notEqual(start, -1, `${name} must exist`);
  const match = source.slice(start).match(/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i);
  assert.ok(match, `${name} must have a dollar-quoted body`);
  return compact(match[2]);
}

const migration = fs.readFileSync(path.join(root, migrationPath), "utf8");
const body = functionBody(migration, "snacky_confirm_route_pickup_batch_v3");

test("V3 derives immutable movement provenance instead of trusting client fields", () => {
  assert.match(body, /v_actor_team_member_id := public\.snacky_current_team_member_id\(\)/i);
  assert.match(body, /v_canonical_source_type := case when v_is_admin_correction then 'admin_missed_route_pickup' else 'route_pickup_batch' end/i);
  assert.match(body, /'related_pickup_batch_id', v_request_batch_id/i);
  assert.match(body, /'source_type', v_canonical_source_type/i);
  assert.match(body, /'source_id', v_request_batch_id/i);
  assert.match(body, /'created_by', v_actor_team_member_id/i);
  assert.match(body, /'idempotency_key', pg_catalog\.format\( 'route-pickup-v3:%s:%s'/i);
  assert.doesNotMatch(
    body.slice(body.indexOf("select coalesce( pg_catalog.jsonb_agg"), body.indexOf("v_expected_movement_count")),
    /submitted\.value->>'(?:source_type|source_id|created_by|idempotency_key|related_route_id|related_pickup_batch_id)'/i,
    "canonical movement provenance must never be copied from submitted JSON",
  );
  assert.match(body, /from public\.snacky_confirm_route_pickup_batch_v2\([\s\S]*v_canonical_pickup_batch[\s\S]*v_canonical_inventory_movements/i);
  assert.match(body, /submitted\.created_by is distinct from v_route_operator_id/i);
  assert.match(body, /submitted\.pickup_batch_id = v_request_batch_id[\s\S]*submitted\.created_by is distinct from v_actor_team_member_id/i);
});

test("V3 reconciles every pickup quantity representation before calling V2", () => {
  const callIndex = body.indexOf("from public.snacky_confirm_route_pickup_batch_v2(");
  const requiredPreflightMessages = [
    "product summary does not exactly match the checked pick-list quantities",
    "ledger quantities do not exactly match pick-list, batch, and route-stock quantities",
    "route-stop picked quantities do not exactly match the checked pick list",
    "refill picked quantities do not exactly match the checked route products",
    "new pickup batch may only move stock from storage to its assigned operator bag",
  ];

  for (const message of requiredPreflightMessages) {
    const index = body.toLowerCase().indexOf(message);
    assert.ok(index >= 0 && index < callIndex, `${message} must fail before V2 can advance workflow state`);
  }

  assert.match(body, /submitted_stock\.picked_qty - coalesce\(current_stock\.picked_qty, 0\) as delta_quantity/i);
  assert.match(body, /when movement\.reason = 'storage_to_operator_bag' then movement\.quantity::bigint else -movement\.quantity::bigint/i);
  assert.match(body, /coalesce\(stock_delta\.delta_quantity, 0\) is distinct from coalesce\(movement_delta\.delta_quantity, 0\)/i);
  assert.match(body, /full join picked using \(product_id\)[\s\S]*summary\.quantity is distinct from picked\.quantity/i);
});

test("V3 rejects malformed, duplicated, unplanned, and wrong-custody movement rows", () => {
  assert.match(body, /quantity', ''\) !~ '\^\[1-9\]\[0-9\]\*\$'/i);
  assert.match(body, /to_entity_id'\)::uuid is distinct from v_route_operator_id/i);
  assert.match(body, /from_entity_id'\)::uuid is distinct from v_route_operator_id/i);
  assert.match(body, /having pg_catalog\.count\(\*\) > 1[\s\S]*duplicate product and endpoint rows/i);
  assert.match(body, /active is distinct from true[\s\S]*location_type::text not in \( 'main_storage', 'vehicle', 'temporary', 'other' \)/i);
  assert.match(body, /one pickup payload cannot both issue and return the same product/i);
  assert.match(body, /pickup batch or movement key already has ledger history without an exact confirmation receipt/i);
});

test("route, storage, custody, bag, and V2 locks follow one canonical order", () => {
  const routeMutex = body.indexOf("'snacky:route-inventory:");
  const routeRow = body.indexOf("from public.routes route_row");
  const storageLock = body.indexOf("pg_catalog.hashtext(v_storage_lock.product_id::text)");
  const custodyLock = body.indexOf("'snacky:operator-custody:");
  const bagLock = body.indexOf("'snacky:operator-bag:");
  const v2Call = body.indexOf("from public.snacky_confirm_route_pickup_batch_v2(");

  assert.ok(routeMutex >= 0 && routeRow > routeMutex, "route mutex must precede the route row lock");
  assert.ok(storageLock > routeRow && custodyLock > storageLock, "storage locks must precede custody");
  assert.ok(bagLock > custodyLock && v2Call > bagLock, "sorted bag locks must precede all ledger writes");
  assert.match(body.slice(custodyLock, v2Call), /select distinct movement\.product_id[\s\S]*order by movement\.product_id/i);
});

test("silent ON CONFLICT suppression rolls back instead of advancing stops or route", () => {
  const lowerBody = body.toLowerCase();
  const v2Call = lowerBody.indexOf("from public.snacky_confirm_route_pickup_batch_v2(");
  const ledgerCount = lowerBody.indexOf("v_actual_movement_count is distinct from v_expected_movement_count", v2Call);
  const exactLedger = lowerBody.indexOf("select * from expected except all select * from actual", ledgerCount);
  const stopProof = lowerBody.indexOf("selected route stops did not commit the picked transition exactly", exactLedger);
  const checklistWrite = lowerBody.indexOf("update public.route_pick_list_items as pick_item", stopProof);
  const receiptWrite = lowerBody.indexOf("confirmation_payload_hash = v_payload_hash", checklistWrite);

  assert.ok(v2Call >= 0 && ledgerCount > v2Call && exactLedger > ledgerCount);
  assert.ok(stopProof > exactLedger && checklistWrite > stopProof && receiptWrite > checklistWrite,
    "all ledger/workflow postconditions must pass before checklist and receipt commit");
  assert.match(body, /pickup ledger did not commit exactly one canonical movement per intended row/i);
  assert.match(body, /route did not commit the pickup status returned by the atomic writer/i);
  assert.match(body, /pickup batch did not commit its exact canonical confirmation snapshot/i);
  assert.match(body, /pickup batch-stop links did not commit exactly/i);
  assert.match(body, /pickup batch checklist cardinality did not commit exactly/i);
});

test("an exact retry re-proves the saved ledger and receipt cardinality", () => {
  const retryStart = body.indexOf("v_existing_batch.confirmation_payload_hash is not null");
  const firstV2Call = body.indexOf("from public.snacky_confirm_route_pickup_batch_v2(");
  const retryBody = body.slice(retryStart, firstV2Call);

  assert.match(retryBody, /confirmation_payload_hash is distinct from v_payload_hash/i);
  assert.match(retryBody, /confirmation_result->>'movement_count'/i);
  assert.match(retryBody, /v_actual_movement_count is distinct from v_expected_movement_count/i);
  assert.match(retryBody, /movement\.related_pickup_batch_id = v_request_batch_id or \( movement\.source_type = v_canonical_source_type and movement\.source_id = v_request_batch_id \)/i);
  assert.match(retryBody, /select \* from expected except all select \* from actual/i);
  assert.match(retryBody, /ledger no longer matches its immutable receipt; manual review is required/i);
});

test("aggregate mismatch model fails in either direction", () => {
  const validates = ({ summary, picks, oldStock, newStock, movementDelta }) => (
    summary === picks
    && newStock - oldStock === movementDelta
    && movementDelta === summary
  );

  assert.equal(validates({ summary: 100, picks: 100, oldStock: 0, newStock: 100, movementDelta: 1 }), false);
  assert.equal(validates({ summary: 1, picks: 1, oldStock: 0, newStock: 1, movementDelta: 100 }), false);
  assert.equal(validates({ summary: 100, picks: 1, oldStock: 0, newStock: 100, movementDelta: 100 }), false);
  assert.equal(validates({ summary: 100, picks: 100, oldStock: 0, newStock: 100, movementDelta: 100 }), true);
});
