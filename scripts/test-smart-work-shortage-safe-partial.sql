\set ON_ERROR_STOP on

begin;
update public.smart_work_dispatch_control
set enabled=true,mode='pilot',updated_by=test_uuid(201),updated_at=now()
where id=1;
insert into public.smart_work_dispatch_scope(operator_id,machine_id,created_by)
values
 (test_uuid(201),test_uuid(1),test_uuid(201)),
 (test_uuid(201),test_uuid(2),test_uuid(201))
on conflict do nothing;

do $$
declare p jsonb; r jsonb; l0 jsonb; l1 jsonb;
begin
  p:=test_trip_plan(array[test_uuid(301),test_uuid(302)]);
  l0:=(p->'lanes'->0)||jsonb_build_object('take',2,'after',3,'action','refill','reason','insufficient_stock');
  l1:=(p->'lanes'->1)||jsonb_build_object('take',0,'after',1,'action','keep','reason','keep_remaining');
  p:=jsonb_set(p,'{lanes}',jsonb_build_array(l0,l1));
  p:=p||jsonb_build_object('status','partial','totalUnits',2,'emptyAfter',0,'unknownAfter',0,'underfilled',2,'errors','[]'::jsonb);
  r:=public.snacky_start_smart_work_trip_v1(test_uuid(101),test_uuid(201),test_uuid(701),
      array[test_uuid(301),test_uuid(302)],repeat('a',64),p);
  perform test_assert((r->>'reservedUnits')::int=2,'partial route reserves only positive safe units');
  perform test_assert((r->>'shortageLanes')::int=2,'partial route reports every shortage lane');
  perform test_assert((select sum(planned_qty)=2 and sum(picked_qty)=0 from route_stock_lines where route_id=(r->>'routeId')::uuid),
    'route stock reservation excludes zero-take shortage line');
  perform test_assert((select count(*)=2 from route_stop_items where route_id=(r->>'routeId')::uuid),
    'zero-take shortage lane remains visible on the route');
  perform test_assert((select count(*)=1 from route_stop_items where route_id=(r->>'routeId')::uuid and planned_quantity=0 and notes like 'KNOWN STOCK SHORTAGE%'),
    'zero-take shortage has explicit do-not-substitute instruction');
  perform test_assert((select count(*)=1 from route_stop_items where route_id=(r->>'routeId')::uuid and planned_quantity=2 and notes like 'PARTIAL STOCK%'),
    'partially supplied lane records remaining shortage');
end $$;
set constraints all immediate;
rollback;

begin;
update public.smart_work_dispatch_control
set enabled=true,mode='pilot',updated_by=test_uuid(201),updated_at=now()
where id=1;
insert into public.smart_work_dispatch_scope(operator_id,machine_id,created_by)
values(test_uuid(201),test_uuid(1),test_uuid(201))
on conflict do nothing;
do $$
declare p jsonb; l jsonb;
begin
  p:=test_trip_plan(array[test_uuid(301)]);
  l:=(p->'lanes'->0)||jsonb_build_object('take',0,'after',1,'action','keep','reason','stock_unknown');
  p:=jsonb_set(p,'{lanes}',jsonb_build_array(l));
  p:=p||jsonb_build_object('status','partial','totalUnits',1,'emptyAfter',0,'unknownAfter',0,'underfilled',1,'errors','[]'::jsonb);
  begin
    perform public.snacky_start_smart_work_trip_v1(test_uuid(101),test_uuid(201),test_uuid(702),
      array[test_uuid(301)],repeat('a',64),p);
    raise exception 'unknown stock partial was accepted';
  exception when invalid_parameter_value then null;
  end;
end $$;
select test_assert((select count(*)=0 from routes),'unsafe partial leaves no route');
select test_assert((select count(*)=0 from smart_work_trip_requests),'unsafe partial leaves no receipt');
rollback;
