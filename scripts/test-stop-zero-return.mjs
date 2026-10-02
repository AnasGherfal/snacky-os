import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function sourceFunctionBody(source, functionName) {
  const start = source.indexOf(`export async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} must be exported`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function sqlFunctionBody(source, functionName) {
  const startPattern = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${functionName}\\s*\\(`, "i");
  const start = source.search(startPattern);
  assert.notEqual(start, -1, `${functionName} must be defined`);
  const definition = source.slice(start);
  const body = definition.match(/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i);
  assert.ok(body, `${functionName} must use a dollar-quoted SQL body`);
  return body[2];
}

test("an explicit zero fill never manufactures a return from planned or assigned quantity", () => {
  const actions = sourceFunctionBody(read("src/lib/operator-actions.ts"), "completeStop");

  assert.match(actions, /rpc\(\s*"snacky_commit_route_stop_inventory_v1"/);
  assert.match(actions, /p_fill_lines/);
  assert.match(actions, /const rpcStopId = requireUuidValue\(stopId,\s*"Stop id"\)/);
  assert.match(actions, /p_route_stop_id:\s*rpcStopId/);
  assert.doesNotMatch(actions, /\bp_stop_id\s*:/);
  assert.doesNotMatch(actions, /buildExplicitZeroFillReturn/);
  assert.doesNotMatch(actions, /route_stop_zero_fill_return/);
  assert.doesNotMatch(actions, /zeroFillReturn|zero_fill_return/i);
  assert.doesNotMatch(actions, /assigned[^\n]{0,100}operator_bag_to_storage/i);
});

test("the atomic stop commit has no zero-fill storage-return branch", () => {
  const migration = read("supabase/migrations/20260905091000_route_stop_inventory_commit.sql");
  const body = sqlFunctionBody(migration, "snacky_commit_route_stop_inventory_v1");

  assert.match(body, /route_stop_fill_lines/i, "an actual zero must still be persisted as field truth");
  assert.doesNotMatch(body, /route_stop_zero_fill_return/i);
  assert.doesNotMatch(body, /actual_(quantity|qty)\s*=\s*0[\s\S]{0,800}operator_bag_to_storage/i);
  assert.doesNotMatch(body, /operator_bag_to_storage[\s\S]{0,800}actual_(quantity|qty)\s*=\s*0/i);
});

test("bag stock moves back to storage only after a physical terminal count", () => {
  const terminalMigration = read("supabase/migrations/20260905090000_route_terminal_inventory_reconciliation.sql");
  const finalizer = sqlFunctionBody(terminalMigration, "snacky_finalize_route_inventory");
  const leftoversPage = read("src/app/operator/routes/[id]/leftovers/page.tsx");

  assert.match(finalizer, /jsonb_to_recordset\s*\(\s*v_counts/i);
  assert.match(finalizer, /counted_quantity/i);
  assert.match(finalizer, /operator_bag_to_storage/i);
  assert.match(leftoversPage, /physical route-bag count/i);
  assert.match(leftoversPage, /finalizeRouteInventory\(\{/);
  assert.doesNotMatch(leftoversPage, /recordLeftovers\(\{/);
});

test("legacy zero-fill movements remain visible as history but never define current custody", () => {
  const adminSummary = read("src/app/routes/[id]/page.tsx");
  const operatorSummary = read("src/app/operator/routes/[id]/page.tsx");
  const pickedItemsApi = read("src/app/api/operator/routes/[id]/picked-items/route.ts");

  assert.match(adminSummary, /route_stop_zero_fill_return/);
  assert.match(operatorSummary, /Number\(item\.returned_qty \?\? 0\)/);
  assert.doesNotMatch(operatorSummary, /item\.picked_qty \|\| item\.planned_qty/);
  assert.match(pickedItemsApi, /snacky_route_bag_snapshot/);
  assert.match(pickedItemsApi, /const bagHistoryItems = allCustodyItems/);
  assert.match(pickedItemsApi, /signed_quantity/);
});

test("the obsolete planned-quantity zero-return helper is gone", () => {
  assert.equal(
    fs.existsSync(path.join(root, "src/lib/route-stop-zero-return.ts")),
    false,
    "planned quantities must never be reusable as an automatic storage return",
  );
});
