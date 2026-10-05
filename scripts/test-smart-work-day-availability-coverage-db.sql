\set ON_ERROR_STOP on
begin;
set local role service_role;
create function pg_temp.check_it(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label;end $$;
select pg_temp.check_it(public.snacky_valid_smart_coverage('operator','{"mode":"days","days":[1,2,3,4,6,7],"enabled":true}'),'variable-hour weekdays are valid');
select pg_temp.check_it(not public.snacky_valid_smart_coverage('operator','{"mode":"days","days":[],"enabled":true}'),'enabled operator needs at least one day');
select pg_temp.check_it(public.snacky_valid_smart_coverage('operator','{"mode":"days","days":[],"enabled":false}'),'disabled operator may have no days');
select pg_temp.check_it(not public.snacky_valid_smart_coverage('operator','{"mode":"days","days":[1,1],"enabled":true}'),'duplicate weekdays are rejected');
select pg_temp.check_it(not public.snacky_valid_smart_coverage('operator','{"mode":"days","days":[0],"enabled":true}'),'invalid weekday is rejected');
select public.snacky_save_smart_work_coverage(
 '00000000-0000-0000-0000-000000000001','operator','00000000-0000-0000-0000-000000000002',0,
 '{"mode":"days","days":[1,2,3,4,6,7],"enabled":true}'
);
select pg_temp.check_it((select value='{"mode":"days","days":[1,2,3,4,6,7],"enabled":true}'::jsonb from public.smart_work_coverage_settings where operator_id='00000000-0000-0000-0000-000000000002'),'day availability persists without times');
rollback;
