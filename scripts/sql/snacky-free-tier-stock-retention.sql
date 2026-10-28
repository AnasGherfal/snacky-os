-- Snacky production capacity safeguard — applied only after 2026-10-27 emergency
-- data-size reduction, when the published XY stock view was verified unchanged.
-- Intended for the Free plan's 500 MB DATABASE-size cap; does not touch
-- cash, sales transactions, inventory movements, Finance, or route history.
--
-- Maintenance policy for imported XY stock snapshots:
-- * all observations from the most recent 12 hours;
-- * one ~10-minute capture window every 6 hours for the preceding 29 days;
-- * one weekly UTC-midnight window older than 29 days;
-- * every row currently selected by latest_vms_stock_by_slot, at any age.
-- Other providers and unverified rows are never deleted by this job.
--
-- Full-resolution historical stock-activity comparisons WILL lose granularity.
-- To keep all 10-minute history permanently, move to paid storage / external
-- historical archive. Never infer sales, loss, or cash from the retained sample.
--
-- Idempotent: a new cron.schedule call with the same name updates the job,
-- rather than creating multiple overlapping retention jobs.
SELECT cron.schedule(
  'snacky-xy-stock-retention',
  '35 * * * *',
  $snacky_retention$
  WITH protected_latest AS MATERIALIZED (
    SELECT id FROM public.latest_vms_stock_by_slot
  ),
  candidates AS MATERIALIZED (
    SELECT s.id
    FROM public.vms_stock_snapshots AS s
    WHERE s.source_provider = 'xy'
      AND s.import_row_status = 'imported'
      AND s.captured_at IS NOT NULL
      AND s.captured_at < now() - interval '12 hours'
      AND NOT EXISTS (SELECT 1 FROM protected_latest AS l WHERE l.id = s.id)
      AND (
        (
          s.captured_at >= now() - interval '29 days'
          AND NOT (
            extract(hour FROM s.captured_at AT TIME ZONE 'UTC')::int % 6 = 0
            AND extract(minute FROM s.captured_at AT TIME ZONE 'UTC')::int < 10
          )
        )
        OR (
          s.captured_at < now() - interval '29 days'
          AND NOT (
            extract(hour FROM s.captured_at AT TIME ZONE 'UTC')::int = 0
            AND extract(minute FROM s.captured_at AT TIME ZONE 'UTC')::int < 10
            AND extract(doy FROM s.captured_at AT TIME ZONE 'UTC')::int % 7 = 0
          )
        )
      )
    ORDER BY s.captured_at, s.id
    LIMIT 12000
  ),
  pruned AS (
    DELETE FROM public.vms_stock_snapshots AS s
    USING candidates AS c
    WHERE s.id = c.id
    RETURNING s.id
  )
  SELECT count(*)::integer AS pruned_stock_snapshots FROM pruned;
  $snacky_retention$
);

-- Ordinary VACUUM marks deleted tuples/pages reusable; unlike VACUUM FULL,
-- it does not rewrite / exclusively lock the working business table.
SELECT cron.schedule(
  'snacky-xy-stock-vacuum',
  '45 */6 * * *',
  'VACUUM (ANALYZE) public.vms_stock_snapshots'
);

-- pg_cron execution logs are operational telemetry, not route/Finance ledgers.
-- Keep seven days, matching the emergency recovery cleanup.
SELECT cron.schedule(
  'snacky-cron-execution-log-retention',
  '10 2 * * *',
  $snacky_logs$
  DELETE FROM cron.job_run_details
  WHERE start_time < now() - interval '7 days'
  $snacky_logs$
);

-- Safe verification (no secrets or job SQL disclosed):
-- SELECT jobid,jobname,schedule,active FROM cron.job
-- WHERE jobname IN ('snacky-xy-stock-retention',
--                   'snacky-xy-stock-vacuum',
--                   'snacky-cron-execution-log-retention');
-- SELECT count(*) FROM public.latest_vms_stock_by_slot;
-- SELECT pg_database_size(current_database());
