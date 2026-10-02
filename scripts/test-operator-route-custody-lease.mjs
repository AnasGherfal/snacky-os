import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leaseMigrationPath = "supabase/migrations/20260905095000_operator_route_custody_lease.sql";
const bagMigrationPath = "supabase/migrations/20260905094000_operator_bag_debit_concurrency_guard.sql";
const terminalMigrationPath = "supabase/migrations/20260905090000_route_terminal_inventory_reconciliation.sql";
const stopMigrationPath = "supabase/migrations/20260905091000_route_stop_inventory_commit.sql";
const operatorActionsPath = "src/lib/operator-actions.ts";
const adminPickupActionsPath = "src/lib/admin-route-pickup-actions.ts";

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
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
  return compact(body[2]);
}

test("custody lease table is private and unique per operator and route", () => {
  const migration = compact(read(leaseMigrationPath));

  assert.match(migration, /create table if not exists public\.operator_route_custody_leases \([\s\S]*operator_id uuid primary key[\s\S]*route_id uuid not null unique/i);
  assert.match(migration, /operator_id uuid primary key references public\.team_members\(id\) on delete restrict/i);
  assert.match(migration, /route_id uuid not null unique references public\.routes\(id\) on delete restrict/i);
  assert.match(migration, /alter table public\.operator_route_custody_leases enable row level security/i);
  assert.match(migration, /revoke all on table public\.operator_route_custody_leases from public, anon, authenticated/i);
  assert.match(migration, /grant all on table public\.operator_route_custody_leases to service_role/i);
  assert.doesNotMatch(migration, /grant (select|insert|update|delete|all)[\s\S]{0,100}operator_route_custody_leases[\s\S]{0,100}to (anon|authenticated)/i);
  assert.match(migration, /revoke all privileges on table public\.route_pickup_batches from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on table public\.route_pickup_batches to authenticated/i);
  assert.match(migration, /grant all privileges on table public\.route_pickup_batches to service_role/i);
  assert.match(migration, /drop policy if exists "snacky_route_pickup_batches_delete_by_route_access" on public\.route_pickup_batches/i);
  assert.doesNotMatch(migration, /grant[\s\S]{0,80}\b(delete|truncate|references|trigger|maintain)\b[\s\S]{0,80}route_pickup_batches[\s\S]{0,80}to authenticated/i,
    "batch snapshots must not expose destructive, owner-level, or RLS-bypassing table capabilities");
  assert.match(migration, /revoke all privileges on table public\.route_pick_list_items from public, anon, authenticated/i);
  assert.match(migration, /grant select on table public\.route_pick_list_items to authenticated/i);
  assert.match(migration, /grant all privileges on table public\.route_pick_list_items to service_role/i);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all privileges) on table public\.route_pick_list_items to authenticated/i,
    "authenticated clients must not rewrite historical checklist proof rows directly");
});

test("deployment preflight derives endpoint custody, blocks writers, and aborts every ambiguous seed", () => {
  const migration = compact(read(leaseMigrationPath));
  const activeBody = sqlFunctionBody(read(leaseMigrationPath), "_snacky_active_route_custody");

  assert.match(activeBody, /movement\.to_entity_id as operator_id[\s\S]*movement\.quantity::bigint as quantity_delta[\s\S]*to_entity_type = 'operator_bag'::public\.inventory_entity_type/i);
  assert.match(activeBody, /movement\.from_entity_id as operator_id[\s\S]*-movement\.quantity::bigint as quantity_delta[\s\S]*from_entity_type = 'operator_bag'::public\.inventory_entity_type/i);
  assert.match(activeBody, /group by leg\.route_id, leg\.operator_id, leg\.product_id/i);
  assert.match(activeBody, /join public\.routes route_row on route_row\.id = balance\.route_id/i);
  assert.match(activeBody, /where balance\.signed_quantity > 0/i);
  assert.match(activeBody, /route_row\.status::text not in \([\s\S]*'completed'[\s\S]*'cancelled'[\s\S]*\)/i,
    "terminal route history must not become a live custody lease");
  assert.doesNotMatch(activeBody, /signed_quantity <> 0/i,
    "negative legacy balances are discrepancy history, not physical custody claims");

  const routeLockIndex = migration.indexOf("lock table public.routes in share row exclusive mode");
  const batchLockIndex = migration.indexOf("lock table public.route_pickup_batches in access exclusive mode");
  const checklistLockIndex = migration.indexOf("lock table public.route_pick_list_items in share row exclusive mode");
  const movementLockIndex = migration.indexOf("lock table public.inventory_movements in share row exclusive mode");
  const seedIndex = migration.indexOf("insert into public.operator_route_custody_leases", movementLockIndex);
  assert.ok(
    routeLockIndex >= 0
      && batchLockIndex > routeLockIndex
      && checklistLockIndex > batchLockIndex
      && movementLockIndex > checklistLockIndex
      && seedIndex > movementLockIndex,
    "deployment must follow route -> batch -> checklist -> movement runtime lock order and keep writers blocked through seed",
  );
  assert.match(migration, /count\(\*\) filter \(where active\.operator_id is null\) > 0[\s\S]*count\(distinct active\.operator_id\) <> 1/i);
  assert.match(migration, /active\.operator_id is distinct from route_row\.operator_id/i);
  assert.match(migration, /group by active\.operator_id having pg_catalog\.count\(distinct active\.route_id\) > 1/i);
  assert.match(migration, /cross join lateral public\._snacky_route_bag_history_balances\(route_row\.id\) history/i);
  assert.match(migration, /history\.signed_quantity <> 0[\s\S]*route_row\.operator_id is null[\s\S]*history\.bag_owner_id is null[\s\S]*history\.bag_owner_id is distinct from route_row\.operator_id/i,
    "preflight must reject wrong or null owners even when their live-route balance is negative");
  assert.match(migration, /nonterminal route % has nonzero bag history for owner % instead of assigned operator %/i);
  assert.match(migration, /custody lease migration blocked: route % has zero or multiple active bag owners/i);
  assert.match(migration, /custody lease migration blocked: operator % has active stock on multiple routes/i);
  assert.match(migration.slice(seedIndex), /where not exists \([\s\S]*existing_lease\.operator_id = active\.operator_id[\s\S]*existing_lease\.route_id = active\.route_id/i,
    "an exact existing seed may be replayed, while unique constraints still reject conflicting leases");
  assert.doesNotMatch(migration.slice(seedIndex), /on conflict/i,
    "seed conflicts must abort rather than silently preserve an arbitrary lease");
});

test("every route bag mutation is grouped at statement scope from signed endpoint deltas", () => {
  const migration = compact(read(leaseMigrationPath));
  const insertBody = sqlFunctionBody(read(leaseMigrationPath), "snacky_guard_operator_route_custody_insert");
  const updateBody = sqlFunctionBody(read(leaseMigrationPath), "snacky_guard_operator_route_custody_update");
  const deleteBody = sqlFunctionBody(read(leaseMigrationPath), "snacky_guard_operator_route_custody_delete");

  assert.match(migration, /after insert on public\.inventory_movements referencing new table as new_rows for each statement/i);
  assert.match(migration, /after update on public\.inventory_movements referencing old table as old_rows new table as new_rows for each statement/i);
  assert.match(migration, /after delete on public\.inventory_movements referencing old table as old_rows for each statement/i);
  assert.match(migration, /create trigger trg_snacky_00_operator_route_custody_insert/i);
  assert.match(migration, /create trigger trg_snacky_00_operator_route_custody_update/i);
  assert.match(migration, /create trigger trg_snacky_00_operator_route_custody_delete/i);
  assert.match(migration, /drop trigger if exists trg_snacky_operator_route_custody_insert on public\.inventory_movements/i);
  assert.match(migration, /drop trigger if exists trg_snacky_operator_route_custody_update on public\.inventory_movements/i);
  assert.match(migration, /drop trigger if exists trg_snacky_operator_route_custody_delete on public\.inventory_movements/i);
  assert.doesNotMatch(migration, /trg_snacky_00_operator_route_custody_[\s\S]{0,160}for each row/i);

  assert.match(insertBody, /inserted\.to_entity_id as operator_id[\s\S]*inserted\.quantity::bigint as delta_quantity[\s\S]*to_entity_type::text = 'operator_bag'/i);
  assert.match(insertBody, /inserted\.from_entity_id as operator_id[\s\S]*-inserted\.quantity::bigint as delta_quantity[\s\S]*from_entity_type::text = 'operator_bag'/i);
  assert.match(updateBody, /updated\.to_entity_id as operator_id[\s\S]*updated\.quantity::bigint as delta_quantity/i);
  assert.match(updateBody, /updated\.from_entity_id as operator_id[\s\S]*-updated\.quantity::bigint as delta_quantity/i);
  assert.match(updateBody, /previous\.to_entity_id as operator_id[\s\S]*-previous\.quantity::bigint as delta_quantity/i);
  assert.match(updateBody, /previous\.from_entity_id as operator_id[\s\S]*previous\.quantity::bigint as delta_quantity/i);
  assert.match(deleteBody, /removed\.to_entity_id as operator_id[\s\S]*-removed\.quantity::bigint as delta_quantity/i);
  assert.match(deleteBody, /removed\.from_entity_id as operator_id[\s\S]*removed\.quantity::bigint as delta_quantity/i);
  for (const body of [insertBody, updateBody, deleteBody]) {
    assert.doesNotMatch(body, /enters_bag|bool_or/i,
      "lease claims must not depend on one row merely having an incoming endpoint");
  }
  for (const body of [insertBody, updateBody, deleteBody]) {
    assert.match(body, /_snacky_assert_operator_route_custody_touches\(v_touches\)/i);
  }
  for (const body of [insertBody, updateBody]) {
    assert.match(body, /route-related operator-bag movements require an operator endpoint id/i);
  }
});

test("concurrent claims serialize and use authoritative post-statement positive balances", () => {
  const migration = read(leaseMigrationPath);
  const claimBody = sqlFunctionBody(migration, "_snacky_assert_operator_route_custody_touches");

  assert.match(claimBody, /group by touch\.operator_id having pg_catalog\.count\(distinct touch\.route_id\) > 1/i);
  assert.match(claimBody, /group by touch\.route_id, touch\.operator_id[\s\S]*order by touch\.route_id, touch\.operator_id[\s\S]*route_row\.operator_id[\s\S]*for share/i);
  assert.doesNotMatch(claimBody, /for key share/i,
    "route custody reads must conflict with concurrent operator/status updates");
  assert.match(claimBody, /select distinct touch\.operator_id[\s\S]*order by touch\.operator_id[\s\S]*'snacky:operator-custody:'/i);
  assert.match(claimBody, /v_route_operator_id is null or v_route_operator_id is distinct from v_touch\.operator_id/i);
  assert.match(claimBody, /v_route_status in \([\s\S]*'completed'[\s\S]*'cancelled'[\s\S]*terminal route history cannot claim or spend live operator custody/i);
  assert.match(claimBody, /from public\.operator_route_custody_leases lease[\s\S]*for update/i);
  assert.match(claimBody, /v_existing_route_id is distinct from v_touch\.route_id[\s\S]*already carries inventory for another route/i);
  assert.match(claimBody, /select exists \([\s\S]*from public\.inventory_movements movement[\s\S]*group by movement\.product_id[\s\S]*having pg_catalog\.sum\([\s\S]*\) > 0[\s\S]*into v_has_positive_after/i);
  assert.match(claimBody, /elsif v_has_positive_after then insert into public\.operator_route_custody_leases/i);
  assert.doesNotMatch(claimBody, /enters_bag|bool_or/i);
  assert.ok(
    claimBody.indexOf("v_before_balance := v_after_balance - v_touch.delta_quantity")
      < claimBody.indexOf("select exists ( select 1 from public.inventory_movements movement"),
    "route nonnegative validation must finish before a new lease is claimed",
  );

  const claim = (existingRoute, requestedRoute, hasPositiveAfter) => {
    if (existingRoute && existingRoute !== requestedRoute) return "reject";
    if (existingRoute) return existingRoute;
    return hasPositiveAfter ? requestedRoute : null;
  };
  assert.equal(claim(null, "route-a", false), null, "a net-zero multi-row statement must not create a phantom lease");
  assert.equal(claim(null, "route-a", true), "route-a", "a positive post-statement pickup claims the operator");
  assert.equal(claim(null, "route-a", true), "route-a", "removing an old outgoing leg claims custody when it reveals positive stock");
  assert.equal(claim(null, "route-a", false), null, "repairing a legacy negative to zero does not claim physical custody");
  assert.equal(claim("route-a", "route-a", false), "route-a", "zero balance retains the same lease until audited release");
  assert.equal(claim("route-a", "route-b", false), "reject", "every touch fails while the operator carries another route");
});

test("canonical writers lock route, custody, then sorted bag keys", () => {
  const bagBody = sqlFunctionBody(read(bagMigrationPath), "_snacky_assert_operator_bag_balance_changes");
  const terminalBody = sqlFunctionBody(read(terminalMigrationPath), "snacky_finalize_route_inventory");
  const pickupBody = sqlFunctionBody(read(terminalMigrationPath), "return_pickup_batch_to_assigned");
  const stopBody = sqlFunctionBody(read(stopMigrationPath), "snacky_commit_route_stop_inventory_v1");

  for (const [writerName, body] of [
    ["generic bag guard", bagBody],
    ["terminal finalizer", terminalBody],
    ["pickup return", pickupBody],
    ["stop commit", stopBody],
  ]) {
    const custodyIndex = body.indexOf("'snacky:operator-custody:");
    const bagIndex = body.indexOf("'snacky:operator-bag:");
    assert.ok(custodyIndex >= 0 && bagIndex > custodyIndex,
      `${writerName} must acquire custody before any product bag lock`);
  }

  assert.match(bagBody.slice(0, bagBody.indexOf("'snacky:operator-custody:")), /select distinct parsed\.bag_owner_id[\s\S]*order by parsed\.bag_owner_id/i);
  assert.match(bagBody, /group by parsed\.bag_owner_id, parsed\.product_id[\s\S]*order by parsed\.bag_owner_id, parsed\.product_id/i);
  const claimBody = sqlFunctionBody(read(leaseMigrationPath), "_snacky_assert_operator_route_custody_touches");
  const routeRowIndex = claimBody.indexOf("from public.routes route_row");
  const custodyIndex = claimBody.indexOf("'snacky:operator-custody:");
  assert.ok(routeRowIndex >= 0 && custodyIndex > routeRowIndex,
    "generic route movements must lock their route row before operator custody");
  assert.ok("trg_snacky_00_operator_route_custody_insert" < "trg_snacky_operator_bag_balance_insert",
    "Postgres alphabetical AFTER-trigger order must claim route/custody before adding product bag locks");
});

test("lease release requires zero route custody plus terminal or exact pristine-return proof", () => {
  const migration = compact(read(leaseMigrationPath));
  const releaseBody = sqlFunctionBody(read(leaseMigrationPath), "_snacky_release_operator_route_custody");
  const pickupReturnBody = sqlFunctionBody(read(terminalMigrationPath), "return_pickup_batch_to_assigned");

  assert.match(releaseBody, /p_proof not in \('terminal_reconciliation', 'pristine_pickup_return'\)/i);
  assert.ok(releaseBody.indexOf("from public.routes route_row") < releaseBody.indexOf("'snacky:operator-custody:"),
    "release must lock/validate the route row before operator custody");
  assert.match(releaseBody, /from public\.routes route_row[\s\S]*for share/i);
  assert.match(releaseBody, /from public\.route_pickup_batches batch_row[\s\S]*for share/i);
  assert.doesNotMatch(releaseBody, /for key share/i);
  assert.match(releaseBody, /from public\._snacky_route_bag_balances\(p_route_id\)[\s\S]*signed_quantity <> 0[\s\S]*cannot be released while its operator-bag balance is nonzero/i);
  assert.match(releaseBody, /reconciliation\.route_status_after = v_route\.status[\s\S]*reconciliation\.status in \('balanced', 'needs_review'\)/i);
  assert.match(releaseBody, /terminal route custody requires its matching inventory reconciliation/i);
  assert.match(releaseBody, /v_batch\.status <> 'cancelled'[\s\S]*v_batch\.returned_to_assigned_at is null[\s\S]*v_batch\.storage_deducted/i);
  assert.match(releaseBody, /reversal\.reversed_movement_id = pickup\.id[\s\S]*reversal\.source_type = 'route_pickup_return'[\s\S]*reversal\.source_id = p_pickup_batch_id/i);
  assert.match(releaseBody, /v_pickup_count <> v_reversal_count[\s\S]*v_return_source_count <> v_reversal_count[\s\S]*v_pickup_quantity <> v_reversal_quantity/i);
  assert.match(releaseBody, /movement\.related_route_id = p_route_id and not coalesce\(\([\s\S]*\), false\)/i,
    "null provenance fields must fail the exact pristine-movement allowlist");
  assert.match(releaseBody, /route contains inventory activity outside the pristine pickup and its exact return/i);
  assert.match(releaseBody, /field activity exists, so this pickup is not pristine/i);
  const deleteIndex = releaseBody.indexOf("delete from public.operator_route_custody_leases");
  assert.ok(deleteIndex > releaseBody.indexOf("pristine pickup reversal evidence"),
    "the lease may be deleted only after every proof check");

  assert.match(migration, /after update of status on public\.routes for each row when \(old\.status is distinct from new\.status\)/i);
  assert.match(migration, /drop trigger if exists trg_snacky_release_pristine_pickup_custody on public\.route_pickup_batches/i);
  assert.match(migration, /drop function if exists public\.snacky_release_pristine_pickup_custody\(\)/i);
  assert.doesNotMatch(migration, /create trigger trg_snacky_release_pristine_pickup_custody/i,
    "batch AFTER work must not invert the canonical route-to-batch lock order");
  const batchUpdate = pickupReturnBody.indexOf("update public.route_pickup_batches batch_row");
  const explicitRelease = pickupReturnBody.indexOf("_snacky_release_operator_route_custody", batchUpdate);
  const routeUpdate = pickupReturnBody.indexOf("update public.routes r", batchUpdate);
  assert.ok(batchUpdate >= 0 && explicitRelease > batchUpdate && routeUpdate > explicitRelease,
    "pristine return must save its batch proof, explicitly release custody, then update route status");
  assert.match(pickupReturnBody, /'pristine_pickup_return'[\s\S]*p_pickup_batch_id/i);
});

test("pickup confirmation atomically owns finalized batch and checklist evidence", () => {
  const migration = compact(read(leaseMigrationPath));
  const terminalMigration = read(terminalMigrationPath);
  const terminalBody = sqlFunctionBody(terminalMigration, "snacky_finalize_route_inventory");
  const returnBody = sqlFunctionBody(terminalMigration, "return_pickup_batch_to_assigned");
  const wrapperBody = sqlFunctionBody(read(leaseMigrationPath), "snacky_confirm_route_pickup_batch_v3");
  const guardBody = sqlFunctionBody(read(leaseMigrationPath), "snacky_guard_route_pickup_batch_audit");
  const operatorActions = compact(read(operatorActionsPath));
  const adminActions = compact(read(adminPickupActionsPath));

  assert.match(wrapperBody, /set_config\( 'snacky\.route_pickup_batch_write_mode', 'confirm', true \)[\s\S]*from public\.snacky_confirm_route_pickup_batch_v2\(/i);
  assert.match(wrapperBody, /update public\.route_pick_list_items as pick_item set is_checked = coalesce\(submitted\.is_checked, false\)[\s\S]*checked_at = case[\s\S]*then pick_item\.checked_at[\s\S]*checked_by = case[\s\S]*then pick_item\.checked_by[\s\S]*jsonb_to_recordset\( coalesce\(p_pick_list_rows, '\[\]'::jsonb\) \)/i,
    "checked state must be committed by the same security-definer pickup RPC as inventory");
  assert.match(wrapperBody, /pick_item\.is_checked is distinct from coalesce\(submitted\.is_checked, false\)/i,
    "an exact checked-state match must not refresh checklist evidence timestamps");
  assert.ok(
    wrapperBody.indexOf("from public.snacky_confirm_route_pickup_batch_v2(")
      < wrapperBody.indexOf("update public.route_pick_list_items as pick_item"),
    "the wrapper must persist checklist evidence before returning the committed pickup result",
  );
  assert.match(migration, /revoke all on function public\.snacky_confirm_route_pickup_batch_v2\([\s\S]*\) from public, anon, authenticated, service_role/i,
    "callers must not bypass the marked V3 wrapper through V2");
  assert.match(migration, /grant execute on function public\.snacky_confirm_route_pickup_batch_v3\([\s\S]*\) to authenticated, service_role/i);

  const normalizedMigration = migration.replace(/\s+/g, "").toLowerCase();
  const retiredPickupSignatures = [
    "public.confirm_route_pickup_batch(uuid,public.route_status,public.route_status,timestamptz,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[],uuid[])",
    "public.confirm_route_pickup_batch(uuid,public.route_status,public.route_status,timestamptz,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[])",
    "public.confirm_route_pickup_batch_core(uuid,public.route_status,public.route_status,timestamptz,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[])",
    "public.confirm_route_pickup_batch_core(uuid,public.route_status,public.route_status,timestamptz,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[],uuid[])",
  ];
  for (const signature of retiredPickupSignatures) {
    assert.ok(
      normalizedMigration.includes(
        `revokeallonfunction${signature}frompublic,anon,authenticated,service_role;`,
      ),
      `${signature} must not remain directly executable by any API role`,
    );
  }
  const pickupExecuteGrants = migration.split(";").filter((statement) =>
    /grant execute on function public\.(?:snacky_)?confirm_route_pickup_batch(?:_core|_v[23])?\s*\(/i.test(statement)
  );
  assert.equal(pickupExecuteGrants.length, 1,
    "V3 must be the only pickup-confirmation function granted to API roles by this migration");
  assert.match(pickupExecuteGrants[0], /public\.snacky_confirm_route_pickup_batch_v3[\s\S]*to authenticated, service_role/i);
  assert.doesNotMatch(migration, /drop function(?: if exists)? public\.(?:confirm_route_pickup_batch|confirm_route_pickup_batch_core|snacky_confirm_route_pickup_batch_v2)\s*\(/i,
    "internal implementations must remain available to their security-definer owner chain");
  assert.match(migration, /select pg_catalog\.pg_notify\('pgrst', 'reload schema'\);\s*$/i,
    "PostgREST must discover V3 in the same deployed migration");
  assert.match(migration, /add column if not exists confirmation_payload_hash text[\s\S]*add column if not exists confirmation_result jsonb/i);
  assert.match(migration, /route_pickup_batches_confirmation_receipt_pair_check[\s\S]*\(confirmation_payload_hash is null\) = \(confirmation_result is null\)/i);
  assert.match(wrapperBody, /item\.value - array\[ 'created_at', 'updated_at', 'checked_at', 'confirmed_at', 'prepared_at', 'started_at' \]::text\[[\s\S]*v_payload_hash := pg_catalog\.md5\([\s\S]*selected_machine_ids/i,
    "the receipt hash must cover stable business payloads while removing dynamic timestamps");
  assert.match(wrapperBody, /from public\.route_pickup_batches batch_row[\s\S]*for update[\s\S]*confirmation_payload_hash is distinct from v_payload_hash[\s\S]*retry payload does not match the committed receipt/i);
  assert.ok(
    wrapperBody.indexOf("v_existing_batch.confirmation_payload_hash is not null")
      < wrapperBody.indexOf("from public.snacky_confirm_route_pickup_batch_v2("),
    "an exact receipt retry must return before V2 revalidates changed route/stop state",
  );
  assert.match(wrapperBody, /legacy finalized pickup batch has no retry receipt; manual review is required/i);
  assert.match(wrapperBody, /atomic pickup confirmation returned no result[\s\S]*v_pickup_batch_id is distinct from v_request_batch_id[\s\S]*v_route_status is null[\s\S]*v_pending_stop_count is null[\s\S]*invalid receipt result/i,
    "a malformed first V2 result must roll back before any receipt can be stored");
  assert.match(wrapperBody, /update public\.route_pickup_batches batch_row set confirmation_payload_hash = v_payload_hash, confirmation_result = v_confirmation_result[\s\S]*pickup confirmation receipt could not be stored atomically/i);
  assert.match(wrapperBody, /with storage_product_keys as \([\s\S]*from_entity_type = 'storage'[\s\S]*union[\s\S]*to_entity_type = 'storage'[\s\S]*order by key_row\.storage_id, key_row\.product_id[\s\S]*pg_advisory_xact_lock\( pg_catalog\.hashtext\(v_storage_lock\.product_id::text\), pg_catalog\.hashtext\(v_storage_lock\.storage_id::text\)/i);
  assert.ok(
    wrapperBody.indexOf("order by key_row.storage_id, key_row.product_id")
      < wrapperBody.indexOf("from public.snacky_confirm_route_pickup_batch_v2("),
    "all storage/product locks must be held in canonical order before V2's unordered re-locks",
  );

  assert.match(guardBody, /tg_op = 'insert'[\s\S]*new\.status = 'draft'[\s\S]*v_mode = 'confirm'[\s\S]*new\.status = 'confirmed'/i);
  assert.match(guardBody, /tg_op = 'update'[\s\S]*pickup batch identity and creation evidence are immutable/i);
  assert.match(guardBody, /v_mode = 'confirm'[\s\S]*old\.status = 'confirmed'[\s\S]*return old/i,
    "a confirmation retry must preserve the original finalized snapshot");
  assert.match(guardBody, /old\.confirmation_payload_hash is null[\s\S]*new\.confirmation_payload_hash ~ '\^\[0-9a-f\]\{32\}\$'[\s\S]*jsonb_typeof\(new\.confirmation_result\) = 'object'[\s\S]*return new/i,
    "V3 must be able to install exactly one receipt after V2 succeeds");
  assert.match(guardBody, /old\.status = 'draft'[\s\S]*old\.prepared_at is not null[\s\S]*old\.prepared_by is not null[\s\S]*new\.selected_stop_ids is not distinct from old\.selected_stop_ids[\s\S]*new\.product_summary is not distinct from old\.product_summary/i,
    "confirmation must preserve the authoritative prepared snapshot");
  assert.match(guardBody, /v_mode = 'pristine_return'[\s\S]*old\.status = 'confirmed'[\s\S]*new\.status = 'cancelled'[\s\S]*returned_to_assigned_at is not null/i);
  assert.match(guardBody, /v_mode = 'route_cancel'[\s\S]*new\.status = 'cancelled'[\s\S]*confirmed_at is not distinct from old\.confirmed_at/i);
  assert.match(guardBody, /tg_op = 'delete'[\s\S]*old\.status = 'draft'[\s\S]*confirmed and returned pickup batches cannot be deleted/i);
  assert.match(migration, /before insert on public\.route_pickup_batches[\s\S]*execute function public\.snacky_guard_route_pickup_batch_audit\(\)/i);
  assert.match(migration, /before update on public\.route_pickup_batches[\s\S]*execute function public\.snacky_guard_route_pickup_batch_audit\(\)/i);
  assert.match(migration, /before delete on public\.route_pickup_batches[\s\S]*execute function public\.snacky_guard_route_pickup_batch_audit\(\)/i);

  assert.match(terminalBody, /set_config\( 'snacky\.route_pickup_batch_write_mode', 'route_cancel', true \)[\s\S]*update public\.route_pickup_batches[\s\S]*set_config\( 'snacky\.route_pickup_batch_write_mode', '', true \)/i);
  assert.match(returnBody, /set_config\( 'snacky\.route_pickup_batch_write_mode', 'pristine_return', true \)[\s\S]*update public\.route_pickup_batches[\s\S]*set_config\( 'snacky\.route_pickup_batch_write_mode', '', true \)/i);

  assert.match(operatorActions, /const pickuprpcargs = \{[\s\S]*p_pick_list_rows: picklistrows[\s\S]*supabase\.rpc\("snacky_confirm_route_pickup_batch_v3", \{ \.\.\.pickuprpcargs/i);
  assert.match(adminActions, /supabase\.rpc\("snacky_confirm_route_pickup_batch_v3", payload\.rpcargs\)/i);
  assert.doesNotMatch(`${operatorActions} ${adminActions}`, /supabase\.rpc\("snacky_confirm_route_pickup_batch_v2"/i,
    "all application pickup writers must use the marked atomic wrapper");
  assert.doesNotMatch(operatorActions, /from\("route_pickup_batches"\)\.update\(/i,
    "the client must not repeat batch finalization after the atomic RPC commits");
  assert.doesNotMatch(operatorActions, /from\("route_pick_list_items"\)\.update\(/i,
    "the client must not perform a fallible checklist write after inventory commits");
  assert.doesNotMatch(operatorActions, /pickup was confirmed, but (the prepared batch|checklist state)/i,
    "a committed pickup must never be returned to the operator as a false failure");
});

test("pickup confirmation receipt makes lost-response retries deterministic", () => {
  const commitOrReplay = ({ receiptHash, receiptResult }, requestHash, nextResult) => {
    if (receiptHash !== null) {
      if (receiptHash !== requestHash) return { outcome: "conflict" };
      return { outcome: "replay", result: receiptResult };
    }
    return {
      outcome: "commit",
      result: nextResult,
      receiptHash: requestHash,
      receiptResult: nextResult,
    };
  };

  const originalResult = {
    pickup_batch_id: "batch-a",
    route_status: "pickup_confirmed",
    picked_stop_ids: ["stop-a"],
    pending_stop_count: 0,
  };
  const first = commitOrReplay({ receiptHash: null, receiptResult: null }, "hash-a", originalResult);
  assert.equal(first.outcome, "commit");
  const exactRetry = commitOrReplay(
    { receiptHash: first.receiptHash, receiptResult: first.receiptResult },
    "hash-a",
    { ...originalResult, pending_stop_count: 99 },
  );
  assert.deepEqual(exactRetry, { outcome: "replay", result: originalResult },
    "a lost response returns the original stored result without rerunning inventory");
  assert.deepEqual(
    commitOrReplay({ receiptHash: first.receiptHash, receiptResult: first.receiptResult }, "hash-b", originalResult),
    { outcome: "conflict" },
    "the same batch id can never replay with changed quantities or products",
  );
});

test("all lease helpers are internal security-definer functions", () => {
  const migration = compact(read(leaseMigrationPath));
  const internalSignatures = [
    "_snacky_active_route_custody()",
    "_snacky_assert_operator_route_custody_touches(jsonb)",
    "_snacky_release_operator_route_custody(uuid, uuid, text, uuid)",
    "snacky_guard_operator_route_custody_insert()",
    "snacky_guard_operator_route_custody_update()",
    "snacky_guard_operator_route_custody_delete()",
    "snacky_release_terminal_route_custody()",
    "snacky_guard_route_pickup_batch_audit()",
  ];

  const securityDefinerDefinitions = migration.match(/language (?:sql|plpgsql)(?: stable| volatile)? security definer/gi) ?? [];
  assert.equal(securityDefinerDefinitions.length, internalSignatures.length + 1,
    "only the eight internal helpers plus the authenticated V3 wrapper may be security definer");
  assert.equal((migration.match(/set search_path = ''/gi) ?? []).length, internalSignatures.length + 1);
  for (const signature of internalSignatures) {
    const compactSignature = signature.replace(/\s+/g, "");
    const revoke = migration.split(";").find((statement) =>
      /revoke all on function/i.test(statement)
      && statement.replace(/\s+/g, "").includes(compactSignature));
    assert.ok(revoke, `${signature} must have an explicit privilege revoke`);
    assert.match(revoke, /from public, anon, authenticated/i);
  }
});
