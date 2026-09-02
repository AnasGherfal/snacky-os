-- Keep XY synchronization automatic even when no planner has Snacky OS open.
-- The scheduler token and endpoint URL are read from Supabase Vault at run time;
-- neither value is stored in this migration or in pg_cron's command text.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.enqueue_xy_vms_sync()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  scheduler_url text;
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

  select net.http_post(
    url => btrim(scheduler_url),
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

alter function private.enqueue_xy_vms_sync() owner to postgres;
revoke all on function private.enqueue_xy_vms_sync() from public, anon, authenticated;

-- Close abandoned or duplicate rows before enforcing one live XY import. The
-- trigger clears crashed runs before each new attempt; the partial index makes
-- the browser, manual button, Vercel cron, and Supabase cron share one lock.
lock table public.vms_sync_runs in share row exclusive mode;

with ranked_running as (
  select
    id,
    started_at,
    row_number() over (order by started_at desc, id desc) as running_rank
  from public.vms_sync_runs
  where provider = 'xy'
    and status = 'running'
    and sync_type in ('machines', 'products', 'machine_goods', 'machine_status', 'all')
)
update public.vms_sync_runs run
set
  status = 'failed',
  completed_at = coalesce(run.completed_at, now()),
  message = coalesce(run.message, 'Abandoned or duplicate XY synchronization was closed automatically.')
from ranked_running ranked
where run.id = ranked.id
  and (
    ranked.running_rank > 1
    or ranked.started_at < now() - interval '15 minutes'
  );

create or replace function public.snacky_expire_stale_xy_sync_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider = 'xy'
    and new.status = 'running'
    and new.sync_type in ('machines', 'products', 'machine_goods', 'machine_status', 'all')
  then
    update public.vms_sync_runs
    set
      status = 'failed',
      completed_at = coalesce(completed_at, clock_timestamp()),
      message = coalesce(message, 'Abandoned XY synchronization was closed automatically.')
    where provider = 'xy'
      and status = 'running'
      and sync_type in ('machines', 'products', 'machine_goods', 'machine_status', 'all')
      and started_at < clock_timestamp() - interval '15 minutes';
  end if;

  return new;
end;
$$;

alter function public.snacky_expire_stale_xy_sync_runs() owner to postgres;
revoke all on function public.snacky_expire_stale_xy_sync_runs() from public, anon, authenticated;

drop trigger if exists snacky_expire_stale_xy_sync_runs_before_insert on public.vms_sync_runs;
create trigger snacky_expire_stale_xy_sync_runs_before_insert
before insert on public.vms_sync_runs
for each row
execute function public.snacky_expire_stale_xy_sync_runs();

create unique index if not exists idx_vms_sync_runs_one_running_xy_import
on public.vms_sync_runs (provider)
where provider = 'xy'
  and status = 'running'
  and sync_type in ('machines', 'products', 'machine_goods', 'machine_status', 'all');

select cron.unschedule(jobid)
from cron.job
where jobname = 'snacky-xy-vms-hourly';

select cron.schedule(
  'snacky-xy-vms-hourly',
  '7 * * * *',
  $job$select private.enqueue_xy_vms_sync();$job$
);
