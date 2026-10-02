import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath =
  "supabase/migrations/20260906155000_operator_personal_purchase_inventory_locking.sql";

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

const migration = read(migrationPath);
const canonicalFunction = compact(
  between(
    migration,
    "create or replace function public._snacky_create_operator_personal_purchase_v2(",
    "create or replace function public.create_operator_personal_purchase(",
  ),
);
const currentWrapper = compact(
  between(
    migration,
    "create or replace function public.create_operator_personal_purchase(",
    "create or replace function public.create_operator_personal_purchase_for_period(",
  ),
);
const selectedPeriodWrapper = compact(
  between(
    migration,
    "create or replace function public.create_operator_personal_purchase_for_period(",
    "revoke all on function public.operator_money_reserved_qty(uuid)",
  ),
);
const api = read("src/app/api/operator-money/route.ts");
const availabilityApi = compact(read("src/app/api/operator-money/availability.ts"));

test("both supported API signatures delegate to one authenticated command", () => {
  assert.match(canonicalFunction, /security definer set search_path = ''/i);
  assert.match(canonicalFunction, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(canonicalFunction, /if v_actor_user_id is null then raise exception 'Not authenticated'/i);
  assert.match(canonicalFunction, /snacky_current_team_member_id\(\)/i);
  assert.match(
    canonicalFunction,
    /snacky_current_profile_has_any_role\(array\['owner', 'admin'\]\)/i,
  );
  assert.match(canonicalFunction, /Only owner\/admin can add an item to a selected money period/i);
  assert.match(canonicalFunction, /Operators can only buy for themselves/i);

  for (const wrapper of [currentWrapper, selectedPeriodWrapper]) {
    assert.match(wrapper, /security definer set search_path = ''/i);
    assert.match(wrapper, /public\._snacky_create_operator_personal_purchase_v2\(/i);
    assert.doesNotMatch(wrapper, /insert into public\.inventory_movements/i);
  }
  assert.match(currentWrapper, /p_client_submission_id, false \);/i);
  assert.match(selectedPeriodWrapper, /p_client_submission_id, true \);/i);
});

test("the application has no alternate personal-purchase writer caller", () => {
  assert.match(api, /rpc\("create_operator_personal_purchase"/i);
  assert.match(api, /rpc\("create_operator_personal_purchase_for_period"/i);
  assert.doesNotMatch(api, /snacky_record_operator_personal_purchase/i);
  assert.doesNotMatch(api, /\.from\("inventory_movements"\)\s*\.(?:insert|upsert|update|delete)\(/i);
});

test("lost-response replay is actor-bound and immutable before mutable readiness checks", () => {
  const submissionLock = canonicalFunction.indexOf("'snacky:operator-personal-purchase:v2:' || v_submission_id");
  const existingPurchase = canonicalFunction.indexOf("where purchase.client_submission_id = v_submission_id for update");
  const replayReturn = canonicalFunction.indexOf("return v_purchase;", existingPurchase);
  const authorization = canonicalFunction.indexOf("v_is_manager :=", replayReturn);
  const periodStatus = canonicalFunction.indexOf("v_period.lifecycle_status <> 'open'", authorization);
  const stockRead = canonicalFunction.indexOf("from public.operator_money_available_storage", periodStatus);

  assert.ok(submissionLock >= 0 && existingPurchase > submissionLock);
  assert.ok(replayReturn > existingPurchase && authorization > replayReturn);
  assert.ok(periodStatus > authorization && stockRead > periodStatus);
  assert.match(canonicalFunction, /v_purchase\.created_by is distinct from v_actor_team_member_id/i);
  assert.match(canonicalFunction, /v_purchase\.person_id is distinct from p_person_id/i);
  assert.match(canonicalFunction, /v_purchase\.period_id is distinct from p_period_id/i);
  assert.match(canonicalFunction, /v_purchase\.purchased_at is distinct from p_purchased_at/i);
  assert.match(canonicalFunction, /idempotency_payload -> 'request' is distinct from v_request_payload/i);
  assert.match(canonicalFunction, /v_existing_movement\.source_id is distinct from v_purchase\.id/i);
  assert.match(canonicalFunction, /jsonb_typeof\(v_existing_movement\.idempotency_payload\) is distinct from 'object'/i);
  assert.match(canonicalFunction, /idempotency_payload #> '\{result,purchase_id\}' is distinct from pg_catalog\.to_jsonb\(v_purchase\.id\)/i);
  assert.match(canonicalFunction, /idempotency_payload #> '\{result,period_id\}' is distinct from pg_catalog\.to_jsonb\(v_purchase\.period_id\)/i);
  assert.match(canonicalFunction, /idempotency_payload #> '\{result,purchased_at\}' is distinct from pg_catalog\.to_jsonb\(v_purchase\.purchased_at\)/i);
  assert.match(canonicalFunction, /idempotency_payload #> '\{result,unit_price_lyd\}' is distinct from pg_catalog\.to_jsonb\(v_purchase\.unit_price_lyd\)/i);
  assert.match(
    canonicalFunction,
    /from public\.inventory_movements reversal where reversal\.reversed_movement_id = v_existing_movement\.id/i,
  );
  assert.match(canonicalFunction, /submission id was already used with a different immutable payload/i);
  assert.match(canonicalFunction, /saved personal purchase inventory proof does not match/i);
});

test("stock is serialized in the route/purchase lock order before it is read", () => {
  const periodParentLock = canonicalFunction.indexOf("from public.operator_money_periods period");
  const storageLoop = canonicalFunction.indexOf("for v_storage_lock in select storage.id");
  const orderedStorage = canonicalFunction.indexOf("order by storage.id, p_product_id", storageLoop);
  const advisoryLock = canonicalFunction.indexOf(
    "pg_catalog.hashtext(p_product_id::text), pg_catalog.hashtext(v_storage_lock.id::text)",
    storageLoop,
  );
  const productLock = canonicalFunction.indexOf("from public.products product", advisoryLock);
  const productForShare = canonicalFunction.indexOf("for share", productLock);
  const availabilityRead = canonicalFunction.indexOf(
    "from public.operator_money_available_storage(p_product_id)",
    productForShare,
  );
  const movementInsert = canonicalFunction.indexOf("insert into public.inventory_movements", availabilityRead);

  assert.ok(periodParentLock >= 0 && storageLoop > periodParentLock);
  assert.ok(orderedStorage > storageLoop && advisoryLock > orderedStorage);
  assert.ok(productLock > advisoryLock && productForShare > productLock);
  assert.ok(availabilityRead > productForShare && movementInsert > availabilityRead);
  assert.match(canonicalFunction, /Not enough physical storage stock/i);
  assert.match(canonicalFunction, /Not enough available storage stock after route reservations/i);
  assert.match(
    canonicalFunction,
    /storage\.location_type in \('main_storage', 'vehicle', 'temporary', 'other'\)/i,
  );
});

test("reservation availability is derived once across storage locations", () => {
  const reservedFunction = compact(
    between(
      migration,
      "create or replace function public.operator_money_reserved_qty(",
      "create or replace function public.operator_money_available_storage(",
    ),
  );
  const availabilityFunction = compact(
    between(
      migration,
      "create or replace function public.operator_money_available_storage(",
      "create or replace function public._snacky_create_operator_personal_purchase_v2(",
    ),
  );

  assert.match(reservedFunction, /public\.route_stock_lines stock_line/i);
  assert.match(reservedFunction, /coalesce\(stock_line\.planned_qty, 0\) - coalesce\(stock_line\.picked_qty, 0\)/i);
  assert.match(reservedFunction, /route_row\.status::text in/i);
  assert.match(availabilityFunction, /set search_path = ''/i);
  assert.match(availabilityFunction, /sum\(stock\.on_hand_qty\) over/i);
  assert.match(availabilityFunction, /rows between unbounded preceding and 1 preceding/i);
  assert.match(availabilityFunction, /total_reserved - ranked\.stock_before/i);
  assert.match(
    availabilityFunction,
    /storage\.location_type in \('main_storage', 'vehicle', 'temporary', 'other'\)/i,
  );

  assert.match(
    availabilityApi,
    /\.in\("location_type", \["main_storage", "vehicle", "temporary", "other"\]\)/i,
  );
  assert.match(availabilityApi, /if \(reservedResult\.error\) throw reservedResult\.error/i);
  assert.doesNotMatch(availabilityApi, /reservedResult\.error \? 0/i);

  const canDebit = ({ onHand, reserved, requested }) =>
    onHand >= requested && Math.max(onHand - reserved, 0) >= requested;
  assert.equal(canDebit({ onHand: 10, reserved: 0, requested: 10 }), true);
  assert.equal(canDebit({ onHand: 10, reserved: 6, requested: 5 }), false);
  assert.equal(canDebit({ onHand: 3, reserved: 0, requested: 4 }), false);
});

test("canonical selling price is database-owned and committed with the inventory movement", () => {
  assert.match(
    canonicalFunction,
    /coalesce\( nullif\(product\.current_selling_price_lyd, 0\), nullif\(product\.selling_price, 0\), 0 \)/i,
  );
  assert.doesNotMatch(canonicalFunction, /p_unit_price_lyd/i);
  assert.match(currentWrapper, /p_unit_price_lyd remains only for PostgREST signature compatibility/i);
  assert.match(canonicalFunction, /idempotency_payload/i);
  assert.match(canonicalFunction, /'request', v_request_payload, 'result', v_result_payload/i);
  assert.match(canonicalFunction, /insert into public\.operator_personal_purchases/i);
});

test("only the two canonical wrappers remain executable write surfaces", () => {
  const compactMigration = compact(migration);
  assert.match(
    compactMigration,
    /revoke all on function public\.operator_money_reserved_qty\(uuid\) from public, anon, authenticated; grant execute on function public\.operator_money_reserved_qty\(uuid\) to service_role/i,
  );
  assert.match(
    compactMigration,
    /revoke all on function public\.operator_money_available_storage\(uuid\) from public, anon, authenticated; grant execute on function public\.operator_money_available_storage\(uuid\) to service_role/i,
  );
  assert.match(
    compactMigration,
    /revoke all on function public\._snacky_create_operator_personal_purchase_v2\( uuid, uuid, uuid, uuid, integer, timestamptz, text, text, boolean \) from public, anon, authenticated, service_role/i,
  );
  assert.match(
    compactMigration,
    /revoke all on function public\.create_operator_personal_purchase\( uuid, uuid, uuid, integer, numeric, text, text \) from public, anon, authenticated, service_role; grant execute on function public\.create_operator_personal_purchase\( uuid, uuid, uuid, integer, numeric, text, text \) to authenticated, service_role/i,
  );
  assert.match(
    compactMigration,
    /revoke all on function public\.create_operator_personal_purchase_for_period\( uuid, uuid, uuid, uuid, integer, timestamptz, text, text \) from public, anon, authenticated, service_role; grant execute on function public\.create_operator_personal_purchase_for_period\( uuid, uuid, uuid, uuid, integer, timestamptz, text, text \) to authenticated, service_role/i,
  );
  assert.match(
    compactMigration,
    /snacky_record_operator_personal_purchase\(jsonb\)[\s\S]*from public, anon, authenticated, service_role/i,
  );
  assert.match(compactMigration, /pg_notify\('pgrst', 'reload schema'\)/i);
});
