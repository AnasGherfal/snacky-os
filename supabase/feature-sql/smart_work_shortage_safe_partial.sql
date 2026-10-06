-- Shortage-safe Smart Work partial refill release.
-- Known warehouse shortages may create a route only when all lane readings/mappings are verified.
-- Unknown stock, stale/unmapped/restricted lanes remain hard blockers. No rollout scope or data is seeded here.
create or replace function public.snacky_start_smart_work_trip_v1(
  p_auth_user uuid,p_actor uuid,p_request uuid,p_duty_ids uuid[],p_fingerprint text,p_plan jsonb
) returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  person public.team_members%rowtype; saved public.smart_work_trip_requests%rowtype;
  d public.smart_work_duties%rowtype; cfg jsonb; shift jsonb; lane jsonb; actual record;
  req_ids uuid[]; machine_ids uuid[]; route_id_new uuid; stop_id_new uuid;
  ts timestamptz:=clock_timestamp(); local_day date; weekday integer;
  cursor_at timestamptz; finish_at timestamptz; shift_end timestamptz; shift_start timestamptz;
  available_minutes integer; consumed_minutes integer:=0; trip_minutes integer:=0; cost integer; day_only boolean:=false;
  picked_product uuid; target integer; take_qty integer; remove_qty integer; expected_count integer;
  result jsonb; dispatch_mode text;
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
  select coalesce(mode,'all') into dispatch_mode from public.smart_work_dispatch_control where id=1 and enabled;
  if dispatch_mode is null or dispatch_mode not in ('pilot','all') then
    raise exception 'Smart Work dispatch is not enabled' using errcode='55000';
  end if;
  if dispatch_mode='pilot' and not exists(
    select 1 from public.smart_work_dispatch_scope where operator_id=p_actor
  ) then
    raise exception 'Operator is outside the Smart Work pilot' using errcode='42501';
  end if;
  if jsonb_typeof(p_plan) is distinct from 'object' or p_plan->>'status' not in ('complete','partial')
    or jsonb_typeof(p_plan->'lanes') is distinct from 'array'
    or jsonb_typeof(p_plan->'generatedAt') is distinct from 'string'
    or jsonb_typeof(p_plan->'expiresAt') is distinct from 'string'
    or jsonb_typeof(p_plan->'totalUnits') is distinct from 'number'
    or jsonb_typeof(p_plan->'unknownAfter') is distinct from 'number'
    or jsonb_typeof(p_plan->'errors') is distinct from 'array' then
    raise exception 'A current safe product plan is required' using errcode='22023';
  end if;
  if jsonb_array_length(p_plan->'lanes') not between 1 and 600
    or not isfinite((p_plan->>'expiresAt')::timestamptz) or not isfinite((p_plan->>'generatedAt')::timestamptz)
    or (p_plan->>'expiresAt')::timestamptz<=ts or (p_plan->>'expiresAt')::timestamptz>ts+interval '5 minutes'
    or (p_plan->>'generatedAt')::timestamptz not between ts-interval '5 minutes' and ts+interval '1 minute'
    or (p_plan->>'totalUnits')::integer not between 1 and 600000
    or (p_plan->>'unknownAfter')::integer<>0
    or jsonb_array_length(p_plan->'errors')<>0 then
    raise exception 'A current safe product plan is required' using errcode='22023';
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
       and state='required' and blocker is null and route_stop_id is null)<>cardinality(req_ids) then
    raise exception 'A duty changed, is blocked, or belongs to another operator' using errcode='40001';
  end if;
  select array_agg(machine_id order by machine_id) into machine_ids from public.smart_work_duties where id=any(req_ids);
  if (select count(distinct x) from unnest(machine_ids) x)<>cardinality(req_ids) then
    raise exception 'Duplicate machine duties' using errcode='22023';
  end if;
  if dispatch_mode='pilot' and exists(
    select 1 from unnest(machine_ids) x(machine_id)
    where not exists(
      select 1 from public.smart_work_dispatch_scope s
      where s.operator_id=p_actor and s.machine_id=x.machine_id
    )
  ) then
    raise exception 'Selected machine is outside the Smart Work pilot' using errcode='42501';
  end if;
  if exists(select 1 from public.route_stops s join public.routes r on r.id=s.route_id
    where s.machine_id=any(machine_ids) and public.snacky_route_is_reservation_status(r.status::text)
      and s.status::text not in ('completed','skipped','canceled','cancelled')) then
    raise exception 'A machine is already assigned to an open trip' using errcode='40001';
  end if;
  if exists(select 1 from public.smart_work_duties other where other.owner_id=p_actor and other.state='required'
    and other.blocker is null and other.route_stop_id is null and not(other.id=any(req_ids))
    and exists(select 1 from public.smart_work_duties chosen where chosen.id=any(req_ids)
      and (case other.priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,coalesce(other.due_at,'infinity'::timestamptz),other.required_at)
        < (case chosen.priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,coalesce(chosen.due_at,'infinity'::timestamptz),chosen.required_at))) then
    raise exception 'Higher priority required work must be handled or have a recorded blocker first' using errcode='40001';
  end if;
  local_day:=(ts at time zone 'Africa/Tripoli')::date;
  weekday:=extract(isodow from local_day);
  select value into cfg from public.smart_work_coverage_settings where kind='operator' and operator_id=p_actor;
  if cfg is null or cfg->>'enabled' is distinct from 'true' then raise exception 'Approved operator availability required' using errcode='22023'; end if;
  if cfg->>'mode'='days' then
    day_only:=true;
    if jsonb_typeof(cfg->'days') is distinct from 'array'
      or not ((cfg->'days') @> to_jsonb(array[weekday])) then
      raise exception 'Operator is not available today' using errcode='22023';
    end if;
  else
    select x into shift from jsonb_array_elements(cfg->'windows') x where (x->>'day')::integer=weekday;
    if shift is null then raise exception 'Operator has no work window today' using errcode='22023'; end if;
    shift_start:=(local_day::text||' '||(shift->>'start'))::timestamp at time zone 'Africa/Tripoli';
    shift_end:=(local_day::text||' '||(shift->>'end'))::timestamp at time zone 'Africa/Tripoli';
    available_minutes:=(shift->>'minutes')::integer;
    if ts<shift_start or ts>=shift_end then raise exception 'Outside approved work hours' using errcode='22023'; end if;
  end if;
  cursor_at:=ts;
  if not day_only then
    if exists(select 1 from public.smart_work_duties where owner_id=p_actor and not(id=any(req_ids)) and expected_minutes is null
      and ((completed_at at time zone 'Africa/Tripoli')::date=local_day or (completed_at is null and route_stop_id is not null))) then
      raise exception 'Existing work duration is not configured' using errcode='22023';
    end if;
    select coalesce(sum(expected_minutes),0) into consumed_minutes from public.smart_work_duties
      where owner_id=p_actor and not(id=any(req_ids)) and
        ((completed_at at time zone 'Africa/Tripoli')::date=local_day or (completed_at is null and route_stop_id is not null));
  end if;
  if exists(select 1 from public.routes r join public.route_stops s on s.route_id=r.id
    where r.operator_id=p_actor and public.snacky_route_is_reservation_status(r.status::text)
      and s.status::text not in ('completed','skipped','canceled','cancelled')
      and not exists(select 1 from public.smart_work_duties x where x.route_stop_id=s.id and x.completed_at is null)) then
    raise exception 'Refresh required duties to account for existing manual trips first' using errcode='40001';
  end if;
  for d in select * from public.smart_work_duties where id=any(req_ids)
    order by case priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,due_at,required_at,id loop
    select value into cfg from public.smart_work_coverage_settings where kind='machine' and machine_id=d.machine_id;
    if cfg is null or cfg->>'enabled' is distinct from 'true'
      or p_actor::text not in (cfg->>'primaryId',coalesce(cfg->>'backupId','')) then
      raise exception 'Approved machine coverage is missing or changed' using errcode='22023';
    end if;
    if cfg->>'mode' is distinct from 'standing' then
      if not((cfg->'days') @> to_jsonb(array[weekday])) then
        raise exception 'Machine is not available for service today' using errcode='22023';
      end if;
      cost:=(cfg->>'travelMinutes')::integer+(cfg->>'serviceMinutes')::integer;
      trip_minutes:=trip_minutes+cost;
      finish_at:=greatest(cursor_at+make_interval(mins=>(cfg->>'travelMinutes')::integer),
        (local_day::text||' '||(cfg->>'accessStart'))::timestamp at time zone 'Africa/Tripoli')
        +make_interval(mins=>(cfg->>'serviceMinutes')::integer);
      if finish_at>((local_day::text||' '||(cfg->>'accessEnd'))::timestamp at time zone 'Africa/Tripoli')
        or (d.due_at is not null and d.due_at>ts and finish_at>d.due_at)
        or (not day_only and (finish_at>shift_end or trip_minutes+consumed_minutes>available_minutes)) then
        raise exception 'Selected trip does not fit the approved work/access window' using errcode='22023';
      end if;
      cursor_at:=finish_at;
    end if;
  end loop;
  select count(*) into expected_count from public.machine_slots where machine_id=any(machine_ids)
    and active and trim(slot_code)~'^[0-9]{1,4}$';
  if expected_count<>jsonb_array_length(p_plan->'lanes') or expected_count=0
    or (select count(distinct x->>'slotId') from jsonb_array_elements(p_plan->'lanes') x)<>expected_count then
    raise exception 'Every usable lane must be included exactly once' using errcode='22023';
  end if;
  for lane in select x from jsonb_array_elements(p_plan->'lanes') x loop
    if jsonb_typeof(lane) is distinct from 'object' or not(lane ?& array['machineId','slotId','code','originalProductId','productId','current','originalCapacity','target','take','removeExpected','after','action','reason'])
      or exists(select 1 from unnest(array['current','originalCapacity','target','take','removeExpected','after']) k where jsonb_typeof(lane->k) is distinct from 'number') then
      raise exception 'Missing lane fields' using errcode='22023';
    end if;
    if lane->>'action'='exception' or lane->>'reason' in ('verify_lane','missing_mapping','restricted','stock_unknown') then
      raise exception 'Unsafe lane requires verification before dispatch' using errcode='22023';
    end if;
    if (lane->>'machineId')::uuid is null or (lane->>'machineId')::uuid<>all(machine_ids) then
      raise exception 'Unexpected machine' using errcode='22023';
    end if;
    select s.id,s.machine_id,s.slot_code,r.product_id,r.current_qty,r.capacity,r.captured_at,m.location_id,
      coalesce(c.location_type,l.location_type::text) as location_type into actual
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
      or remove_qty not between 0 and 1000
      or (lane->>'after')::integer not between 0 and target
      or not exists(select 1 from public.products where id=picked_product and active) then
      raise exception 'Invalid lane plan' using errcode='22023';
    end if;
    if exists(select 1 from public.smart_route_slot_product_rules where machine_slot_id=actual.id and product_id=picked_product and rule='prohibited')
      or exists(select 1 from public.smart_route_location_product_rules where product_id=picked_product and rule='prohibited'
        and (machine_id=actual.machine_id or location_id=actual.location_id or location_type=actual.location_type)) then
      raise exception 'Product is prohibited at this machine or lane' using errcode='22023';
    end if;
    if picked_product=actual.product_id then
      if target<>actual.capacity or remove_qty<>0
        or take_qty>target-actual.current_qty
        or (lane->>'after')::integer<>actual.current_qty+take_qty
        or (lane->>'action') is distinct from (case when take_qty=0 then 'keep' else 'refill' end)
        or (take_qty=0 and (lane->>'after')::integer<target and lane->>'reason' not in ('no_compatible_stock','keep_remaining'))
        or (take_qty>0 and (lane->>'after')::integer<target and lane->>'reason'<>'insufficient_stock') then
        raise exception 'Current product refill quantities changed' using errcode='40001';
      end if;
    else
      if lane->>'action' is distinct from 'replace'
        or target<actual.current_qty
        or not exists(select 1 from public.smart_route_slot_product_rules where machine_slot_id=actual.id
          and product_id=picked_product and rule='allowed' and verified_capacity=target)
        or (actual.current_qty>0 and (take_qty<>target or remove_qty<>actual.current_qty or (lane->>'after')::integer<>target))
        or (actual.current_qty=0 and (remove_qty<>0 or take_qty not between 1 and target or (lane->>'after')::integer<>take_qty)) then
        raise exception 'Replacement needs verified fit and safe quantities' using errcode='22023';
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
    'stopCount',cardinality(req_ids),'reservedUnits',(p_plan->>'totalUnits')::integer,
    'shortageLanes',(select count(*) from jsonb_array_elements(p_plan->'lanes') x where (x->>'after')::integer<(x->>'target')::integer),
    'replayed',false);
  insert into public.smart_work_trip_requests(auth_user_id,request_id,actor_id,duty_ids,input_fingerprint,route_id,plan,result)
    values(p_auth_user,p_request,p_actor,req_ids,p_fingerprint,route_id_new,p_plan,result);
  insert into public.routes(id,route_date,operator_id,status,created_by,notes)
    values(route_id_new,local_day,p_actor,'assigned',p_actor,
      format('Smart Work: selected required stops. Stock reserved; pickup not yet confirmed. Known shortage lanes: %s.',
        (select count(*) from jsonb_array_elements(p_plan->'lanes') x where (x->>'after')::integer<(x->>'target')::integer)));
  expected_count:=0;
  for d in select * from public.smart_work_duties where id=any(req_ids)
    order by case priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,due_at,required_at,id loop
    expected_count:=expected_count+1;stop_id_new:=gen_random_uuid();
    insert into public.route_stops(id,route_id,machine_id,stop_order,status)
      values(stop_id_new,route_id_new,d.machine_id,expected_count,'pending');
    for lane in
      select x from jsonb_array_elements(p_plan->'lanes') x
      where (x->>'machineId')::uuid=d.machine_id
        and ((x->>'take')::integer>0 or (x->>'after')::integer<(x->>'target')::integer)
    loop
      insert into public.route_stop_items(route_id,route_stop_id,machine_id,product_id,machine_slot_id,slot_code,
        planned_quantity,recommended_take_qty,final_take_qty,source,notes,slot_allocations)
      values(route_id_new,stop_id_new,d.machine_id,(lane->>'productId')::uuid,(lane->>'slotId')::uuid,lane->>'code',
        (lane->>'take')::integer,(lane->>'take')::integer,(lane->>'take')::integer,'refill_recommendation',
        case
          when (lane->>'take')::integer=0 and (lane->>'after')::integer<(lane->>'target')::integer then
            format('KNOWN STOCK SHORTAGE — lane %s: leave %s unchanged at %s/%s. Do not substitute unless separately approved. Duty stays unresolved until current evidence shows the machine healthy.',lane->>'code',lane->>'productName',lane->>'after',lane->>'target')
          when lane->>'action'='replace' then
            format('PRODUCT CHANGE — lane %s: count and remove remaining %s first (expected %s). Record actual removal, change and verify XY product to %s, then fill %s/%s. Never mix products; removed units are not yet returned warehouse stock.%s',lane->>'code',lane->>'originalName',lane->>'removeExpected',lane->>'productName',lane->>'after',lane->>'target',case when (lane->>'after')::integer<(lane->>'target')::integer then ' Known stock shortage remains.' else '' end)
          when (lane->>'after')::integer<(lane->>'target')::integer then
            format('PARTIAL STOCK — lane %s: take %s of %s; planned result %s/%s. Known shortage remains visible and the duty is not completed by this plan.',lane->>'code',lane->>'take',lane->>'productName',lane->>'after',lane->>'target')
          else 'Smart Work verified product plan.'
        end,
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

create or replace function public.snacky_refresh_smart_work_duties(p_actor uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  v_now timestamptz:=now(); v_day date:=(now() at time zone 'Africa/Tripoli')::date;
  o record; d public.smart_work_duties%rowtype; old_d public.smart_work_duties%rowtype;
  observations jsonb; cfg jsonb; opcfg jsonb; w jsonb; first_day date; access_day date; deadline timestamptz;
  person uuid; candidates uuid[]; route_ids uuid[]; route_owner uuid; proof record;
  cost integer; busy integer; spent integer; other_cost integer; missing_cost integer;
  shift_start timestamptz; shift_end timestamptz; site_start timestamptz; site_end timestamptz;
  start_at timestamptz; finish_at timestamptz; added integer:=0; changed integer:=0;
begin
  if not exists(select 1 from public.team_members t where t.id=p_actor and t.active
    and t.active_status='active' and not coalesce(t.must_change_password,false)
    and (t.role::text in ('owner','admin','supervisor','operator') or coalesce(t.roles::text[],'{}') && array['owner','admin','supervisor','operator'])) then
    raise exception 'Active operator or operations account required' using errcode='42501';
  end if;
  -- Serializes duty refreshes only. It does NOT lock/claim routes or products.
  perform pg_advisory_xact_lock(hashtextextended('snacky:daily-duty-refresh:v1',0));
  lock table public.smart_work_coverage_settings in share mode;

  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into observations from public.snacky_smart_duty_observations() x;
  for o in select * from jsonb_to_recordset(observations) as x(machine_id uuid,priority text,empty_lanes integer,low_lanes integer,unknown_lanes integer,unmapped_lanes integer,lane_count integer,average_fullness numeric,oldest_at timestamptz,newest_at timestamptz) where priority in ('today','urgent','immediate') loop
    if not exists(select 1 from public.smart_work_duties where machine_id=o.machine_id and completed_at is null) then
      -- Do not reopen a just-completed service from an older reading.
      if not exists(select 1 from public.smart_work_duties where machine_id=o.machine_id and completed_at>=o.newest_at) then
        insert into public.smart_work_duties(machine_id,service_date,required_at,priority,observation,updated_by)
        values(o.machine_id,(least(v_now,o.newest_at) at time zone 'Africa/Tripoli')::date,least(v_now,o.newest_at),o.priority,to_jsonb(o),p_actor);
        added:=added+1;
      end if;
    end if;
  end loop;

  for d in select * from public.smart_work_duties where completed_at is null order by required_at,id for update loop
    old_d:=d; cfg:=null; o:=null;
    select * into o from jsonb_to_recordset(observations) as x(machine_id uuid,priority text,empty_lanes integer,low_lanes integer,unknown_lanes integer,unmapped_lanes integer,lane_count integer,average_fullness numeric,oldest_at timestamptz,newest_at timestamptz) where machine_id=d.machine_id;
    select value into cfg from public.smart_work_coverage_settings where machine_id=d.machine_id and kind='machine';
    d.blocker:=null;
    if o.machine_id is null then d.blocker:='machine_inactive';
    else
      d.observation:=to_jsonb(o);
      if o.priority='immediate' or (o.priority='urgent' and d.priority='today') then d.priority:=o.priority; end if;
      if o.unknown_lanes>0 or o.priority='verify' then d.blocker:='readings_unknown';
      elsif o.unmapped_lanes>0 then d.blocker:='products_unmapped';end if;
    end if;
    if cfg is null or not (cfg->>'enabled')::boolean then
      d.blocker:=coalesce(d.blocker,'coverage_missing');
    elsif cfg->>'mode'='standing' then
      -- Standing responsibility deliberately makes no claim about work hours, travel time, site access or today's capacity.
      null;
    else
      cost:=(cfg->>'travelMinutes')::int+(cfg->>'serviceMinutes')::int;
      d.expected_minutes:=greatest(coalesce(d.expected_minutes,0),cost);
      first_day:=d.service_date;
      select first_day+x into access_day from generate_series(0,6) x
      where (cfg->'days') @> to_jsonb(array[extract(isodow from first_day+x)::int]) order by x limit 1;
      deadline:=(access_day+(cfg->>'accessEnd')::time) at time zone 'Africa/Tripoli';
      -- Original deadline can tighten, never move to tomorrow on a refresh.
      d.due_at:=case when d.due_at is null then deadline else least(d.due_at,deadline) end;
      if not (cfg->'days') @> to_jsonb(array[extract(isodow from v_day)::int]) then d.blocker:=coalesce(d.blocker,'site_closed'); end if;
    end if;

    -- Completed manual routes may provide evidence; visiting/skipping alone never clears a duty.
    select s.id stop_id,s.completed_at,c.id receipt_id,c.operator_id,c.inventory_needs_review,q.verification_status
    into proof from public.route_stops s
    join public.route_stop_inventory_commits c on c.route_stop_id=s.id and c.machine_id=s.machine_id and c.route_id=s.route_id
    left join public.route_stop_quantity_confirmations q on q.route_stop_id=s.id and q.machine_id=s.machine_id
    where s.machine_id=d.machine_id and s.status::text='completed' and s.completed_at>=d.required_at and s.completed_at<=v_now
      and c.committed_at>=d.required_at and c.committed_at<=v_now and c.workflow_completed_at is not null
    order by s.completed_at desc limit 1;
    if proof.stop_id is not null then
      d.route_stop_id:=proof.stop_id;
      if not proof.inventory_needs_review
        and proof.verification_status in ('xy_api_verified','xy_screenshot_saved','owner_completed')
        and o.machine_id is not null and o.unknown_lanes=0 and o.unmapped_lanes=0 and o.priority<>'verify'
        and o.lane_count>0 and o.oldest_at>=proof.completed_at
        and exists(select 1 from public.route_stop_fill_lines f where f.route_stop_id=proof.stop_id and f.actual_qty>0 and not f.needs_review) then
        if o.priority='healthy' then
          d.state:='completed';d.completed_at:=proof.completed_at;d.completed_by:=proof.operator_id;
          d.completion_receipt_id:=proof.receipt_id;d.blocker:=null;
        else
          -- The visit is verified, but the machine still needs stock. Keep the original duty alive
          -- and detach the completed stop so another safe trip may be created later.
          d.state:='required';d.route_stop_id:=null;d.blocker:=null;
          d.completed_at:=null;d.completed_by:=null;d.completion_receipt_id:=null;
        end if;
      else
        d.state:='verification_pending';d.blocker:='service_needs_verification';
      end if;
    else
      select array_agg(s.id order by s.id) into route_ids from public.route_stops s join public.routes r on r.id=s.route_id
      where s.machine_id=d.machine_id and r.status::text in ('draft','assigned','in_progress','pickup_confirmed')
        and s.status::text not in ('completed','skipped','cancelled','canceled');
      if coalesce(cardinality(route_ids),0)>1 then d.blocker:='assignment_conflict';
      elsif cardinality(route_ids)=1 then
        select r.operator_id into route_owner from public.route_stops s join public.routes r on r.id=s.route_id where s.id=route_ids[1];
        if exists(select 1 from public.route_stops s join public.routes r on r.id=s.route_id where s.id=route_ids[1] and r.route_date>v_day) then d.blocker:='future_trip_only';
        elsif exists(select 1 from public.team_members where id=route_owner and active and active_status='active') then
          if d.owner_id is null then d.owner_id:=route_owner;d.assigned_via:='existing_route';end if;
          if d.owner_id<>route_owner then d.blocker:='assignment_conflict';
          else d.route_stop_id:=route_ids[1];
            select case when s.status::text in ('in_progress','arrived','filling') or r.status::text in ('in_progress','pickup_confirmed') then 'in_progress' else 'required' end
              into d.state from public.route_stops s join public.routes r on r.id=s.route_id where s.id=route_ids[1];
          end if;
        else d.blocker:=coalesce(d.blocker,'route_without_active_operator');end if;
      elsif d.route_stop_id is not null then
        -- A skipped/cancelled/manual route change is an exception, not completion.
        d.blocker:=coalesce(d.blocker,'previous_trip_unfinished');
      end if;
    end if;
    if d.state<>'completed' and d.owner_id is not null and not exists(select 1 from public.team_members t
      where t.id=d.owner_id and t.active and t.active_status='active') then d.blocker:=coalesce(d.blocker,'owner_unavailable');end if;
    -- Daily responsibility is stable and independent of a variable work schedule. The backup is eligibility only;
    -- it is never auto-assigned here. Existing open-route ownership still wins when already present.
    if d.state<>'completed' and d.owner_id is null and coalesce(cardinality(route_ids),0)=0
      and cfg is not null and (cfg->>'enabled')::boolean then
      person:=nullif(cfg->>'primaryId','')::uuid;
      if exists(select 1 from public.team_members t where t.id=person and t.active and t.active_status='active'
        and (t.role::text in ('owner','admin','supervisor','operator') or coalesce(t.roles::text[],'{}') && array['owner','admin','supervisor','operator'])) then
        d.owner_id:=person; d.assigned_via:='primary';
      else
        d.blocker:=coalesce(d.blocker,'primary_unavailable');
      end if;
    end if;
    -- Availability is a day-level eligibility rule for variable-hour operators. It never reassigns the duty.
    -- Existing routed work is left alone; availability governs new self-dispatch only.
    if d.state<>'completed' and d.owner_id is not null and d.route_stop_id is null and d.blocker is null then
      opcfg:=null;
      select value into opcfg from public.smart_work_coverage_settings where operator_id=d.owner_id and kind='operator';
      if opcfg is null then
        d.blocker:='owner_availability_missing';
      elsif opcfg->>'enabled' is distinct from 'true' then
        d.blocker:='owner_unavailable_today';
      elsif opcfg->>'mode'='days' then
        if not ((opcfg->'days') @> to_jsonb(array[extract(isodow from v_day)::int])) then
          d.blocker:='owner_unavailable_today';
        end if;
      elsif not exists(
        select 1 from jsonb_array_elements(opcfg->'windows') x
        where (x->>'day')::int=extract(isodow from v_day)::int
      ) then
        d.blocker:='owner_unavailable_today';
      end if;
    end if;
    if (to_jsonb(d)-array['observation','revision','updated_by','updated_at']) is distinct from
       (to_jsonb(old_d)-array['observation','revision','updated_by','updated_at']) then
      update public.smart_work_duties set due_at=d.due_at,priority=d.priority,state=d.state,owner_id=d.owner_id,assigned_via=d.assigned_via,
        expected_minutes=d.expected_minutes,route_stop_id=d.route_stop_id,blocker=d.blocker,completed_at=d.completed_at,
        completed_by=d.completed_by,completion_receipt_id=d.completion_receipt_id,observation=d.observation,
        revision=old_d.revision+1,updated_by=p_actor,updated_at=v_now where id=d.id;
      changed:=changed+1;
    end if;
  end loop;

  -- Backup operators are never assigned automatically. Variable availability belongs to next-trip selection,
  -- not to the durable responsibility ledger.
  return jsonb_build_object('created',added,'changed',changed,'checkedAt',v_now,'dispatchEnabled',false);
end $$;
revoke all on function public.snacky_refresh_smart_work_duties(uuid) from public,anon,authenticated;
grant execute on function public.snacky_refresh_smart_work_duties(uuid) to service_role;

select pg_notify('pgrst','reload schema');
