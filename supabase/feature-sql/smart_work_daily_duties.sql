-- Part 2B: persistent service obligations only. NEVER creates routes or changes goods.
create table if not exists public.smart_work_duties (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.machines(id) on delete restrict,
  service_date date not null,
  required_at timestamptz not null default now(),
  due_at timestamptz,
  priority text not null check (priority in ('today','urgent','immediate')),
  state text not null default 'required' check (state in ('required','in_progress','verification_pending','completed')),
  owner_id uuid references public.team_members(id) on delete restrict,
  assigned_via text check (assigned_via in ('primary','backup','existing_route')),
  expected_minutes integer check (expected_minutes between 1 and 960),
  route_stop_id uuid references public.route_stops(id) on delete restrict,
  blocker text,
  completed_at timestamptz,
  completed_by uuid references public.team_members(id) on delete restrict,
  completion_receipt_id uuid references public.route_stop_inventory_commits(id) on delete restrict,
  observation jsonb not null default '{}',
  revision integer not null default 1 check (revision>0),
  updated_by uuid not null references public.team_members(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check ((state='completed') = (completed_at is not null)),
  check (state<>'completed' or (completion_receipt_id is not null and completed_by is not null)),
  check ((owner_id is null) = (assigned_via is null))
);
create unique index if not exists smart_work_one_outstanding_duty on public.smart_work_duties(machine_id) where completed_at is null;
create index if not exists smart_work_duty_owner on public.smart_work_duties(owner_id,due_at);
create index if not exists smart_work_duty_stop on public.smart_work_duties(route_stop_id);
create index if not exists smart_work_duty_receipt on public.smart_work_duties(completion_receipt_id);
create index if not exists smart_work_duty_actor on public.smart_work_duties(updated_by);
create index if not exists smart_work_duty_completer on public.smart_work_duties(completed_by);
create table if not exists public.smart_work_duty_events (
  id bigint generated always as identity primary key,
  duty_id uuid not null references public.smart_work_duties(id) on delete restrict,
  revision integer not null,
  actor_id uuid not null references public.team_members(id) on delete restrict,
  before_state jsonb, after_state jsonb not null,
  created_at timestamptz not null default now(),
  unique(duty_id,revision)
);
create index if not exists smart_work_duty_event_actor on public.smart_work_duty_events(actor_id);
alter table public.smart_work_duties enable row level security;
alter table public.smart_work_duty_events enable row level security;
-- Reset broad Supabase defaults, including service_role audit editing.
revoke all on public.smart_work_duties,public.smart_work_duty_events from public,anon,authenticated,service_role;
grant select,insert,update on public.smart_work_duties to service_role;
grant select,insert on public.smart_work_duty_events to service_role;
revoke all on sequence public.smart_work_duty_events_id_seq from public,anon,authenticated,service_role;
grant usage,select on sequence public.smart_work_duty_events_id_seq to service_role;

create or replace function public.snacky_smart_duty_audit()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
  insert into public.smart_work_duty_events(duty_id,revision,actor_id,before_state,after_state)
  values(new.id,new.revision,new.updated_by,case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
  return new;
end $$;
drop trigger if exists smart_work_duty_audit on public.smart_work_duties;
create trigger smart_work_duty_audit after insert or update on public.smart_work_duties for each row execute function public.snacky_smart_duty_audit();
revoke all on function public.snacky_smart_duty_audit() from public,anon,authenticated;

-- Same physical-lane normalization, freshness and urgency rules as Part 1.
-- This reads existing snapshots only; it never calls XY or edits quantities.
create or replace function public.snacky_smart_duty_observations()
returns table(machine_id uuid,priority text,empty_lanes integer,low_lanes integer,unknown_lanes integer,
  unmapped_lanes integer,lane_count integer,average_fullness numeric,oldest_at timestamptz,newest_at timestamptz)
language sql stable security invoker set search_path=pg_catalog,public as $$
with slots as (
  select machine_id,trim(slot_code)::integer code,bool_and(active) active
  from public.machine_slots where trim(slot_code) ~ '^[0-9]{1,4}$'
  group by machine_id,trim(slot_code)::integer
), raw as (
  select machine_id,trim(slot_code)::integer code,current_qty,capacity,captured_at,product_id
  from public.latest_vms_stock_by_slot where source_provider='xy' and trim(slot_code) ~ '^[0-9]{1,4}$'
), codes as (
  select machine_id,code from slots where active
  union select r.machine_id,r.code from raw r where not exists(select 1 from slots s where s.machine_id=r.machine_id and s.code=r.code and not s.active)
), lanes as (
  select c.machine_id,c.code,count(r.code) samples,max(r.current_qty) qty,max(r.capacity) cap,
    min(r.captured_at) captured_at,bool_and(r.product_id is not null) mapped
  from codes c left join raw r on r.machine_id=c.machine_id and r.code=c.code group by c.machine_id,c.code
), valid as (
  select *,coalesce(samples=1 and captured_at between now()-interval '30 minutes' and now()+interval '1 minute'
    and cap between 1 and 1000 and cap=floor(cap) and qty between 0 and cap and qty=floor(qty),false) good from lanes
), stats as (
  select m.id,count(v.code)::int n,count(*) filter(where good)::int known,
    count(*) filter(where good and qty=0)::int empty,
    count(*) filter(where good and qty>0 and (qty<=2 or qty::numeric/cap<=.2))::int low,
    count(*) filter(where good and not mapped)::int unmapped,
    avg(100*qty::numeric/nullif(cap,0)) filter(where good) fullness,min(captured_at) oldest,max(captured_at) newest
  from public.machines m left join valid v on v.machine_id=m.id where m.status::text='active' group by m.id
)
select id,case when known=0 then 'verify'
  when empty>=25 or empty::numeric/nullif(n,0)>=.6 or (known=n and fullness<=15) then 'immediate'
  when empty>=20 or (empty+low)::numeric/nullif(n,0)>=.5 or (known=n and fullness<=25) then 'urgent'
  when empty>=16 or (empty+low)::numeric/nullif(n,0)>=.35 or (known=n and fullness<=35) then 'today'
  when known<n then 'verify' when empty>0 or low>0 or fullness<=55 then 'monitor' else 'healthy' end,
  empty,low,n-known,unmapped,n,case when known=n then fullness else null end,oldest,newest from stats;
$$;
revoke all on function public.snacky_smart_duty_observations() from public,anon,authenticated;
grant execute on function public.snacky_smart_duty_observations() to service_role;

create or replace function public.snacky_refresh_smart_work_duties(p_actor uuid)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  v_now timestamptz:=now(); v_day date:=(now() at time zone 'Africa/Tripoli')::date;
  o record; d public.smart_work_duties%rowtype; old_d public.smart_work_duties%rowtype;
  cfg jsonb; opcfg jsonb; w jsonb; first_day date; access_day date; deadline timestamptz;
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

  for o in select * from public.snacky_smart_duty_observations() where priority in ('today','urgent','immediate') loop
    if not exists(select 1 from public.smart_work_duties where machine_id=o.machine_id and completed_at is null) then
      -- Do not reopen a just-completed service from an older reading.
      if not exists(select 1 from public.smart_work_duties where machine_id=o.machine_id and completed_at>=o.newest_at) then
        insert into public.smart_work_duties(machine_id,service_date,required_at,priority,observation,updated_by)
        values(o.machine_id,v_day,v_now,o.priority,to_jsonb(o),p_actor);
        added:=added+1;
      end if;
    end if;
  end loop;

  for d in select * from public.smart_work_duties where completed_at is null order by required_at,id for update loop
    old_d:=d; cfg:=null; o:=null;
    select * into o from public.snacky_smart_duty_observations() where machine_id=d.machine_id;
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
    if d.blocker is null and old_d.blocker='no_capacity' and d.owner_id is null then d.blocker:='no_capacity';end if;
    if (to_jsonb(d)-array['observation','revision','updated_by','updated_at']) is distinct from
       (to_jsonb(old_d)-array['observation','revision','updated_by','updated_at']) then
      update public.smart_work_duties set due_at=d.due_at,priority=d.priority,state=d.state,owner_id=d.owner_id,assigned_via=d.assigned_via,
        expected_minutes=d.expected_minutes,route_stop_id=d.route_stop_id,blocker=d.blocker,completed_at=d.completed_at,
        completed_by=d.completed_by,completion_receipt_id=d.completion_receipt_id,observation=d.observation,
        revision=old_d.revision+1,updated_by=p_actor,updated_at=v_now where id=d.id;
      changed:=changed+1;
    end if;
  end loop;

  -- Whole outstanding workload is considered, independently of any next-trip selection.
  for d in select * from public.smart_work_duties where completed_at is null and owner_id is null
      and state='required' and (blocker is null or blocker='no_capacity')
      order by case priority when 'immediate' then 0 when 'urgent' then 1 else 2 end,due_at nulls last,required_at,id for update loop
    select value into cfg from public.smart_work_coverage_settings where machine_id=d.machine_id and kind='machine';
    if cfg is null or not (cfg->>'enabled')::boolean or d.due_at is null or d.expected_minutes is null then continue;end if;
    candidates:=array_remove(array[(cfg->>'primaryId')::uuid,(cfg->>'backupId')::uuid],null);
    foreach person in array candidates loop
      if not exists(select 1 from public.team_members t where t.id=person and t.active and t.active_status='active'
        and (t.role::text in ('owner','admin','supervisor','operator') or coalesce(t.roles::text[],'{}') && array['owner','admin','supervisor','operator'])) then continue;end if;
      select value into opcfg from public.smart_work_coverage_settings where operator_id=person and kind='operator';
      if opcfg is null or not (opcfg->>'enabled')::boolean then continue;end if;
      select x into w from jsonb_array_elements(opcfg->'windows') x where (x->>'day')::int=extract(isodow from v_day)::int;
      if w is null then continue;end if;
      shift_start:=(v_day+(w->>'start')::time) at time zone 'Africa/Tripoli';
      shift_end:=(v_day+(w->>'end')::time) at time zone 'Africa/Tripoli';
      site_start:=(v_day+(cfg->>'accessStart')::time) at time zone 'Africa/Tripoli';
      site_end:=(v_day+(cfg->>'accessEnd')::time) at time zone 'Africa/Tripoli';
      select coalesce(sum(expected_minutes),0),count(*) filter(where expected_minutes is null) into busy,missing_cost
        from public.smart_work_duties where owner_id=person and completed_at is null;
      if missing_cost>0 then continue;end if;
      -- Existing trips outside the duty ledger also consume the operator's time.
      select coalesce(sum((s.value->>'travelMinutes')::int+(s.value->>'serviceMinutes')::int),0),count(*) filter(where s.id is null)
      into other_cost,missing_cost from public.route_stops rs join public.routes r on r.id=rs.route_id
      left join public.smart_work_coverage_settings s on s.machine_id=rs.machine_id and s.kind='machine'
      where r.operator_id=person and r.route_date<=v_day and r.status::text in ('draft','assigned','in_progress','pickup_confirmed')
        and rs.status::text not in ('completed','skipped','cancelled','canceled')
        and not exists(select 1 from public.smart_work_duties x where x.completed_at is null and x.route_stop_id=rs.id);
      if missing_cost>0 then continue;end if;
      busy:=busy+other_cost;
      select coalesce(sum(expected_minutes),0) into spent from public.smart_work_duties
        where completed_by=person and (completed_at at time zone 'Africa/Tripoli')::date=v_day;
      start_at:=greatest(v_now,shift_start)+make_interval(mins=>busy);
      finish_at:=greatest(start_at+make_interval(mins=>(cfg->>'travelMinutes')::int),site_start)
        +make_interval(mins=>(cfg->>'serviceMinutes')::int);
      if spent+busy+d.expected_minutes<=(w->>'minutes')::int and finish_at<=least(shift_end,site_end)
        and (d.due_at<=v_now or finish_at<=d.due_at) then
        update public.smart_work_duties set owner_id=person,assigned_via=case when person=candidates[1] then 'primary' else 'backup' end,
          blocker=null,revision=revision+1,updated_by=p_actor,updated_at=v_now where id=d.id;
        changed:=changed+1;exit;
      end if;
    end loop;
    if not exists(select 1 from public.smart_work_duties where id=d.id and owner_id is not null) and d.blocker is distinct from 'no_capacity' then
      update public.smart_work_duties set blocker='no_capacity',revision=revision+1,updated_by=p_actor,updated_at=v_now where id=d.id;
      changed:=changed+1;
    end if;
  end loop;
  return jsonb_build_object('created',added,'changed',changed,'checkedAt',v_now,'dispatchEnabled',false);
end $$;
revoke all on function public.snacky_refresh_smart_work_duties(uuid) from public,anon,authenticated;
grant execute on function public.snacky_refresh_smart_work_duties(uuid) to service_role;
select pg_notify('pgrst','reload schema');
