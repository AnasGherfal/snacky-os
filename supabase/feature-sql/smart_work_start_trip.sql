-- Part 3B: staged transaction layer. Do not enable until real pickup integration is rehearsed.
-- No staffing, duties, routes, quantities or enabled flag are seeded by this script.
create schema if not exists smart_work_dispatch_private;
revoke all on schema smart_work_dispatch_private from public,anon,authenticated;
create table if not exists public.smart_work_dispatch_control (
  id integer primary key check(id=1), enabled boolean not null default false
);
create table if not exists public.smart_work_trip_requests (
  auth_user_id uuid not null, request_id uuid not null, actor_id uuid not null,
  duty_ids uuid[] not null, input_fingerprint text not null,
  route_id uuid not null unique, plan jsonb not null, result jsonb not null,
  created_at timestamptz not null default now(), primary key(auth_user_id,request_id)
);
alter table public.smart_work_dispatch_control enable row level security;
alter table public.smart_work_trip_requests enable row level security;
revoke all on public.smart_work_dispatch_control,public.smart_work_trip_requests from public,anon,authenticated,service_role;
grant select on public.smart_work_dispatch_control to service_role;
grant select,insert on public.smart_work_trip_requests to service_role;

-- Private trigger guards see reservations hidden by operator RLS but grant no write capability.
create or replace function smart_work_dispatch_private.lock_operations()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name<>'smart_work_dispatch_control'
    and not exists(select 1 from public.smart_work_dispatch_control where enabled)
    and not exists(select 1 from public.smart_work_trip_requests q join public.routes r on r.id=q.route_id
      where public.snacky_route_is_reservation_status(r.status::text)) then return null; end if;
  if auth.uid() is null and current_setting('role',true) is distinct from 'service_role' and session_user<>'postgres' then
    raise exception 'Authenticated operation required' using errcode='42501';
  end if;
  -- Fail rather than wait while a legacy pickup might hold its own locks.
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('snacky:smart-trip-operations:v1',0)) then
    raise exception 'Another pickup or trip is being saved. Retry.' using errcode='40001';
  end if;
  return null;
end $$;

create or replace function smart_work_dispatch_private.check_reservations()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.smart_work_trip_requests q join public.routes r on r.id=q.route_id
    where public.snacky_route_is_reservation_status(r.status::text)) then return null; end if;
  if auth.uid() is null and current_setting('role',true) is distinct from 'service_role' and session_user<>'postgres' then
    raise exception 'Authenticated operation required' using errcode='42501';
  end if;
  if exists(
    select 1 from public.smart_work_trip_requests q
    join public.routes r on r.id=q.route_id and public.snacky_route_is_reservation_status(r.status::text)
    join public.route_stops s on s.route_id=r.id and s.status::text not in ('completed','skipped','canceled','cancelled')
    join public.route_stops other on other.machine_id=s.machine_id and other.id<>s.id
      and other.status::text not in ('completed','skipped','canceled','cancelled')
    join public.routes r2 on r2.id=other.route_id and public.snacky_route_is_reservation_status(r2.status::text)
  ) then raise exception 'Machine already has an open Smart Work trip' using errcode='23505'; end if;
  if exists(
    with protected as (
      select distinct l.product_id from public.smart_work_trip_requests q
      join public.routes r on r.id=q.route_id and public.snacky_route_is_reservation_status(r.status::text)
      join public.route_stock_lines l on l.route_id=r.id where l.planned_qty>l.picked_qty
    ), reserved as (
      select l.product_id,sum(greatest(0,l.planned_qty-l.picked_qty)) qty
      from public.route_stock_lines l join protected p using(product_id)
      join public.routes r on r.id=l.route_id and public.snacky_route_is_reservation_status(r.status::text)
      group by l.product_id
    ) select 1 from reserved r left join public.route_storage_stock_by_product s using(product_id)
      where r.qty>greatest(0,coalesce(s.quantity_on_hand,0))
  ) then raise exception 'Storage is insufficient after existing trip reservations' using errcode='23514'; end if;
  return null;
end $$;
revoke all on function smart_work_dispatch_private.lock_operations(),smart_work_dispatch_private.check_reservations() from public,anon,authenticated,service_role;

-- Release toggles share the commit mutex. Application keeps SELECT-only permission on the gate.
drop trigger if exists smart_work_dispatch_toggle_lock on public.smart_work_dispatch_control;
create trigger smart_work_dispatch_toggle_lock before insert or update or delete or truncate
  on public.smart_work_dispatch_control for each statement execute function smart_work_dispatch_private.lock_operations();

-- Deferred checks allow existing atomic pickup to deduct stock AND mark it picked.
do $$ declare t text; begin
  foreach t in array array['routes','route_stops','route_stock_lines','inventory_movements'] loop
    execute format('drop trigger if exists smart_work_trip_write_lock on public.%I',t);
    execute format('create trigger smart_work_trip_write_lock before insert or update or delete on public.%I for each statement execute function smart_work_dispatch_private.lock_operations()',t);
    execute format('drop trigger if exists smart_work_trip_reservation_check on public.%I',t);
    execute format('create constraint trigger smart_work_trip_reservation_check after insert or update or delete on public.%I deferrable initially deferred for each row execute function smart_work_dispatch_private.check_reservations()',t);
  end loop;
end $$;

create or replace function public.snacky_start_smart_work_trip_v1(
  p_auth_user uuid,p_actor uuid,p_request uuid,p_duty_ids uuid[],p_fingerprint text,p_plan jsonb
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  person public.team_members%rowtype; saved public.smart_work_trip_requests%rowtype;
  d public.smart_work_duties%rowtype; cfg jsonb; shift jsonb; lane jsonb; actual record;
  req_ids uuid[]; machine_ids uuid[]; route_id_new uuid; stop_id_new uuid;
  ts timestamptz:=clock_timestamp(); local_day date; weekday integer;
  cursor_at timestamptz; finish_at timestamptz; shift_end timestamptz; shift_start timestamptz;
  available_minutes integer; consumed_minutes integer; trip_minutes integer:=0; cost integer;
  picked_product uuid; target integer; take_qty integer; remove_qty integer; expected_count integer;
  result jsonb;
begin
  if p_auth_user is null or p_actor is null or p_request is null then raise exception 'Invalid identity' using errcode='42501'; end if;
  select * into person from public.team_members where id=p_actor and auth_user_id=p_auth_user;
  if not found or person.active is distinct from true or person.active_status::text is distinct from 'active'
    or coalesce(person.must_change_password,false)
    or not (array[person.role::text]||coalesce(person.roles::text[],'{}')) && array['operator','owner','admin','supervisor'] then
    raise exception 'Active operator identity required' using errcode='42501';
  end if;
  if p_duty_ids is null or cardinality(p_duty_ids) not between 1 and 6 or array_ndims(p_duty_ids)<>1
    or array_position(p_duty_ids,null) is not null or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid trip request' using errcode='22023';
  end if;
  select array_agg(x order by x) into req_ids from (select distinct unnest(p_duty_ids) x) a;
  if cardinality(req_ids)<>cardinality(p_duty_ids) then raise exception 'Duplicate duties' using errcode='22023'; end if;
  if not pg_try_advisory_xact_lock(hashtextextended('snacky:daily-duty-refresh:v1',0))
    or not pg_try_advisory_xact_lock(hashtextextended('snacky:smart-trip-operations:v1',0)) then
    raise exception 'Work is changing. Retry.' using errcode='40001';
  end if;
  select * into saved from public.smart_work_trip_requests where auth_user_id=p_auth_user and request_id=p_request;
  if found then
    if saved.actor_id<>p_actor or saved.duty_ids<>req_ids or saved.input_fingerprint<>p_fingerprint then
      raise exception 'Request key was already used for a different trip' using errcode='40001';
    end if;
    return saved.result||jsonb_build_object('replayed',true);
  end if;
  if not exists(select 1 from public.smart_work_dispatch_control where id=1 and enabled) then
    raise exception 'Smart Work dispatch is not enabled' using errcode='55000';
  end if;
  if jsonb_typeof(p_plan) is distinct from 'object' or p_plan->>'status' is distinct from 'complete'
    or jsonb_typeof(p_plan->'lanes') is distinct from 'array'
    or jsonb_typeof(p_plan->'generatedAt') is distinct from 'string'
    or jsonb_typeof(p_plan->'expiresAt') is distinct from 'string'
    or jsonb_typeof(p_plan->'totalUnits') is distinct from 'number' then
    raise exception 'A current complete product plan is required' using errcode='22023';
  end if;
  if jsonb_array_length(p_plan->'lanes') not between 1 and 600
    or not isfinite((p_plan->>'expiresAt')::timestamptz) or not isfinite((p_plan->>'generatedAt')::timestamptz)
    or (p_plan->>'expiresAt')::timestamptz<=ts or (p_plan->>'expiresAt')::timestamptz>ts+interval '5 minutes'
    or (p_plan->>'generatedAt')::timestamptz not between ts-interval '5 minutes' and ts+interval '1 minute'
    or (p_plan->>'totalUnits')::integer not between 1 and 600000 then
    raise exception 'A current complete product plan is required' using errcode='22023';
  end if;
  -- Do not lock the read-only gate using a mode requiring UPDATE. Its trigger uses our mutex.
  -- Read locks stabilize role/rule/slot changes and both sources of the latest-stock view.
  lock table public.team_members,public.smart_work_coverage_settings,public.machines,public.machine_slots,
    public.products,public.smart_route_slot_product_rules,public.smart_route_location_product_rules,
    public.smart_route_machine_context,public.locations,public.vms_stock_snapshots,public.vms_import_batches
    in share mode nowait;
  select * into person from public.team_members where id=p_actor and auth_user_id=p_auth_user;
  if not found or person.active is distinct from true or person.active_status::text is distinct from 'active'
    or coalesce(person.must_change_password,false)
    or not (array[person.role::text]||coalesce(person.roles::text[],'{}')) && array['operator','owner','admin','supervisor'] then
    raise exception 'Operator identity changed' using errcode='42501';
  end if;
  perform 1 from public.smart_work_duties where id=any(req_ids) order by id for update;
  if (select count(*) from public.smart_work_duties where id=any(req_ids) and owner_id=p_actor
       and state='required' and blocker is null and route_stop_id is null and due_at is not null)<>cardinality(req_ids) then
    raise exception 'A duty changed, is blocked, or belongs to another operator' using errcode='40001';
  end if;
  select array_agg(machine_id order by machine_id) into machine_ids from public.smart_work_duties where id=any(req_ids);
  if (select count(distinct x) from unnest(machine_ids) x)<>cardinality(req_ids) then
    raise exception 'Duplicate machine duties' using errcode='22023';
  end if;
  if exists(select 1 from public.route_stops s join public.routes r on r.id=s.route_id
    where s.machine_id=any(machine_ids) and public.snacky_route_is_reservation_status(r.status::text)
      and s.status::text not in ('completed','skipped','canceled','cancelled')) then
    raise exception 'A machine is already assigned to an open trip' using errcode='40001';
  end if;
  if exists(select 1 from public.smart_work_duties other where other.owner_id=p_actor and other.state='required'
    and other.blocker is null and other.route_stop_id is null and not(other.id=any(req_ids))
    and exists(select 1 from public.smart_work_duties chosen where chosen.id=any(req_ids)
      and (case other.priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,other.due_at,other.required_at)
        < (case chosen.priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,chosen.due_at,chosen.required_at))) then
    raise exception 'Higher priority required work must be handled or have a recorded blocker first' using errcode='40001';
  end if;
  local_day:=(ts at time zone 'Africa/Tripoli')::date;
  weekday:=extract(isodow from local_day);
  select value into cfg from public.smart_work_coverage_settings where kind='operator' and operator_id=p_actor;
  if cfg is null or cfg->>'enabled' is distinct from 'true' then raise exception 'Approved operator work hours required' using errcode='22023'; end if;
  select x into shift from jsonb_array_elements(cfg->'windows') x where (x->>'day')::integer=weekday;
  if shift is null then raise exception 'Operator has no work window today' using errcode='22023'; end if;
  shift_start:=(local_day::text||' '||(shift->>'start'))::timestamp at time zone 'Africa/Tripoli';
  shift_end:=(local_day::text||' '||(shift->>'end'))::timestamp at time zone 'Africa/Tripoli';
  available_minutes:=(shift->>'minutes')::integer;
  if ts<shift_start or ts>=shift_end then raise exception 'Outside approved work hours' using errcode='22023'; end if;
  cursor_at:=ts;
  if exists(select 1 from public.smart_work_duties where owner_id=p_actor and not(id=any(req_ids)) and expected_minutes is null
    and ((completed_at at time zone 'Africa/Tripoli')::date=local_day or (completed_at is null and route_stop_id is not null))) then
    raise exception 'Existing work duration is not configured' using errcode='22023';
  end if;
  select coalesce(sum(expected_minutes),0) into consumed_minutes from public.smart_work_duties
    where owner_id=p_actor and not(id=any(req_ids)) and
      ((completed_at at time zone 'Africa/Tripoli')::date=local_day or (completed_at is null and route_stop_id is not null));
  if exists(select 1 from public.routes r join public.route_stops s on s.route_id=r.id
    where r.operator_id=p_actor and public.snacky_route_is_reservation_status(r.status::text)
      and s.status::text not in ('completed','skipped','canceled','cancelled')
      and not exists(select 1 from public.smart_work_duties x where x.route_stop_id=s.id and x.completed_at is null)) then
    raise exception 'Refresh required duties to account for existing manual trips first' using errcode='40001';
  end if;
  for d in select * from public.smart_work_duties where id=any(req_ids)
    order by case priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,due_at,required_at,id loop
    select value into cfg from public.smart_work_coverage_settings where kind='machine' and machine_id=d.machine_id;
    if cfg is null or cfg->>'enabled' is distinct from 'true' or not((cfg->'days') @> to_jsonb(array[weekday]))
      or p_actor::text not in (cfg->>'primaryId',coalesce(cfg->>'backupId','')) then
      raise exception 'Approved machine coverage is missing or changed' using errcode='22023';
    end if;
    cost:=(cfg->>'travelMinutes')::integer+(cfg->>'serviceMinutes')::integer;
    trip_minutes:=trip_minutes+cost;
    finish_at:=greatest(cursor_at+make_interval(mins=>(cfg->>'travelMinutes')::integer),
      (local_day::text||' '||(cfg->>'accessStart'))::timestamp at time zone 'Africa/Tripoli')
      +make_interval(mins=>(cfg->>'serviceMinutes')::integer);
    if finish_at>shift_end or finish_at>((local_day::text||' '||(cfg->>'accessEnd'))::timestamp at time zone 'Africa/Tripoli')
      or (d.due_at>ts and finish_at>d.due_at) or trip_minutes+consumed_minutes>available_minutes then
      raise exception 'Selected trip does not fit the approved work/access window' using errcode='22023';
    end if;
    cursor_at:=finish_at;
  end loop;
  select count(*) into expected_count from public.machine_slots where machine_id=any(machine_ids)
    and active and trim(slot_code)~'^[0-9]{1,4}$';
  if expected_count<>jsonb_array_length(p_plan->'lanes') or expected_count=0
    or (select count(distinct x->>'slotId') from jsonb_array_elements(p_plan->'lanes') x)<>expected_count then
    raise exception 'Every usable lane must be included exactly once' using errcode='22023';
  end if;
  for lane in select x from jsonb_array_elements(p_plan->'lanes') x loop
    if jsonb_typeof(lane) is distinct from 'object' or not(lane ?& array['machineId','slotId','code','originalProductId','productId','current','originalCapacity','target','take','removeExpected','after','action'])
      or exists(select 1 from unnest(array['current','originalCapacity','target','take','removeExpected','after']) k where jsonb_typeof(lane->k) is distinct from 'number') then
      raise exception 'Missing lane fields' using errcode='22023';
    end if;
    if (lane->>'machineId')::uuid is null or (lane->>'machineId')::uuid<>all(machine_ids) then
      raise exception 'Unexpected machine' using errcode='22023';
    end if;
    select s.id,s.machine_id,s.slot_code,r.product_id,r.current_qty,r.capacity,r.captured_at,m.location_id,
      coalesce(c.location_type,l.location_type) as location_type into actual
    from public.machine_slots s join public.machines m on m.id=s.machine_id and m.status::text='active'
    join public.latest_vms_stock_by_slot r on r.machine_id=s.machine_id
      and (case when trim(r.slot_code)~'^[0-9]{1,4}$' then trim(r.slot_code)::integer end)
        = (case when trim(s.slot_code)~'^[0-9]{1,4}$' then trim(s.slot_code)::integer end)
      and r.source_provider='xy'
    left join public.smart_route_machine_context c on c.machine_id=m.id
    left join public.locations l on l.id=m.location_id
    where s.id=(lane->>'slotId')::uuid and s.active and s.machine_id=(lane->>'machineId')::uuid;
    if not found or actual.product_id is null or actual.current_qty is null or actual.capacity is null or actual.captured_at is null
      or actual.capacity not between 1 and 1000 or actual.current_qty not between 0 and actual.capacity
      or actual.captured_at not between ts-interval '30 minutes' and ts+interval '1 minute'
      or actual.product_id is distinct from (lane->>'originalProductId')::uuid
      or actual.current_qty is distinct from (lane->>'current')::integer
      or actual.capacity is distinct from (lane->>'originalCapacity')::integer
      or trim(actual.slot_code)::integer is distinct from (lane->>'code')::integer then
      raise exception 'Lane reading changed or cannot be verified' using errcode='40001';
    end if;
    if (select count(*) from public.latest_vms_stock_by_slot r where r.machine_id=actual.machine_id and r.source_provider='xy'
      and (case when trim(r.slot_code)~'^[0-9]{1,4}$' then trim(r.slot_code)::integer end)=trim(actual.slot_code)::integer)<>1
      or (select count(*) from public.machine_slots s where s.machine_id=actual.machine_id
        and (case when trim(s.slot_code)~'^[0-9]{1,4}$' then trim(s.slot_code)::integer end)=trim(actual.slot_code)::integer)<>1 then
      raise exception 'Duplicate lane definitions need review' using errcode='22023';
    end if;
    picked_product:=(lane->>'productId')::uuid;target:=(lane->>'target')::integer;
    take_qty:=(lane->>'take')::integer;remove_qty:=(lane->>'removeExpected')::integer;
    if picked_product is null or target not between 1 and 1000 or take_qty not between 0 and 1000
      or not exists(select 1 from public.products where id=picked_product and active)
      or (lane->>'after')::integer is distinct from target then
      raise exception 'Invalid complete lane plan' using errcode='22023';
    end if;
    if exists(select 1 from public.smart_route_slot_product_rules where machine_slot_id=actual.id and product_id=picked_product and rule='prohibited')
      or exists(select 1 from public.smart_route_location_product_rules where product_id=picked_product and rule='prohibited'
        and (machine_id=actual.machine_id or location_id=actual.location_id or location_type=actual.location_type)) then
      raise exception 'Product is prohibited at this machine or lane' using errcode='22023';
    end if;
    if picked_product=actual.product_id then
      if target<>actual.capacity or take_qty<>target-actual.current_qty or remove_qty<>0
        or (lane->>'action') is distinct from (case when take_qty=0 then 'keep' else 'refill' end) then
        raise exception 'Current product refill quantities changed' using errcode='40001';
      end if;
    else
      if take_qty<>target or remove_qty<>actual.current_qty or target<actual.current_qty
        or lane->>'action' is distinct from 'replace'
        or not exists(select 1 from public.smart_route_slot_product_rules where machine_slot_id=actual.id
          and product_id=picked_product and rule='allowed' and verified_capacity=target) then
        raise exception 'Replacement needs verified fit, capacity and full stock' using errcode='22023';
      end if;
    end if;
  end loop;
  if exists(select 1 from public.latest_vms_stock_by_slot r where r.machine_id=any(machine_ids) and r.source_provider='xy'
    and trim(r.slot_code)~'^[0-9]{1,4}$' and not exists(select 1 from public.machine_slots s where s.machine_id=r.machine_id
      and (case when trim(s.slot_code)~'^[0-9]{1,4}$' then trim(s.slot_code)::integer end)
        =(case when trim(r.slot_code)~'^[0-9]{1,4}$' then trim(r.slot_code)::integer end))) then
    raise exception 'XY has an unconfigured lane' using errcode='22023';
  end if;
  if exists(with needed as (
    select (x->>'productId')::uuid product_id,sum((x->>'take')::integer) qty from jsonb_array_elements(p_plan->'lanes') x group by 1
  ), reserved as (
    select l.product_id,sum(greatest(0,l.planned_qty-l.picked_qty)) qty from public.route_stock_lines l
      join public.routes r on r.id=l.route_id and public.snacky_route_is_reservation_status(r.status::text) group by 1
  ) select 1 from needed n left join public.route_storage_stock_by_product s using(product_id) left join reserved r using(product_id)
    where n.qty>greatest(0,coalesce(s.quantity_on_hand,0)-coalesce(r.qty,0))) then
    raise exception 'Storage changed or is insufficient after reservations' using errcode='23514';
  end if;
  if (select sum((x->>'take')::integer) from jsonb_array_elements(p_plan->'lanes') x)<>(p_plan->>'totalUnits')::integer then
    raise exception 'Product totals do not match lane quantities' using errcode='22023';
  end if;
  route_id_new:=gen_random_uuid();
  result:=jsonb_build_object('routeId',route_id_new,'href','/operator/routes/'||route_id_new::text,
    'stopCount',cardinality(req_ids),'reservedUnits',(p_plan->>'totalUnits')::integer,'replayed',false);
  insert into public.smart_work_trip_requests(auth_user_id,request_id,actor_id,duty_ids,input_fingerprint,route_id,plan,result)
    values(p_auth_user,p_request,p_actor,req_ids,p_fingerprint,route_id_new,p_plan,result);
  insert into public.routes(id,route_date,operator_id,status,created_by,notes)
    values(route_id_new,local_day,p_actor,'assigned',p_actor,'Smart Work: selected required stops. Stock reserved; pickup not yet confirmed.');
  expected_count:=0;
  for d in select * from public.smart_work_duties where id=any(req_ids)
    order by case priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,due_at,required_at,id loop
    expected_count:=expected_count+1;stop_id_new:=gen_random_uuid();
    insert into public.route_stops(id,route_id,machine_id,stop_order,status)
      values(stop_id_new,route_id_new,d.machine_id,expected_count,'pending');
    for lane in select x from jsonb_array_elements(p_plan->'lanes') x where (x->>'machineId')::uuid=d.machine_id and (x->>'take')::integer>0 loop
      insert into public.route_stop_items(route_id,route_stop_id,machine_id,product_id,machine_slot_id,slot_code,
        planned_quantity,recommended_take_qty,final_take_qty,source,notes,slot_allocations)
      values(route_id_new,stop_id_new,d.machine_id,(lane->>'productId')::uuid,(lane->>'slotId')::uuid,lane->>'code',
        (lane->>'take')::integer,(lane->>'take')::integer,(lane->>'take')::integer,'refill_recommendation',
        case when lane->>'action'='replace' then format('PRODUCT CHANGE — lane %s: count and remove remaining %s first (expected %s). Record actual removal, change and verify XY product to %s, then fill %s. Never mix products; removed units are not yet returned warehouse stock.',lane->>'code',lane->>'originalName',lane->>'removeExpected',lane->>'productName',lane->>'take')
          else 'Smart Work verified product plan.' end,
        jsonb_build_array(jsonb_build_object('machine_slot_id',lane->>'slotId','slot_code',lane->>'code',
          'current_qty',case when lane->>'action'='replace' then 0 else (lane->>'current')::integer end,
          'target_qty',(lane->>'target')::integer,'recommended_take_qty',(lane->>'take')::integer,'final_take_qty',(lane->>'take')::integer,'allocation_kind','slot')));
    end loop;
    update public.smart_work_duties set route_stop_id=stop_id_new,revision=revision+1,updated_by=p_actor,updated_at=ts where id=d.id;
  end loop;
  insert into public.route_stock_lines(route_id,product_id,planned_qty,picked_qty,returned_qty)
    select route_id_new,(x->>'productId')::uuid,sum((x->>'take')::integer)::integer,0,0
      from jsonb_array_elements(p_plan->'lanes') x where (x->>'take')::integer>0 group by 2;
  return result;
end $$;
revoke all on function public.snacky_start_smart_work_trip_v1(uuid,uuid,uuid,uuid[],text,jsonb) from public,anon,authenticated;
grant execute on function public.snacky_start_smart_work_trip_v1(uuid,uuid,uuid,uuid[],text,jsonb) to service_role;
