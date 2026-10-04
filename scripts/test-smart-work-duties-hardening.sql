-- Isolated CI only, following the core duty persistence tests.
\set ON_ERROR_STOP on
do $$begin
 if exists(select 1 from pg_constraint where conrelid='public.smart_work_duties'::regclass and confrelid in ('public.route_stops'::regclass,'public.route_stop_inventory_commits'::regclass)) then
   raise exception 'Duty links must not restrict existing route or receipt deletion';
 end if;
end $$;
insert into public.machines(id,name) values('10000000-0000-0000-0000-000000000098','Observation time test');
insert into public.machine_slots(machine_id,slot_code) values('10000000-0000-0000-0000-000000000098','001');
insert into public.latest_vms_stock_by_slot(machine_id,slot_code,product_id,current_qty,capacity,captured_at) values('10000000-0000-0000-0000-000000000098','001','20000000-0000-0000-0000-000000000001',0,8,now()-interval '10 minutes');
set role service_role;
select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');
reset role;
do $$begin
 if not exists(select 1 from public.smart_work_duties d join public.latest_vms_stock_by_slot s on s.machine_id=d.machine_id
 where d.machine_id='10000000-0000-0000-0000-000000000098' and d.required_at=s.captured_at
 and d.service_date=(s.captured_at at time zone 'Africa/Tripoli')::date) then
   raise exception 'Required time must reflect source observation rather than page-opening time';
 end if;
end $$;
\echo 'PASS: source-observation time and noninterference with operational route deletion'
