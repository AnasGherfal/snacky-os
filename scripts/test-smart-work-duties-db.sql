\set ON_ERROR_STOP on
create function pg_temp.check_it(ok boolean,label text) returns void language plpgsql as $$ begin if ok is distinct from true then raise exception 'FAIL: %',label; end if; raise notice 'PASS: %',label;end $$;
insert into public.team_members(id,full_name,role) values
 ('00000000-0000-0000-0000-000000000001','Owner','owner'),
 ('00000000-0000-0000-0000-000000000002','Noury test','operator'),
 ('00000000-0000-0000-0000-000000000003','Basheer test','operator'),
 ('00000000-0000-0000-0000-000000000004','Viewer','viewer');
insert into public.machines(id,name) select ('10000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,'Machine '||i from generate_series(1,3)i;
insert into public.machine_slots(machine_id,slot_code) select id,lpad(i::text,3,'0') from public.machines cross join generate_series(1,40)i;
insert into public.latest_vms_stock_by_slot(machine_id,slot_code,product_id,current_qty,capacity,captured_at)
select machine_id,slot_code,'20000000-0000-0000-0000-000000000001',0,8,now() from public.machine_slots;
select pg_temp.check_it(not has_function_privilege('anon','public.snacky_refresh_smart_work_duties(uuid)','execute'),'anon cannot refresh');
select pg_temp.check_it(not has_function_privilege('authenticated','public.snacky_refresh_smart_work_duties(uuid)','execute'),'browser cannot supply an actor to RPC');
select pg_temp.check_it(not has_table_privilege('authenticated','public.smart_work_duties','select'),'no browser table access');
select pg_temp.check_it(not has_table_privilege('service_role','public.smart_work_duty_events','update,delete,truncate'),'audit history immutable to application');
select pg_temp.check_it(not has_table_privilege('service_role','public.smart_work_duties','delete'),'duty deletion denied');
select pg_temp.check_it((select bool_and(relrowsecurity) from pg_class where oid in ('public.smart_work_duties'::regclass,'public.smart_work_duty_events'::regclass)),'RLS enabled');
select pg_temp.check_it((select not prosecdef from pg_proc where oid='public.snacky_refresh_smart_work_duties(uuid)'::regprocedure),'refresh is security invoker');
do $$begin
  perform public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000004');
  raise exception 'viewer refresh was allowed';
exception when insufficient_privilege then null;end $$;
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select count(*)=3 from public.smart_work_duties),'three required duties saved');
select pg_temp.check_it((select bool_and(owner_id is null and due_at is null and blocker='coverage_missing') from public.smart_work_duties),'missing setup never invents person or deadline');
create temporary table originals as select id,required_at,service_date from public.smart_work_duties;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select count(*)=3 from public.smart_work_duties),'refresh does not duplicate work');
select pg_temp.check_it((select bool_and(d.required_at=o.required_at and d.service_date=o.service_date) from public.smart_work_duties d join originals o using(id)),'refresh preserves required date');
-- Setup is always explicit; use broad fixture hours to avoid test-host timezone assumptions.
insert into public.smart_work_coverage_settings(kind,machine_id,value,version,updated_by)
select 'machine',id,jsonb_build_object('primaryId','00000000-0000-0000-0000-000000000002','backupId','00000000-0000-0000-0000-000000000003',
'days',jsonb_build_array(1,2,3,4,5,6,7),'accessStart','00:00','accessEnd','23:59','travelMinutes',0,'serviceMinutes',1,'enabled',true),1,'00000000-0000-0000-0000-000000000001' from public.machines;
insert into public.smart_work_coverage_settings(kind,operator_id,value,version,updated_by)
values('operator','00000000-0000-0000-0000-000000000002',jsonb_build_object('windows',jsonb_build_array(jsonb_build_object('day',extract(isodow from now() at time zone 'Africa/Tripoli')::int,'start','00:00','end','23:59','minutes',1)),'enabled',true),1,'00000000-0000-0000-0000-000000000001'),
('operator','00000000-0000-0000-0000-000000000003',jsonb_build_object('windows',jsonb_build_array(jsonb_build_object('day',extract(isodow from now() at time zone 'Africa/Tripoli')::int,'start','00:00','end','23:59','minutes',1)),'enabled',true),1,'00000000-0000-0000-0000-000000000001');
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select count(*)=1 from public.smart_work_duties where assigned_via='primary'),'primary capacity limits promises');
select pg_temp.check_it((select count(*)=1 from public.smart_work_duties where assigned_via='backup'),'approved backup handles overflow');
select pg_temp.check_it((select count(*)=1 from public.smart_work_duties where owner_id is null and blocker='no_capacity'),'insufficient team capacity stays uncovered');
select pg_temp.check_it((select bool_and(due_at is not null) from public.smart_work_duties),'deadlines come from approved access');
create temporary table unchanged as select id,owner_id,due_at,revision from public.smart_work_duties;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000003');
select pg_temp.check_it((select bool_and(d.owner_id is not distinct from u.owner_id and d.due_at=u.due_at and d.revision=u.revision) from public.smart_work_duties d join unchanged u using(id)),'repeat evaluation preserves owners, deadlines and revision');
-- Simulate original deadline from yesterday; a new day never creates a clean slate.
update public.smart_work_duties set service_date=service_date-1,required_at=required_at-interval '1 day',due_at=due_at-interval '1 day',revision=revision+1;
create temporary table carry as select id,required_at,due_at,owner_id from public.smart_work_duties;
update public.latest_vms_stock_by_slot set captured_at=now()-interval '1 day';
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select count(*)=3 from public.smart_work_duties where completed_at is null),'missing readings do not erase duties');
select pg_temp.check_it((select bool_and(d.required_at=c.required_at and d.due_at=c.due_at and d.owner_id is not distinct from c.owner_id) from public.smart_work_duties d join carry c using(id)),'original deadlines and owners survive midnight and stale stock');
-- Full stock without an audited service record is NOT completion.
update public.latest_vms_stock_by_slot set captured_at=now(),current_qty=8;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select count(*)=3 from public.smart_work_duties where completed_at is null),'healthier readings alone do not discharge required service');
insert into public.routes values('30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','completed',(now() at time zone 'Africa/Tripoli')::date);
insert into public.route_stops values('40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','skipped',now()-interval '5 minutes');
insert into public.route_stop_inventory_commits values('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002',now()-interval '5 minutes',now()-interval '5 minutes',false);
insert into public.route_stop_quantity_confirmations values('40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','offline_pending');
insert into public.route_stop_fill_lines values('40000000-0000-0000-0000-000000000001',10,false);
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select state<>'completed' from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000001'),'skipped stop never completes duty');
update public.route_stops set status='completed';
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select state='verification_pending' from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000001'),'offline pending retains responsibility');
update public.route_stop_quantity_confirmations set verification_status='xy_api_verified';
update public.latest_vms_stock_by_slot set current_qty=0 where machine_id='10000000-0000-0000-0000-000000000001' and slot_code='001';
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select state='verification_pending' from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000001'),'partial machine coverage cannot look completed');
update public.latest_vms_stock_by_slot set current_qty=8;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
select pg_temp.check_it((select state='completed' and completion_receipt_id is not null from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000001'),'audited service plus fully checked current stock completes duty');
select pg_temp.check_it((select count(*)=2 from public.smart_work_duties where completed_at is null),'one completed machine leaves two required');
select pg_temp.check_it((select count(*)=1 from public.routes) and (select count(*)=1 from public.route_stops),'duty updates never create operational routes');
select pg_temp.check_it(not exists(select duty_id,revision from public.smart_work_duty_events group by duty_id,revision having count(*)>1),'each revision has one audit event');
