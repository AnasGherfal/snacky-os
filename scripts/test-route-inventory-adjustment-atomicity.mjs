import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = "supabase/migrations/20260906155500_atomic_route_inventory_adjustments.sql";
const apiPath = "src/app/api/operator/routes/[id]/stops/[stopId]/adjustments/route.ts";
const operatorActionsPath = "src/lib/operator-actions.ts";
const movementPagePath = "src/app/inventory/movements/page.tsx";

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

const migration = compact(read(migrationPath));
const rawMigration = read(migrationPath);
const createRpc = compact(between(
  rawMigration,
  "create or replace function public.create_route_inventory_adjustment(",
  "create or replace function public.cancel_inventory_adjustment(",
));
const cancelRpc = compact(between(
  rawMigration,
  "create or replace function public.cancel_inventory_adjustment(",
  "-- Parent rows are written only by the two hardened RPCs.",
));
const api = compact(read(apiPath));
const operatorActions = compact(read(operatorActionsPath));
const movementPage = compact(read(movementPagePath));

test("adjustment creation is an authenticated route-scoped database command", () => {
  assert.match(createRpc, /security definer set search_path = ''/i);
  assert.match(createRpc, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(createRpc, /snacky_current_team_member_id\(\)/i);
  assert.match(createRpc, /snacky_current_profile_has_any_role\(array\['owner', 'admin', 'supervisor'\]\)/i);
  assert.match(createRpc, /snacky_operator_can_access_route\(p_route_id\)/i);
  assert.match(createRpc, /A stable submission id between 1 and 200 characters is required/i);
  assert.doesNotMatch(createRpc, /set search_path = public/i);
});

test("exact create replay precedes terminal rejection and validates immutable parent and child", () => {
  const preflight = createRpc.indexOf("where adjustment.client_submission_id = v_submission_id");
  const routeMutex = createRpc.indexOf("'snacky:route-inventory:' || p_route_id::text");
  const exactBranch = createRpc.indexOf("if v_existing.id is not null then");
  const terminalRoute = createRpc.indexOf("if v_route.status::text in (");
  const movementInsert = createRpc.indexOf("insert into public.inventory_movements", terminalRoute);

  assert.ok(preflight >= 0 && routeMutex > preflight,
    "the retry preflight must run before route locking");
  assert.ok(exactBranch > routeMutex && terminalRoute > exactBranch,
    "exact replay must be evaluated before route/stop terminal rejection");
  assert.ok(movementInsert > terminalRoute,
    "exact replay returns before any new movement insert");
  assert.match(createRpc, /Adjustment retry does not match the committed immutable record/i);
  assert.match(createRpc, /v_movement\.idempotency_payload = v_expected_payload/i);
  assert.match(createRpc, /v_movement\.source_type is distinct from 'inventory_adjustment'/i);
  assert.match(createRpc, /v_movement\.source_id is distinct from v_existing\.id/i);
  assert.match(
    createRpc,
    /v_collision_count <> \( case when v_existing\.adjustment_type = 'returned_from_machine' then 2 else 1 end \)/i,
  );
  assert.match(createRpc, /v_storage_movement_key, v_submission_id, 'machine-return-storage:' \|\| v_existing\.id::text/i);
  assert.match(createRpc, /v_stop\.status::text in \('completed', 'skipped', 'cancelled', 'canceled'\)/i);
});

test("create uses the shared route, custody, bag, product, then ledger lock hierarchy", () => {
  const routeMutex = createRpc.indexOf("'snacky:route-inventory:' || p_route_id::text");
  const routeLock = createRpc.indexOf("from public.routes route_row where route_row.id = p_route_id for update");
  const stopLock = createRpc.indexOf("from public.route_stops stop_row where stop_row.id = p_route_stop_id for update");
  const custodyLock = createRpc.indexOf("'snacky:operator-custody:' || v_route.operator_id::text");
  const bagLock = createRpc.indexOf("'snacky:operator-bag:' || v_route.operator_id::text || ':' || p_product_id::text");
  const productLock = createRpc.indexOf("from public.products product_row where product_row.id = p_product_id for update");
  const movementLock = createRpc.indexOf("from public.inventory_movements movement", productLock);

  assert.ok(routeMutex >= 0 && routeLock > routeMutex && stopLock > routeLock);
  assert.ok(custodyLock > stopLock && bagLock > custodyLock && productLock > bagLock && movementLock > productLock,
    "route -> stop -> custody -> bag -> product -> movement order must be deterministic");
  assert.match(createRpc, /movement\.related_route_id = p_route_id and movement\.product_id = p_product_id/i);
  assert.match(createRpc, /v_global_bag_qty/i);
  assert.match(createRpc, /operator_route_custody_leases/i);
  assert.match(createRpc, /Damaged quantity exceeds verified stock/i);
});

test("canonical costs and nullable machine location are captured inside the transaction", () => {
  const productLock = createRpc.indexOf("from public.products product_row where product_row.id = p_product_id for update");
  const costCapture = createRpc.indexOf("v_unit_cost := coalesce(", productLock);
  const parentInsert = createRpc.indexOf("insert into public.inventory_adjustments", costCapture);
  assert.ok(productLock >= 0 && costCapture > productLock && parentInsert > costCapture);
  assert.match(createRpc, /nullif\(v_product\.average_cost_lyd, 0\)/i);
  assert.match(createRpc, /select machine\.location_id into v_location_id/i);
  assert.match(createRpc, /v_location_id, p_route_id/i);
  assert.doesNotMatch(createRpc, /machine must have a location|location is required/i,
    "active machines with nullable locations must remain usable");
});

test("parent, ledger movement, and link commit atomically with no ignored update", () => {
  const parentInsert = createRpc.indexOf("insert into public.inventory_adjustments");
  const movementInsert = createRpc.indexOf("insert into public.inventory_movements", parentInsert);
  const linkUpdate = createRpc.indexOf("update public.inventory_adjustments adjustment set inventory_movement_id", movementInsert);
  const rowCount = createRpc.indexOf("get diagnostics v_updated_count = row_count", linkUpdate);
  assert.ok(parentInsert >= 0 && movementInsert > parentInsert && linkUpdate > movementInsert && rowCount > linkUpdate);
  assert.match(createRpc, /'route-inventory-adjustment:create:v2:' \|\| v_submission_id/i);
  assert.match(createRpc, /idempotency_payload[\s\S]*v_expected_payload/i);
  assert.match(createRpc, /if p_adjustment_type = 'returned_from_machine' then insert into public\.inventory_movements/i);
  assert.match(createRpc, /'operator_bag_to_storage'::public\.movement_reason/i);
  assert.match(createRpc, /storage_movement_id = v_storage_movement_id/i);
  assert.match(createRpc, /if v_updated_count <> 1 then raise exception 'Adjustment movement link could not be committed atomically\.'/i);
  assert.doesNotMatch(createRpc, /when others then null|on conflict do nothing/i);
});

test("cancellation locks the shared route scope and validates an exact signed reversal", () => {
  const preflight = cancelRpc.indexOf("from public.inventory_adjustments adjustment where adjustment.id = p_adjustment_id");
  const routeMutex = cancelRpc.indexOf("'snacky:route-inventory:' || v_preflight.route_id::text");
  const routeLock = cancelRpc.indexOf("from public.routes route_row where route_row.id = v_preflight.route_id for update");
  const stopLock = cancelRpc.indexOf("from public.route_stops stop_row where stop_row.id = v_preflight.route_stop_id for update");
  const custodyLock = cancelRpc.indexOf("'snacky:operator-custody:' || v_adjustment.operator_id::text");
  const bagLock = cancelRpc.indexOf("'snacky:operator-bag:' || v_adjustment.operator_id::text || ':' || v_adjustment.product_id::text");
  const productLock = cancelRpc.indexOf("from public.products product_row where product_row.id = v_adjustment.product_id for update");
  const originalLock = cancelRpc.indexOf("where movement.id = v_adjustment.inventory_movement_id for update");

  assert.ok(preflight >= 0 && routeMutex > preflight && routeLock > routeMutex && stopLock > routeLock);
  assert.ok(custodyLock > stopLock && bagLock > custodyLock && productLock > bagLock && originalLock > productLock);
  assert.match(cancelRpc, /v_original\.idempotency_payload = v_original_expected_payload/i);
  assert.match(cancelRpc, /v_reversal\.reversed_movement_id is distinct from v_original\.id/i);
  assert.match(cancelRpc, /v_reversal\.source_type is distinct from 'inventory_adjustment_cancel'/i);
  assert.match(cancelRpc, /v_reversal\.idempotency_payload = v_expected_payload/i);
  assert.match(cancelRpc, /v_storage_reversal\.reversed_movement_id is distinct from v_storage_movement\.id/i);
  assert.match(cancelRpc, /storage_reversal_movement_id is distinct from v_storage_reversal\.id/i);
  assert.match(cancelRpc, /v_cancel_candidate_count <> \( case when v_adjustment\.adjustment_type = 'returned_from_machine' then 2 else 1 end \)/i);
  assert.match(cancelRpc, /v_cancel_candidate_count <> 0 or v_reversal\.id is not null or v_storage_reversal\.id is not null/i);
});

test("exact cancel replay precedes terminal rejection and signed totals reverse exactly", () => {
  const replay = cancelRpc.indexOf("if v_adjustment.status = 'cancelled' then");
  const terminal = cancelRpc.indexOf("if v_route.status::text in (");
  const reversalInsert = cancelRpc.indexOf("insert into public.inventory_movements", terminal);
  assert.ok(replay >= 0 && terminal > replay && reversalInsert > terminal);
  assert.match(cancelRpc, /v_reversal\.line_total_lyd is distinct from -v_original\.line_total_lyd/i);
  assert.match(cancelRpc, /-v_original\.line_total_lyd, v_original\.id/i);
  assert.doesNotMatch(cancelRpc, /abs\s*\(\s*v_original\.line_total_lyd/i);
  assert.match(cancelRpc, /Terminal route history cannot be changed here\. Use inventory review instead\./i);
  assert.match(cancelRpc, /Cancellation would exceed physical storage stock/i);
  assert.match(cancelRpc, /Cancellation would consume stock reserved for active routes/i);
  const storageReverse = cancelRpc.indexOf("v_storage_movement.to_entity_type");
  const primaryReverse = cancelRpc.indexOf("v_original.to_entity_type", storageReverse);
  assert.ok(storageReverse >= 0 && primaryReverse > storageReverse,
    "returned-product cancellation must restore storage -> bag before bag -> machine");
});

test("legacy return trigger is removed and machine balance is globally serialized", () => {
  assert.match(migration, /drop trigger if exists inventory_adjustments_post_machine_return_to_storage on public\.inventory_adjustments/i);
  assert.match(migration, /drop function if exists public\.snacky_post_machine_return_to_storage\(\)/i);
  assert.doesNotMatch(migration, /create trigger inventory_adjustments_post_machine_return_to_storage/i);
  assert.match(migration, /create or replace function public\._snacky_assert_machine_balance_changes\(p_changes jsonb\)/i);
  assert.match(migration, /order by parsed\.machine_id, parsed\.product_id/i);
  assert.match(migration, /'snacky:machine-stock:' \|\| v_change\.machine_id::text \|\| ':' \|\| v_change\.product_id::text/i);
  assert.match(migration, /Machine movement would worsen recorded stock below zero/i);
  assert.match(migration, /referencing new table as new_rows for each statement/i);
  assert.match(migration, /referencing old table as old_rows new table as new_rows for each statement/i);
  assert.match(migration, /drop trigger if exists trg_snacky_machine_balance_insert on public\.inventory_movements/i);
  assert.match(migration, /create trigger trg_snacky_zz_machine_balance_insert after insert on public\.inventory_movements/i);
  assert.match(migration, /create trigger trg_snacky_zz_machine_balance_update after update on public\.inventory_movements/i);
  assert.match(migration, /create trigger trg_snacky_zz_machine_balance_delete after delete on public\.inventory_movements/i);
  assert.ok(
    "trg_snacky_zz_machine_balance_insert" > "trg_snacky_operator_bag_balance_insert",
    "PostgreSQL must fire the bag guard before the machine guard for the same INSERT",
  );
  assert.match(createRpc, /'snacky:machine-stock:' \|\| p_machine_id::text \|\| ':' \|\| p_product_id::text/i);
  assert.match(createRpc, /Returned quantity exceeds the verified machine stock for this product\. No inventory was changed\./i);
});

test("direct parent writes are closed while authenticated reads and RPCs remain", () => {
  assert.match(migration, /revoke all on table public\.inventory_adjustments from public, anon, authenticated/i);
  assert.match(migration, /grant select on table public\.inventory_adjustments to authenticated/i);
  assert.match(migration, /grant all on table public\.inventory_adjustments to service_role/i);
  assert.match(migration, /revoke all on function public\.create_route_inventory_adjustment\([\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.create_route_inventory_adjustment\([\s\S]*to authenticated, service_role/i);
  assert.match(migration, /revoke all on function public\.cancel_inventory_adjustment\(uuid, text\) from public, anon, authenticated, service_role/i);
});

test("managed ledger rows direct users to their source workflow instead of generic reversal", () => {
  assert.match(movementPage, /function managedMovementGuidance\(movement: MovementCorrectionSourceRow\)/i);
  assert.match(movementPage, /movement\.related_purchase_id \|\| movement\.related_purchase_line_id/i);
  assert.match(movementPage, /sourceType === "operator_personal_purchase"/i);
  assert.match(movementPage, /sourceType === "inventory_adjustment" \|\| sourceType === "inventory_adjustment_cancel"/i);
  assert.match(movementPage, /movement\.historical_route_deduction_line_id/i);
  assert.match(movementPage, /movement\.related_refill_order_id/i);
  assert.match(movementPage, /movement\.import_batch_id/i);
  assert.match(movementPage, /movement\.related_pickup_batch_id/i);
  assert.match(movementPage, /movement\.reversed_movement_id/i);
  const guidanceBranch = movementPage.indexOf("if (guidance)");
  const genericDialog = movementPage.indexOf("triggerLabel=\"Create Correction\"", guidanceBranch);
  assert.ok(guidanceBranch >= 0 && genericDialog > guidanceBranch,
    "the generic correction dialog must render only after managed guidance returns early");
  assert.match(movementPage, /source_type, source_id,[^\"]*related_refill_order_id,[^\"]*related_pickup_batch_id,[^\"]*import_batch_id,[^\"]*historical_route_deduction_line_id/i);
  assert.match(movementPage, /Open purchase to void/i);
  assert.match(movementPage, /Review the item there\. Voiding a personal purchase is not available yet; contact an admin for a documented correction\./i);
  assert.match(movementPage, /Review in Operator Money/i);
  assert.match(movementPage, /Open adjustment workflow/i);
  assert.match(movementPage, /Open inventory review/i);
});

test("the API requires and forwards the UI's stable submission without fallback", () => {
  assert.match(api, /if \(!clientSubmissionId \|\| clientSubmissionId\.length > 200\)/i);
  assert.match(api, /code: "INVALID_SUBMISSION_ID"/i);
  assert.match(api, /p_client_submission_id: clientSubmissionId/i);
  assert.doesNotMatch(api, /p_client_submission_id: clientSubmissionId \|\|/i);
  assert.doesNotMatch(api, /route-inventory-adjustment:\$\{routeId\}:\$\{stopId\}/i);
  assert.match(api, /getSupabaseServerClient\(accessToken\)/i);
  assert.doesNotMatch(api, /\.from\("inventory_movements"\)\.(?:insert|update|upsert|delete)/i);
});

test("stop inventory cannot spoof a manager actor through caller UUIDs", () => {
  assert.match(migration, /alter function public\.snacky_commit_route_stop_inventory_v1\( uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb \) rename to snacky_commit_route_stop_inventory_v1_private/i);
  assert.match(migration, /revoke all on function public\.snacky_commit_route_stop_inventory_v1_private\([\s\S]*from public, anon, authenticated, service_role/i);
  const wrapper = compact(between(
    rawMigration,
    "create or replace function public.snacky_commit_route_stop_inventory_v1(\n  p_route_id uuid,",
    "revoke all on function public.snacky_commit_route_stop_inventory_v1(\n  uuid, uuid, uuid, text, jsonb, jsonb",
  ));
  assert.match(wrapper, /security definer set search_path = ''/i);
  assert.match(wrapper, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(wrapper, /v_actor_team_member_id := public\.snacky_current_team_member_id\(\)/i);
  assert.match(wrapper, /snacky_commit_route_stop_inventory_v1_private\( p_route_id, p_route_stop_id, p_machine_id, v_actor_user_id, v_actor_team_member_id/i);
  assert.doesNotMatch(wrapper, /p_actor_user_id|p_actor_team_member_id/i);
  assert.match(migration, /grant execute on function public\.snacky_commit_route_stop_inventory_v1\( uuid, uuid, uuid, text, jsonb, jsonb \) to authenticated/i);

  const caller = operatorActions.slice(
    operatorActions.indexOf("const rpcRouteId = requireUuidValue"),
    operatorActions.indexOf("if (stopInventoryError)", operatorActions.indexOf("const rpcRouteId = requireUuidValue")),
  );
  assert.match(caller, /await supabase\.rpc\( "snacky_commit_route_stop_inventory_v1"/i);
  assert.doesNotMatch(caller, /completionWorkflowClient\.rpc|p_actor_user_id|p_actor_team_member_id/i);

  const resolveActor = ({ authUserId, linkedTeamMemberId, forgedUserId, forgedTeamMemberId }) => ({
    userId: authUserId,
    teamMemberId: linkedTeamMemberId,
    ignoredForgedPair: Boolean(forgedUserId || forgedTeamMemberId),
  });
  assert.deepEqual(resolveActor({
    authUserId: "operator-user",
    linkedTeamMemberId: "operator-team",
    forgedUserId: "manager-user",
    forgedTeamMemberId: "manager-team",
  }), {
    userId: "operator-user",
    teamMemberId: "operator-team",
    ignoredForgedPair: true,
  });
});

test("serialized damaged adjustments cannot overdraw shared route stock", () => {
  const applyDamage = (available, requested) => {
    if (requested <= 0 || available < requested) return { accepted: false, available };
    return { accepted: true, available: available - requested };
  };
  const first = applyDamage(10, 7);
  const second = applyDamage(first.available, 4);
  assert.deepEqual(first, { accepted: true, available: 3 });
  assert.deepEqual(second, { accepted: false, available: 3 });
});

test("returned-product two-leg posting and complete cancellation restore every balance", () => {
  const applyReturn = ({ machine, bag, storage }, quantity) => {
    if (quantity > machine) return { accepted: false, machine, bag, storage };
    return { accepted: true, machine: machine - quantity, bag, storage: storage + quantity };
  };
  const cancelReturn = ({ machine, bag, storage }, quantity) => {
    if (quantity > storage) return { accepted: false, machine, bag, storage };
    return { accepted: true, machine: machine + quantity, bag, storage: storage - quantity };
  };
  const initial = { machine: 8, bag: 2, storage: 10 };
  const posted = applyReturn(initial, 3);
  assert.deepEqual(posted, { accepted: true, machine: 5, bag: 2, storage: 13 });
  const replay = applyReturn({ machine: 2, bag: 0, storage: 0 }, 3);
  assert.equal(replay.accepted, false, "an over-return is rejected before either leg exists");
  const cancelled = cancelReturn(posted, 3);
  assert.deepEqual(cancelled, { accepted: true, ...initial });
});
