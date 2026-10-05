\set ON_ERROR_STOP on
begin;
set local role service_role;
do $$
declare cfg jsonb:='{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":null,"days":[1,2,3],"accessStart":"08:00","accessEnd":"16:00","travelMinutes":30,"serviceMinutes":45,"enabled":true}'; r jsonb; n integer;
begin
  assert public.snacky_valid_smart_coverage('machine',cfg);
  assert not public.snacky_valid_smart_coverage('machine',cfg||'{"days":[1,1]}');
  assert not public.snacky_valid_smart_coverage('machine',cfg||'{"accessStart":"25:00"}');
  assert not public.snacky_valid_smart_coverage('machine',cfg||'{"enabled":"true"}');
  assert not public.snacky_valid_smart_coverage('machine',cfg||'{"travelMinutes":null}');
  assert not public.snacky_valid_smart_coverage('machine',cfg||'{"serviceMinutes":10000000000000000}');
  assert public.snacky_valid_smart_coverage('machine','{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":null,"mode":"standing","enabled":true}');
  assert not public.snacky_valid_smart_coverage('machine','{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":null,"mode":"standing","enabled":true,"accessStart":"00:00"}');
  assert not public.snacky_valid_smart_coverage('machine','{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":"00000000-0000-0000-0000-000000000002","mode":"standing","enabled":true}');
  assert not public.snacky_valid_smart_coverage('operator','{"enabled":true,"windows":[]}');
  assert public.snacky_valid_smart_coverage('operator','{"enabled":false,"windows":[]}');
  assert not public.snacky_valid_smart_coverage('operator','{"enabled":true,"windows":[{"day":1,"start":"08:00","end":"09:00","minutes":90}]}');
  r:=public.snacky_save_smart_work_coverage('00000000-0000-0000-0000-000000000001','machine','00000000-0000-0000-0000-000000000003',0,cfg);
  assert (r->>'version')::integer=1;
  begin
    perform public.snacky_save_smart_work_coverage('00000000-0000-0000-0000-000000000001','machine','00000000-0000-0000-0000-000000000003',0,cfg);
    raise exception 'A stale create was accepted';
  exception when serialization_failure then null; end;
  r:=public.snacky_save_smart_work_coverage('00000000-0000-0000-0000-000000000001','machine','00000000-0000-0000-0000-000000000003',1,cfg||'{"serviceMinutes":50}');
  assert (r->>'version')::integer=2;
  select count(*) into n from public.smart_work_coverage_events where setting_id=(r->>'id')::uuid;
  assert n=2;
  begin
    perform public.snacky_save_smart_work_coverage('00000000-0000-0000-0000-000000000002','machine','00000000-0000-0000-0000-000000000003',2,cfg);
    raise exception 'Operator changed owner configuration';
  exception when insufficient_privilege then null; end;
  begin
    perform public.snacky_save_smart_work_coverage('00000000-0000-0000-0000-000000000001','machine','00000000-0000-0000-0000-000000000003',2,cfg||'{"primaryId":"00000000-0000-0000-0000-000000000005"}');
    raise exception 'Inactive primary accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.snacky_save_smart_work_coverage('00000000-0000-0000-0000-000000000001','machine','00000000-0000-0000-0000-000000000003',2,cfg||'{"primaryId":"00000000-0000-0000-0000-000000000004"}');
    raise exception 'Viewer accepted as primary';
  exception when invalid_parameter_value then null; end;
  assert not has_table_privilege('anon','public.smart_work_coverage_settings','SELECT');
  assert not has_table_privilege('authenticated','public.smart_work_coverage_settings','UPDATE');
  assert not has_function_privilege('authenticated','public.snacky_save_smart_work_coverage(uuid,text,uuid,integer,jsonb)','EXECUTE');
  assert not has_table_privilege('service_role','public.smart_work_coverage_events','UPDATE');
  assert not has_table_privilege('service_role','public.smart_work_coverage_events','DELETE');
  assert (select relrowsecurity from pg_class where oid='public.smart_work_coverage_settings'::regclass);
  assert (select not prosecdef from pg_proc where oid='public.snacky_save_smart_work_coverage(uuid,text,uuid,integer,jsonb)'::regprocedure);
end $$;
rollback;
-- Persistence across transactions, as distinct from an in-memory unit test.
set role service_role;
select public.snacky_save_smart_work_coverage('00000000-0000-0000-0000-000000000001','operator','00000000-0000-0000-0000-000000000002',0,'{"enabled":true,"windows":[{"day":1,"start":"08:00","end":"16:00","minutes":360}]}');
reset role;
do $$ begin assert (select version=1 from public.smart_work_coverage_settings where operator_id='00000000-0000-0000-0000-000000000002');end $$;
