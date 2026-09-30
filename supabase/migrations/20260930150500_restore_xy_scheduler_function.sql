-- Restore the private XY scheduler enqueue function on environments where
-- the durable scheduler migration was not applied even though the cron job exists.

create extension if not exists pg_net with schema extensions;

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
