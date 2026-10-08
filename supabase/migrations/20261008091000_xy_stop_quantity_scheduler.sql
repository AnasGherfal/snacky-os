-- Every minute, enqueue a short authenticated batch of XY selection stock syncs.
-- Reuses the existing XY scheduler URL/token stored only in Supabase Vault.
create or replace function private.enqueue_xy_stop_quantity_sync()
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  scheduler_url text;
  scheduler_token text;
  target_url text;
  request_id bigint;
begin
  select decrypted_secret into scheduler_url
  from vault.decrypted_secrets where name='xy_vms_scheduler_url';

  select decrypted_secret into scheduler_token
  from vault.decrypted_secrets where name='xy_vms_scheduler_token';

  if nullif(btrim(scheduler_url),'') is null
      or nullif(btrim(scheduler_token),'') is null
      or scheduler_url !~ '/api/cron/xy-vms/?$' then
    raise exception 'XY stock scheduler credential/endpoint configuration is invalid.';
  end if;
  target_url := regexp_replace(btrim(scheduler_url), '/api/cron/xy-vms/?$', '/api/cron/xy-stop-quantities');
  select net.http_post(
    url := target_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || btrim(scheduler_token),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 45000
  ) into request_id;
  return request_id;
end;
$$;
alter function private.enqueue_xy_stop_quantity_sync() owner to postgres;
revoke all on function private.enqueue_xy_stop_quantity_sync() from public,anon,authenticated;

select cron.unschedule(jobid)
from cron.job where jobname='snacky-xy-stop-quantities-every-minute';

select cron.schedule(
  'snacky-xy-stop-quantities-every-minute',
  '* * * * *',
  $job$select private.enqueue_xy_stop_quantity_sync();$job$
);
