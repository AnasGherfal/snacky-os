-- Count each machine separately inside a shared physical cash box.
-- The box remains the custody unit; Finance still receives one total equal to the machine sum.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.cash_collection_machines
  add column if not exists counted_amount_lyd numeric(12,2)
  check (counted_amount_lyd is null or counted_amount_lyd >= 0);

comment on column public.cash_collection_machines.counted_amount_lyd is
  'Physical amount counted for this machine within the shared cash box. The collection total is the sum posted to Finance.';

create or replace function snacky_private.cash_handover_validate_v1(p_command jsonb)
returns void language plpgsql set search_path=pg_catalog
as $$
declare p jsonb; a text; v_key text; allowed text[];
begin
  if jsonb_typeof(p_command) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_command))<>5
    or exists(select 1 from jsonb_object_keys(p_command) k where k not in ('request_id','collection_id','action','revision','payload'))
    or coalesce(p_command->>'request_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or jsonb_typeof(p_command->'revision') is distinct from 'number'
    or coalesce(p_command->>'revision','') !~ '^(0|[1-9][0-9]{0,8})$'
    or jsonb_typeof(p_command->'payload') is distinct from 'object'
    or length(p_command::text)>10000 then
    raise exception 'Invalid cash handover command' using errcode='22023';
  end if;
  p:=p_command->'payload'; a:=p_command->>'action';
  case a
    when 'enable' then allowed:=array['enabled'];
    when 'counter' then allowed:=array['user_id','enabled'];
    when 'assign' then allowed:=array['assigned_to'];
    when 'dropoff' then allowed:=array['assigned_to','storage_location','seal_condition','notes'];
    when 'pickup','direct_pickup','takeover' then allowed:=array['confirm_bag_id','seal_condition','notes'];
    when 'count' then allowed:=case when p ? 'machine_counts' then array['amount','cash_location','machine_counts'] else array['amount','cash_location'] end;
    else raise exception 'Invalid cash handover action' using errcode='22023';
  end case;
  if exists(select 1 from jsonb_object_keys(p) k where not k=any(allowed))
    or (select count(*) from jsonb_object_keys(p))<>cardinality(allowed) then
    raise exception 'Invalid action fields' using errcode='22023';
  end if;
  if a in ('enable','counter') then
    if jsonb_typeof(p->'enabled') is distinct from 'boolean' or p_command->'collection_id' is distinct from 'null'::jsonb or (p_command->>'revision')::int<>0 then
      raise exception 'Invalid management command' using errcode='22023';
    end if;
  elsif coalesce(p_command->>'collection_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'A collection reference is required' using errcode='22023';
  end if;
  foreach v_key in array allowed loop
    if v_key<>'enabled' and jsonb_typeof(p->v_key) is distinct from 'string' then
      raise exception 'Invalid text field' using errcode='22023';
    end if;
  end loop;
  if a='counter' and (p->>'user_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Invalid counter' using errcode='22023';
  end if;
  if a in ('assign','dropoff') and (p->>'assigned_to') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Select a cash coordinator' using errcode='22023';
  end if;
  if a in ('dropoff','pickup','direct_pickup','takeover') then
    if (p->>'seal_condition') not in ('intact','broken','mismatch') or length(p->>'notes')>1000
      or ((a='takeover' or p->>'seal_condition'<>'intact') and length(trim(p->>'notes'))<3) then
      raise exception 'Record the seal and explain any exception or custody takeover' using errcode='22023';
    end if;
  end if;
  if a='dropoff' and length(trim(p->>'storage_location')) not between 2 and 180 then
    raise exception 'Specify the exact safe or storage location' using errcode='22023';
  end if;
  if a in ('pickup','direct_pickup','takeover') and length(trim(p->>'confirm_bag_id')) not between 1 and 120 then
    raise exception 'Confirm the physical box reference' using errcode='22023';
  end if;
  if a='count' and ((p->>'amount') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?
end;
$$;
revoke all on function snacky_private.cash_handover_validate_v1(jsonb) from public,anon,authenticated;


    or length(trim(p->>'cash_location')) not between 2 and 180
    or (p ? 'machine_counts' and length(p->>'machine_counts') > 8000)) then
    raise exception 'Enter valid per-machine cash amounts and where the counted cash will be kept' using errcode='22023';
  end if;
end;
$$;
revoke all on function snacky_private.cash_handover_validate_v1(jsonb) from public,anon,authenticated;



create or replace function snacky_private.cash_handover_command_v1_impl(p_command jsonb,p_evidence_path text default null)
returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,auth,snacky_private
as $$
declare
  v_actor uuid:=auth.uid(); v_team uuid; v_owner boolean; v_counter boolean; v_enabled boolean;
  v_request uuid; v_id uuid; v_action text; p jsonb; v_revision integer;
  v_cash public.cash_collections%rowtype; h snacky_private.cash_handovers%rowtype;
  r snacky_private.cash_handover_requests%rowtype; v_has_handover boolean;
  v_target uuid; v_now timestamptz:=clock_timestamp(); v_result jsonb; v_amount numeric;
  v_finance_count integer; v_finance_amount numeric; v_event_detail jsonb:='{}'::jsonb;
  v_machine_counts jsonb; v_expected_machine_count integer; v_submitted_machine_count integer;
begin
  perform snacky_private.cash_handover_validate_v1(p_command);
  if v_actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','warehouse','purchasing','finance']) then
    raise exception 'Not authorized for cash handling' using errcode='42501';
  end if;
  select p0.team_member_id into v_team from public.profiles p0
    where p0.id=v_actor and p0.active_status='active' for share;
  if v_team is null then raise exception 'Link this active account to a team member first' using errcode='42501'; end if;
  perform 1 from public.team_members t where t.id=v_team and coalesce(t.active_status,'active')='active' and coalesce(t.active,true) for share;
  if not found then raise exception 'The team member is inactive' using errcode='42501'; end if;
  -- Serialize grant revocation against an in-flight counter action.
  perform 1 from snacky_private.cash_handover_counters where user_id=v_actor for share;
  v_owner:=public.snacky_current_profile_has_any_role(array['owner','admin']);
  v_counter:=snacky_private.cash_handover_counter_v1(v_actor);
  v_request:=(p_command->>'request_id')::uuid; v_id:=(p_command->>'collection_id')::uuid;
  v_action:=p_command->>'action'; p:=p_command->'payload'; v_revision:=(p_command->>'revision')::integer;
  if v_action in ('enable','counter','assign','takeover') and not v_owner then
    raise exception 'Only the owner or admin can manage cash responsibility' using errcode='42501';
  end if;
  if v_action in ('pickup','direct_pickup','count') and not v_counter then
    raise exception 'Cash coordinator permission is required' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cash-handover:'||v_request::text,0));
  select * into r from snacky_private.cash_handover_requests where request_id=v_request;
  if found then
    if r.actor_user_id<>v_actor or r.command<>p_command then
      raise exception 'This request reference was used for different work' using errcode='23505';
    end if;
    if r.result is null then raise exception 'Save not confirmed; retry the same request' using errcode='40001'; end if;
    return r.result;
  end if;
  select enabled into v_enabled from snacky_private.cash_handover_settings where singleton;

  if v_id is not null then
    -- All cash commands and the original count function lock the same parent.
    select * into v_cash from public.cash_collections where id=v_id for update;
    if not found then raise exception 'Collection unavailable' using errcode='42501'; end if;
    select * into h from snacky_private.cash_handovers where collection_id=v_id for update;
    v_has_handover:=found;
    if not (v_owner or v_cash.operator_id=v_team or (v_has_handover and h.assigned_to=v_actor)) then
      raise exception 'Collection unavailable' using errcode='42501';
    end if;
    -- Older cash records may have no physical box/seal identifier. Never
    -- manufacture one or enroll them through an unchecked NULL comparison.
    if coalesce(v_cash.cash_bag_id,'') !~ '[^[:space:]]' then
      raise exception 'This record has no physical box reference; review the existing cash record without creating a replacement collection' using errcode='23514';
    end if;
    if v_cash.custody_status not in ('removed','in_storage') or v_cash.actual_cash_collected is not null or v_cash.voided_at is not null then
      raise exception 'This collection is already counted or closed' using errcode='23514';
    end if;
    if coalesce(h.revision,0)<>v_revision then
      raise exception 'The box changed on another device; reload before continuing' using errcode='40001';
    end if;
    if not v_has_handover and not v_enabled then
      raise exception 'New handovers are paused; existing boxes can still be completed' using errcode='23514';
    end if;
  end if;

  insert into snacky_private.cash_handover_requests(request_id,actor_user_id,collection_id,command)
    values(v_request,v_actor,v_id,p_command);

  case v_action
    when 'enable' then
      update snacky_private.cash_handover_settings set enabled=(p->>'enabled')::boolean,updated_by=v_actor,updated_at=v_now where singleton;
      v_event_detail:=p;
    when 'counter' then
      v_target:=(p->>'user_id')::uuid;
      perform 1 from public.profiles t where t.id=v_target and t.active_status='active' and t.team_member_id is not null
        and (public.snacky_profile_has_any_role(t.roles,t.role,array['operator','warehouse','purchasing','finance','supervisor'])
          or exists(select 1 from public.team_members tm where tm.id=t.team_member_id and public.snacky_profile_has_any_role(tm.roles,tm.role,array['operator','warehouse','purchasing','finance','supervisor']))) for share;
      if (p->>'enabled')::boolean and not found then raise exception 'Choose an active operational account linked to a team member' using errcode='22023'; end if;
      insert into snacky_private.cash_handover_counters(user_id,enabled,updated_by,updated_at)
        values(v_target,(p->>'enabled')::boolean,v_actor,v_now)
        on conflict(user_id) do update set enabled=excluded.enabled,updated_by=excluded.updated_by,updated_at=excluded.updated_at;
      v_event_detail:=p;
    when 'assign' then
      v_target:=(p->>'assigned_to')::uuid;
      if not snacky_private.cash_handover_counter_v1(v_target) then raise exception 'The selected coordinator is not active or authorized' using errcode='22023'; end if;
      if v_has_handover and h.stage='picked_up' then raise exception 'Record an actual custody takeover instead of reassigning a box someone holds' using errcode='23514'; end if;
      insert into snacky_private.cash_handovers(collection_id,assigned_to,stage)
        values(v_id,v_target,'assigned') on conflict(collection_id) do update
        set assigned_to=excluded.assigned_to,revision=cash_handovers.revision+1,updated_at=v_now;
      v_event_detail:=jsonb_build_object('assigned_to',v_target);
    when 'dropoff' then
      if v_cash.operator_id is distinct from v_team or v_cash.custody_status<>'removed' or (v_has_handover and h.stage<>'assigned') then
        raise exception 'Only the recorded collector can record this first unattended drop-off' using errcode='42501';
      end if;
      v_target:=(p->>'assigned_to')::uuid;
      if (v_has_handover and h.assigned_to<>v_target) or not snacky_private.cash_handover_counter_v1(v_target) then
        raise exception 'Use the assigned active coordinator; an owner can change the assignment' using errcode='22023';
      end if;
      if p_evidence_path is null or p_evidence_path not like ('cash-handover-'||v_actor::text||'-'||v_request::text||'/%')
        or not exists(select 1 from storage.objects where bucket_id='cash-evidence' and name=p_evidence_path) then
        raise exception 'Upload a photo of this box in its storage location' using errcode='22023';
      end if;
      insert into snacky_private.cash_handovers(collection_id,assigned_to,stage,deposited_at,deposited_by,storage_location,drop_photo_path)
        values(v_id,v_target,'dropped',v_now,v_actor,trim(p->>'storage_location'),p_evidence_path)
        on conflict(collection_id) do update set stage='dropped',deposited_at=v_now,deposited_by=v_actor,
          storage_location=excluded.storage_location,drop_photo_path=excluded.drop_photo_path,
          revision=cash_handovers.revision+1,updated_at=v_now;
      -- Physical arrival, NOT acknowledgment by another person.
      update public.cash_collections set custody_status='in_storage',storage_received_at=v_now,storage_received_by=null,
        storage_location=trim(p->>'storage_location'),storage_seal_condition=p->>'seal_condition',
        storage_notes='Unattended drop-off; pickup must be acknowledged in Cash handling. '||trim(p->>'notes'),updated_at=v_now where id=v_id;
      update public.cash_removal_receipts set custody_status='in_storage',storage_received_at=v_now,storage_received_by=null,
        storage_location=trim(p->>'storage_location'),updated_at=v_now where cash_collection_id=v_id;
      perform snacky_private.append_cash_collection_event(v_id,'stored',v_now,null,p->>'seal_condition',p_evidence_path,null,
        'Unattended drop-off; no independent receipt claimed. '||trim(p->>'notes'),
        jsonb_build_object('handover_mode','unattended_dropoff','receiver_confirmed',false),v_request);
      v_event_detail:=jsonb_build_object('location',trim(p->>'storage_location'),'seal',p->>'seal_condition','notes',trim(p->>'notes'),'assigned_to',v_target);
    when 'pickup','direct_pickup','takeover' then
      if upper(trim(p->>'confirm_bag_id')) is distinct from upper(trim(v_cash.cash_bag_id)) then raise exception 'The physical box reference does not match' using errcode='22023'; end if;
      if v_action='pickup' and (not v_has_handover or h.assigned_to<>v_actor or h.stage not in ('assigned','dropped') or v_cash.custody_status<>'in_storage') then
        raise exception 'This box is not waiting for your pickup' using errcode='42501';
      end if;
      if v_action='direct_pickup' and (v_cash.operator_id is distinct from v_team or v_cash.custody_status<>'removed' or (v_has_handover and (h.assigned_to<>v_actor or h.stage<>'assigned'))) then
        raise exception 'Direct counting is only for your own collected box' using errcode='42501';
      end if;
      if v_action='takeover' and (not v_has_handover or h.stage<>'picked_up' or h.picked_up_by=v_actor) then
        raise exception 'There is no other custodian to take over from' using errcode='23514';
      end if;
      insert into snacky_private.cash_handovers(collection_id,assigned_to,stage,picked_up_at,picked_up_by,pickup_seal,pickup_note)
        values(v_id,v_actor,'picked_up',v_now,v_actor,p->>'seal_condition',trim(p->>'notes'))
        on conflict(collection_id) do update set assigned_to=v_actor,stage='picked_up',picked_up_at=v_now,picked_up_by=v_actor,
          pickup_seal=excluded.pickup_seal,pickup_note=excluded.pickup_note,revision=cash_handovers.revision+1,updated_at=v_now;
      v_event_detail:=jsonb_build_object('seal',p->>'seal_condition','notes',trim(p->>'notes'),'previous_holder',h.picked_up_by);
    when 'count' then
      if not v_has_handover or h.stage<>'picked_up' or h.assigned_to<>v_actor or h.picked_up_by<>v_actor then
        raise exception 'Acknowledge physical pickup before counting' using errcode='42501';
      end if;
      if p ? 'machine_counts' then
        begin
          v_machine_counts:=(p->>'machine_counts')::jsonb;
        exception when others then
          raise exception 'Machine count breakdown is invalid' using errcode='22023';
        end;
        if jsonb_typeof(v_machine_counts) is distinct from 'array'
           or jsonb_array_length(v_machine_counts)<1
           or jsonb_array_length(v_machine_counts)>100 then
          raise exception 'Count every machine in this cash box separately' using errcode='22023';
        end if;
        if exists (
          select 1 from jsonb_array_elements(v_machine_counts) x(value)
          where jsonb_typeof(x.value) is distinct from 'object'
             or (select count(*) from jsonb_object_keys(x.value))<>2
             or exists(select 1 from jsonb_object_keys(x.value) k where k not in ('machine_id','amount'))
             or coalesce(x.value->>'machine_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}
  end case;

  insert into snacky_private.cash_handover_events(collection_id,event_type,actor_user_id,event_at,detail)
    values(v_id,v_action,v_actor,v_now,v_event_detail);
  v_result:=jsonb_build_object('ok',true,'request_id',v_request,'collection_id',v_id,'action',v_action,
    'revision',case when v_id is null then 0 else (select revision from snacky_private.cash_handovers where collection_id=v_id) end);
  if v_action='count' then v_result:=v_result||jsonb_build_object('amount',v_amount::text,'finance_posted',true); end if;
  update snacky_private.cash_handover_requests set result=v_result where request_id=v_request;
  return v_result;
end;
$$;
revoke all on function snacky_private.cash_handover_command_v1_impl(jsonb,text) from public,anon;
grant execute on function snacky_private.cash_handover_command_v1_impl(jsonb,text) to authenticated;


             or coalesce(x.value->>'amount','') !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?
  end case;

  insert into snacky_private.cash_handover_events(collection_id,event_type,actor_user_id,event_at,detail)
    values(v_id,v_action,v_actor,v_now,v_event_detail);
  v_result:=jsonb_build_object('ok',true,'request_id',v_request,'collection_id',v_id,'action',v_action,
    'revision',case when v_id is null then 0 else (select revision from snacky_private.cash_handovers where collection_id=v_id) end);
  if v_action='count' then v_result:=v_result||jsonb_build_object('amount',v_amount::text,'finance_posted',true); end if;
  update snacky_private.cash_handover_requests set result=v_result where request_id=v_request;
  return v_result;
end;
$$;
revoke all on function snacky_private.cash_handover_command_v1_impl(jsonb,text) from public,anon;
grant execute on function snacky_private.cash_handover_command_v1_impl(jsonb,text) to authenticated;


        ) then
          raise exception 'Every selected machine needs one valid counted LYD amount' using errcode='22023';
        end if;
        select count(*),count(distinct (x.value->>'machine_id')::uuid)
          into v_submitted_machine_count,v_expected_machine_count
        from jsonb_array_elements(v_machine_counts) x(value);
        if v_submitted_machine_count<>v_expected_machine_count then
          raise exception 'A machine can be counted only once in one cash box' using errcode='22023';
        end if;
        select count(*) into v_expected_machine_count
        from public.cash_collection_machines cm where cm.cash_collection_id=v_id;
        if v_expected_machine_count<>v_submitted_machine_count
           or exists (
             select 1 from public.cash_collection_machines cm
             where cm.cash_collection_id=v_id
               and not exists (
                 select 1 from jsonb_array_elements(v_machine_counts) x(value)
                 where (x.value->>'machine_id')::uuid=cm.machine_id
               )
           )
           or exists (
             select 1 from jsonb_array_elements(v_machine_counts) x(value)
             where not exists (
               select 1 from public.cash_collection_machines cm
               where cm.cash_collection_id=v_id and cm.machine_id=(x.value->>'machine_id')::uuid
             )
           ) then
          raise exception 'Counted machines must exactly match the machines in this cash box' using errcode='22023';
        end if;
        update public.cash_collection_machines cm
        set counted_amount_lyd=round((x.value->>'amount')::numeric,2)
        from jsonb_array_elements(v_machine_counts) x(value)
        where cm.cash_collection_id=v_id and cm.machine_id=(x.value->>'machine_id')::uuid;
        select round(coalesce(sum((x.value->>'amount')::numeric),0),2)
          into v_amount from jsonb_array_elements(v_machine_counts) x(value);
        if v_amount is distinct from (p->>'amount')::numeric then
          raise exception 'Cash-box total does not match the per-machine count sum' using errcode='22023';
        end if;
      else
        v_amount:=(p->>'amount')::numeric;
      end if;
      perform public.confirm_cash_count_auto_period_v1(v_id,v_amount,v_request);
      -- Keep pickup-seal exceptions visible to the owner's existing cash audit.
      update public.cash_collections set count_seal_condition=h.pickup_seal,
        reconciliation_status=case when h.pickup_seal<>'intact' or coalesce(storage_seal_condition,'intact')<>'intact' then 'variance_review' else reconciliation_status end,
        review_status=case when h.pickup_seal<>'intact' or coalesce(storage_seal_condition,'intact')<>'intact' then 'variance_review' else review_status end
        where id=v_id;
      -- Verify the existing trigger actually posted once; any failure rolls back
      -- count, per-machine breakdown, audit event, and Finance together.
      select count(*)::integer,min(ft.amount) into v_finance_count,v_finance_amount from public.financial_transactions ft
        where (ft.linked_cash_collection_id=v_id or ft.related_cash_collection_id=v_id or (ft.source_type='cash_collection' and ft.source_id=v_id))
          and coalesce(ft.transaction_status,'active')='active' and not coalesce(ft.is_void,false);
      if v_finance_count<>1 or v_finance_amount is distinct from v_amount then
        raise exception 'Finance posting was not verified; no count was saved' using errcode='23514';
      end if;
      update snacky_private.cash_handovers set cash_kept_at=trim(p->>'cash_location'),revision=revision+1,updated_at=v_now where collection_id=v_id;
      v_event_detail:=jsonb_build_object(
        'location',trim(p->>'cash_location'),
        'finance_posted',true,
        'machine_counts',coalesce(v_machine_counts,'[]'::jsonb)
      );
  end case;

  insert into snacky_private.cash_handover_events(collection_id,event_type,actor_user_id,event_at,detail)
    values(v_id,v_action,v_actor,v_now,v_event_detail);
  v_result:=jsonb_build_object('ok',true,'request_id',v_request,'collection_id',v_id,'action',v_action,
    'revision',case when v_id is null then 0 else (select revision from snacky_private.cash_handovers where collection_id=v_id) end);
  if v_action='count' then v_result:=v_result||jsonb_build_object('amount',v_amount::text,'finance_posted',true); end if;
  update snacky_private.cash_handover_requests set result=v_result where request_id=v_request;
  return v_result;
end;
$$;
revoke all on function snacky_private.cash_handover_command_v1_impl(jsonb,text) from public,anon;
grant execute on function snacky_private.cash_handover_command_v1_impl(jsonb,text) to authenticated;



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
      'counted_amount_lyd',cm.counted_amount_lyd::text,
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



select pg_notify('pgrst','reload schema');
commit;
