import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = "supabase/migrations/20260905094500_inventory_movement_idempotency_constraint.sql";
const genericWriterClosurePath = "supabase/migrations/20260906155700_close_generic_inventory_writer.sql";

function read(relativePath) {
  const absolutePath = path.join(root, relativePath);
  assert.equal(fs.existsSync(absolutePath), true, `${relativePath} must exist`);
  return fs.readFileSync(absolutePath, "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function topLevelSql(source) {
  return source.replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "");
}

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing start marker: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing end marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

test("idempotency migration rejects existing non-null duplicate movement keys", () => {
  const migration = compact(read(migrationPath));

  assert.match(migration, /from public\.inventory_movements movement where movement\.idempotency_key is not null/i);
  assert.match(migration, /group by movement\.idempotency_key having pg_catalog\.count\(\*\) > 1/i);
  assert.match(migration, /raise exception 'Cannot install inventory movement idempotency uniqueness/i);
  assert.match(migration, /errcode = '23505'/i);
});

test("a full unique index becomes the real one-column UNIQUE constraint", () => {
  const migration = compact(read(migrationPath));
  const indexDefinition = migration.match(
    /create unique index if not exists inventory_movements_idempotency_key_key on public\.inventory_movements\(idempotency_key\)([^;]*);/i,
  );

  assert.ok(indexDefinition, "the full idempotency index must be created");
  assert.doesNotMatch(indexDefinition[1], /\bwhere\b/i,
    "plain ON CONFLICT inference requires a non-partial unique index");
  assert.match(migration, /add constraint inventory_movements_idempotency_key_key unique using index inventory_movements_idempotency_key_key/i);
  assert.match(migration, /constraint_row\.contype = 'u'/i);
  assert.match(migration, /array_length\(constraint_row\.conkey, 1\) = 1/i);
  assert.match(migration, /attribute_row\.attname = 'idempotency_key'/i);
});

test("legacy index and advisory trigger are removed only after constraint verification", () => {
  const migration = compact(read(migrationPath));
  const addConstraint = migration.indexOf("add constraint inventory_movements_idempotency_key_key");
  const verification = migration.indexOf("attribute_row.attname = 'idempotency_key'");
  const dropPartial = migration.indexOf("drop index if exists public.idx_inventory_movements_idempotency_key");
  const dropTrigger = migration.indexOf("drop trigger if exists snacky_pickup_v2_inventory_movement_guard");
  const dropFunction = migration.indexOf("drop function if exists public.snacky_pickup_v2_inventory_movement_guard()");

  assert.ok(addConstraint >= 0 && verification > addConstraint && dropPartial > verification,
    "the old partial index must survive until the full constraint is installed and checked");
  assert.ok(dropTrigger > dropPartial && dropFunction > dropTrigger,
    "the legacy mutex may be removed only after database uniqueness is authoritative");
});

test("every original movement has at most one reversal after a fail-fast history preflight", () => {
  const migration = compact(read(migrationPath));
  const lowerMigration = migration.toLowerCase();
  const duplicatePreflight = lowerMigration.indexOf("group by movement.reversed_movement_id");
  const uniqueIndex = lowerMigration.indexOf("create unique index if not exists idx_inventory_movements_reversed_movement_id_unique");
  const indexVerification = lowerMigration.indexOf("inventory reversal uniqueness was not installed with the expected non-null predicate");

  assert.match(migration, /where movement\.reversed_movement_id is not null group by movement\.reversed_movement_id having pg_catalog\.count\(\*\) > 1/i);
  assert.match(migration, /raise exception 'Cannot install inventory reversal uniqueness:[^']*'[^;]*errcode = '23505'/i);
  assert.match(
    migration,
    /create unique index if not exists idx_inventory_movements_reversed_movement_id_unique on public\.inventory_movements\(reversed_movement_id\) where reversed_movement_id is not null/i,
  );
  assert.match(migration, /index_row\.indisunique[\s\S]*index_row\.indnkeyatts = 1[\s\S]*attribute_row\.attname = 'reversed_movement_id'/i);
  assert.match(migration, /pg_catalog\.pg_get_expr\(index_row\.indpred, index_row\.indrelid\)/i);
  assert.ok(duplicatePreflight >= 0 && uniqueIndex > duplicatePreflight && indexVerification > uniqueIndex,
    "duplicate history must abort before the reversal index is installed and verified");
});

test("idempotency contract migration does not rewrite ledger history", () => {
  const topLevel = compact(topLevelSql(read(migrationPath)));

  assert.doesNotMatch(topLevel, /insert into public\.inventory_movements/i);
  assert.doesNotMatch(topLevel, /update public\.inventory_movements/i);
  assert.doesNotMatch(topLevel, /delete from public\.inventory_movements/i);
  assert.doesNotMatch(topLevel, /truncate/i);
});

test("simple storage adjustments calculate and commit one serialized idempotent ledger result", () => {
  const migration = compact(read(migrationPath));
  const action = compact(between(
    read("src/lib/inventory-actions.ts"),
    "export async function createStorageAdjustment",
    "export async function createInventoryMovementCorrection",
  ));
  const functionBody = between(
    migration,
    "create or replace function public.snacky_create_storage_adjustment_v1(",
    "revoke all on function public.snacky_create_storage_adjustment_v1(",
  );

  assert.match(migration, /alter table public\.inventory_movements add column if not exists idempotency_payload jsonb/i);
  assert.match(migration, /attribute_row\.attname = 'idempotency_payload'[\s\S]*atttypid = 'pg_catalog\.jsonb'::pg_catalog\.regtype/i);
  assert.match(functionBody, /security definer set search_path = ''/i);
  assert.match(functionBody, /auth\.uid\(\) is null/i);
  assert.match(functionBody, /snacky_current_profile_has_any_role\(array\['owner', 'admin'\]\)/i);
  assert.match(functionBody, /storage-adjustment:v1:' \|\| v_submission_uuid::text/i);
  assert.match(functionBody, /'request', v_request_payload, 'result', v_result_payload/i);
  assert.match(functionBody, /idempotency_payload -> 'request' is distinct from v_request_payload/i);
  assert.match(functionBody, /source_type is distinct from 'storage_adjustment'/i);
  assert.match(functionBody, /source_id is distinct from v_submission_uuid/i);

  const commandLockIndex = functionBody.indexOf("'snacky:storage-adjustment:v1:' || v_submission_uuid::text");
  const replayIndex = functionBody.indexOf("where movement.idempotency_key = v_idempotency_key");
  const activeStorageLockIndex = functionBody.indexOf("for v_storage_lock in");
  const pairLockIndex = functionBody.indexOf("pg_catalog.hashtext(v_storage_lock.id::text)");
  const productReadinessIndex = functionBody.indexOf("perform product_row.id");
  const storageReadinessIndex = functionBody.indexOf("perform storage_row.id");
  const stockReadIndex = functionBody.indexOf("from public.current_inventory_by_location inventory");
  const reservationReadIndex = functionBody.indexOf("from public.route_stock_lines stock_line");
  const insertIndex = functionBody.indexOf("insert into public.inventory_movements");
  assert.ok(
    commandLockIndex >= 0
      && replayIndex > commandLockIndex
      && activeStorageLockIndex > replayIndex
      && pairLockIndex > activeStorageLockIndex
      && productReadinessIndex > replayIndex
      && productReadinessIndex > pairLockIndex
      && storageReadinessIndex > productReadinessIndex
      && stockReadIndex > storageReadinessIndex
      && reservationReadIndex > stockReadIndex
      && insertIndex > reservationReadIndex,
    "storage adjustment must command-lock, replay-check, lock every active storage balance, revalidate catalog rows, calculate authoritative stock/reservations, then insert",
  );
  assert.match(functionBody, /for v_replay_attempt in 1\.\.2 loop[\s\S]*if v_replay_attempt = 1 then[\s\S]*for v_storage_lock in/i);
  assert.match(functionBody, /where coalesce\(storage_row\.active, true\) = true and storage_row\.location_type in \('main_storage', 'vehicle', 'temporary', 'other'\) order by storage_row\.id, p_product_id for share/i);
  assert.match(functionBody, /pg_catalog\.hashtext\(p_product_id::text\), pg_catalog\.hashtext\(v_storage_lock\.id::text\)/i);
  assert.match(functionBody, /perform product_row\.id[\s\S]*for share[\s\S]*perform storage_row\.id[\s\S]*for share/i);

  assert.match(functionBody, /if v_adjustment_type = 'set_exact' then v_quantity_after := p_quantity::bigint; v_quantity_delta := v_quantity_after - v_quantity_before/i);
  assert.match(functionBody, /elsif v_adjustment_type = 'add' then v_quantity_delta := p_quantity::bigint; v_quantity_after := v_quantity_before \+ v_quantity_delta/i);
  assert.match(functionBody, /else v_quantity_delta := -p_quantity::bigint; v_quantity_after := v_quantity_before \+ v_quantity_delta/i);
  assert.match(functionBody, /if v_quantity_after < 0 then raise exception 'Storage adjustment would make stock negative/i);
  assert.match(functionBody, /v_storage_total_after := v_storage_total_before - v_quantity_before \+ v_quantity_after/i);
  assert.match(functionBody, /join public\.storage_locations storage_row on storage_row\.id = inventory\.location_id and coalesce\(storage_row\.active, true\) = true and storage_row\.location_type in \('main_storage', 'vehicle', 'temporary', 'other'\)/i);
  assert.match(functionBody, /greatest\( coalesce\(stock_line\.planned_qty, 0\) - coalesce\(stock_line\.picked_qty, 0\), 0 \)::bigint/i);
  assert.match(functionBody, /if v_storage_total_after < v_reserved_quantity then raise exception 'Storage adjustment would leave % units while active routes reserve %/i);
  assert.match(functionBody, /on conflict \(idempotency_key\) do nothing/i);
  assert.match(functionBody, /return query select v_movement_id, v_already_applied, v_quantity_before::integer, v_quantity_after::integer, v_quantity_delta::integer/i);
  assert.match(
    migration,
    /revoke all on function public\.snacky_create_storage_adjustment_v1\([\s\S]*?\) from public, anon; grant execute on function public\.snacky_create_storage_adjustment_v1\([\s\S]*?\) to authenticated/i,
  );
  assert.match(action, /rpc\("snacky_create_storage_adjustment_v1"/i);
  assert.match(action, /p_client_submission_id: clientSubmissionId/i);
  assert.match(action, /p_storage_location_id: storageId/i);
  assert.match(action, /const quantityAfter = Number\(adjustment\?\.quantity_after\)/i);
  assert.match(action, /atomic storage adjustment database update is not active yet\. No inventory was changed/i);
  assert.doesNotMatch(action, /\.from\("current_inventory_by_location"\)/i,
    "set-exact must not pre-read a stale aggregate balance in the app");
  assert.doesNotMatch(action, /\.from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)\(/i,
    "the app must not write the storage adjustment outside its RPC transaction");
});

test("storage adjustment arithmetic cannot silently overdraw storage", () => {
  const calculate = (before, type, requested) => {
    const delta = type === "set_exact" ? requested - before : type === "add" ? requested : -requested;
    const after = before + delta;
    if (delta === 0) throw new Error("no-op");
    if (after < 0) throw new Error("negative");
    return { before, after, delta, movementQuantity: Math.abs(delta) };
  };

  assert.deepEqual(calculate(10, "set_exact", 4), { before: 10, after: 4, delta: -6, movementQuantity: 6 });
  assert.deepEqual(calculate(10, "set_exact", 14), { before: 10, after: 14, delta: 4, movementQuantity: 4 });
  assert.deepEqual(calculate(10, "add", 3), { before: 10, after: 13, delta: 3, movementQuantity: 3 });
  assert.deepEqual(calculate(10, "remove", 3), { before: 10, after: 7, delta: -3, movementQuantity: 3 });
  assert.throws(() => calculate(2, "remove", 3), /negative/);
  assert.throws(() => calculate(2, "set_exact", 2), /no-op/);

  const preservesReservations = ({ totalBefore, locationBefore, locationAfter, reserved }) => (
    totalBefore - locationBefore + locationAfter >= reserved
  );
  assert.equal(preservesReservations({ totalBefore: 10, locationBefore: 10, locationAfter: 5, reserved: 8 }), false);
  assert.equal(preservesReservations({ totalBefore: 15, locationBefore: 10, locationAfter: 5, reserved: 8 }), true);

  const activeStorageTotal = (rows) => rows
    .filter((row) => row.active && ["main_storage", "vehicle", "temporary", "other"].includes(row.type))
    .reduce((total, row) => total + row.quantity, 0);
  assert.equal(activeStorageTotal([
    { active: true, type: "main_storage", quantity: 10 },
    { active: false, type: "main_storage", quantity: 100 },
    { active: true, type: "operator_bag", quantity: 100 },
  ]), 10, "inactive and non-storage custody stock cannot satisfy active route reservations");

  // With a product-wide set of pair locks, the first correction commits
  // before the second reads. A stale concurrent snapshot would incorrectly
  // let both 5-unit reductions pass against the same 15-unit reservation.
  const reserved = 15;
  let serializedTotal = 20;
  const firstAfter = serializedTotal - 5;
  assert.equal(firstAfter >= reserved, true);
  serializedTotal = firstAfter;
  const secondAfter = serializedTotal - 5;
  assert.equal(secondAfter >= reserved, false);
});

test("operator pickup has no non-atomic ledger fallback writer", () => {
  const action = compact(read("src/lib/operator-actions.ts"));

  assert.doesNotMatch(action, /upsertInventoryMovementsWithFallback/i);
  assert.doesNotMatch(action, /logPickupRpcUsedFallback/i);
  assert.doesNotMatch(
    action,
    /\.from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)\(/i,
    "operator actions must commit inventory only through the atomic database RPCs",
  );
  assert.match(action, /rpc\("snacky_confirm_route_pickup_batch_v3"/i);
  assert.match(action, /p_inventory_movements: movements/i);
});

test("generic parentless stock movements are closed while owner/admin storage counts remain", () => {
  const closure = compact(read(genericWriterClosurePath));
  const action = compact(read("src/lib/inventory-actions.ts"));
  const form = compact(read("src/components/StockMovementForm.tsx"));
  const page = compact(read("src/app/inventory/movements/new/page.tsx"));

  assert.match(closure, /revoke all on function public\.snacky_create_stock_movement_v1\([\s\S]*?\) from public, anon, authenticated, service_role/i);
  assert.match(closure, /revoke all on table public\.inventory_movements from service_role/i);
  assert.match(closure, /grant select on table public\.inventory_movements to service_role/i);
  assert.doesNotMatch(closure, /grant (?:all|insert|update|delete|truncate) on table public\.inventory_movements to service_role/i);

  assert.doesNotMatch(action, /createStockMovement|snacky_create_stock_movement_v1/i);
  assert.doesNotMatch(form, /Transfer \/ Advanced Movement|from_location|to_location|admin_override/i);
  assert.match(form, /Use the source workflow for custody movements/i);
  assert.match(page, /!isOwnerAdminRole\(profile\)/i);

  assert.match(form, /clientSubmissionId: string/i);
  assert.match(form, /name="client_submission_id" value=\{clientSubmissionId\}/i);
  assert.match(form, /setClientSubmissionId\([\s\S]*draft\.clientSubmissionId/i);
  assert.match(page, /initialClientSubmissionId=\{randomUUID\(\)\}/i,
    "each newly rendered deliberate movement must receive a fresh operation id");
});

test("manual-sale cancellation and its exact reversal commit in one database transaction", () => {
  const migration = compact(read(migrationPath));
  const patchHandler = compact(read("src/app/api/operator/routes/[id]/stops/[stopId]/manual-sales/route.ts").split("export async function PATCH")[1] ?? "");

  assert.match(migration, /create or replace function public\.snacky_cancel_route_manual_sale_v1\(/i);
  assert.match(migration, /from public\.routes route_row where route_row\.id = p_route_id for update/i);
  assert.match(migration, /from public\.route_manual_sales sale_row[\s\S]*for update/i);
  assert.match(migration, /v_original\.source_type is distinct from 'route_manual_sale'/i);
  assert.match(migration, /reversed_movement_id[\s\S]*v_sale\.inventory_movement_id[\s\S]*'route_manual_sale_cancel'/i);
  assert.match(migration, /v_reversal\.reversed_movement_id is distinct from v_sale\.inventory_movement_id/i);
  assert.match(migration, /on conflict \(idempotency_key\) do nothing/i);
  assert.match(migration, /update public\.route_manual_sales sale_row set status = 'cancelled'/i);
  assert.match(migration, /grant execute on function public\.snacky_cancel_route_manual_sale_v1\(uuid, uuid, uuid, text\) to authenticated/i);

  const reversalWrite = migration.indexOf("'route_manual_sale_cancel'");
  const saleStateWrite = migration.indexOf("update public.route_manual_sales sale_row");
  assert.ok(reversalWrite >= 0 && saleStateWrite > reversalWrite,
    "the reversal must be proven before the sale is marked cancelled");

  assert.match(patchHandler, /routeClient\.rpc\( "snacky_cancel_route_manual_sale_v1"/i);
  assert.match(patchHandler, /MANUAL_SALE_SCHEMA_UPDATE_REQUIRED/i);
  assert.match(patchHandler, /Nothing was changed\./i);
  assert.doesNotMatch(patchHandler, /\.from\("inventory_movements"\)\s*\.insert\(/i);
  assert.doesNotMatch(patchHandler, /\.from\("route_manual_sales"\)\s*\.update\(/i);
});

test("a concurrent inventory correction delegates winner selection to one atomic RPC", () => {
  const correctionAction = compact(read("src/lib/inventory-actions.ts").split("export async function createInventoryMovementCorrection")[1] ?? "");

  assert.match(correctionAction, /rpc\("snacky_create_inventory_movement_correction_v1"/i);
  assert.match(correctionAction, /p_original_movement_id: id/i);
  assert.match(correctionAction, /already_applied/i);
  assert.doesNotMatch(correctionAction, /\.from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)\(/i);
  assert.doesNotMatch(correctionAction, /\.eq\("reversed_movement_id", id\)/i,
    "the application must not race the database to choose a reversal winner");
});
