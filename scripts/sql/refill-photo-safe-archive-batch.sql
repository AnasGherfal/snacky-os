-- Snacky safe archive planning: read-only, COPY-ONLY candidates.
-- No photo is approved for release, deletion, or transfer by this query.
-- Run immediately before owner review; revalidate every live source object,
-- route, issue, URL, and quantity reference again in the server archive worker.
BEGIN TRANSACTION READ ONLY;
WITH objects AS (
  SELECT o.name AS path,(o.metadata->>'size')::bigint AS expected_size,
    o.updated_at AS source_updated_at,
    trim(both '"' from o.metadata->>'eTag') AS expected_etag
  FROM storage.objects o
  WHERE o.bucket_id='refill-photos'
    AND greatest(o.created_at,o.updated_at) < now()-interval '30 days'
    AND (o.metadata->>'size') ~ '^[0-9]+$'
    AND (o.metadata->>'size')::bigint BETWEEN 200000 AND 7*1024*1024
    AND trim(both '"' from o.metadata->>'eTag') ~ '^[0-9a-fA-F]{32,64}$'
    AND o.name ~ '^[0-9a-fA-F-]{36}/[a-zA-Z0-9._/-]+\.(jpg|jpeg|png|webp)$'
), refs AS (
  SELECT o.*, 'routine_overview'::text AS kind, h.id AS reference_id,
    h.route_id,h.route_stop_id,h.machine_id,false AS include_safety,
    h.refill_at AS reference_at
  FROM objects o
  JOIN public.machine_refill_history h ON h.machine_photo_path=o.path
  WHERE h.machine_photo_url='/api/storage/refill-photos/'||o.path
    AND NOT coalesce(h.issues_found,false) AND h.linked_issue_id IS NULL
    -- Most recently recorded machine overview must stay on Supabase.
    AND EXISTS (SELECT 1 FROM public.machine_refill_history later
      WHERE later.machine_id=h.machine_id AND later.machine_photo_path IS NOT NULL
        AND (later.refill_at,later.id)>(h.refill_at,h.id))
    AND NOT EXISTS(SELECT 1 FROM public.machine_refill_history hx
      WHERE hx.machine_photo_path=o.path AND hx.id<>h.id)
    AND NOT EXISTS(SELECT 1 FROM public.route_stop_safety_checks sx
      WHERE sx.proof_photo_path=o.path OR sx.proof_photo_url='/api/storage/refill-photos/'||o.path)
  UNION ALL
  SELECT o.*, 'historical_safety'::text AS kind, s.id AS reference_id,
    s.route_id,s.route_stop_id,s.machine_id,true AS include_safety,
    coalesce(st.completed_at,o.source_updated_at) AS reference_at
  FROM objects o
  JOIN public.route_stop_safety_checks s ON s.proof_photo_path=o.path
  LEFT JOIN public.route_stops st ON st.id=s.route_stop_id
  WHERE s.proof_photo_url='/api/storage/refill-photos/'||o.path
    AND NOT EXISTS(SELECT 1 FROM public.route_stop_safety_checks sx
      WHERE sx.proof_photo_path=o.path AND sx.id<>s.id)
    AND NOT EXISTS(SELECT 1 FROM public.machine_refill_history h
      WHERE h.machine_photo_path=o.path)
), eligible AS (
  SELECT ref.*,m.name AS machine_name
  FROM refs ref
  JOIN public.routes r ON r.id=ref.route_id AND r.status::text='completed'
  JOIN public.route_stops st ON st.id=ref.route_stop_id AND st.status::text='completed'
  JOIN public.machines m ON m.id=ref.machine_id
  WHERE NOT EXISTS(SELECT 1 FROM public.issues i
    WHERE i.machine_id=ref.machine_id AND i.resolved_at IS NULL AND i.archived_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM public.route_stop_quantity_confirmations q
      WHERE q.evidence_files @> jsonb_build_array(jsonb_build_object('photoPath',ref.path))
         OR q.evidence_files @> jsonb_build_array(
           jsonb_build_object('photoUrl','/api/storage/refill-photos/'||ref.path)))
)
SELECT kind,machine_name,reference_id,route_id,route_stop_id,machine_id,
  expected_size AS candidate_bytes,
  jsonb_build_object('path',path,'expectedSize',expected_size,
    'expectedUpdatedAt',to_char(source_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expectedEtag',expected_etag,
    'includeSafety',include_safety,'release',false,
    'source_release_approved',false) AS copy_only_job,
  'REVIEW_REQUIRED_NOT_APPROVED'::text AS status
FROM eligible
ORDER BY expected_size DESC,source_updated_at ASC
LIMIT 10;
COMMIT;
