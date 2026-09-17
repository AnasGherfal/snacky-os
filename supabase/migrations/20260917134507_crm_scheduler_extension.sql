-- Scheduler extension only. No job, task or enabled routine is created.
-- Do not reissue CREATE EXTENSION on Supabase when pg_cron already exists:
-- its platform DDL hook can rerun privilege changes even with IF NOT EXISTS.
do $$
begin
 if not exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then
  create extension pg_cron with schema pg_catalog;
  grant usage on schema cron to postgres;
  grant all privileges on all tables in schema cron to postgres;
 end if;
end
$$;
