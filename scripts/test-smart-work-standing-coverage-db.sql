\set ON_ERROR_STOP on
begin;
set local role service_role;
create function pg_temp.check_it(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label;end $$;
select pg_temp.check_it(public.snacky_valid_smart_coverage('machine','{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":null,"mode":"standing","enabled":true}'),'standing config is valid without invented hours');
select pg_temp.check_it(not public.snacky_valid_smart_coverage('machine','{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":null,"mode":"standing","enabled":true,"accessStart":"00:00"}'),'standing config rejects hidden schedule fields');
select pg_temp.check_it(not public.snacky_valid_smart_coverage('machine','{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":"00000000-0000-0000-0000-000000000002","mode":"standing","enabled":true}'),'primary cannot also be backup');
select public.snacky_save_smart_work_coverage(
 '00000000-0000-0000-0000-000000000001','machine','00000000-0000-0000-0000-000000000003',0,
 '{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":null,"mode":"standing","enabled":true}'
);
select pg_temp.check_it((select value->>'mode'='standing' and value->>'primaryId'='00000000-0000-0000-0000-000000000002' and value->'backupId'='null'::jsonb from public.smart_work_coverage_settings where machine_id='00000000-0000-0000-0000-000000000003'),'standing responsibility persists exactly');
select pg_temp.check_it((select count(*)=1 from public.smart_work_coverage_events e join public.smart_work_coverage_settings s on s.id=e.setting_id where s.machine_id='00000000-0000-0000-0000-000000000003'),'standing save is audited once');
select pg_temp.check_it(not has_function_privilege('authenticated','public.snacky_save_smart_work_coverage(uuid,text,uuid,integer,jsonb)','execute'),'browser still cannot save responsibility directly');
rollback;
