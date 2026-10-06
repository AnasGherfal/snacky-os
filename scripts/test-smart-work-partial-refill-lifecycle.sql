\set ON_ERROR_STOP on
create function pg_temp.check_it(ok boolean,label text) returns void language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;

insert into public.team_members(id,full_name,role) values
 ('00000000-0000-0000-0000-000000000001','Owner','owner'),
 ('00000000-0000-0000-0000-000000000002','Operator','operator');
insert into public.machines(id,name) values('10000000-0000-0000-0000-000000000001','Pilot machine');
insert into public.machine_slots(machine_id,slot_code)
select '10000000-0000-0000-0000-000000000001',lpad(i::text,3,'0') from generate_series(1,40)i;
insert into public.latest_vms_stock_by_slot(machine_id,slot_code,product_id,current_qty,capacity,captured_at)
select '10000000-0000-0000-0000-000000000001',lpad(i::text,3,'0'),'20000000-0000-0000-0000-000000000001',0,8,now()
from generate_series(1,40)i;

insert into public.smart_work_coverage_settings(kind,machine_id,value,version,updated_by)
values('machine','10000000-0000-0000-0000-000000000001',
 jsonb_build_object('primaryId','00000000-0000-0000-0000-000000000002','backupId',null,
 'days',jsonb_build_array(1,2,3,4,5,6,7),'accessStart','00:00','accessEnd','23:59',
 'travelMinutes',0,'serviceMinutes',1,'enabled',true),1,'00000000-0000-0000-0000-000000000001');
insert into public.smart_work_coverage_settings(kind,operator_id,value,version,updated_by)
values('operator','00000000-0000-0000-0000-000000000002',
 jsonb_build_object('enabled',true,'windows',jsonb_build_array(jsonb_build_object(
 'day',extract(isodow from now() at time zone 'Africa/Tripoli')::int,'start','00:00','end','23:59','minutes',960))),
 1,'00000000-0000-0000-0000-000000000001');

set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select count(*)=1 from public.smart_work_duties),'initial required duty exists');

insert into public.routes values(
 '30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','completed',
 (now() at time zone 'Africa/Tripoli')::date
);
insert into public.route_stops values(
 '40000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 '10000000-0000-0000-0000-000000000001','completed',now()-interval '2 minutes'
);
insert into public.route_stop_inventory_commits values(
 '50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',
 '40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',
 '00000000-0000-0000-0000-000000000002',now()-interval '2 minutes',now()-interval '2 minutes',false
);
insert into public.route_stop_quantity_confirmations values(
 '40000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','xy_api_verified'
);
insert into public.route_stop_fill_lines values('40000000-0000-0000-0000-000000000001',10,false);

-- Verified post-visit stock is fresh but still clearly requires service.
update public.latest_vms_stock_by_slot set captured_at=now(),current_qty=8;
update public.latest_vms_stock_by_slot set current_qty=0 where machine_id='10000000-0000-0000-0000-000000000001' and slot_code in (
 select lpad(i::text,3,'0') from generate_series(1,20)i
);
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select state='required' and completed_at is null and route_stop_id is null and owner_id='00000000-0000-0000-0000-000000000002'
  from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000001'),
  'verified partial service reopens original duty for another trip');
select pg_temp.check_it((select blocker is null from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000001'),
  'verified shortage does not become a verification blocker');

-- Once a later verified reading is fully healthy, the same duty may complete.
update public.latest_vms_stock_by_slot set current_qty=8,captured_at=now();
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
select pg_temp.check_it((select state='completed' and completed_at is not null and completion_receipt_id is not null
  from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000001'),
  'duty completes only after healthy verified evidence');
select pg_temp.check_it((select count(*)=1 from public.routes and (select count(*) from public.route_stops)=1),
  'duty lifecycle never creates extra routes');
