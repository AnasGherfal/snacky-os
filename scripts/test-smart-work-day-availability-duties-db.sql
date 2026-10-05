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
insert into public.smart_work_coverage_settings(kind,operator_id,value,version,updated_by)
values
 ('operator','00000000-0000-0000-0000-000000000002',
   jsonb_build_object('mode','days','days',(select coalesce(jsonb_agg(d),'[]'::jsonb) from generate_series(1,7)d where d<>extract(isodow from now() at time zone 'Africa/Tripoli')::int),'enabled',true),
   1,'00000000-0000-0000-0000-000000000001'),
 ('operator','00000000-0000-0000-0000-000000000003','{"mode":"days","days":[1,2,3,4,5,6,7],"enabled":true}',1,'00000000-0000-0000-0000-000000000001');
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select count(*)=2 from public.smart_work_duties where owner_id='00000000-0000-0000-0000-000000000002' and assigned_via='primary'),'unavailable primary still owns its duties');
select pg_temp.check_it((select count(*)=2 from public.smart_work_duties where owner_id='00000000-0000-0000-0000-000000000002' and blocker='owner_unavailable_today'),'unavailable weekday blocks new self-dispatch');
select pg_temp.check_it((select count(*)=1 from public.smart_work_duties where owner_id='00000000-0000-0000-0000-000000000003' and blocker is null),'available operator remains dispatchable');
select pg_temp.check_it((select count(*)=0 from public.smart_work_duties where assigned_via='backup'),'weekday unavailability never auto-hands work to backup');
update public.smart_work_coverage_settings
set value='{"mode":"days","days":[1,2,3,4,5,6,7],"enabled":true}',version=version+1
where operator_id='00000000-0000-0000-0000-000000000002';
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select count(*)=2 from public.smart_work_duties where owner_id='00000000-0000-0000-0000-000000000002' and blocker is null),'blocker clears when primary is available again');
select pg_temp.check_it((select count(*)=0 from public.smart_work_duties where assigned_via='backup'),'owner remains primary after availability returns');
select pg_temp.check_it((select bool_and(due_at is null and expected_minutes is null) from public.smart_work_duties),'weekday-only availability invents no times or durations');
