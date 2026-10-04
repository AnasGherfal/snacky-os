-- Part 2A: approved coverage configuration ONLY. No duty/route/inventory writes.
create or replace function public.snacky_valid_smart_coverage(p_kind text, v jsonb)
returns boolean language plpgsql immutable security invoker set search_path = pg_catalog as $$
declare w jsonb; d jsonb; used_days integer[] := '{}'; start_min integer; end_min integer; days integer[];
begin
  if jsonb_typeof(v) is distinct from 'object' or jsonb_typeof(v->'enabled') is distinct from 'boolean' then return false; end if;
  if p_kind='machine' then
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

create table public.smart_work_coverage_settings (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('machine','operator')),
  machine_id uuid references public.machines(id) on delete restrict,
  operator_id uuid references public.team_members(id) on delete restrict,
  value jsonb not null,
  version integer not null check (version>=1),
  updated_by uuid not null references public.team_members(id) on delete restrict,
  updated_at timestamptz not null default now(),
  check ((kind='machine' and machine_id is not null and operator_id is null) or (kind='operator' and operator_id is not null and machine_id is null)),
  check (public.snacky_valid_smart_coverage(kind,value)),
  unique(machine_id), unique(operator_id)
);
create index smart_work_coverage_updated_by_idx on public.smart_work_coverage_settings(updated_by);
create table public.smart_work_coverage_events (
  id bigint generated always as identity primary key,
  setting_id uuid not null references public.smart_work_coverage_settings(id) on delete restrict,
  actor_id uuid not null references public.team_members(id) on delete restrict,
  before_value jsonb, after_value jsonb not null,
  version integer not null, created_at timestamptz not null default now(),
  unique(setting_id,version)
);
create index smart_work_coverage_events_actor_idx on public.smart_work_coverage_events(actor_id);
alter table public.smart_work_coverage_settings enable row level security;
alter table public.smart_work_coverage_events enable row level security;
revoke all on public.smart_work_coverage_settings,public.smart_work_coverage_events from public,anon,authenticated;
grant select,insert,update on public.smart_work_coverage_settings to service_role;
grant select,insert on public.smart_work_coverage_events to service_role;
revoke all on sequence public.smart_work_coverage_events_id_seq from public,anon,authenticated;
grant usage,select on sequence public.smart_work_coverage_events_id_seq to service_role;
revoke all on function public.snacky_valid_smart_coverage(text,jsonb) from public,anon,authenticated;
grant execute on function public.snacky_valid_smart_coverage(text,jsonb) to service_role;

create or replace function public.snacky_save_smart_work_coverage(p_actor uuid,p_kind text,p_target uuid,p_expected integer,p_value jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare current_row public.smart_work_coverage_settings; saved public.smart_work_coverage_settings; before_value jsonb; person uuid;
begin
  if p_expected is null or p_expected<0 or not public.snacky_valid_smart_coverage(p_kind,p_value) then
    raise exception 'Invalid coverage settings' using errcode='22023'; end if;
  if not exists(select 1 from public.team_members t where t.id=p_actor and t.active and t.active_status='active' and not coalesce(t.must_change_password,false)
    and (t.role::text in ('owner','admin') or coalesce(t.roles::text[],'{}') && array['owner','admin'])) then
    raise exception 'Owner or admin required' using errcode='42501'; end if;
  if p_kind='machine' then
    if not exists(select 1 from public.machines m where m.id=p_target and (not (p_value->>'enabled')::boolean or m.status::text='active')) then
      raise exception 'Machine is not active' using errcode='22023'; end if;
    for person in select (p_value->>'primaryId')::uuid union select (p_value->>'backupId')::uuid loop
      if (p_value->>'enabled')::boolean and person is not null and not exists(select 1 from public.team_members t where t.id=person and t.active and t.active_status='active'
        and (t.role::text in ('operator','owner','admin','supervisor') or coalesce(t.roles::text[],'{}') && array['operator','owner','admin','supervisor'])) then
        raise exception 'Coverage operator is unavailable' using errcode='22023'; end if;
    end loop;
  elsif (p_value->>'enabled')::boolean and not exists(select 1 from public.team_members t where t.id=p_target and t.active and t.active_status='active'
    and (t.role::text in ('operator','owner','admin','supervisor') or coalesce(t.roles::text[],'{}') && array['operator','owner','admin','supervisor'])) then
    raise exception 'Operator is not active' using errcode='22023';
  end if;
  select * into current_row from public.smart_work_coverage_settings
    where kind=p_kind and (machine_id=p_target or operator_id=p_target) for update;
  if found then
    if current_row.version<>p_expected then raise exception 'Settings changed; reload before saving' using errcode='40001'; end if;
    before_value:=current_row.value;
    update public.smart_work_coverage_settings set value=p_value,version=version+1,updated_by=p_actor,updated_at=now()
      where id=current_row.id returning * into saved;
  else
    if p_expected<>0 then raise exception 'Settings changed; reload before saving' using errcode='40001'; end if;
    insert into public.smart_work_coverage_settings(kind,machine_id,operator_id,value,version,updated_by)
      values(p_kind,case when p_kind='machine' then p_target end,case when p_kind='operator' then p_target end,p_value,1,p_actor)
      returning * into saved;
  end if;
  insert into public.smart_work_coverage_events(setting_id,actor_id,before_value,after_value,version)
    values(saved.id,p_actor,before_value,saved.value,saved.version);
  return to_jsonb(saved);
exception when unique_violation then raise exception 'Settings changed; reload before saving' using errcode='40001';
end $$;
revoke all on function public.snacky_save_smart_work_coverage(uuid,text,uuid,integer,jsonb) from public,anon,authenticated;
grant execute on function public.snacky_save_smart_work_coverage(uuid,text,uuid,integer,jsonb) to service_role;
comment on table public.smart_work_coverage_settings is 'Owner-approved future coverage and work windows; does not create or reassign duties, routes or inventory.';
select pg_notify('pgrst','reload schema');
