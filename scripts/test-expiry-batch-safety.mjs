import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(path, "utf8");
const form = read("src/components/PurchaseForm.tsx");
const actions = read("src/lib/purchase-actions.ts");
const migration = read("supabase/migrations/20260920101500_expiry_batch_safety.sql");
const detail = read("src/app/purchases/[id]/page.tsx");
const expiryPage = read("src/app/inventory/expiry/page.tsx");
const nav = read("src/components/module-tabs-config.ts");
const sw = read("public/sw.js");

test("purchase receipt requires a separate expiry batch per line", () => {
  assert.match(form, /expiryDate: string/);
  assert.match(form, /supplierLotCode: string/);
  assert.match(form, /shortExpiryConfirmed: boolean/);
  assert.match(form, /Expiry date is required before receiving this batch/);
  assert.match(form, /Expired stock cannot be received/);
  assert.match(form, /30 days or less remaining/);
  assert.match(form, /Add another expiry batch for this product/);
  assert.match(actions, /expiry_date: line\.expiryDate/);
  assert.match(actions, /snacky_create_purchase_with_lines_v3/);
  assert.match(actions, /snacky_update_draft_purchase_v2/);
});

test("database receipt boundary fails closed on missing, expired or unconfirmed short dates", () => {
  assert.match(migration, /snacky_expiry_purchase_receipt_guard/);
  assert.match(migration, /Expiry date is required before receiving stock/);
  assert.match(migration, /Expired stock cannot be received/);
  assert.match(migration, /days_left<=30 and not coalesce\(r\.short_expiry_confirmed,false\)/);
  assert.match(migration, /before insert on public\.inventory_movements/);
  assert.match(migration, /new\.reason::text='purchase_received'/);
});

test("expiry tracking is additive and follows inventory movements by FEFO", () => {
  assert.match(migration, /create table if not exists public\.inventory_batches/);
  assert.match(migration, /create table if not exists public\.inventory_batch_balances/);
  assert.match(migration, /create table if not exists public\.inventory_batch_movement_allocations/);
  assert.match(migration, /after insert on public\.inventory_movements/);
  assert.match(migration, /order by \(b\.expiry_date is null\) desc,b\.expiry_date asc/);
  assert.match(migration, /source_kind in \('purchase','legacy_unknown'\)/);
  assert.match(migration, /seed_legacy_unknown_v1/);
  assert.match(migration, /latest_vms_stock_by_slot/);
  assert.match(migration, /snacky_reconcile_machine_expiry_batches_v1/);
  assert.doesNotMatch(migration, /update public\.inventory_movements set quantity/);
});

test("alerts happen only for remaining stock and use the existing private push queue", () => {
  assert.match(migration, /having sum\(bal\.quantity\)>0/);
  for (const milestone of ["expiry_30d", "expiry_14d", "expiry_7d", "expiry_3d", "expiry_1d", "expired"]) {
    assert.match(migration, new RegExp(milestone));
  }
  assert.match(migration, /snacky_notice_private\.deliveries/);
  assert.match(migration, /source_kind='expiry_batch'/);
  assert.match(migration, /snacky-assignment-notifications/);
  assert.match(migration, /snacky-expiry-safety/);
  assert.match(sw, /relationships\|inventory/);
});

test("expiry control makes legacy uncertainty and machine reconciliation explicit", () => {
  assert.match(expiryPage, /EXPIRY UNKNOWN/);
  assert.match(expiryPage, /physically check/);
  assert.match(expiryPage, /reconciled against recent VMS stock/);
  assert.match(expiryPage, /storage_qty/);
  assert.match(expiryPage, /operator_bag_qty/);
  assert.match(expiryPage, /machine_qty/);
  assert.match(nav, /Expiry Control/);
  assert.match(detail, /Expiry not recorded/);
});
