-- Multi-machine cash removals must preserve two separate facts:
-- 1) the amount physically removed from each machine, and
-- 2) the physical cash box / sealed bag that holds those machine amounts.
-- One cash_collections row remains one physical box so custody, handover,
-- counting, reconciliation, and Finance posting stay box-scoped.

alter table public.cash_collection_machines
  add column if not exists removed_amount_lyd numeric(12,2);

alter table public.cash_removal_receipt_machines
  add column if not exists removed_amount_lyd numeric(12,2);

alter table public.cash_collections
  add column if not exists removal_group_id uuid,
  add column if not exists removal_box_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.cash_collection_machines'::regclass
      and conname='cash_collection_machines_removed_amount_check'
  ) then
    alter table public.cash_collection_machines
      add constraint cash_collection_machines_removed_amount_check
      check (removed_amount_lyd is null or removed_amount_lyd >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.cash_removal_receipt_machines'::regclass
      and conname='cash_removal_receipt_machines_removed_amount_check'
  ) then
    alter table public.cash_removal_receipt_machines
      add constraint cash_removal_receipt_machines_removed_amount_check
      check (removed_amount_lyd is null or removed_amount_lyd >= 0);
  end if;
end;
$$;

create unique index if not exists cash_collections_removal_group_box_uidx
  on public.cash_collections(removal_group_id, removal_box_key)
  where removal_group_id is not null and removal_box_key is not null;

create index if not exists idx_cash_collections_removal_group
  on public.cash_collections(removal_group_id)
  where removal_group_id is not null;

comment on column public.cash_collection_machines.removed_amount_lyd is
  'Amount declared as physically removed from this machine before machine cash is combined into a physical box.';
comment on column public.cash_removal_receipt_machines.removed_amount_lyd is
  'Immutable receipt snapshot of the amount declared as removed from this machine.';
comment on column public.cash_collections.removal_group_id is
  'One operator submission may create several physical cash boxes. This groups those box records without merging custody.';
comment on column public.cash_collections.removal_box_key is
  'Stable box key within one removal submission. Each key maps to exactly one physical box/seal.';

create or replace function snacky_private.record_standalone_cash_removal_group_v1_impl(
  p_boxes jsonb,
  p_removed_at timestamptz,
  p_removal_type text,
  p_compartments text[],
  p_notes text,
  p_client_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, snacky_private, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_collector_id uuid := public.snacky_current_team_member_id();
  v_removed_at timestamptz := coalesce(p_removed_at, now());
  v_compartments text[];
  v_box jsonb;
  v_box_key text;
  v_bag_id text;
  v_evidence_path text;
  v_evidence_file_name text;
  v_collection_id uuid;
  v_single_machine uuid;
  v_declared_total numeric(12,2);
  v_existing_count integer;
  v_box_count integer;
  v_line_count integer;
begin
  if v_actor is null
     or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','finance','operator']) then
    raise exception 'Not authorized to record cash removal' using errcode='42501';
  end if;
  if v_collector_id is null then
    raise exception 'Your account must be linked to a team member before handling cash' using errcode='42501';
  end if;
  if p_client_submission_id is null then
    raise exception 'A stable removal submission reference is required' using errcode='22023';
  end if;
  if jsonb_typeof(p_boxes) is distinct from 'array'
     or jsonb_array_length(p_boxes) < 1
     or jsonb_array_length(p_boxes) > 12 then
    raise exception 'Record between 1 and 12 physical cash boxes' using errcode='22023';
  end if;
  if p_removal_type not in ('full','partial') then
    raise exception 'Removal type must be full or partial' using errcode='22023';
  end if;

  select array_agg(distinct lower(trim(x.compartment)) order by lower(trim(x.compartment)))
  into v_compartments
  from unnest(coalesce(p_compartments,array[]::text[])) x(compartment)
  where nullif(trim(x.compartment),'') is not null;

  if coalesce(cardinality(v_compartments),0)=0
     or not (v_compartments <@ array['notes','coins','recycler','change_float']::text[]) then
    raise exception 'Select every cash compartment handled' using errcode='22023';
  end if;
  if p_removal_type='partial' and nullif(trim(coalesce(p_notes,'')),'') is null then
    raise exception 'Explain what cash remained for a partial removal' using errcode='22023';
  end if;
  if v_removed_at > now() + interval '10 minutes' then
    raise exception 'Removal time cannot be in the future' using errcode='22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_boxes) b(value)
    where jsonb_typeof(b.value) is distinct from 'object'
      or coalesce(trim(b.value->>'box_key'),'') !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$'
      or length(trim(coalesce(b.value->>'cash_bag_id',''))) not between 1 and 120
      or length(trim(coalesce(b.value->>'removal_evidence_path',''))) not between 1 and 500
      or length(coalesce(b.value->>'removal_evidence_file_name','')) > 255
      or jsonb_typeof(b.value->'machines') is distinct from 'array'
      or jsonb_array_length(b.value->'machines') < 1
  ) then
    raise exception 'Every physical box needs a key, seal, photo, and at least one machine' using errcode='22023';
  end if;

  select count(*), count(distinct trim(b.value->>'box_key'))
  into v_box_count, v_existing_count
  from jsonb_array_elements(p_boxes) b(value);
  if v_box_count <> v_existing_count then
    raise exception 'Physical box keys must be unique in one removal' using errcode='22023';
  end if;

  if (
    select count(*)
    from (
      select lower(trim(b.value->>'cash_bag_id')) bag
      from jsonb_array_elements(p_boxes) b(value)
      group by lower(trim(b.value->>'cash_bag_id'))
      having count(*)>1
    ) duplicates
  ) > 0 then
    raise exception 'Each physical box must have a different seal ID' using errcode='22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_boxes) b(value)
    cross join lateral jsonb_array_elements(b.value->'machines') m(value)
    where jsonb_typeof(m.value) is distinct from 'object'
      or coalesce(m.value->>'machine_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(m.value->>'removed_amount_lyd','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$'
  ) then
    raise exception 'Every selected machine needs one valid non-negative LYD amount' using errcode='22023';
  end if;

  select count(*), count(distinct (m.value->>'machine_id')::uuid)
  into v_line_count, v_existing_count
  from jsonb_array_elements(p_boxes) b(value)
  cross join lateral jsonb_array_elements(b.value->'machines') m(value);
  if v_line_count <> v_existing_count then
    raise exception 'A machine can belong to only one physical box in one removal' using errcode='22023';
  end if;
  if v_line_count > 100 then
    raise exception 'Too many machines in one cash removal' using errcode='22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_boxes) b(value)
    cross join lateral jsonb_array_elements(b.value->'machines') m(value)
    where not exists (
      select 1 from public.machines machine
      where machine.id=(m.value->>'machine_id')::uuid
    )
  ) then
    raise exception 'One or more selected machines do not exist' using errcode='23503';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cash-removal-group:'||p_client_submission_id::text,0));

  select count(*) into v_existing_count
  from public.cash_collections
  where removal_group_id=p_client_submission_id;

  if v_existing_count>0 then
    if v_existing_count<>v_box_count then
      raise exception 'This removal submission reference was already used for different boxes' using errcode='23505';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_boxes) b(value)
      where not exists (
        select 1
        from public.cash_collections c
        where c.removal_group_id=p_client_submission_id
          and c.removal_box_key=trim(b.value->>'box_key')
          and upper(trim(c.cash_bag_id))=upper(trim(b.value->>'cash_bag_id'))
      )
    ) then
      raise exception 'This removal submission reference was already used for different box details' using errcode='23505';
    end if;

    if (
      select count(*)
      from public.cash_collection_machines cm
      join public.cash_collections c on c.id=cm.cash_collection_id
      where c.removal_group_id=p_client_submission_id
    ) <> v_line_count then
      raise exception 'This removal submission reference was already used for different machine lines' using errcode='23505';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(p_boxes) b(value)
      cross join lateral jsonb_array_elements(b.value->'machines') m(value)
      where not exists (
        select 1
        from public.cash_collections c
        join public.cash_collection_machines cm on cm.cash_collection_id=c.id
        where c.removal_group_id=p_client_submission_id
          and c.removal_box_key=trim(b.value->>'box_key')
          and cm.machine_id=(m.value->>'machine_id')::uuid
          and cm.removed_amount_lyd=round((m.value->>'removed_amount_lyd')::numeric,2)
          and cm.removal_type=p_removal_type
          and cm.compartments=v_compartments
      )
    ) then
      raise exception 'This removal submission reference was already used for different machine amounts' using errcode='23505';
    end if;

    return (
      select jsonb_build_object(
        'group_id',p_client_submission_id,
        'replayed',true,
        'collection_ids',coalesce(jsonb_agg(c.id order by c.removal_box_key),'[]'::jsonb),
        'boxes',coalesce(jsonb_agg(jsonb_build_object(
          'box_key',c.removal_box_key,
          'collection_id',c.id,
          'cash_bag_id',c.cash_bag_id,
          'machine_count',(select count(*) from public.cash_collection_machines cm where cm.cash_collection_id=c.id),
          'declared_total_lyd',(select coalesce(sum(cm.removed_amount_lyd),0)::text from public.cash_collection_machines cm where cm.cash_collection_id=c.id)
        ) order by c.removal_box_key),'[]'::jsonb)
      )
      from public.cash_collections c
      where c.removal_group_id=p_client_submission_id
    );
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_boxes) b(value)
    join public.cash_collections c
      on lower(trim(c.cash_bag_id))=lower(trim(b.value->>'cash_bag_id'))
  ) then
    raise exception 'One or more box or seal IDs have already been used' using errcode='23505';
  end if;

  for v_box in
    select value
    from jsonb_array_elements(p_boxes)
    order by value->>'box_key'
  loop
    v_box_key:=trim(v_box->>'box_key');
    v_bag_id:=upper(trim(v_box->>'cash_bag_id'));
    v_evidence_path:=trim(v_box->>'removal_evidence_path');
    v_evidence_file_name:=nullif(trim(coalesce(v_box->>'removal_evidence_file_name','')),'');

    select
      case when jsonb_array_length(v_box->'machines')=1
        then ((v_box->'machines')->0->>'machine_id')::uuid
        else null end,
      round(sum((m.value->>'removed_amount_lyd')::numeric),2)
    into v_single_machine,v_declared_total
    from jsonb_array_elements(v_box->'machines') m(value);

    insert into public.cash_collections(
      route_id,machine_id,operator_id,vms_expected_cash,actual_cash_collected,
      review_status,custody_status,reconciliation_status,collected_at,cash_bag_id,
      notes,client_submission_id,removal_group_id,removal_box_key,updated_at
    ) values (
      null,v_single_machine,v_collector_id,null,null,
      'collected_pending_count','removed','pending',v_removed_at,v_bag_id,
      nullif(trim(coalesce(p_notes,'')),''),null,p_client_submission_id,v_box_key,now()
    )
    returning id into v_collection_id;

    insert into public.cash_collection_machines(
      cash_collection_id,machine_id,removal_type,compartments,interval_end_at,removed_amount_lyd
    )
    select
      v_collection_id,
      (m.value->>'machine_id')::uuid,
      p_removal_type,
      v_compartments,
      v_removed_at,
      round((m.value->>'removed_amount_lyd')::numeric,2)
    from jsonb_array_elements(v_box->'machines') m(value);

    insert into public.cash_removal_receipts(
      cash_collection_id,operator_id,cash_bag_id,collected_at,custody_status,
      removal_evidence_path,removal_evidence_file_name,removal_notes,created_at,updated_at
    ) values (
      v_collection_id,v_collector_id,v_bag_id,v_removed_at,'removed',
      v_evidence_path,v_evidence_file_name,nullif(trim(coalesce(p_notes,'')),''),now(),now()
    );

    insert into public.cash_removal_receipt_machines(
      cash_collection_id,machine_id,removal_type,compartments,removed_amount_lyd
    )
    select
      v_collection_id,
      (m.value->>'machine_id')::uuid,
      p_removal_type,
      v_compartments,
      round((m.value->>'removed_amount_lyd')::numeric,2)
    from jsonb_array_elements(v_box->'machines') m(value);

    perform snacky_private.append_cash_collection_event(
      v_collection_id,
      'removed',
      v_removed_at,
      null,
      'intact',
      v_evidence_path,
      v_evidence_file_name,
      p_notes,
      jsonb_build_object(
        'removal_group_id',p_client_submission_id,
        'box_key',v_box_key,
        'machine_count',jsonb_array_length(v_box->'machines'),
        'machine_amounts',v_box->'machines',
        'declared_box_total_lyd',v_declared_total,
        'removal_type',p_removal_type,
        'compartments',to_jsonb(v_compartments),
        'route_id',null,
        'cash_bag_id',v_bag_id
      ),
      v_collection_id
    );
  end loop;

  return (
    select jsonb_build_object(
      'group_id',p_client_submission_id,
      'replayed',false,
      'collection_ids',coalesce(jsonb_agg(c.id order by c.removal_box_key),'[]'::jsonb),
      'boxes',coalesce(jsonb_agg(jsonb_build_object(
        'box_key',c.removal_box_key,
        'collection_id',c.id,
        'cash_bag_id',c.cash_bag_id,
        'machine_count',(select count(*) from public.cash_collection_machines cm where cm.cash_collection_id=c.id),
        'declared_total_lyd',(select coalesce(sum(cm.removed_amount_lyd),0)::text from public.cash_collection_machines cm where cm.cash_collection_id=c.id)
      ) order by c.removal_box_key),'[]'::jsonb)
    )
    from public.cash_collections c
    where c.removal_group_id=p_client_submission_id
  );
end;
$$;

revoke all on function snacky_private.record_standalone_cash_removal_group_v1_impl(jsonb,timestamptz,text,text[],text,uuid)
  from public,anon,authenticated;
grant execute on function snacky_private.record_standalone_cash_removal_group_v1_impl(jsonb,timestamptz,text,text[],text,uuid)
  to authenticated,service_role;

create or replace function public.record_standalone_cash_removal_group_v1(
  p_boxes jsonb,
  p_removed_at timestamptz,
  p_removal_type text,
  p_compartments text[],
  p_notes text,
  p_client_submission_id uuid
)
returns jsonb
language sql
set search_path=public,auth,snacky_private
as $$
  select snacky_private.record_standalone_cash_removal_group_v1_impl(
    p_boxes,p_removed_at,p_removal_type,p_compartments,p_notes,p_client_submission_id
  );
$$;

revoke all on function public.record_standalone_cash_removal_group_v1(jsonb,timestamptz,text,text[],text,uuid)
  from public,anon;
grant execute on function public.record_standalone_cash_removal_group_v1(jsonb,timestamptz,text,text[],text,uuid)
  to authenticated,service_role;

create or replace function snacky_private.cash_collection_machine_lines_v1_impl(p_collection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,auth,snacky_private
as $$
declare
  v_actor uuid:=auth.uid();
  v_team uuid;
  v_owner boolean;
  v_counter boolean;
  v_operator uuid;
  v_assigned uuid;
begin
  if v_actor is null
     or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','warehouse','purchasing','finance']) then
    raise exception 'Cash handling access denied' using errcode='42501';
  end if;

  select p.team_member_id into v_team
  from public.profiles p
  join public.team_members t on t.id=p.team_member_id
  where p.id=v_actor and p.active_status='active'
    and coalesce(t.active_status,'active')='active' and coalesce(t.active,true);

  if v_team is null then
    raise exception 'An active linked team account is required' using errcode='42501';
  end if;

  v_owner:=public.snacky_current_profile_has_any_role(array['owner','admin']);
  v_counter:=snacky_private.cash_handover_counter_v1(v_actor);

  select c.operator_id,h.assigned_to
  into v_operator,v_assigned
  from public.cash_collections c
  left join snacky_private.cash_handovers h on h.collection_id=c.id
  where c.id=p_collection_id;

  if not found or not (v_owner or v_operator=v_team or (v_counter and v_assigned=v_actor)) then
    raise exception 'Cash box not found or not accessible' using errcode='42501';
  end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',m.id,
      'name',coalesce(nullif(m.name,''),m.machine_code),
      'location',l.name,
      'removed_amount_lyd',cm.removed_amount_lyd::text,
      'removal_type',cm.removal_type
    ) order by coalesce(l.name,m.name,m.machine_code),m.id),'[]'::jsonb)
    from public.cash_collection_machines cm
    join public.machines m on m.id=cm.machine_id
    left join public.locations l on l.id=m.location_id
    where cm.cash_collection_id=p_collection_id
  );
end;
$$;

revoke all on function snacky_private.cash_collection_machine_lines_v1_impl(uuid)
  from public,anon,authenticated;
grant execute on function snacky_private.cash_collection_machine_lines_v1_impl(uuid)
  to authenticated,service_role;

create or replace function public.snacky_cash_collection_machine_lines_v1(p_collection_id uuid)
returns jsonb
language sql
set search_path=public,auth,snacky_private
as $$
  select snacky_private.cash_collection_machine_lines_v1_impl(p_collection_id);
$$;

revoke all on function public.snacky_cash_collection_machine_lines_v1(uuid) from public,anon;
grant execute on function public.snacky_cash_collection_machine_lines_v1(uuid) to authenticated,service_role;

select pg_notify('pgrst','reload schema');
