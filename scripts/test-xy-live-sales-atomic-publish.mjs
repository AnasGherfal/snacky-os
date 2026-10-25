import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync("supabase/migrations/20261025170000_xy_live_sales_atomic_publish.sql","utf8");
const importer = readFileSync("src/lib/xy-live-sales-sync.ts","utf8");
const normalizer = readFileSync("src/lib/xy-live-sales.ts","utf8");

test("server-only atomic publish refuses incomplete or ambiguous source batches", () => {
  assert.match(sql, /create or replace function public\.snacky_publish_xy_live_sales_batch_v1\(/i);
  assert.match(sql, /security invoker/i);
  assert.match(sql, /set search_path = pg_catalog, public/i);
  assert.match(sql, /current_user <> 'service_role'/);
  assert.match(sql, /revoke all on function public\.snacky_publish_xy_live_sales_batch_v1\(uuid,jsonb\)/);
  assert.match(sql, /grant execute on function public\.snacky_publish_xy_live_sales_batch_v1\(uuid,jsonb\)\s+to service_role/);
  assert.match(sql, /p_metrics->>'pagination_complete' is distinct from 'true'/);
  assert.match(sql, /v_fetched <> v_inserted \+ v_duplicates/);
  assert.match(sql, /v_rejected <> 0 or v_review <> 0 or v_mapped <> v_fetched/);
  assert.match(sql, /if v_rows <> v_inserted or v_invalid <> 0/);
  assert.match(sql, /for update/);
  assert.match(sql, /v_batch\.status <> 'draft'/);
  assert.match(sql, /v_batch\.deleted_at is not null/);
  assert.match(sql, /v_batch\.source_usage->>'source_type' is distinct from 'xy_live_sales_api'/);
});

test("SQL verifies paid transaction evidence and unknown payment method fails closed", () => {
  assert.match(sql, /t\.transaction_status = 'needs_review'/);
  assert.match(sql, /t\.mapped_machine_id is null/);
  assert.match(sql, /coalesce\(t\.payment_time,t\.delivery_time\) is null/);
  assert.match(sql, /t\.payment_amount is null/);
  assert.match(sql, /public\.snacky_vms_normalize_payment_method\(t\.raw_row,t\.normalized_row\) not in \('cash','card'\)/);
  assert.match(normalizer, /payment_method: first\(row, aliases\.paymentMethod\)/);
  assert.doesNotMatch(sql, /delete from public\.vms_transactions_raw/i);
  assert.doesNotMatch(sql, /update public\.vms_transactions_raw/i);
});

test("only one final database call promotes staged XY import visibility", () => {
  assert.match(importer, /\.rpc\("snacky_publish_xy_live_sales_batch_v1"/);
  assert.match(importer, /p_batch_id: importBatchId/);
  assert.match(importer, /p_metrics: publicationMetrics/);
  assert.match(importer, /await assertNoQuarantinedSaleHashCollisions\(supabase, dbRows\)/);
  assert.match(importer, /await saveRows\(supabase, dbRows\)/);
  assert.ok(importer.indexOf("await saveRows(supabase, dbRows)") <
    importer.indexOf('await supabase.rpc("snacky_publish_xy_live_sales_batch_v1"'));
  assert.match(importer, /batchPublished = true/);
  assert.match(importer, /if \(batchPublished && publishedResult\)/);
  assert.match(importer, /\.eq\("status", "draft"\)/);
  assert.match(importer, /publication_status: "unverified"/);
});

test("atomic batch publication explicitly remains distinct from chunk upload atomicity", () => {
  assert.match(sql, /existing chunked draft-row writes are intentionally NOT made atomic/i);
  assert.match(sql, /failed draft batches must remain ineligible/i);
  assert.match(sql, /never relink, reactivate or delete a historical import/i);
  assert.ok(!/delete from public\.vms_import_batches/i.test(sql));
});
