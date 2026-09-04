import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const inventoryPage = fs.readFileSync(new URL("../src/app/inventory/page.tsx", import.meta.url), "utf8");
const restockLoader = fs.readFileSync(new URL("../src/lib/restock-priority-data.ts", import.meta.url), "utf8");
const rlsMigration = fs.readFileSync(new URL("../supabase/migrations/20260904082626_optimize_inventory_rls_reads.sql", import.meta.url), "utf8");

test("authorized inventory pages use protected server reads for expensive aggregates", () => {
  assert.match(inventoryPage, /const inventoryReadClient = getSupabaseAdminClient\(\) \?\? supabase/);
  assert.match(inventoryPage, /inventoryReadClient\s*\.from\("current_inventory_by_location"\)/);
  assert.match(inventoryPage, /inventoryReadClient\s*\.from\("inventory_movements"\)/);
  assert.match(restockLoader, /loadProducts\(inventoryReadClient, errors\)/);
  assert.match(restockLoader, /inventoryReadClient\.from\("refill_recommendations"\)/);
});

test("inventory RLS caches row-independent authorization checks", () => {
  assert.match(rlsMigration, /alter policy snacky_inventory_movements_select_by_effective_role/);
  assert.match(rlsMigration, /\(select public\.snacky_current_profile_has_any_role/);
  assert.match(rlsMigration, /alter policy snacky_products_select_by_effective_role/);
  assert.match(rlsMigration, /alter policy snacky_storage_locations_select_by_effective_role/);
  assert.match(rlsMigration, /auth_user_id = \(select auth\.uid\(\)\)/);
  assert.doesNotMatch(rlsMigration, /disable row level security/i);
});
