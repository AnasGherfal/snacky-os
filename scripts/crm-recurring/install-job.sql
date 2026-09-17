-- Explicit deployment step, NOT an automatically applied migration.
-- Run as database administrator only after schema/app checks and rollback review.
-- Requires pg_cron already installed. It does NOT enable task generation.
begin;
do $$begin
 if to_regprocedure('crm_automation_private.tick(timestamp with time zone)') is null or to_regclass('cron.job') is null then
  raise exception 'Recurring migration and pg_cron must be installed first';end if;
 if (select enabled from crm_automation_private.settings where singleton) then
  raise exception 'Pause generation before configuring the scheduler';end if;
 if exists(select 1 from cron.job where jobname='snacky-crm-recurring' and (command<>'select crm_automation_private.tick();' or username<>current_user)) then
  raise exception 'A different job already uses this name. Review it; do not overwrite it.';end if;
end $$;
select cron.schedule('snacky-crm-recurring','*/15 * * * *','select crm_automation_private.tick();');
commit;
-- After validation an owner/admin can enable generation in the Routines page.
-- Application rollback: set NEXT_PUBLIC_SNACKY_CRM_RECURRING_ENABLED=false and rebuild.
-- Worker rollback: pause generation; optionally unschedule only this named job.
-- Preserve existing tasks, routines and occurrence history. Never drop business history.
