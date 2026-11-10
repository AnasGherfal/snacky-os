import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const sql = fs.readFileSync("supabase/migrations/20261110140952_remove_redundant_vms_import_lookup_indexes.sql", "utf8");
test("only exactly two known redundant non-unique index names can be dropped", () => {
  const drops=[...sql.matchAll(/DROP INDEX\s+(?:IF EXISTS\s+)?([a-z_]+\.[a-z_]+)\s*;/gi)].map(m=>m[1]);
  assert.deepEqual(drops,[
    "public.idx_vms_import_rows_batch",
    "public.idx_vms_import_raw_rows_batch"
  ]);
  assert.doesNotMatch(sql,/\bDELETE\b\s+\bFROM\b|\bUPDATE\b\s+public\.|\bTRUNCATE\b|\bDROP\s+TABLE\b|\bCASCADE\b/i);
});
test("the exact unique constraint covering indexes must remain", () => {
  assert.match(sql,/vms_import_rows_import_batch_id_row_number_key/);
  assert.match(sql,/vms_import_raw_rows_import_batch_id_source_row_number_key/);
  assert.match(sql,/i\.indisunique AND i\.indisvalid AND i\.indisready/);
  assert.match(sql,/NOT i\.indisunique AND NOT i\.indisprimary/);
  assert.match(sql,/NOT EXISTS \(SELECT 1 FROM pg_constraint c WHERE c\.conindid=idx\.oid\)/);
  assert.doesNotMatch(sql,/DROP INDEX.*(?:vms_import_rows_import_batch_id_row_number_key|vms_import_raw_rows_import_batch_id_source_row_number_key)/);
});
test("DDL stops on drift or lock wait rather than risking operational disruption", () => {
  assert.match(sql,/SET LOCAL lock_timeout = '2s'/);
  assert.match(sql,/SET LOCAL statement_timeout = '15s'/);
  assert.match(sql,/RAISE EXCEPTION/);
  assert.match(sql,/pg_get_indexdef/);
});
