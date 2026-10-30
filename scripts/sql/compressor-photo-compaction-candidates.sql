-- READ ONLY. Candidate metadata for compressor ON photo archives, not a deletion order.
-- Exact bytes/ETag/updated_at must be rechecked by the authenticated archive worker.
-- No manifest here is approved for source removal; all originals must survive
-- unchanged in verified private storage until owner acceptance and separate flags.
BEGIN TRANSACTION READ ONLY;
WITH proof_refs AS (
  SELECT o.name AS path, (o.metadata->>'size')::bigint AS expected_size,
         o.updated_at AS source_updated_at,
         trim(both '"' from o.metadata->>'eTag') AS expected_etag,
         s.id AS safety_check_id,s.route_id,s.route_stop_id,s.machine_id,
         m.name AS machine_name,
         EXISTS (SELECT 1 FROM public.issues i
                 WHERE i.machine_id=s.machine_id AND i.resolved_at IS NULL AND i.archived_at IS NULL)
           AS has_unresolved_issue,
         (SELECT count(*) FROM public.route_stop_safety_checks other
          WHERE other.proof_photo_path=o.name) AS safety_references
  FROM storage.objects o
  JOIN public.route_stop_safety_checks s ON s.proof_photo_path=o.name
  JOIN public.routes r ON r.id=s.route_id AND r.status::text='completed'
  JOIN public.route_stops st ON st.id=s.route_stop_id AND st.status::text='completed'
  JOIN public.machines m ON m.id=s.machine_id
  WHERE o.bucket_id='refill-photos'
    AND o.name ~ '^[0-9a-f-]{36}/compressor/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$'
    AND s.compressor_confirmed IS TRUE
    AND s.proof_photo_url='/api/storage/refill-photos/'||o.name
    AND (o.metadata->>'size')::bigint BETWEEN 200000 AND 7*1024*1024
    AND trim(both '"' from o.metadata->>'eTag') ~ '^[0-9a-fA-F]{32,64}$'
    AND NOT EXISTS (SELECT 1 FROM public.machine_refill_history h
                    WHERE h.machine_photo_path=o.name)
    AND NOT EXISTS (SELECT 1 FROM public.route_stop_quantity_confirmations q
      WHERE q.evidence_files @> jsonb_build_array(jsonb_build_object('photoPath',o.name))
         OR q.evidence_files @> jsonb_build_array(
           jsonb_build_object('photoUrl','/api/storage/refill-photos/'||o.name)))
)
SELECT machine_name, safety_check_id, route_id, route_stop_id, machine_id,
       has_unresolved_issue, source_updated_at,
       jsonb_build_object(
         'path',path,'expectedSize',expected_size,
         'expectedUpdatedAt',to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'expectedEtag',expected_etag,
         'includeSafety',true,'release',false
       ) AS copy_only_canary_payload,
       false AS source_release_approved
FROM proof_refs
WHERE safety_references=1
ORDER BY has_unresolved_issue, expected_size, source_updated_at
LIMIT 53;
COMMIT;
