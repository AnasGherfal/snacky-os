-- Snapshot-only manifest, never an authorization token or SQL delete.
-- The user authorized permanent Supabase Storage API deletion of ONLY
-- machine overviews and compressor/safety photo proof older than 30 full days.
-- JSONB machine quantity screenshots, cash evidence and receipts are excluded.
BEGIN TRANSACTION READ ONLY;
WITH old_refill AS (
  SELECT o.name AS path,(o.metadata->>'size')::bigint AS expected_size,
    o.created_at AS created_at,o.updated_at AS updated_at,
    trim(both '"' from o.metadata->>'eTag') AS expected_etag
  FROM storage.objects o
  WHERE o.bucket_id = 'refill-photos'
    AND o.created_at < now() - interval '30 days'
    AND o.updated_at < now() - interval '30 days'
    AND (o.metadata->>'size') ~ '^[0-9]+$'
    AND (o.metadata->>'size')::bigint BETWEEN 1 AND 10*1024*1024
    AND trim(both '"' from o.metadata->>'eTag') ~ '^[a-fA-F0-9]{32,64}$'
    AND o.name ~ '^[0-9a-fA-F-]{36}/[A-Za-z0-9._/-]+\.(jpg|jpeg|png|webp)$'
), classified AS (
 SELECT o.*,CASE
   WHEN EXISTS(SELECT 1 FROM public.route_stop_safety_checks s
               WHERE s.proof_photo_path = o.path) THEN 'compressor'
   WHEN EXISTS(SELECT 1 FROM public.machine_refill_history h
               WHERE h.machine_photo_path = o.path)
    AND NOT EXISTS(SELECT 1 FROM public.route_stop_safety_checks s
                   WHERE s.proof_photo_path = o.path) THEN 'machine'
   ELSE NULL END AS kind
 FROM old_refill o
), safe AS (
 SELECT c.* FROM classified c
 WHERE kind IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.route_stop_quantity_confirmations q
     WHERE position(c.path in coalesce(q.evidence_files::text, '')) > 0
   )
)
SELECT kind,expected_size,
       jsonb_build_object(
         'kind',kind,
         'path',path,
         'expectedSize',expected_size,
         'expectedUpdatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'expectedEtag',expected_etag
       ) AS job,
       'OWNER_AUTHORIZED_BUT_REQUIRE_RUNTIME_RECHECK' AS status
FROM safe ORDER BY path ASC LIMIT 1000;
COMMIT;
