import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = {
  terminalMigration: "supabase/migrations/20260905090000_route_terminal_inventory_reconciliation.sql",
  stopMigration: "supabase/migrations/20260905091000_route_stop_inventory_commit.sql",
  pickedItemsApi: "src/app/api/operator/routes/[id]/picked-items/route.ts",
  leftoversPage: "src/app/operator/routes/[id]/leftovers/page.tsx",
  operatorActions: "src/lib/operator-actions.ts",
  routeActions: "src/lib/route-actions.ts",
  adminToolsActions: "src/lib/admin-tools-actions.ts",
  operatorStopPage: "src/app/operator/routes/[id]/stops/[stopId]/page.tsx",
};

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function compactSignature(source) {
  return source.replace(/\s+/g, "").toLowerCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sqlFunctionBody(source, functionName) {
  const startPattern = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${escapeRegExp(functionName)}\\s*\\(`, "i");
  const start = source.search(startPattern);
  assert.notEqual(start, -1, `${functionName} must be defined`);
  const definition = source.slice(start);
  const body = definition.match(/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i);
  assert.ok(body, `${functionName} must use a dollar-quoted SQL body`);
  return body[2];
}

function sourceFunctionBody(source, functionName) {
  const start = source.indexOf(`export async function ${functionName}`);
  assert.notEqual(start, -1, `${functionName} must be exported`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

function topLevelSql(source) {
  return source.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "");
}

function assertFunctionPrivilegeContract(source, functionName, argumentTypes, grantee = "authenticated") {
  const normalized = compact(source);
  const signature = `${functionName}(${argumentTypes})`.replace(/\s+/g, "").toLowerCase();
  const statements = normalized.split(";").filter((statement) => statement.replace(/\s+/g, "").toLowerCase().includes(signature));
  const revokes = statements.filter((statement) => /\brevoke\b/i.test(statement)).join(" ");
  const grants = statements.filter((statement) => /\bgrant\b/i.test(statement)).join(" ");

  assert.match(revokes, /\bpublic\b/i, `${functionName} must be revoked from PUBLIC`);
  assert.match(revokes, /\banon\b/i, `${functionName} must be revoked from anon`);
  assert.match(grants, new RegExp(`\\b${grantee}\\b`, "i"), `${functionName} must be granted only to ${grantee} callers`);
  if (grantee === "service_role") {
    assert.doesNotMatch(grants, /\bauthenticated\b/i, `${functionName} must not remain callable by authenticated clients`);
  }
}

test("terminal and stop RPC signatures are stable application contracts", () => {
  const terminal = compactSignature(read(files.terminalMigration));
  const stop = compactSignature(read(files.stopMigration));

  assert.ok(terminal.includes(compactSignature(
    "create or replace function public.snacky_route_bag_balances(p_route_id uuid) returns table(bag_owner_id uuid, product_id uuid, signed_quantity bigint)",
  )));
  assert.ok(terminal.includes(compactSignature(
    "create or replace function public.snacky_finalize_route_inventory(p_route_id uuid, p_action text, p_storage_location_id uuid default null, p_counts jsonb default '[]'::jsonb, p_reason text default null, p_client_submission_id text default null, p_expected_ledger_token text default null) returns table(reconciliation_id uuid, route_id uuid, route_status public.route_status, reconciliation_status text, returned_quantity integer, discrepancy_quantity integer, already_finalized boolean)",
  )));
  assert.ok(stop.includes(compactSignature(
    "create or replace function public.snacky_commit_route_stop_inventory_v1(p_route_id uuid, p_route_stop_id uuid, p_machine_id uuid, p_actor_user_id uuid, p_actor_team_member_id uuid, p_submission_id text, p_fill_lines jsonb, p_machine_storage_lines jsonb) returns jsonb",
  )));
  assert.ok(terminal.includes(compactSignature(
    "create or replace function public.return_pickup_batch_to_assigned(p_route_id uuid, p_pickup_batch_id uuid, p_reason text default null) returns table(pickup_batch_id uuid, route_id uuid, route_status public.route_status, compensating_movement_count integer, restored_quantity integer, already_returned boolean)",
  )));

  assertFunctionPrivilegeContract(read(files.terminalMigration), "snacky_route_bag_balances", "uuid");
  assertFunctionPrivilegeContract(read(files.terminalMigration), "snacky_route_bag_snapshot", "uuid");
  assertFunctionPrivilegeContract(read(files.terminalMigration), "snacky_route_inventory_count_options", "uuid");
  assertFunctionPrivilegeContract(read(files.terminalMigration), "snacky_finalize_route_inventory", "uuid, text, uuid, jsonb, text, text, text");
  assertFunctionPrivilegeContract(read(files.terminalMigration), "return_pickup_batch_to_assigned", "uuid, uuid, text");
  assertFunctionPrivilegeContract(read(files.stopMigration), "snacky_commit_route_stop_inventory_v1", "uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb", "service_role");
});

test("canonical bag balances are grouped in Postgres from every bag endpoint", () => {
  const migration = read(files.terminalMigration);
  const historyBody = compact(sqlFunctionBody(migration, "_snacky_route_bag_history_balances"));
  const outstandingBody = compact(sqlFunctionBody(migration, "_snacky_route_bag_balances"));

  assert.match(historyBody, /sum\s*\([\w.]*quantity_delta\)/i);
  assert.match(historyBody, /to_entity_type(?:::text)? = 'operator_bag'/i);
  assert.match(historyBody, /from_entity_type(?:::text)? = 'operator_bag'/i);
  assert.match(historyBody, /[\w.]*quantity(?:::bigint)? as quantity_delta/i);
  assert.match(historyBody, /-[\w.]*quantity(?:::bigint)? as quantity_delta/i);
  assert.match(historyBody, /union all/i);
  assert.match(historyBody, /related_route_id = p_route_id/i);
  assert.match(historyBody, /group by[\s\S]*product_id/i);
  assert.match(historyBody, /group by[\s\S]*(bag_owner|from_entity_id|to_entity_id)/i);
  assert.doesNotMatch(historyBody, /\bhaving\b[\s\S]*signed_quantity\s*<>\s*0/i,
    "custody history must preserve owner/product keys whose signed balance is zero");
  assert.doesNotMatch(historyBody, /\blimit\b/i, "custody totals must never be truncated by a row limit");

  assert.match(outstandingBody, /_snacky_route_bag_history_balances\s*\(\s*p_route_id\s*\)/i);
  assert.match(outstandingBody, /signed_quantity\s*<>\s*0/i,
    "the outstanding-balance helper alone should filter net-zero keys");

  const publicBody = compact(sqlFunctionBody(migration, "snacky_route_bag_balances"));
  assert.match(publicBody, /auth\.uid\(\)/i);
  assert.match(publicBody, /_snacky_route_bag_balances\s*\(\s*p_route_id\s*\)/i);
  assert.match(migration, /security definer/i);
  assert.match(migration, /set search_path = ''/i);
});

test("terminal snapshot and exact count coverage preserve zero-net custody history", () => {
  const migration = read(files.terminalMigration);
  const tokenBody = compact(sqlFunctionBody(migration, "_snacky_route_bag_ledger_token"));
  const snapshotBody = compact(sqlFunctionBody(migration, "snacky_route_bag_snapshot"));
  const finalizerBody = compact(sqlFunctionBody(migration, "snacky_finalize_route_inventory"));

  assert.match(tokenBody, /_snacky_route_bag_history_balances\s*\(\s*p_route_id\s*\)/i);
  assert.match(tokenBody, /signed_quantity::text/i);
  assert.match(snapshotBody, /_snacky_route_bag_history_balances\s*\(\s*p_route_id\s*\)/i);
  assert.match(snapshotBody, /'ledger_token'/i);
  assert.match(snapshotBody, /'balances'/i);
  assert.match(finalizerBody, /from public\._snacky_route_bag_history_balances\(p_route_id\) b left join pg_catalog\.jsonb_to_recordset\(v_counts\)/i);
  assert.match(finalizerBody, /including a zero balance/i);
  assert.match(finalizerBody, /with ledger as \( select b\.bag_owner_id, b\.product_id, b\.signed_quantity::integer as ledger_quantity from public\._snacky_route_bag_history_balances\(p_route_id\) b \)/i);
});

test("route-authorized inventory options expose only safe active product and return-storage fields", () => {
  const migration = read(files.terminalMigration);
  const body = compact(sqlFunctionBody(migration, "snacky_route_inventory_count_options"));

  assert.match(body, /auth\.uid\(\)/i);
  assert.match(body, /snacky_operator_can_access_route\(p_route_id\)/i);
  assert.match(body, /snacky_current_profile_has_any_role\(array\['owner', 'admin', 'supervisor', 'warehouse'\]\)/i);
  assert.match(body, /not exists \(select 1 from public\.routes r where r\.id = p_route_id\)/i);
  assert.match(body, /'active_product_options'/i);
  assert.match(body, /'id', product_row\.id, 'name', product_row\.name, 'sku', product_row\.sku/i);
  assert.match(body, /from public\.products product_row where product_row\.active = true/i);
  assert.match(body, /'return_storage_options'/i);
  assert.match(body, /'id', storage_row\.id, 'name', storage_row\.name, 'location_type', storage_row\.location_type/i);
  assert.match(body, /storage_row\.active = true and storage_row\.location_type in \('main_storage', 'vehicle', 'temporary', 'other'\)/i);
  assert.doesNotMatch(body, /purchase_price|selling_price|cost|auth_user_id|created_by/i);
});

test("route stock cache sync updates returned quantities before inserting missing rows", () => {
  const body = compact(sqlFunctionBody(read(files.terminalMigration), "_snacky_sync_route_stock_lines"));

  assert.match(body, /order by ap\.product_id/i);
  assert.match(body, /pg_advisory_xact_lock[\s\S]*snacky:route-stock-line:/i);
  assert.match(
    body,
    /update public\.route_stock_lines[\s\S]*planned_qty\s*=\s*greatest\(coalesce\(rsl\.planned_qty, 0\), v_stock_line\.picked_quantity\)[\s\S]*picked_qty\s*=\s*v_stock_line\.picked_quantity[\s\S]*returned_qty\s*=\s*v_stock_line\.returned_quantity/i,
  );
  assert.match(body, /if not found then[\s\S]*insert into public\.route_stock_lines/i);
  assert.match(
    body,
    /greatest\(v_stock_line\.picked_quantity, v_stock_line\.returned_quantity\), v_stock_line\.picked_quantity, v_stock_line\.returned_quantity/i,
  );

  const existingPlanned = (planned, picked) => Math.max(planned ?? 0, picked);
  const missingPlanned = (picked, returned) => Math.max(picked, returned);
  assert.equal(existingPlanned(5, 7), 7);
  assert.equal(existingPlanned(10, 7), 10);
  assert.equal(missingPlanned(7, 0), 7);
  assert.equal(missingPlanned(0, 3), 3);

  const updateIndex = body.indexOf("update public.route_stock_lines");
  const insertIndex = body.indexOf("insert into public.route_stock_lines");
  assert.ok(
    updateIndex >= 0 && insertIndex > updateIndex,
    "existing cache rows must be updated explicitly before the BEFORE INSERT guard can suppress a missing-row insert",
  );
});

test("picked-items API uses the atomic history snapshot and locks finalization during migration fallback", () => {
  const source = read(files.pickedItemsApi);
  assert.match(source, /\.rpc\("snacky_route_bag_snapshot", \{ p_route_id: routeId \}\)/);
  assert.match(source, /\.rpc\("snacky_route_inventory_count_options", \{ p_route_id: routeId \}\)/);
  assert.match(source, /snapshot\?\.ledger_token/);
  assert.match(source, /snapshot\?\.balances/);
  assert.match(source, /row\.signed_quantity/);
  assert.match(source, /signedQuantity/);
  assert.match(source, /remainingQty:\s*balanceByProduct\.get\(row\.productId\) \?\? 0/);
  assert.match(source, /inventoryFinalizationBlockCode = !ledgerToken \|\| !inventoryCountOptionsAvailable[\s\S]*\? "SERVICES_UNAVAILABLE"/);
  assert.match(source, /inventoryFinalizationAvailable:\s*inventoryFinalizationBlockCode === null/);
  assert.match(source, /Atomic bag snapshot is not installed; finalization remains locked/i);

  assert.match(source, /const allCustodyItems:[\s\S]*authoritativeCustodyRows/);
  assert.match(source, /const bagHistoryItems = allCustodyItems/,
    "zero-net custody keys from the snapshot must remain available for explicit confirmation");
  assert.match(source, /const custodyItems = allCustodyItems\.filter\(\(item\) => item\.signedQuantity !== 0\)/);
  assert.match(source, /balanceByProduct\.set\(productId,[\s\S]*signedQuantity/);
});

test("stop inventory commit is atomic, locked, retry-safe, and never auto-returns a zero fill", () => {
  const migration = read(files.stopMigration);
  const body = compact(sqlFunctionBody(migration, "snacky_commit_route_stop_inventory_v1"));

  assert.doesNotMatch(body, /auth\.uid\(\)/i, "the service-only writer must validate explicit server actor ids");
  assert.match(body, /p_actor_user_id/i);
  assert.match(body, /p_actor_team_member_id/i);
  assert.match(body, /from public\.profiles[\s\S]*join public\.team_members/i);
  assert.match(body, /v_actor_is_manager[\s\S]*v_actor_is_operator/i);
  assert.match(body, /from public\.routes[\s\S]*for update/i);
  assert.match(body, /from public\.route_stops[\s\S]*for update/i);
  assert.match(body, /pg_advisory_xact_lock/i);
  assert.match(body, /_snacky_route_bag_balances/i);
  assert.match(body, /v_operator_bag_before/i);
  assert.match(body, /v_route_bag_before/i);
  assert.match(body, /v_operator_bag_after\s*<\s*least\(v_operator_bag_before,\s*0\)[\s\S]*v_route_bag_after\s*<\s*least\(v_route_bag_before,\s*0\)/i);
  assert.match(body, /p_submission_id/i);
  assert.match(body, /idempotency_key/i);
  assert.match(body, /on conflict/i);
  assert.match(body, /public\.inventory_movements/i);
  assert.match(body, /public\.route_stop_fill_lines/i);
  assert.match(body, /public\.route_stops/i);
  assert.match(body, /completed|reviewed|cancelled/i);
  assert.doesNotMatch(body, /route_stop_zero_fill_return/i);
  assert.doesNotMatch(body, /operator_bag_to_storage/i, "zero fills must remain in operator custody until physical terminal reconciliation");
});

test("terminal finalization locks the route and derives reconciliation from server custody", () => {
  const migration = read(files.terminalMigration);
  const body = compact(sqlFunctionBody(migration, "snacky_finalize_route_inventory"));

  assert.match(body, /auth\.uid\(\)/i);
  assert.match(body, /from public\.routes[\s\S]*for update/i);
  assert.match(body, /pg_advisory_xact_lock/i);
  assert.match(body, /_snacky_route_bag_balances/i);
  assert.match(body, /v_counts jsonb := coalesce\(p_counts, '\[\]'::jsonb\)/i);
  assert.match(body, /jsonb_to_recordset\s*\(\s*v_counts\s*\)/i);
  for (const field of ["bag_owner_id", "product_id", "counted_quantity", "discrepancy_reason"]) {
    assert.match(body, new RegExp(`\\b${field}\\b`, "i"));
  }
  assert.doesNotMatch(body, /current_?remaining/i);
  assert.doesNotMatch(body, /client_?(available|balance|picked)/i);
  assert.match(body, /route_inventory_reconciliations/i);
  assert.match(body, /route_inventory_reconciliation_lines/i);
  assert.match(body, /route_inventory_discrepancies/i);
  assert.match(body, /p_action[\s\S]*'complete'[\s\S]*'cancel'/i);
  assert.match(body, /storage_locations[\s\S]*active = true/i);
  assert.match(body, /'operator_bag'::public\.inventory_entity_type[\s\S]*v_line\.bag_owner_id[\s\S]*'storage'::public\.inventory_entity_type[\s\S]*v_storage_location_id/i);
  assert.doesNotMatch(body, /route_stop_zero_fill_return/i);

  const reconciliationInsert = body.indexOf("insert into public.route_inventory_reconciliations");
  const movementInsert = body.indexOf("insert into public.inventory_movements", reconciliationInsert);
  const routeUpdate = body.indexOf("update public.routes", movementInsert);
  assert.ok(reconciliationInsert >= 0 && movementInsert > reconciliationInsert && routeUpdate > movementInsert,
    "reconciliation, append-only ledger movements, and terminal status must be committed by one database function");
});

test("terminal finalization fails closed on oversized, stale, unassigned, or unfinished submissions", () => {
  const body = compact(sqlFunctionBody(read(files.terminalMigration), "snacky_finalize_route_inventory"));

  assert.match(body, /jsonb_array_length\(v_counts\) > 500/i);
  assert.match(body, /pg_column_size\(v_counts\) > 1048576/i);
  assert.match(body, /length\(coalesce\(p_reason, ''\)\) > 2000/i);
  assert.match(body, /length\(v_submission_id\) > 200/i);
  assert.match(body, /p_expected_ledger_token/i);
  assert.match(body, /_snacky_route_bag_ledger_token\(p_route_id\)/i);
  assert.match(body, /errcode = '40001'/i);
  assert.match(body, /v_route\.operator_id is distinct from v_actor_team_member_id/i,
    "ordinary operators must be the route's exact assigned operator");
  assert.match(body, /v_route\.operator_id is null[\s\S]*assigned to an operator before it can be completed/i);
  assert.match(body, /v_route\.status::text not in \('in_progress', 'pickup_confirmed', 'started', 'filling', 'machine_filling'\)/i);
  assert.match(body, /not exists \( select 1 from public\.route_stops rs where rs\.route_id = p_route_id \)/i);
  assert.match(body, /receipt\.workflow_completed_at is null/i,
    "route finalization must not race the workflow write after a stop inventory commit");
  assert.match(body, /rs\.status::text not in \('completed', 'skipped', 'canceled'\)/i);

  const submissionRetry = body.indexOf("where rec.client_submission_id = v_submission_id");
  const routeRetry = body.indexOf("where rec.route_id = p_route_id", submissionRetry);
  const readiness = body.indexOf("if v_action = 'complete' then", routeRetry);
  assert.ok(submissionRetry >= 0 && routeRetry > submissionRetry && readiness > routeRetry,
    "active-route readiness must run only after both lost-response replay branches");
});

test("terminal writers use route, sorted custody owner, then sorted bag-key lock order", () => {
  const migration = read(files.terminalMigration);
  const finalizerBody = compact(sqlFunctionBody(migration, "snacky_finalize_route_inventory"));
  const pickupBody = compact(sqlFunctionBody(migration, "return_pickup_batch_to_assigned"));

  assert.match(finalizerBody, /_snacky_route_bag_history_balances\(p_route_id\)[\s\S]*union[\s\S]*jsonb_to_recordset\(v_counts\)/i);
  assert.match(finalizerBody, /order by involved\.bag_owner_id[\s\S]*snacky:operator-custody:/i);
  assert.match(finalizerBody, /order by involved\.bag_owner_id, involved\.product_id/i);
  assert.match(finalizerBody, /snacky:operator-bag:' \|\| v_bag_lock\.bag_owner_id::text \|\| ':' \|\| v_bag_lock\.product_id::text/i);
  const finalizerCustodyLock = finalizerBody.indexOf("snacky:operator-custody:");
  const finalizerBagLock = finalizerBody.indexOf("snacky:operator-bag:");
  const finalizerWrite = finalizerBody.indexOf("insert into public.route_inventory_reconciliations");
  assert.ok(finalizerCustodyLock >= 0 && finalizerBagLock > finalizerCustodyLock && finalizerWrite > finalizerBagLock,
    "the finalizer must hold sorted owner locks and then bag keys before its first business write");

  assert.match(pickupBody, /select distinct pickup_movement\.to_entity_id as bag_owner_id, pickup_movement\.product_id/i);
  assert.match(pickupBody, /select distinct pickup_movement\.to_entity_id as bag_owner_id[\s\S]*order by pickup_movement\.to_entity_id[\s\S]*snacky:operator-custody:/i);
  assert.match(pickupBody, /order by pickup_movement\.to_entity_id, pickup_movement\.product_id/i);
  assert.match(pickupBody, /snacky:operator-bag:' \|\| v_bag_lock\.bag_owner_id::text \|\| ':' \|\| v_bag_lock\.product_id::text/i);
  const pickupCustodyLock = pickupBody.indexOf("snacky:operator-custody:");
  const pickupBagLock = pickupBody.indexOf("snacky:operator-bag:");
  const pickupWrite = pickupBody.indexOf("insert into public.inventory_movements");
  assert.ok(pickupCustodyLock >= 0 && pickupBagLock > pickupCustodyLock && pickupWrite > pickupBagLock,
    "pickup return must hold sorted owner locks and then bag keys before writing reversals");
});

test("terminal finalization repairs only the impossible global-bag lower bound and opens an audited case", () => {
  const body = compact(sqlFunctionBody(read(files.terminalMigration), "snacky_finalize_route_inventory"));

  assert.match(body, /v_global_projected_balance := v_global_bag_balance - v_line\.ledger_quantity::bigint/i);
  assert.match(body, /v_global_alignment_quantity := greatest\(-v_global_projected_balance, 0::bigint\)/i,
    "alignment must be max(route ledger - global bag, 0), independent of the physical count");
  assert.match(body, /v_global_alignment_quantity > 2147483647/i);
  assert.match(body, /'adjustment'::public\.inventory_entity_type[\s\S]*'operator_bag'::public\.inventory_entity_type/i);
  assert.match(body, /related_route_id,[\s\S]*values \([\s\S]*null,[\s\S]*'route_terminal_global_bag_alignment'/i);
  assert.match(body, /movement\.related_route_id is null/i);
  assert.match(body, /route-terminal:global-bag-alignment:/i);
  assert.match(body, /'negative_bag_balance'[\s\S]*v_global_projected_balance::integer[\s\S]*0[\s\S]*v_global_alignment_quantity::integer/i);
  assert.match(body, /'route_terminal_global_bag_alignment'[\s\S]*'route-terminal-global-bag-discrepancy:'/i);
  assert.match(body, /correcting_movement_id = excluded\.correcting_movement_id/i);
  assert.match(body, /sum\(discrepancy\.absolute_quantity::bigint\)[\s\S]*discrepancy\.route_id = p_route_id[\s\S]*status in \('open', 'investigating'\)/i,
    "the route reconciliation header must include the global-alignment review case");

  const alignmentIndex = body.indexOf("route-terminal:global-bag-alignment:");
  const routeVarianceIndex = body.indexOf("route-terminal:variance:");
  const returnIndex = body.indexOf("route-terminal:return:");
  assert.ok(alignmentIndex >= 0 && routeVarianceIndex > alignmentIndex && returnIndex > routeVarianceIndex,
    "global lower-bound alignment must happen before every possible route-scoped debit");
});

test("pristine pickup return aligns an impossible global bag lower bound without changing route arithmetic", () => {
  const body = compact(sqlFunctionBody(read(files.terminalMigration), "return_pickup_batch_to_assigned"));

  assert.match(body, /v_global_projected_balance := v_global_bag_balance - v_return_group\.route_return_quantity/i);
  assert.match(body, /v_global_alignment_quantity := greatest\(-v_global_projected_balance, 0::bigint\)/i);
  assert.match(body, /v_global_alignment_quantity > 2147483647/i);
  assert.match(body, /related_route_id,[\s\S]*values \([\s\S]*null,[\s\S]*'route_pickup_global_bag_alignment'/i,
    "the lower-bound correction must remain outside the exact route ledger");
  assert.match(body, /'negative_bag_balance'[\s\S]*v_global_projected_balance::integer[\s\S]*v_global_alignment_quantity::integer/i);
  assert.match(body, /'route_pickup_global_bag_alignment'[\s\S]*'route-pickup-global-bag-discrepancy:'/i);
  assert.match(body, /correcting_movement_id = excluded\.correcting_movement_id/i);

  const alignForReturn = (globalBalance, routeReturnQuantity) => {
    const projected = globalBalance - routeReturnQuantity;
    const alignment = Math.max(-projected, 0);
    return {
      projected,
      alignment,
      afterReturn: globalBalance + alignment - routeReturnQuantity,
    };
  };
  assert.deepEqual(
    alignForReturn(-9, 14),
    { projected: -23, alignment: 23, afterReturn: 0 },
    "live legacy global -9 plus active route +14 needs an audited +23 unscoped alignment before exact -14 return",
  );
  assert.deepEqual(
    alignForReturn(20, 14),
    { projected: 6, alignment: 0, afterReturn: 6 },
    "a globally healthy bag must not receive an unnecessary adjustment",
  );

  const alignmentIndex = body.indexOf("route-pickup:global-bag-alignment:");
  const reversalIndex = body.indexOf("'route_pickup_return'", alignmentIndex);
  assert.ok(alignmentIndex >= 0 && reversalIndex > alignmentIndex,
    "lower-bound alignment must precede every route-scoped pickup debit");
});

test("terminal cancellation and return destination selection fail closed", () => {
  const body = compact(sqlFunctionBody(read(files.terminalMigration), "snacky_finalize_route_inventory"));

  assert.match(body, /v_action = 'cancel'[\s\S]*jsonb_array_length\(v_counts\) = 0[\s\S]*related_route_id = p_route_id[\s\S]*from_entity_type::text = 'operator_bag'[\s\S]*to_entity_type::text = 'operator_bag'/i);
  assert.match(body, /This route has operator-bag history\. Enter explicit physical counts before finalizing it\./i);
  assert.doesNotMatch(body, /jsonb_agg[\s\S]{0,500}greatest\(b\.signed_quantity/i,
    "cancellation must never convert the ledger balance into an assumed physical count");

  assert.match(body, /select distinct im\.from_entity_id as storage_location_id[\s\S]*from_entity_type::text = 'storage'[\s\S]*to_entity_type::text = 'operator_bag'/i);
  assert.match(body, /This route was picked from multiple storage locations\. Select the physical return destination explicitly\./i);
  assert.match(body, /v_eligible_storage_count = 0[\s\S]*No active storage location can receive physical route leftovers\./i);
  assert.match(body, /v_eligible_storage_count > 1[\s\S]*This route has no pickup-origin storage and more than one return destination is available\. Select one explicitly\./i);
});

test("pristine pickup rollback reverses exact source legs and refuses any used batch", () => {
  const migration = read(files.terminalMigration);
  const body = compact(sqlFunctionBody(migration, "return_pickup_batch_to_assigned"));

  assert.match(body, /auth\.uid\(\)/i);
  assert.match(body, /pg_advisory_xact_lock/i);
  assert.match(body, /from public\.routes[\s\S]*for update/i);
  assert.match(body, /from public\.route_pickup_batches[\s\S]*for update/i);
  assert.match(body, /status <> 'confirmed'/i);
  assert.match(body, /multiple active pickup batches/i);
  assert.match(body, /inventory activity exists after or outside this pickup/i);
  assert.match(body, /route_stop_fill_lines/i);
  assert.match(body, /cash_collections/i);
  assert.match(body, /machine_refill_history/i);
  assert.match(body, /pickup_movement\.to_entity_id[\s\S]*'storage'::public\.inventory_entity_type[\s\S]*pickup_movement\.from_entity_id/i);
  assert.match(body, /reversed_movement_id[\s\S]*pickup_movement\.id/i);
  assert.match(body, /on conflict do nothing/i);
  assert.match(body, /v_reversal_count <> v_pickup_movement_count/i);
  assert.match(body, /_snacky_route_bag_balances\s*\(\s*p_route_id\s*\)/i);
  assert.match(body, /returned_to_assigned_at is not null[\s\S]*true/i);
  assert.match(body, /to_regprocedure\([\s\S]*_snacky_release_operator_route_custody\(uuid,uuid,text,uuid\)/i);
  const batchUpdate = body.indexOf("update public.route_pickup_batches batch_row");
  const release = body.indexOf("_snacky_release_operator_route_custody", batchUpdate);
  const routeUpdate = body.indexOf("update public.routes r", batchUpdate);
  assert.ok(batchUpdate >= 0 && release > batchUpdate && routeUpdate > release,
    "the RPC must release custody explicitly without a batch AFTER trigger lock inversion");
  assert.match(body, /set status = 'assigned'::public\.route_status/i);
});

test("pristine pickup retry validates persisted state and exact reversal provenance", () => {
  const body = compact(sqlFunctionBody(read(files.terminalMigration), "return_pickup_batch_to_assigned"));
  const retryStart = body.indexOf("if v_batch.returned_to_assigned_at is not null then");
  const retryEnd = body.indexOf("if v_route.status::text in", retryStart);
  assert.ok(retryStart >= 0 && retryEnd > retryStart, "the already-returned retry branch must exist");
  const retry = body.slice(retryStart, retryEnd);

  assert.match(retry, /reverse_movement\.reversed_movement_id = pickup_movement\.id/i);
  assert.match(retry, /reverse_movement\.source_type = 'route_pickup_return'/i);
  assert.match(retry, /reverse_movement\.source_id = p_pickup_batch_id/i);
  assert.match(retry, /v_route\.status::text <> 'assigned'/i);
  assert.match(retry, /v_batch\.status <> 'cancelled'/i);
  assert.match(retry, /coalesce\(v_batch\.storage_deducted, false\)/i);
  assert.match(retry, /v_reversal_count <> v_pickup_movement_count/i);
  assert.match(retry, /v_return_source_count <> v_reversal_count/i,
    "retry validation must reject extra source-tagged rows outside the exact reversal set");
  assert.match(retry, /v_reversal_count <> coalesce\(v_batch\.returned_to_assigned_movement_count, 0\)/i);
  assert.match(retry, /v_reversal_quantity <> coalesce\(v_batch\.returned_to_assigned_quantity, 0\)::bigint/i);
  assert.match(retry, /_snacky_route_bag_balances\(p_route_id\)/i);
  assert.match(retry, /v_batch\.returned_to_assigned_movement_count[\s\S]*v_batch\.returned_to_assigned_quantity[\s\S]*true/i);
  assert.doesNotMatch(retry, /select[\s\S]*0,[\s\S]*0,[\s\S]*true/i,
    "an idempotent retry must return and validate the persisted movement totals");

  const postRetry = body.slice(retryEnd);
  assert.match(postRetry, /reverse_movement\.source_type = 'route_pickup_return'/i);
  assert.match(postRetry, /reverse_movement\.source_id = p_pickup_batch_id/i);
  assert.match(postRetry, /v_return_source_count <> v_reversal_count/i);
});

test("application callers cannot continue after failed leftovers or use bespoke cancellation arithmetic", () => {
  const leftovers = read(files.leftoversPage);
  assert.doesNotMatch(leftovers, /Leftover reconciliation failed but route completion will continue/);
  assert.match(leftovers, /finalizeRouteInventory\(\{/);
  assert.doesNotMatch(leftovers, /recordLeftovers\(\{/);
  assert.doesNotMatch(leftovers, /completeRoute\(routeId\)/);
  const failureGuard = leftovers.indexOf("if (!completionResult.success)");
  assert.notEqual(failureGuard, -1, "atomic finalization failure must be handled explicitly");
  assert.match(leftovers.slice(failureGuard, failureGuard + 1800), /throw new Error/);

  const operatorActions = sourceFunctionBody(read(files.operatorActions), "finalizeRouteInventory");
  assert.match(operatorActions, /rpc\("snacky_finalize_route_inventory"/);
  assert.match(operatorActions, /p_counts/);
  assert.doesNotMatch(operatorActions, /currentRemainingQty|current_remaining_qty/);

  const routeActions = read(files.routeActions);
  assert.doesNotMatch(routeActions, /export async function cancelRoute\b/);
  assert.doesNotMatch(routeActions, /reverseOutstandingPickedStock/);

  const adminCompletion = sourceFunctionBody(read(files.adminToolsActions), "forceCompleteRouteWithAudit");
  assert.match(adminCompletion, /redirect\(`\/operator\/routes\/\$\{routeId\}\/leftovers\?mode=complete`\)/,
    "admin completion must open the physical-count workflow");
  assert.doesNotMatch(adminCompletion, /snacky_finalize_route_inventory|counted_quantity:\s*0/,
    "an admin shortcut cannot fabricate a physical zero count");

  const stopPage = read(files.operatorStopPage);
  assert.match(stopPage, /isRouteStopDoneStatus\(stopData\.stopStatus\)[\s\S]*Completed stop — read only/);
  assert.match(stopPage, /Closed stop — read only/,
    "skipped and cancelled stops must also bypass the mutable completion form");
  assert.doesNotMatch(stopPage, /t\("Save Stop Changes"\)/,
    "completed stops must not expose the mutable operator form");
});

test("assignment, pickup, terminal-state, and post-terminal movement guards stay intact", () => {
  const routeActions = read(files.routeActions);
  const assignment = sourceFunctionBody(routeActions, "assignRoute");
  assert.match(assignment, /rpc\("snacky_route_bag_balances", \{ p_route_id: id \}\)/);
  assert.match(assignment, /Number\(balance\.signed_quantity \?\? 0\) !== 0/);
  assert.doesNotMatch(assignment, /from\("inventory_movements"\)/);
  assert.match(assignment, /already has picked stock/i);

  const migration = read(files.terminalMigration);
  assert.match(migration, /create or replace function public\.snacky_guard_route_inventory_integrity/i);
  assert.match(migration, /create trigger trg_snacky_route_inventory_integrity/i);
  assert.match(migration, /before update[\s\S]*on public\.routes/i);
  assert.match(migration, /from public\._snacky_route_bag_balances\(old\.id\)[\s\S]*signed_quantity <> 0/i);
  assert.match(migration, /to_regclass\('public\.operator_route_custody_leases'\)[\s\S]*where lease\.route_id = \$1/i,
    "reassignment must also wait for the zero-balance lease to receive its audited release proof");
  assert.match(migration, /v_has_custody_lease[\s\S]*or exists \([\s\S]*_snacky_route_bag_balances\(old\.id\)/i);
  assert.match(migration, /create or replace function public\.snacky_guard_terminal_route_inventory_movement/i);
  assert.match(migration, /create trigger trg_snacky_terminal_route_inventory_movement/i);
  assert.match(migration, /before insert or update or delete on public\.inventory_movements/i);
  assert.match(migration, /terminal route bag movements are immutable/i);
  const terminalMovementGuard = compact(sqlFunctionBody(migration, "snacky_guard_terminal_route_inventory_movement"));
  assert.match(terminalMovementGuard, /from public\.routes r where r\.id = old\.related_route_id for share/i);
  assert.match(terminalMovementGuard, /from public\.routes r where r\.id = new\.related_route_id for share/i);
  assert.doesNotMatch(terminalMovementGuard, /for key share/i,
    "route reads must conflict with concurrent non-key status updates");
  assert.doesNotMatch(migration, /drop function[^;]*(snacky_confirm_route_pickup|return_pickup_batch_to_assigned)/i);
  assert.doesNotMatch(migration, /create or replace function public\.snacky_confirm_route_pickup/i);
});

test("terminal reconciliation is idempotent without rewriting historical business rows", () => {
  const terminal = read(files.terminalMigration);
  const stop = read(files.stopMigration);
  const terminalBody = compact(sqlFunctionBody(terminal, "snacky_finalize_route_inventory"));

  assert.match(terminal, /create table if not exists public\.route_inventory_reconciliations/i);
  assert.match(terminal, /client_submission_id text not null/i);
  assert.match(terminal, /payload_hash text not null/i);
  assert.match(terminal, /route_inventory_reconciliations_payload_hash_check[\s\S]*\^\[0-9a-f\]\{32\}\$/i);
  assert.match(terminal, /legacy-route-terminal-reconciliation:/i,
    "an older reconciliation without a reconstructible pre-finalization token must receive a non-replayable marker");
  assert.match(terminal, /unique\s*\(route_id\)/i);
  assert.match(terminal, /unique\s*\(client_submission_id\)/i);
  assert.match(terminalBody, /v_submission_id\s*:=\s*coalesce[\s\S]*p_client_submission_id/i);
  assert.match(terminalBody, /jsonb_agg\([\s\S]*order by count_row\.bag_owner_id nulls first, count_row\.product_id nulls first/i);
  for (const field of ["route_id", "action", "storage_location_id", "counts", "reason", "expected_ledger_token"]) {
    assert.match(terminalBody, new RegExp(`'${field}'`, "i"));
  }
  assert.match(terminalBody, /v_payload_hash := pg_catalog\.md5/i);
  assert.match(terminalBody, /client_submission_id = v_submission_id/i);
  assert.match(terminalBody, /where rec\.route_id = p_route_id/i);
  assert.match(terminalBody, /client_submission_id = v_submission_id[\s\S]*v_existing\.payload_hash is distinct from v_payload_hash[\s\S]*return query[\s\S]*true; return;/i);
  assert.match(terminalBody, /where rec\.route_id = p_route_id[\s\S]*v_existing\.payload_hash is distinct from v_payload_hash[\s\S]*different immutable payload/i);
  assert.match(terminalBody, /insert into public\.route_inventory_reconciliations \([\s\S]*payload_hash[\s\S]*v_payload_hash/i);
  assert.match(terminalBody, /idempotency_key/i);
  assert.match(terminalBody, /on conflict[\s\S]*do nothing/i);
  assert.match(
    terminalBody,
    /where movement\.product_id = v_line\.product_id and \( \( movement\.to_entity_type::text = 'operator_bag' and movement\.to_entity_id = v_line\.bag_owner_id \) or \( movement\.from_entity_type::text = 'operator_bag' and movement\.from_entity_id = v_line\.bag_owner_id \) \)/i,
    "global bag alignment must use the endpoint-owner predicates served by the bag balance indexes",
  );

  for (const [label, source] of [["terminal", terminal], ["stop", stop]]) {
    const outsideFunctions = compact(topLevelSql(source));
    assert.doesNotMatch(source, /\bdo\s+\$\$/i, `${label} migration must not contain a historical repair block`);
    assert.doesNotMatch(outsideFunctions, /insert into public\.(inventory_movements|routes|route_stops|route_stock_lines|refill_order_lines)/i);
    assert.doesNotMatch(outsideFunctions, /update public\.(inventory_movements|routes|route_stops|route_stock_lines|refill_order_lines)/i);
    assert.doesNotMatch(outsideFunctions, /delete from public\.(inventory_movements|routes|route_stops|route_stock_lines|refill_order_lines)/i);
  }
});
