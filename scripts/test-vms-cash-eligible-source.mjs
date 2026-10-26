import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CASH_ELIGIBLE_VMS_BATCH_STATUSES } from "../src/lib/vms-cash-source.ts";

const health = readFileSync("src/lib/xy-live-sales-sync.ts", "utf8");
const queue = readFileSync("src/app/cash-collections/action-queue/page.tsx", "utf8");
const admin = readFileSync("src/app/admin/vms-api/page.tsx", "utf8");
const sql = readFileSync("supabase/migrations/20260918211800_cash_period_from_last_removal.sql", "utf8");

test("active cash evidence agrees with accepted imported VMS batch states", () => {
  assert.deepEqual([...CASH_ELIGIBLE_VMS_BATCH_STATUSES], [
    "imported", "imported_with_warnings", "partially_imported",
  ]);
  assert.match(sql, /batch\.status in \('imported', 'imported_with_warnings', 'partially_imported'\)/);
  assert.match(sql, /batch\.deleted_at is null/);
});

test("XY sales health ignores transactions belonging to deleted import batches", () => {
  assert.ok(health.includes('select("payment_time, batch:vms_import_batches!inner(id)")'));
  assert.ok(health.includes('select("delivery_time, batch:vms_import_batches!inner(id)")'));
  assert.equal((health.match(/\.in\("batch\.status", \[\.\.\.CASH_ELIGIBLE_VMS_BATCH_STATUSES\]\)/g) ?? []).length, 2);
  assert.equal((health.match(/\.is\("batch\.deleted_at", null\)/g) ?? []).length, 2);
  assert.ok(health.includes("sourceReadVerified"));
  assert.ok(health.includes("if (!sourceReadVerified)"));
});

test("cash source warning uses the same eligible batch filter as reconciliation", () => {
  assert.ok(queue.includes("CASH_ELIGIBLE_VMS_BATCH_STATUSES"));
  assert.equal((queue.match(/select\("id, batch:vms_import_batches!inner\(id\)"\)/g) ?? []).length, 2);
  assert.ok(queue.includes('in("batch.status",[...CASH_ELIGIBLE_VMS_BATCH_STATUSES]).is("batch.deleted_at",null)'));
  assert.ok(queue.includes("Archived/deleted raw rows are not usable cash evidence"));
  assert.ok(queue.includes('href="/admin/vms-api"'));
});

test("admin UI distinguishes no eligible transactions from failed source query", () => {
  assert.ok(admin.includes('label: "Source read unverified"'));
  assert.ok(admin.includes('label: "No eligible active sales"'));
  assert.ok(admin.includes("liveSalesHealth.sourceReadVerified"));
  assert.ok(admin.includes("non-deleted imported VMS batch"));
  assert.ok(admin.includes("Deleted import batches remain excluded"));
  assert.ok(admin.includes("this rolling sync does not reconstruct them"));
  assert.ok(admin.includes('id="cash-transaction-integrity"'));
  assert.ok(admin.includes('Raw rows in eligible import batches'));
  assert.ok(admin.includes('Raw rows in deleted import batches'));
  assert.ok(admin.includes('.in("batch.status", [...CASH_ELIGIBLE_VMS_BATCH_STATUSES])'));
  assert.ok(admin.includes('.is("batch.deleted_at", null)'));
  assert.ok(admin.includes('.eq("batch.status", "deleted")'));
  assert.ok(admin.includes("No raw transactions currently qualify as a cash source"));
  assert.ok(admin.includes("Do not reactivate or reassign deleted records automatically"));
  assert.ok(admin.includes("Transaction batch eligibility could not be verified"));
  assert.ok(admin.includes('Raw rows in unfinished or failed batches'));
  assert.ok(admin.includes('Raw rows missing a source batch'));
  assert.ok(admin.includes('.in("batch.status", ["draft", "failed", "cancelled", "canceled", "previewed", "disabled"])'));
  assert.ok(admin.includes('.is("import_batch_id", null)'));
  assert.ok(admin.includes('never reassign hashes or activate incomplete rows automatically'));
  assert.ok(admin.includes('quarantinedCashRawRows === null ? "Unverified"'));
  assert.ok(admin.includes('orphanCashRawRows === null ? "Unverified"'));
});

test("no historical transactions or cash balances are altered by these source filters", () => {
  const sources = [health.slice(health.indexOf("export async function latestXyLiveSalesHealth()")),
    queue, admin];
  for (const source of sources) {
    assert.doesNotMatch(source, /\b(?:update|insert|delete|upsert)\s*\(/);
  }
});
