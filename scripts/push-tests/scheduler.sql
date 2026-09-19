\set ON_ERROR_STOP on
-- Execute the real scheduler function bodies with only transport/Vault/cron
-- boundaries simulated. CI does not call a live app or expose a real secret.
begin;
create schema if not exists extensions;
create schema net;
create schema vault;
create schema cron;
create table net.test_requests(id bigserial primary key,url text,headers jsonb,body jsonb,timeout_ms integer);
create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$insert into net.test_requests(url,headers,body,timeout_ms) values(url,headers,body,timeout_milliseconds) returning id$$;
create table vault.decrypted_secrets(id uuid default gen_random_uuid(),name text unique,decrypted_secret text,description text);
create function vault.create_secret(secret text,name text,description text) returns uuid language sql as $$insert into vault.decrypted_secrets(decrypted_secret,name,description) values(secret,name,description) returning id$$;
create table cron.test_jobs(jobid bigserial primary key,jobname text unique,schedule text,command text);
create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as $$insert into cron.test_jobs(jobname,schedule,command) values(job_name,schedule,command) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid$$;
\ir ../../.qa/scheduler-under-test.sql
select snacky_notice_private.wake();
select snacky_notice_private.wake();
do $$begin
 if (select count(*) from net.test_requests)<>1 then raise exception 'Wake burst was not coalesced';end if;
 if not exists(select 1 from net.test_requests r join vault.decrypted_secrets v on r.headers->>'Authorization'='Bearer '||v.decrypted_secret where r.url='https://snacky-os.vercel.app/api/notifications/dispatch' and r.timeout_ms=55000 and r.body='{}') then raise exception 'Wrong scheduler URL/authentication/body';end if;
 if (select enabled from snacky_notice_private.settings) then raise exception 'Scheduler activated without new code handshake';end if;
 if (select count(*) from cron.test_jobs where schedule='* * * * *' and command='select snacky_notice_private.wake();')<>1 then raise exception 'Independent periodic wake missing';end if;
 if has_function_privilege('authenticated','snacky_notice_private.wake()','EXECUTE') then raise exception 'Private wake exposed';end if;
end$$;
-- Both migrations may be retried without dropping worker authentication or
-- changing enabled/paused state, and without replacing an installed wake function.
\ir ../../supabase/migrations/20260919220000_assignment_notifications.sql
\ir ../../.qa/scheduler-under-test.sql
update snacky_notice_private.settings set last_wake_at=now()-interval '3 seconds';
select snacky_notice_private.wake();
do $$begin
 if (select count(*) from vault.decrypted_secrets)<>1 or (select count(*) from cron.test_jobs)<>1 then raise exception 'Scheduler rerun duplicated configuration';end if;
 if (select count(*) from net.test_requests)<>2 then raise exception 'Core migration replaced real wake';end if;
 if not exists(select 1 from snacky_notice_private.settings c join vault.decrypted_secrets v on c.token_hash=encode(sha256(convert_to(v.decrypted_secret,'UTF8')),'hex')) then raise exception 'Worker token changed on rerun';end if;
 raise notice 'PASS: actual scheduler SQL, secret reuse, exact request, coalescing, periodic job, access protection and repeatable installation';
end$$;
rollback;
