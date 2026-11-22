-- Railway migration of the assignment notification worker.
-- Supabase pg_cron remains the scheduler; it calls this private RPC.
-- Delivery URL is an environment-specific Vault secret, not a Vercel domain.
-- Set snacky_assignment_dispatch_url in the target Supabase Vault before
-- applying. This migration NEVER reads or copies the worker bearer token.
create or replace function snacky_notice_private.wake()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  worker_token text;
  worker_url text;
  stamp timestamptz;
begin
  update snacky_notice_private.settings
    set last_wake_at = clock_timestamp()
    where singleton
      and (last_wake_at is null or last_wake_at < clock_timestamp() - interval '2 seconds')
    returning last_wake_at into stamp;
  if stamp is null then return; end if;

  select decrypted_secret into worker_token
    from vault.decrypted_secrets
    where name='snacky_assignment_worker_token';
  select decrypted_secret into worker_url
    from vault.decrypted_secrets
    where name='snacky_assignment_dispatch_url';

  if nullif(btrim(worker_token),'') is null then
    raise exception 'Assignment worker bearer token is not configured';
  end if;
  -- The worker cannot be sent to an arbitrary URL. Only a Railway-hosted
  -- destination with the exact fixed dispatch path is accepted here.
  if worker_url is null or
     btrim(worker_url) !~ '^https://[a-z0-9-]+[.]up[.]railway[.]app/api/notifications/dispatch$' then
    raise exception 'Railway assignment worker URL is missing or invalid';
  end if;

  perform net.http_post(
    url := btrim(worker_url),
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer '||worker_token
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end
$function$;
comment on function snacky_notice_private.wake() is
  'Wakes the private assignment dispatcher at the Vault-configured Railway endpoint. No Vercel hosting dependency.';
