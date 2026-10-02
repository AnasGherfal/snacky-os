import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  resolveCanonicalInventoryMovement,
} from "../src/lib/inventory-movement-link-recovery.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const atomicMigration = read("supabase/migrations/20260905094700_atomic_route_sales_compensations.sql");

function functionBody(functionName, nextMarker) {
  const start = atomicMigration.indexOf(`create or replace function public.${functionName}(`);
  assert.notEqual(start, -1, `${functionName} must exist`);
  const end = atomicMigration.indexOf(nextMarker, start);
  assert.notEqual(end, -1, `${functionName} end marker must exist`);
  return atomicMigration.slice(start, end);
}

const manualRpc = functionBody(
  "snacky_create_route_manual_sale_v1",
  "revoke all on function public.snacky_create_route_manual_sale_v1(",
);
const compensationRpc = functionBody(
  "snacky_create_route_customer_compensation_v1",
  "revoke all on function public.snacky_create_route_customer_compensation_v1(",
);

const ids = {
  movement: "10000000-0000-4000-8000-000000000001",
  route: "20000000-0000-4000-8000-000000000002",
  stop: "30000000-0000-4000-8000-000000000003",
  machine: "40000000-0000-4000-8000-000000000004",
  product: "50000000-0000-4000-8000-000000000005",
  operator: "60000000-0000-4000-8000-000000000006",
  parent: "70000000-0000-4000-8000-000000000007",
};

const expected = {
  idempotency_key: `route-manual-sale:${ids.route}:${ids.stop}:${ids.parent}:${ids.product}:${ids.operator}:3`,
  source_type: "route_manual_sale",
  source_id: ids.parent,
  reason: "manual_sale",
  product_id: ids.product,
  quantity: 3,
  from_entity_type: "operator_bag",
  from_entity_id: ids.operator,
  to_entity_type: "customer",
  to_entity_id: null,
  related_route_id: ids.route,
  related_route_stop_id: ids.stop,
  related_machine_id: ids.machine,
  created_by: ids.operator,
};

const canonical = { id: ids.movement, ...expected };

test("an existing parent with no canonical movement fails safe without synthesizing COGS", () => {
  assert.deepEqual(resolveCanonicalInventoryMovement([], expected), { status: "missing" });

  for (const [name, source, parentMarker, terminalMarker] of [
    ["manual sale", manualRpc, "select sale_row.*", "if v_route.status::text in ("],
    ["compensation", compensationRpc, "select compensation_row.*", "if v_route.status::text in ("],
  ]) {
    const replayStart = source.indexOf(parentMarker);
    const replayEnd = source.indexOf(terminalMarker, replayStart);
    const replayBody = source.slice(replayStart, replayEnd);
    assert.doesNotMatch(replayBody, /insert into public\.inventory_movements/, `${name} recovery must never invent a missing movement`);
    assert.match(replayBody, /no canonical inventory movement exists\. Inventory was not changed\./);
    assert.match(replayBody, /set needs_review = true,[\s\S]*review_reason = v_review_reason/);
  }
});

test("the exact canonical movement is accepted and an ambiguous key is rejected", () => {
  assert.deepEqual(resolveCanonicalInventoryMovement([canonical], expected), {
    status: "canonical",
    movementId: ids.movement,
  });
  assert.deepEqual(resolveCanonicalInventoryMovement([canonical, canonical], expected), {
    status: "ambiguous",
    candidateCount: 2,
  });
});

test("a canonical-key row that mismatches any identity field is never accepted", () => {
  const mutations = {
    idempotency_key: "wrong-key",
    source_type: "wrong-source",
    source_id: ids.movement,
    reason: "customer_compensation",
    product_id: ids.movement,
    quantity: 4,
    from_entity_type: "storage",
    from_entity_id: ids.movement,
    to_entity_type: "machine",
    to_entity_id: ids.movement,
    related_route_id: ids.movement,
    related_route_stop_id: ids.movement,
    related_machine_id: ids.movement,
    created_by: ids.movement,
  };

  for (const [field, value] of Object.entries(mutations)) {
    const result = resolveCanonicalInventoryMovement([{ ...canonical, [field]: value }], expected);
    assert.equal(result.status, "mismatch", `${field} must be validated`);
    assert.ok(result.mismatchedFields.includes(field), `${field} must identify its mismatch`);
  }
});

test("both atomic RPC retries validate parent payload and compare-and-set the link", () => {
  const manual = read("src/app/api/operator/routes/[id]/stops/[stopId]/manual-sales/route.ts");
  const compensation = read("src/app/api/operator/routes/[id]/stops/[stopId]/compensations/route.ts");

  assert.match(manual, /\.rpc\("snacky_create_route_manual_sale_v1"/);
  assert.match(compensation, /\.rpc\("snacky_create_route_customer_compensation_v1"/);
  for (const [name, source, parentTable] of [
    ["manual sale", manualRpc, "route_manual_sales"],
    ["compensation", compensationRpc, "route_customer_compensations"],
  ]) {
    assert.match(source, /where .*client_submission_id = v_submission_id[\s\S]*for update/);
    assert.match(source, /different immutable payload/);
    assert.match(source, /idempotency_key is distinct from v_expected_movement_key/);
    assert.match(source, /source_type is distinct from 'route_(?:manual_sale|customer_compensation)'/);
    assert.match(source, /source_id is distinct from v_(?:sale|record)\.id/);
    assert.match(source, new RegExp(`update public\\.${parentTable}[\\s\\S]*set inventory_movement_id = v_movement\\.id`));
    assert.match(source, /and .*inventory_movement_id is null[\s\S]*get diagnostics v_updated_count = row_count/);
    assert.match(source, /if v_updated_count <> 1 then/, `${name} must reject a lost compare-and-set`);
  }
});

test("route bag availability is authoritative, unbounded, and fails closed", () => {
  for (const source of [manualRpc, compensationRpc]) {
    assert.match(source, /'snacky:operator-custody:'/);
    assert.match(source, /'snacky:operator-bag:'/);
    assert.match(source, /movement\.related_route_id = p_route_id[\s\S]*movement\.product_id = p_product_id/);
    assert.match(source, /v_route_bag_qty < p_quantity::bigint/);
    assert.match(source, /v_global_bag_qty < p_quantity::bigint/);
    assert.match(source, /v_review_reason is not null/);
    assert.doesNotMatch(source, /limit\s+5000/i);
  }
});

test("manual-sale retries require a caller-stable submission id", () => {
  const manual = read("src/app/api/operator/routes/[id]/stops/[stopId]/manual-sales/route.ts");
  assert.match(manual, /if \(!clientSubmissionId \|\| clientSubmissionId\.length > 200\)[\s\S]*MISSING_SUBMISSION_ID/);
  assert.match(manualRpc, /v_submission_id is null or pg_catalog\.length\(v_submission_id\) > 200/);
  assert.doesNotMatch(manual, /clientSubmissionId[^\n]*Date\.now\(\)/);
});
