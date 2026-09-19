-- Independent server wake-ups: no open browser, polling tab, or user cookie needed.
-- Vault keeps the worker token out of the repository and public schemas.
create extension if not exists pg_net with schema extensions;
create or replace function snacky_notice_private.wake() returns void
language plpgsql security definer set search_path='' as $$
declare token text;stamp timestamptz;
begin
 -- Retry from cron and coalesce bursts of assignment changes to one wake-up.
 update snacky_notice_private.settings set last_wake_at=clock_timestamp()
 where singleton and (last_wake_at is null or last_wake_at<clock_timestamp()-interval '2 seconds')
 returning last_wake_at into stamp;
 if stamp is null then return;end if;
 select decrypted_secret into token from vault.decrypted_secrets where name='snacky_assignment_worker_token';
 if token is null then raise exception 'Assignment worker token is not configured';end if;
 perform net.http_post(url:='https://snacky-os.vercel.app/api/notifications/dispatch',
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||token),body:='{}'::jsonb,timeout_milliseconds:=55000);
end $$;
revoke all on function snacky_notice_private.wake() from public,anon,authenticated;
-- A fresh installation stays inactive until this authenticated callback is handled
-- by the deployed application. Subsequent manual pauses are never auto-reversed.
do $$declare token text;begin
 select decrypted_secret into token from vault.decrypted_secrets where name='snacky_assignment_worker_token';
 if token is null then
  token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  perform vault.create_secret(token,'snacky_assignment_worker_token','Server-only notification dispatch authentication');
 end if;
 update snacky_notice_private.settings set token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') where singleton;
end$$;
select cron.schedule('snacky-assignment-notifications','* * * * *','select snacky_notice_private.wake();');
