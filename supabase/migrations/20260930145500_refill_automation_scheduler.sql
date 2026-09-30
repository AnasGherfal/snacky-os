-- Run XY freshness + refill batching frequently from Supabase.
-- Vercel remains a once-daily fallback because Hobby cron only supports daily jobs.

select cron.unschedule(jobid)
from cron.job
where jobname = 'snacky-xy-vms-hourly';

select cron.schedule(
  'snacky-xy-vms-hourly',
  '*/10 * * * *',
  $job$select private.enqueue_xy_vms_sync();$job$
);
