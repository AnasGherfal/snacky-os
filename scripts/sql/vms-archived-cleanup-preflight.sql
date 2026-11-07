-- SNACKY VMS cold-archive deletion-readiness audit.
-- READ-ONLY: no mutations, advisory locks, or maintenance operations.
-- This report does NOT authorize removing production data.
WITH approved_batches(batch_id, expected_rows) AS (
  VALUES
    ('50e5063e-5595-4669-b8b1-34b0049bb6a7'::uuid,183),
    ('9a6d9703-7bcc-4e82-84a7-1dfbffc98366'::uuid,249),
    ('ebe64093-f5e8-4d8d-82de-15c40b54fd34'::uuid,1921),
    ('a6ae1837-0411-4831-9052-f7a5bbb0ad88'::uuid,2696),
    ('dbb4caba-634b-4bd4-a192-8c4736fe93ef'::uuid,2696),
    ('23b7e1df-4707-444a-bcb1-905742331e45'::uuid,2696),
    ('2aa9ca15-39bf-43b5-8d66-e9acbd6d1a0b'::uuid,2822),
    ('4f5678c3-445b-404d-8661-89baac1f0933'::uuid,2871)
), inspected AS (
 SELECT a.batch_id, a.expected_rows,b.id IS NOT NULL AS batch_exists,
        b.status, b.is_active,
        b.imported_at,b.deleted_at,
        COUNT(r.id)::int AS present_rows,
        COALESCE(BOOL_AND(r.created_at < now()-interval '60 days'),false) AS all_rows_old,
        MAX(r.created_at) AS most_recent_row
 FROM approved_batches a
 LEFT JOIN public.vms_import_batches b ON b.id=a.batch_id
 LEFT JOIN public.vms_import_rows r ON r.import_batch_id=a.batch_id
 GROUP BY a.batch_id,a.expected_rows,b.id,b.status,b.is_active,b.imported_at,b.deleted_at
), safety AS (
 SELECT *,
   (batch_exists AND status='deleted' AND is_active IS false
    AND imported_at < now()-interval '60 days'
    AND deleted_at < now()-interval '60 days'
    AND present_rows=expected_rows AND all_rows_old) AS currently_matches_archive_gate
 FROM inspected
)
SELECT
  (SELECT COUNT(*) FROM safety)::int AS reviewed_batches,
  (SELECT COUNT(*) FILTER (WHERE currently_matches_archive_gate) FROM safety)::int AS matching_batches,
  (SELECT SUM(present_rows) FROM safety)::bigint AS source_rows_present,
  (SELECT SUM(expected_rows) FROM safety)::bigint AS expected_rows,
  (SELECT COALESCE(BOOL_AND(currently_matches_archive_gate),false) FROM safety) AS eligibility_all_pass,
  (SELECT COUNT(*) FROM pg_constraint c
    WHERE c.contype='f' AND c.confrelid='public.vms_import_rows'::regclass)::int AS foreign_keys_pointing_to_import_rows,
  (SELECT COUNT(*) FROM public.vms_transactions_raw WHERE import_batch_id IN (SELECT batch_id FROM approved_batches))::bigint AS linked_transactions_to_keep,
  (SELECT COUNT(*) FROM public.vms_import_preview_rows WHERE import_batch_id IN (SELECT batch_id FROM approved_batches))::bigint AS linked_preview_rows_to_keep,
  (SELECT COUNT(*) FROM public.vms_monthly_product_profit WHERE import_batch_id IN (SELECT batch_id FROM approved_batches))::bigint AS linked_monthly_profit_to_keep,
  (SELECT COUNT(*) FROM public.vms_import_previews WHERE import_batch_id IN (SELECT batch_id FROM approved_batches))::bigint AS linked_preview_headers_to_keep,
  (SELECT COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
      'batch_id',batch_id,'expected',expected_rows,
      'present',present_rows,'eligible',currently_matches_archive_gate)
    ORDER BY batch_id),'[]'::jsonb) FROM safety) AS batch_summary,
  pg_database_size(current_database())::bigint AS current_database_bytes;