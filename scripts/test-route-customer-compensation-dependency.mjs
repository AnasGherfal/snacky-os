import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const migrationName = "20260905085000_route_customer_compensation_dependency.sql";
const migrationPath = path.join(root, "supabase", "migrations", migrationName);
const sql = fs.readFileSync(migrationPath, "utf8");

assert.ok(
  migrationName < "20260905090000_route_terminal_inventory_reconciliation.sql",
  "customer compensation dependency must run before terminal reconciliation",
);
assert.match(sql, /alter type public\.movement_reason add value 'customer_compensation'/i);
assert.match(sql, /create table if not exists public\.route_customer_compensations/i);
assert.match(sql, /alter table public\.route_customer_compensations enable row level security/i);
assert.match(
  sql,
  /revoke all privileges on table public\.route_customer_compensations\s+from public, anon, authenticated/i,
);
assert.match(
  sql,
  /grant select, insert on table public\.route_customer_compensations to authenticated/i,
);
assert.doesNotMatch(
  sql,
  /grant\s+(?:all|delete|update)[^;]*route_customer_compensations[^;]*authenticated/i,
  "authenticated callers must not receive update, delete, or unrestricted table privileges",
);

for (const policy of [
  "snacky_route_customer_compensations_select",
  "snacky_route_customer_compensations_insert",
]) {
  assert.match(sql, new RegExp(`create policy "${policy}"`, "i"));
}
assert.match(sql, /snacky_current_profile_has_any_role\(array\['owner', 'admin', 'supervisor'\]\)/i);
assert.match(sql, /snacky_operator_can_access_route\(route_id\)/i);

for (const invariant of [
  "route_customer_compensations_quantity_positive",
  "route_customer_compensations_claimed_amount_nonnegative",
  "route_customer_compensations_claim_type_check",
  "route_customer_compensations_product_name_nonblank",
  "route_customer_compensations_submission_nonblank",
  "route_customer_compensations_review_reason_required",
]) {
  assert.match(sql, new RegExp(invariant, "i"), `missing ${invariant}`);
}

for (const index of [
  "idx_route_customer_compensations_submission",
  "idx_route_customer_compensations_inventory_movement",
  "idx_route_customer_compensations_route_time",
  "idx_route_customer_compensations_stop_time",
  "idx_route_customer_compensations_machine_time",
  "idx_route_customer_compensations_location_time",
  "idx_route_customer_compensations_operator_time",
  "idx_route_customer_compensations_product_time",
  "idx_route_customer_compensations_creator",
]) {
  assert.match(sql, new RegExp(index, "i"), `missing ${index}`);
}

console.log("route customer compensation dependency migration assertions passed");
