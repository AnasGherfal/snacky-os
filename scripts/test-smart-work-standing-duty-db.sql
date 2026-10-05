\set ON_ERROR_STOP on
create function pg_temp.check_it(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label;end $$;
insert into public.team_members(id,full_name,role) values
 ('00000000-0000-0000-0000-000000000001','Owner','owner'),
 ('00000000-0000-0000-0000-000000000002','Primary A','operator'),
 ('00000000-0000-0000-0000-000000000003','Primary B','operator');
insert into public.machines(id,name) select ('10000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'Machine '||i from generate_series(1,3)i;
insert into public.machine_slots(machine_id,slot_code) select id,lpad(i::text,3,'0') from public.machines cross join generate_series(1,40)i;
insert into public.latest_vms_stock_by_slot(machine_id,slot_code,product_id,current_qty,capacity,captured_at)
select machine_id,slot_code,'20000000-0000-0000-0000-000000000001',0,8,now() from public.machine_slots;
insert into public.smart_work_coverage_settings(kind,machine_id,value,version,updated_by)
select 'machine',id,
 case when id='10000000-0000-0000-0000-000000000003'::uuid
   then '{"primaryId":"00000000-0000-0000-0000-000000000003","backupId":null,"mode":"standing","enabled":true}'::jsonb
   else '{"primaryId":"00000000-0000-0000-0000-000000000002","backupId":"00000000-0000-0000-0000-000000000003","mode":"standing","enabled":true}'::jsonb
 end,1,'00000000-0000-0000-0000-000000000001'
from public.machines;
select pg_temp.check_it((select count(*)=0 from public.smart_work_coverage_settings where kind='operator'),'random hours require no invented operator schedule');
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select count(*)=3 from public.smart_work_duties),'all urgent machines receive durable duties');
select pg_temp.check_it((select count(*)=2 from public.smart_work_duties where owner_id='00000000-0000-0000-0000-000000000002' and assigned_via='primary'),'primary A owns both configured machines');
select pg_temp.check_it((select count(*)=1 from public.smart_work_duties where owner_id='00000000-0000-0000-0000-000000000003' and assigned_via='primary'),'primary B exclusively owns its machine');
select pg_temp.check_it((select count(*)=0 from public.smart_work_duties where assigned_via='backup'),'backup is never auto-assigned');
select pg_temp.check_it((select bool_and(due_at is null and expected_minutes is null) from public.smart_work_duties),'random hours invent no deadline or duration');
create temporary table first_state as select id,owner_id,assigned_via,revision from public.smart_work_duties;
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000003');
reset role;
select pg_temp.check_it((select bool_and(d.owner_id=f.owner_id and d.assigned_via=f.assigned_via and d.revision=f.revision) from public.smart_work_duties d join first_state f using(id)),'repeat refresh never reallocates responsibility');
-- Adding a genuinely approved site schedule may add timing, but it still cannot auto-handoff to backup.
update public.smart_work_coverage_settings
set value=jsonb_build_object('primaryId',value->>'primaryId','backupId',value->'backupId',
  'days',jsonb_build_array(1,2,3,4,5,6,7),'accessStart','00:00','accessEnd','23:59',
  'travelMinutes',0,'serviceMinutes',1,'enabled',true),version=version+1
where kind='machine';
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select bool_and(due_at is not null and expected_minutes=1) from public.smart_work_duties),'real site schedule can add timing');
select pg_temp.check_it((select count(*)=0 from public.smart_work_duties where assigned_via='backup'),'scheduled timing also never auto-handoffs');
select pg_temp.check_it((select count(*)=0 from public.routes),'responsibility refresh creates no route');
