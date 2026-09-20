-- Distinguish historical backfill from live actionable CRM work.
-- Historical rows preserve real past activity without becoming current reminders.
set lock_timeout = '3s';
set statement_timeout = '45s';

alter table public.location_admin_obligations
  add column if not exists is_historical boolean not null default false,
  add column if not exists historical_source text;

alter table public.issues
  add column if not exists is_historical boolean not null default false,
  add column if not exists historical_source text;

do $$
begin
 if not exists (
   select 1 from pg_constraint
   where conrelid='public.location_admin_obligations'::regclass
     and conname='location_admin_obligations_historical_source_check'
 ) then
   alter table public.location_admin_obligations
     add constraint location_admin_obligations_historical_source_check
     check (historical_source is null or length(historical_source) <= 500);
 end if;
 if not exists (
   select 1 from pg_constraint
   where conrelid='public.issues'::regclass
     and conname='issues_historical_source_check'
 ) then
   alter table public.issues
     add constraint issues_historical_source_check
     check (historical_source is null or length(historical_source) <= 500);
 end if;
end $$;

create index if not exists idx_location_admin_obligations_historical
  on public.location_admin_obligations(location_id,due_date desc)
  where is_historical;

create index if not exists idx_issues_historical_location
  on public.issues(location_id,happened_at desc)
  where is_historical;
