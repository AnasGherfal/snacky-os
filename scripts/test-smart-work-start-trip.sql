\set ON_ERROR_STOP on
create function public.test_start(k integer,ids uuid[] default array[test_uuid(301)],plan_override jsonb default null)
returns jsonb language sql as $$ select public.snacky_start_smart_work_trip_v1(test_uuid(101),test_uuid(201),test_uuid(k),ids,repeat('a',64),coalesce(plan_override,test_trip_plan(ids))) $$;
create function public.test_error(q text,expected text,label text) returns void language plpgsql as $$
begin
  begin execute q; exception when others then
    if sqlstate<>expected then raise exception 'Wrong error for %: expected %, got % %',label,expected,sqlstate,sqlerrm;end if;
    raise notice 'PASS: %',label;return;
  end;
  raise exception 'Expected rejection: %',label;
end $$;

select test_assert(not has_function_privilege('anon','public.snacky_start_smart_work_trip_v1(uuid,uuid,uuid,uuid[],text,jsonb)','execute'),'anonymous cannot start');
select test_assert(not has_function_privilege('authenticated','public.snacky_start_smart_work_trip_v1(uuid,uuid,uuid,uuid[],text,jsonb)','execute'),'browser cannot call privileged commit');
select test_assert(has_function_privilege('service_role','public.snacky_start_smart_work_trip_v1(uuid,uuid,uuid,uuid[],text,jsonb)','execute'),'server can call commit');
select test_assert(not has_table_privilege('service_role','public.smart_work_trip_requests','update'),'request receipts immutable to app');
select test_assert(not has_table_privilege('authenticated','public.smart_work_trip_requests','select'),'other users cannot read receipts');
select test_error('select test_start(401)','55000','disabled by default');
select test_assert((select count(*)=0 from public.routes),'disabled commit leaves no route');
insert into public.smart_work_dispatch_control values(1,true);

begin;
set local role service_role;
select test_start(401) as first_result \gset
select test_assert((select count(*)=1 from public.routes),'one selected duty creates one route');
select test_assert((select count(*)=1 from public.route_stops),'only selected machine becomes a stop');
select test_assert((select sum(planned_qty)=5 and sum(picked_qty)=0 from public.route_stock_lines),'reserve five, pick zero');
select test_assert((select quantity_on_hand=30 from public.route_storage_stock_by_product where product_id=test_uuid(21)),'reservation does not deduct warehouse stock');
select test_assert((select count(*)=2 from public.smart_work_duties where route_stop_id is null and owner_id=test_uuid(201) and revision=1),'remaining two duties retain owner and revision');
select test_assert((select count(*)=4 from public.smart_work_duty_events),'one extra duty audit event');
select test_assert((test_start(401)->>'routeId')=(:'first_result'::jsonb->>'routeId'),'retry returns same route');
select test_assert((test_start(401)->>'replayed')::boolean,'retry marked replayed');
select test_assert((select count(*)=1 from public.smart_work_trip_requests),'retry produces one immutable receipt');
set constraints all immediate;
rollback;

begin;
select test_error($q$select test_start(402,array[test_uuid(301),test_uuid(301)])$q$,'22023','duplicate duty IDs rejected');
select test_error($q$select test_start(402,array[]::uuid[])$q$,'22023','empty selection rejected');
select test_error($q$select test_start(402,array[test_uuid(999)],test_trip_plan(array[test_uuid(301)]))$q$,'40001','unknown duty rejected after valid plan validation');
select test_assert((select count(*)=0 from public.routes),'rejected duty/identity checks create no route');
select test_assert((select count(*)=0 from public.smart_work_trip_requests),'rejected duty/identity checks create no request receipt');
select test_error($q$select snacky_start_smart_work_trip_v1(test_uuid(102),test_uuid(202),test_uuid(402),array[test_uuid(301)],repeat('a',64),test_trip_plan(array[test_uuid(301)]))$q$,'40001','cannot claim another operators duty');
update team_members set active=false where id=test_uuid(201);
select test_error('select test_start(402)','42501','inactive operator rejected');
rollback;

begin;
update team_members set role='viewer',roles=array['viewer'] where id=test_uuid(201);
select test_error('select test_start(402)','42501','role revocation rejected');
rollback;
begin;
update team_members set must_change_password=true where id=test_uuid(201);
select test_error('select test_start(402)','42501','mandatory password change rejected');
rollback;

begin;
select test_error($q$select test_start(403,array[test_uuid(301)],test_trip_plan(array[test_uuid(301)])||'{"status":"partial"}')$q$,'22023','partial plan cannot start as complete');
select test_error($q$select test_start(403,array[test_uuid(301)],test_trip_plan(array[test_uuid(301)])||jsonb_build_object('expiresAt',now()-interval '1 minute'))$q$,'22023','expired plan rejected');
select test_error($q$select test_start(403,array[test_uuid(301)],test_trip_plan(array[test_uuid(301)])||jsonb_build_object('lanes','[]'::jsonb))$q$,'22023','empty lane list rejected');
select test_error($q$select test_start(403,array[test_uuid(301)],jsonb_set(test_trip_plan(array[test_uuid(301)]),'{lanes,0,current}','0'))$q$,'40001','changed machine quantities rejected');
select test_error($q$select test_start(403,array[test_uuid(301)],jsonb_set(test_trip_plan(array[test_uuid(301)]),'{lanes,0,take}','6'))$q$,'40001','excessive take rejected');
select test_error($q$select test_start(403,array[test_uuid(301)],jsonb_set(test_trip_plan(array[test_uuid(301)]),'{totalUnits}','99'))$q$,'22023','mismatched aggregate rejected');
rollback;

begin;
update latest_vms_stock_by_slot set captured_at=now()-interval '1 hour' where machine_id=test_uuid(1);
select test_error('select test_start(404)','40001','stale stock cannot authorize pickup');
rollback;
begin;
insert into latest_vms_stock_by_slot select machine_id,'1',product_id,current_qty,capacity,captured_at,source_provider from latest_vms_stock_by_slot where machine_id=test_uuid(1);
select test_error('select test_start(404)','22023','duplicate XY aliases rejected');
rollback;
begin;
insert into smart_route_slot_product_rules values(test_uuid(11),test_uuid(21),'prohibited',null);
select test_error('select test_start(404)','22023','prohibited product rejected even though mapped');
rollback;
begin;
insert into smart_route_location_product_rules(machine_id,product_id,rule) values(test_uuid(1),test_uuid(21),'prohibited');
select test_error('select test_start(404)','22023','machine restriction enforced');
rollback;

begin;
update smart_work_duties set priority='immediate',revision=revision+1,updated_by=test_uuid(201),updated_at=now() where id=test_uuid(302);
select test_error('select test_start(405)','40001','lower-priority trip cannot drop urgent obligation');
rollback;
begin;
update smart_work_coverage_settings set value=jsonb_set(value,'{enabled}','false') where kind='machine' and machine_id=test_uuid(1);
select test_error('select test_start(405)','22023','disabled coverage rejected');
rollback;
begin;
delete from smart_work_coverage_settings where kind='operator';
select test_error('select test_start(405)','22023','no invented operator availability');
rollback;
begin;
update smart_work_coverage_settings set value=jsonb_set(value,'{windows,0,minutes}','1') where kind='operator';
select test_error('select test_start(405,array[test_uuid(301),test_uuid(302)])','22023','trip exceeds approved usable minutes');
rollback;
begin;
update smart_work_duties set due_at=now()-interval '1 day',revision=revision+1,updated_by=test_uuid(201),updated_at=now() where id=test_uuid(301);
select test_start(405);
select test_assert((select due_at<now()-interval '23 hours' from smart_work_duties where id=test_uuid(301)),'overdue recovery preserves original deadline');
set constraints all immediate;
rollback;

begin;
insert into inventory_movements(product_id,from_entity_type,to_entity_type,quantity) values(test_uuid(21),'storage','operator',29);
select test_error('select test_start(406)','23514','insufficient physical storage rejected');
select test_assert((select count(*)=0 from routes),'shortage leaves no partial route');
rollback;
begin;
insert into routes(id,route_date,operator_id,status) values(test_uuid(901),current_date,test_uuid(202),'assigned');
insert into route_stock_lines(route_id,product_id,planned_qty,picked_qty) values(test_uuid(901),test_uuid(21),28,0);
select test_error('select test_start(406)','23514','legacy unpicked reservations are subtracted');
rollback;
begin;
insert into routes(id,route_date,operator_id,status) values(test_uuid(901),current_date,test_uuid(202),'assigned');
insert into route_stock_lines(route_id,product_id,planned_qty,picked_qty) values(test_uuid(901),test_uuid(21),20,20);
insert into inventory_movements(product_id,from_entity_type,to_entity_type,quantity) values(test_uuid(21),'storage','operator',20);
select test_start(406);
select test_assert((select quantity_on_hand=10 from route_storage_stock_by_product where product_id=test_uuid(21)),'already-picked stock is not deducted again');
set constraints all immediate;
rollback;

begin;
select test_start(407) as result \gset
select test_error('select test_start(408)','40001','different request cannot claim the same duty');
select test_error('select test_start(407,array[test_uuid(302)])','40001','same key cannot create a different trip');
insert into routes(id,route_date,operator_id,status) values(test_uuid(901),current_date,test_uuid(202),'assigned');
select test_error($q$insert into route_stops(route_id,machine_id,status) values(test_uuid(901),test_uuid(1),'pending');set constraints all immediate$q$,'23505','legacy manual writer cannot double-book smart stop');
select test_error($q$insert into route_stock_lines(route_id,product_id,planned_qty,picked_qty) values(test_uuid(901),test_uuid(21),28,0);set constraints all immediate$q$,'23514','legacy stale writer cannot overreserve protected product');
-- Existing pickup performs both steps in one transaction: deferred invariant must allow it.
insert into inventory_movements(product_id,from_entity_type,to_entity_type,quantity) values(test_uuid(21),'storage','operator',5);
update route_stock_lines set picked_qty=planned_qty where route_id=(:'result'::jsonb->>'routeId')::uuid;
set constraints all immediate;
select test_assert((select quantity_on_hand=25 from route_storage_stock_by_product where product_id=test_uuid(21)),'atomic pickup may deduct and mark picked together');
rollback;

begin;
create function public.test_fail_trip_insert() returns trigger language plpgsql as $$ begin raise exception 'injected failure' using errcode='P0001';end $$;
create trigger zz_test_failure before insert on route_stock_lines for each row execute function test_fail_trip_insert();
select test_error('select test_start(409)','P0001','injected late failure propagates');
select test_assert((select count(*)=0 from routes),'late failure rolls back route');
select test_assert((select count(*)=0 from route_stops),'late failure rolls back stops');
select test_assert((select count(*)=0 from route_stop_items),'late failure rolls back item plan');
select test_assert((select count(*)=0 from smart_work_trip_requests),'late failure rolls back idempotency receipt');
select test_assert((select bool_and(route_stop_id is null and revision=1) from smart_work_duties),'late failure rolls back duty pointers and revisions');
select test_assert((select count(*)=3 from smart_work_duty_events),'late failure rolls back duty audit');
rollback;

begin;
insert into smart_route_slot_product_rules values(test_uuid(11),test_uuid(22),'allowed',4);
do $$ declare p jsonb;r jsonb;begin
p:=test_trip_plan(array[test_uuid(301)]);
p:=jsonb_set(p,'{lanes,0}',p->'lanes'->0||jsonb_build_object('productId',test_uuid(22),'productName','Replacement','take',4,'target',4,'after',4,'removeExpected',1,'action','replace'))||'{"totalUnits":4}';
r:=test_start(410,array[test_uuid(301)],p);
perform test_assert((select planned_qty=4 from route_stock_lines where route_id=(r->>'routeId')::uuid),'replacement uses its verified capacity');
perform test_assert((select notes like '%count and remove%' from route_stop_items where route_id=(r->>'routeId')::uuid),'replacement instructions preserve physical removal step');
perform test_assert((select quantity_on_hand=30 from route_storage_stock_by_product where product_id=test_uuid(21)),'old machine product never becomes warehouse availability');
end $$;
set constraints all immediate;
rollback;

select test_assert((select count(*)=0 from routes),'all isolated checks left no trial routes');
