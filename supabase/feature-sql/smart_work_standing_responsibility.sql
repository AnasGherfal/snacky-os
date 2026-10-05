-- Smart Work standing responsibility: primary ownership is durable; random hours are not guessed.
-- This migration changes configuration validation and duty ownership only. It creates no duties, routes or inventory movements.
create or replace function public.snacky_valid_smart_coverage(p_kind text, v jsonb)
returns boolean language plpgsql immutable security invoker set search_path = pg_catalog as $$
declare w jsonb; d jsonb; used_days integer[] := '{}'; start_min integer; end_min integer;
begin
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v->'enabled') is distinct from 'boolean' then return false; end if;
  if p_kind='machine' then
    if v->>'mode'='standing' then
      if not v ?& array['primaryId','backupId','mode','enabled'] or (select count(*) from jsonb_object_keys(v))<>4 then return false; end if;
      if jsonb_typeof(v->'primaryId') is distinct from 'string' or (v->>'primaryId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
      if v->'backupId'<>'null'::jsonb and (jsonb_typeof(v->'backupId') is distinct from 'string' or (v->>'backupId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
      if v->>'primaryId'=v->>'backupId' then return false; end if;
      return true;
    end if;
    if not v ?& array['primaryId','backupId','days','accessStart','accessEnd','travelMinutes','serviceMinutes','enabled']
      or (select count(*) from jsonb_object_keys(v))<>8 then return false; end if;
    if jsonb_typeof(v->'primaryId') is distinct from 'string' or (v->>'primaryId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
    if v->'backupId'<>'null'::jsonb and (jsonb_typeof(v->'backupId') is distinct from 'string' or (v->>'backupId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
    if v->>'primaryId'=v->>'backupId' then return false; end if;
    if jsonb_typeof(v->'days') is distinct from 'array' or jsonb_array_length(v->'days') not between 1 and 7 then return false; end if;
    for d in select * from jsonb_array_elements(v->'days') loop
      if jsonb_typeof(d)<>'number' or d::text !~ '^[1-7]$' or d::text::integer=any(used_days) then return false; end if;
      used_days:=array_append(used_days,d::text::integer);
    end loop;
    if jsonb_typeof(v->'accessStart') is distinct from 'string' or jsonb_typeof(v->'accessEnd') is distinct from 'string'
      or (v->>'accessStart') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (v->>'accessEnd') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
    start_min:=split_part(v->>'accessStart',':',1)::int*60+split_part(v->>'accessStart',':',2)::int;
    end_min:=split_part(v->>'accessEnd',':',1)::int*60+split_part(v->>'accessEnd',':',2)::int;
    if end_min<=start_min or jsonb_typeof(v->'serviceMinutes') is distinct from 'number' or jsonb_typeof(v->'travelMinutes') is distinct from 'number'
      or (v->>'serviceMinutes') !~ '^[0-9]+$' or (v->>'travelMinutes') !~ '^[0-9]+$' then return false; end if;
    if (v->>'serviceMinutes')::int not between 1 and 480 or (v->>'travelMinutes')::int not between 0 and 480
      or (v->>'serviceMinutes')::int>end_min-start_min then return false; end if;
    return true;
  elsif p_kind='operator' then
    if not v ?& array['enabled','windows'] or (select count(*) from jsonb_object_keys(v))<>2
      or jsonb_typeof(v->'windows') is distinct from 'array' then return false; end if;
    if jsonb_array_length(v->'windows')>7 or ((v->>'enabled')::boolean and jsonb_array_length(v->'windows')=0) then return false; end if;
    for w in select * from jsonb_array_elements(v->'windows') loop
      if jsonb_typeof(w) is distinct from 'object' or not w ?& array['day','start','end','minutes']
        or (select count(*) from jsonb_object_keys(w))<>4 then return false; end if;
      if jsonb_typeof(w->'day') is distinct from 'number' or (w->>'day') !~ '^[1-7]$' or (w->>'day')::int=any(used_days) then return false; end if;
      used_days:=array_append(used_days,(w->>'day')::int);
      if jsonb_typeof(w->'start') is distinct from 'string' or jsonb_typeof(w->'end') is distinct from 'string'
        or (w->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or (w->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
      start_min:=split_part(w->>'start',':',1)::int*60+split_part(w->>'start',':',2)::int;
      end_min:=split_part(w->>'end',':',1)::int*60+split_part(w->>'end',':',2)::int;
      if end_min<=start_min or jsonb_typeof(w->'minutes') is distinct from 'number' or (w->>'minutes') !~ '^[0-9]+$' then return false; end if;
      if (w->>'minutes')::int not between 1 and 960 or (w->>'minutes')::int>end_min-start_min then return false; end if;
    end loop;
    return true;
  end if;
  return false;
exception when others then return false;
end $$;
revoke all on function public.snacky_valid_smart_coverage(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.snacky_valid_smart_coverage(text,jsonb) to service_role;

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
      if not proof.inventory_needs_review and proof.verification_status in ('xy_api_verified','xy_screenshot_saved','owner_completed')
        and o.machine_id is not null and o.priority='healthy' and o.unknown_lanes=0 and o.unmapped_lanes=0
        and o.lane_count>0 and o.oldest_at>=proof.completed_at
        and exists(select 1 from public.route_stop_fill_lines f where f.route_stop_id=proof.stop_id and f.actual_qty>0 and not f.needs_review) then
        d.state:='completed';d.completed_at:=proof.completed_at;d.completed_by:=proof.operator_id;d.completion_receipt_id:=proof.receipt_id;d.blocker:=null;
      else d.state:='verification_pending';d.blocker:='service_needs_verification';end if;
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
