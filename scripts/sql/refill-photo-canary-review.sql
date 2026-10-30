-- Snacky: owner review candidates only. No file operations, no approval given.
-- Run on production to generate an updated versioned list of ten safe-to-review
-- routine photos. References beyond these primary tables still require an owner
-- audit before enabling any archive copy, even if this query returns a row.
BEGIN TRANSACTION READ ONLY;

WITH candidates AS (
 SELECT
   o.name AS path,
   (o.metadata->>'size')::bigint AS bytes,
   o.updated_at AS source_updated_at,
   trim(both '"' from o.metadata->>'eTag') AS source_etag,
   h.id AS refill_history_id, h.route_id, h.route_stop_id, h.machine_id,
   m.name AS machine_name,
   'REVIEW_REQUIRED'::text AS review_status,
   false AS source_release_approved
 FROM storage.objects o
 JOIN public.machine_refill_history h ON h.machine_photo_path=o.name
 JOIN public.routes r ON r.id=h.route_id
 JOIN public.route_stops st ON st.id=h.route_stop_id
 JOIN public.machines m ON m.id=h.machine_id
 WHERE o.bucket_id='refill-photos'
   AND greatest(o.created_at,o.updated_at)<now()-interval '30 days'
   AND (o.metadata->>'size')::bigint BETWEEN 200000 AND 7*1024*1024
   AND trim(both '"' from o.metadata->>'eTag') ~ '^[a-fA-F0-9]{32,64}$'
   AND o.name ~ '^[0-9a-f-]{36}/[A-Za-z0-9._/-]+\\.(jpg|jpeg|png|webp)$'
   AND h.machine_photo_url='/api/storage/refill-photos/'||o.name
   AND not coalesce(h.issues_found,false)
   AND h.linked_issue_id IS NULL
   AND r.status::text='completed' AND st.status::text='completed'
   -- Preserve the most recent photo for each machine on Supabase.
   AND EXISTS (
     SELECT 1 FROM public.machine_refill_history later
     WHERE later.machine_id=h.machine_id
       AND later.machine_photo_path IS NOT NULL
       AND (later.refill_at,later.id)>(h.refill_at,h.id)
   )
   -- Do not select paths referenced by multiple histories or any safety proof.
   AND NOT EXISTS (
     SELECT 1 FROM public.machine_refill_history other
     WHERE other.machine_photo_path=o.name AND other.id<>h.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM public.route_stop_safety_checks safety
     WHERE safety.proof_photo_path=o.name
        OR safety.proof_photo_url='/api/storage/refill-photos/'||o.name
   )
   -- Quantities are JSONB arrays of objects; require both path and URL checks.
   AND NOT EXISTS (
     SELECT 1 FROM public.route_stop_quantity_confirmations q
     WHERE q.evidence_files @> jsonb_build_array(jsonb_build_object('photoPath',o.name))
        OR q.evidence_files @> jsonb_build_array(
          jsonb_build_object('photoUrl','/api/storage/refill-photos/'||o.name))
   )
   -- Fail closed if the machine has any issue without an archived/resolved timestamp.
   AND NOT EXISTS (
     SELECT 1 FROM public.issues i
     WHERE i.machine_id=h.machine_id AND i.resolved_at IS NULL AND i.archived_at IS NULL
   )
)
SELECT *
FROM candidates
ORDER BY bytes DESC,source_updated_at ASC
LIMIT 10;

COMMIT;
