-- READ-ONLY capacity / eligibility inventory for COPY-ONLY R2 backup.
-- Never use this query as an authorization to delete original rows.
-- Deleted and inactive means the batch was soft-deleted; it does not prove
-- that all historical references or legal/operational retention obligations are absent.
SELECT
  b.id AS import_batch_id,
  b.report_type,
  b.imported_at,
  b.deleted_at,
  COUNT(r.id) AS original_row_count,
  MIN(r.created_at) AS earliest_row,
  MAX(r.created_at) AS latest_row
FROM public.vms_import_batches b
JOIN public.vms_import_rows r ON r.import_batch_id = b.id
WHERE b.status = 'deleted'
  AND b.is_active IS FALSE
  AND b.imported_at < now() - interval '60 days'
  AND b.deleted_at < now() - interval '60 days'
GROUP BY b.id, b.report_type, b.imported_at, b.deleted_at
HAVING COUNT(r.id) BETWEEN 1 AND 10000
   AND MAX(r.created_at) < now() - interval '60 days'
ORDER BY original_row_count DESC, b.imported_at ASC;
