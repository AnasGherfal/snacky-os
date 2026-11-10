-- Non-destructive disk optimization. Keep all rows and the unique constraints.
-- Fail closed if the exact redundant/covering B-tree index definitions changed.
-- Brief metadata lock only; abort rather than wait for active business queries.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

DO $audit$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class idx ON idx.oid = i.indexrelid
    WHERE i.indexrelid = 'public.idx_vms_import_rows_batch'::regclass
      AND i.indisvalid AND i.indisready
      AND NOT i.indisunique AND NOT i.indisprimary
      AND pg_get_indexdef(idx.oid) =
        'CREATE INDEX idx_vms_import_rows_batch ON public.vms_import_rows USING btree (import_batch_id, row_number)'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=idx.oid)
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = 'public.vms_import_rows_import_batch_id_row_number_key'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX vms_import_rows_import_batch_id_row_number_key ON public.vms_import_rows USING btree (import_batch_id, row_number)'
  ) THEN
    RAISE EXCEPTION 'vms_import_rows duplicate index safety check failed; no index dropped';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    JOIN pg_class idx ON idx.oid=i.indexrelid
    WHERE i.indexrelid = 'public.idx_vms_import_raw_rows_batch'::regclass
      AND i.indisvalid AND i.indisready
      AND NOT i.indisunique AND NOT i.indisprimary
      AND pg_get_indexdef(idx.oid) =
        'CREATE INDEX idx_vms_import_raw_rows_batch ON public.vms_import_raw_rows USING btree (import_batch_id, source_row_number)'
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=idx.oid)
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = 'public.vms_import_raw_rows_import_batch_id_source_row_number_key'::regclass
      AND i.indisunique AND i.indisvalid AND i.indisready
      AND pg_get_indexdef(i.indexrelid) =
        'CREATE UNIQUE INDEX vms_import_raw_rows_import_batch_id_source_row_number_key ON public.vms_import_raw_rows USING btree (import_batch_id, source_row_number)'
  ) THEN
    RAISE EXCEPTION 'vms_import_raw_rows duplicate index safety check failed; no index dropped';
  END IF;
END;
$audit$;

-- The unique constraint indexes cover the exact same lookup columns and order.
-- No rows, constraints, triggers or transaction data are removed.
DROP INDEX public.idx_vms_import_rows_batch;
DROP INDEX public.idx_vms_import_raw_rows_batch;
