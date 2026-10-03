-- Schedule live XY sales through Supabase pg_cron instead of Vercel Cron.
-- This reuses the existing XY scheduler URL/token in Vault and changes only
-- the protected endpoint path from /api/cron/xy-vms to /api/cron/xy-sales.

create extension if not exists pg_net with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.enqueue_xy_sales_sync()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  scheduler_url text;
  sales_url text;
  scheduler_token text;
  request_id bigint;
begin
  select decrypted_secret
    into scheduler_url
  from vault.decrypted_secrets
  where name = 'xy_vms_scheduler_url';

  select decrypted_secret
    into scheduler_token
  from vault.decrypted_secrets
  where name = 'xy_vms_scheduler_token';

  if nullif(btrim(scheduler_url), '') is null or nullif(btrim(scheduler_token), '') is null then
    raise exception 'XY scheduler Vault configuration is missing';
  end if;

  sales_url := regexp_replace(
    btrim(scheduler_url),
    '/api/cron/xy-vms/?$',
    '/api/cron/xy-sales'
  );

  if sales_url = btrim(scheduler_url) then
    raise exception 'XY scheduler URL does not end with /api/cron/xy-vms';
  end if;

  select net.http_post(
    url => sales_url,
    body => jsonb_build_object(
      'source', 'supabase_cron',
      'requested_at', clock_timestamp()
    ),
    headers => jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || btrim(scheduler_token)
    ),
    timeout_milliseconds => 180000
  )
  into request_id;

  return request_id;
end;
$$;

alter function private.enqueue_xy_sales_sync() owner to postgres;
revoke all on function private.enqueue_xy_sales_sync() from public, anon, authenticated;

select cron.unschedule(jobid)
from cron.job
where jobname = 'snacky-xy-sales-hourly';

select cron.schedule(
  'snacky-xy-sales-hourly',
  '15 * * * *',
  $job$select private.enqueue_xy_sales_sync();$job$
);
