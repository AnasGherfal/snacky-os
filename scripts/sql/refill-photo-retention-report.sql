-- READ-ONLY triage, NOT a deletion manifest. Unknown or unlinked files require manual review.
-- Age alone never establishes permission to remove evidence. Links in audit JSON, notes,
-- and other modules must also be checked before any approved archival/removal operation.
BEGIN TRANSACTION READ ONLY;
WITH history AS (
  SELECT h.*, row_number() OVER (PARTITION BY machine_id ORDER BY refill_at DESC,id DESC) AS recency
  FROM public.machine_refill_history h
  WHERE nullif(machine_photo_path,'') IS NOT NULL OR nullif(machine_photo_url,'') IS NOT NULL
), evidence AS (
  SELECT 'compressor'::text AS kind, proof_photo_path AS path, proof_photo_url AS url
  FROM public.route_stop_safety_checks
  UNION ALL
  SELECT 'quantity', f->>'photoPath', f->>'photoUrl'
  FROM public.route_stop_quantity_confirmations q
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q.evidence_files)='array' THEN q.evidence_files ELSE '[]'::jsonb END) f
  UNION ALL SELECT 'issue',null,photo_url FROM public.issues
  UNION ALL SELECT 'adjustment',null,photo_url FROM public.inventory_adjustments
), photos AS (
  SELECT o.name,o.created_at,o.updated_at,(o.metadata->>'size')::bigint AS bytes
  FROM storage.objects o
  WHERE o.bucket_id='refill-photos' AND o.metadata->>'size' ~ '^[0-9]+$'
), classified AS (
  SELECT p.*,CASE
    WHEN p.name LIKE '%/compressor/%' OR EXISTS (
      SELECT 1 FROM evidence e WHERE e.path=p.name
      OR e.url='/api/storage/refill-photos/'||p.name
      OR e.url LIKE '%/storage/v1/object/%/refill-photos/'||p.name
    ) THEN 'protected_safety_quantity_issue'
    WHEN greatest(p.created_at,p.updated_at)>=now()-interval '30 days' THEN 'keep_recent_30d'
    WHEN EXISTS (
      SELECT 1 FROM history h WHERE h.recency=1 AND (h.machine_photo_path=p.name OR h.machine_photo_url='/api/storage/refill-photos/'||p.name)
    ) THEN 'keep_latest_machine_photo'
    WHEN NOT EXISTS (
      SELECT 1 FROM history h WHERE h.machine_photo_path=p.name OR h.machine_photo_url='/api/storage/refill-photos/'||p.name
    ) THEN 'manual_review_no_primary_link'
    WHEN EXISTS (
      SELECT 1 FROM history h
      LEFT JOIN public.routes r ON r.id=h.route_id
      LEFT JOIN public.route_stops s ON s.id=h.route_stop_id
      WHERE (h.machine_photo_path=p.name OR h.machine_photo_url='/api/storage/refill-photos/'||p.name)
      AND (h.route_id IS NULL OR h.route_stop_id IS NULL
        OR coalesce(r.status::text,'unknown') NOT IN ('completed','cancelled')
        OR coalesce(s.status::text,'unknown') NOT IN ('completed','skipped')
        OR coalesce(h.issues_found,false) OR h.linked_issue_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM public.issues i WHERE i.machine_id=h.machine_id AND i.resolved_at IS NULL AND i.archived_at IS NULL))
    ) THEN 'hold_route_issue_or_legacy'
    ELSE 'review_archive_only_no_delete_authorization'
  END AS handling
  FROM photos p
)
SELECT handling,count(*) AS files,sum(bytes) AS bytes
FROM classified GROUP BY handling ORDER BY sum(bytes) DESC;
COMMIT;
