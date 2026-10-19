-- Snacky: machine incident to shared operator queue (first claim wins).
-- CRM remains owner of customer complaints; field operators can close only
-- machine-only reports after proving a fix.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

CREATE OR REPLACE FUNCTION public.snacky_report_machine_issue_v1(p_request_id uuid, p_machine_id uuid, p_description text, p_priority text DEFAULT 'high'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor uuid:=auth.uid();
  v_me uuid;
  v_request jsonb;
  v_saved public.crm_command_receipts%rowtype;
  v_machine public.machines%rowtype;
  v_issue public.issues%rowtype;
  v_response jsonb;
  v_priority text:=pg_catalog.lower(pg_catalog.btrim(coalesce(p_priority,'high')));
  v_description text:=nullif(pg_catalog.btrim(coalesce(p_description,'')),'');
  v_task public.crm_tasks%rowtype;
  v_operator record;
  v_alert_count integer:=0;
begin
  if v_actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']) then
    raise exception 'Customer relations access required.' using errcode='42501';
  end if;
  v_me:=public.snacky_current_team_member_id();
  if v_me is null then
    raise exception 'Active team member required.' using errcode='42501';
  end if;
  if p_request_id is null or p_machine_id is null then
    raise exception 'Request and machine are required.' using errcode='22023';
  end if;
  if v_description is null or pg_catalog.length(v_description)<3 or pg_catalog.length(v_description)>2000 then
    raise exception 'Describe the machine problem in 3 to 2000 characters.' using errcode='22023';
  end if;
  if v_priority not in ('normal','high','critical') then
    raise exception 'Choose Normal, High or Critical priority.' using errcode='22023';
  end if;
  v_request:=pg_catalog.jsonb_build_object(
    'machine_id',p_machine_id,
    'description',v_description,
    'priority',v_priority
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:crm-machine-report:'||p_request_id::text,0)
  );
  select * into v_saved
  from public.crm_command_receipts
  where id=p_request_id
  for update;
  if found then
    if v_saved.actor_user_id is distinct from v_actor
      or v_saved.action is distinct from 'machine.report'
      or v_saved.request is distinct from v_request
    then
      raise exception 'Saved request does not match this machine report.' using errcode='23505';
    end if;
    return v_saved.response;
  end if;
  select * into v_machine
  from public.machines
  where id=p_machine_id and status::text<>'inactive'
  for share;
  if not found then
    raise exception 'Machine is not active or was not found.' using errcode='23503';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:machine-issue:'||p_machine_id::text,0)
  );
  select * into v_issue
  from public.issues i
  where i.machine_id=p_machine_id
    and i.issue_type='machine_unavailable'
    and i.status::text not in ('resolved','closed')
    and i.archived_at is null
    and coalesce(i.is_practice,false)=false
    -- Never merge a machine-only field report into a customer complaint.
    and nullif(pg_catalog.btrim(i.customer_phone),'') is null
    and nullif(pg_catalog.btrim(i.customer_whatsapp),'') is null
    and nullif(pg_catalog.btrim(i.customer_name),'') is null
    and i.contact_channel='other'
  order by i.created_at desc
  limit 1
  for update;
  if not found then
    insert into public.issues(
      machine_id,location_id,reported_by,assigned_to,issue_type,priority,status,
      description,contact_channel,updated_by
    )
    values(
      v_machine.id,v_machine.location_id,v_me,v_me,'machine_unavailable',
      v_priority::public.issue_priority,'open',v_description,'other',v_me
    )
    returning * into v_issue;
  end if;
  -- The same CRM issue remains the owner record. Create exactly one
  -- *unassigned* field-action task, visible for active operators to claim.
  select * into v_task
  from public.crm_tasks t
  where t.issue_id=v_issue.id
    and t.task_type='field_action'
    and t.archived_at is null
    and t.status<>'completed'
  order by t.created_at desc
  limit 1
  for update;

  if not found then
    insert into public.crm_tasks(
      title,issue_id,task_type,assigned_to,due_date,priority,notes,status,
      dispatch_state,created_by,updated_by,is_practice
    )
    values(
      'Inspect machine failure',v_issue.id,'field_action',null,
      (pg_catalog.clock_timestamp() at time zone 'Africa/Tripoli')::date,
      case v_priority when 'critical' then 'urgent' else v_priority end,
      'Machine issue reported by Customer Relations — claim and report the result.',
      'open','available',v_me,v_me,false
    )
    returning * into v_task;

    update public.issues
    set is_waiting=true,
        waiting_on='operator',
        next_action='Machine failure available for an operator to claim',
        next_action_date=(pg_catalog.clock_timestamp() at time zone 'Africa/Tripoli')::date,
        updated_at=pg_catalog.clock_timestamp(),
        updated_by=v_me
    where id=v_issue.id
      and status not in ('resolved','closed');

    -- In-app notifications are durable even if an operator has not enabled
    -- device push. The single operator who claims becomes the assignee.
    for v_operator in
      select distinct t.id
      from public.team_members t
      join public.profiles p on p.team_member_id=t.id
      where t.active and t.active_status='active' and p.active_status='active'
        and (t.role::text='operator' or coalesce(t.roles::text[],'{}')&&array['operator'])
    loop
      begin
        perform snacky_notice_private.emit(
          'task',v_task.id,v_operator.id,'available',
          'Machine unavailable / ماكينة لا تعمل','/operator/issues'
        );
      exception when others then
        -- A push/notification failure cannot roll back the machine report.
        raise warning 'Machine issue operator notification could not be queued: %',sqlstate;
      end;
    end loop;
  end if;

  select count(*)::integer into v_alert_count
  from public.notifications
  where source_kind='task'
    and source_id=v_task.id
    and event_kind='available';
  v_response:=pg_catalog.jsonb_build_object(
    'ok',true,
    'id',v_issue.id,
    'kind','issue',
    'machine_id',v_machine.id,
    'machine_name',coalesce(nullif(v_machine.name,''),v_machine.machine_code),
    'task_id',v_task.id,
    'dispatch_state',v_task.dispatch_state,
    'operator_alerts_queued',v_alert_count,
    'operator_notified',v_alert_count>0,
    'needs_field_assignment',false
  );
  insert into public.crm_command_receipts(id,actor_user_id,action,request,response)
  values(p_request_id,v_actor,'machine.report',v_request,v_response);
  return v_response;
end
$function$
;

-- Shared machine-only queue claim. This does not authorize operators to
-- create/modify customer complaints or claim CRM-assigned customer work.
create or replace function public.snacky_claim_machine_issue_v1(
  p_request_id uuid,
  p_task_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $claim$
declare
  v_actor uuid:=auth.uid();
  v_member uuid;
  v_request jsonb;
  v_saved public.crm_command_receipts%rowtype;
  v_task public.crm_tasks%rowtype;
  v_issue public.issues%rowtype;
  v_response jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if v_actor is null
    or not public.snacky_current_profile_has_any_role(array['operator'])
  then
    raise exception 'Active operator access required' using errcode='42501';
  end if;
  v_member:=public.snacky_current_team_member_id();
  if v_member is null or not exists(
    select 1 from public.team_members t
    where t.id=v_member and t.active and t.active_status='active'
      and (t.role::text='operator' or coalesce(t.roles::text[],'{}')&&array['operator'])
  ) then
    raise exception 'Active operator profile is required' using errcode='42501';
  end if;
  if p_request_id is null or p_task_id is null then
    raise exception 'Claim request and task are required' using errcode='22023';
  end if;
  v_request:=pg_catalog.jsonb_build_object('task_id',p_task_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:machine-claim:'||p_request_id::text,0)
  );
  select * into v_saved from public.crm_command_receipts
  where id=p_request_id for update;
  if found then
    if v_saved.actor_user_id is distinct from v_actor
      or v_saved.action is distinct from 'machine.issue.claim'
      or v_saved.request is distinct from v_request then
      raise exception 'Claim request was used for a different action' using errcode='23505';
    end if;
    return v_saved.response;
  end if;

  -- Row lock serializes simultaneous operators. Exactly one gets ownership.
  select * into v_task from public.crm_tasks
  where id=p_task_id for update;
  if not found or v_task.task_type<>'field_action'
    or v_task.issue_id is null or v_task.archived_at is not null
    or v_task.status='completed' then
    raise exception 'Machine issue is not available' using errcode='23514';
  end if;
  select * into v_issue from public.issues where id=v_task.issue_id for share;
  if not found or v_issue.issue_type<>'machine_unavailable'
    or v_issue.archived_at is not null
    or v_issue.status::text in ('resolved','closed')
    or coalesce(v_issue.is_practice,false)
    or not exists(
      select 1 from public.crm_command_receipts r
      where r.action='machine.report'
        and r.response->>'id'=v_issue.id::text
    )
  then
    raise exception 'This task is not a shared machine-failure report' using errcode='23514';
  end if;
  if v_task.assigned_to is distinct from v_member then
    if v_task.assigned_to is not null or v_task.dispatch_state<>'available' then
      raise exception 'Another operator already claimed this machine issue' using errcode='40001';
    end if;
    update public.crm_tasks
      set assigned_to=v_member,updated_by=v_member,updated_at=v_now
      where id=v_task.id
      returning * into v_task;
    -- Claiming means accepting responsibility. The field work can start
    -- directly on arrival without a redundant second Accept tap.
    perform pg_catalog.set_config('snacky.crm_dispatch_task_id',v_task.id::text,true);
    update public.crm_tasks
      set dispatch_state='accepted',acknowledged_at=coalesce(acknowledged_at,v_now),
          status='in_progress',updated_by=v_member,updated_at=v_now
      where id=v_task.id
      returning * into v_task;
    perform pg_catalog.set_config('snacky.crm_dispatch_task_id','',true);

    update public.issues
      set status='in_progress',is_waiting=true,waiting_on='operator',
          next_action='Operator claimed machine-failure report',
          next_action_date=(v_now at time zone 'Africa/Tripoli')::date,
          updated_at=v_now,updated_by=v_member
      where id=v_issue.id and status not in ('resolved','closed');
  end if;

  -- Clear the previously broadcast unread queue alerts for everyone,
  -- preventing obsolete claim prompts after another operator takes it.
  update public.notifications
  set read_at=coalesce(read_at,v_now)
  where source_kind='task' and source_id=v_task.id
    and event_kind='available' and read_at is null;

  v_response:=pg_catalog.jsonb_build_object(
    'ok',true,
    'request_id',p_request_id,
    'action','claim',
    'task_id',v_task.id,
    'issue_id',v_issue.id,
    'assigned_to',v_task.assigned_to,
    'dispatch_state',v_task.dispatch_state,
    'href','/follow-ups/'||v_task.id::text
  );
  insert into public.crm_command_receipts(id,actor_user_id,action,request,response)
  values(p_request_id,v_actor,'machine.issue.claim',v_request,v_response);
  return v_response;
end
$claim$;

revoke all on function public.snacky_claim_machine_issue_v1(uuid,uuid) from public,anon;
grant execute on function public.snacky_claim_machine_issue_v1(uuid,uuid) to authenticated;


CREATE OR REPLACE FUNCTION crm_dispatch_private.command(p_command jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user uuid:=auth.uid();
  v_actor_member uuid;
  v_request_id uuid;
  v_task_id uuid;
  v_action text;
  v_version text;
  v_note text;
  v_task public.crm_tasks%rowtype;
  v_issue public.issues%rowtype;
  v_saved crm_dispatch_private.requests%rowtype;
  v_response jsonb;
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_photo_count integer;
  v_due date:=(v_now at time zone 'Africa/Tripoli')::date;
begin
  if v_actor_user is null then
    raise exception 'Sign in required' using errcode='42501';
  end if;
  v_actor_member:=public.snacky_current_team_member_id();
  if v_actor_member is null
    or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator'])
  then
    raise exception 'Active staff access required' using errcode='42501';
  end if;
  if p_command is null or pg_catalog.jsonb_typeof(p_command)<>'object'
    or pg_catalog.octet_length(p_command::text)>12000
  then
    raise exception 'Invalid dispatch command' using errcode='22023';
  end if;

  begin
    v_request_id:=(p_command->>'request_id')::uuid;
    v_task_id:=(p_command->>'task_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Valid request and task IDs are required' using errcode='22023';
  end;
  v_action:=pg_catalog.lower(pg_catalog.btrim(coalesce(p_command->>'action','')));
  v_version:=nullif(p_command->>'version','');
  v_note:=nullif(pg_catalog.btrim(coalesce(p_command->>'note','')),'');

  if v_request_id is null or v_task_id is null
    or v_action not in ('accept','en_route','start','block','fix','needs_technician','needs_part','machine_offline')
  then
    raise exception 'Invalid dispatch command' using errcode='22023';
  end if;
  if pg_catalog.length(coalesce(v_note,''))>2000 then
    raise exception 'Dispatch note is too long' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:crm-dispatch:'||v_request_id::text,0)
  );

  select * into v_saved
  from crm_dispatch_private.requests
  where request_id=v_request_id
  for update;
  if found then
    if v_saved.actor_user_id is distinct from v_actor_user
      or v_saved.task_id is distinct from v_task_id
      or v_saved.request is distinct from p_command
    then
      raise exception 'This request ID was already used for another dispatch action' using errcode='23505';
    end if;
    if v_saved.response is not null then return v_saved.response;end if;
  else
    insert into crm_dispatch_private.requests(request_id,actor_user_id,task_id,request)
    values(v_request_id,v_actor_user,v_task_id,p_command);
  end if;

  select * into v_task
  from public.crm_tasks
  where id=v_task_id
  for update;
  if not found
    or v_task.task_type<>'field_action'
    or v_task.issue_id is null
    or v_task.dispatch_state is null
    or v_task.archived_at is not null
  then
    raise exception 'This field action is not available for dispatch' using errcode='23514';
  end if;
  if v_task.assigned_to is distinct from v_actor_member then
    raise exception 'Only the assigned employee can report this field action' using errcode='42501';
  end if;
  if v_version is null or v_version is distinct from v_task.updated_at::text then
    raise exception 'This field action changed. Reload before continuing' using errcode='40001';
  end if;

  select * into v_issue from public.issues where id=v_task.issue_id for share;
  if not found or v_issue.archived_at is not null or v_issue.status::text in ('resolved','closed') then
    raise exception 'The customer issue is no longer open for field work' using errcode='23514';
  end if;

  if v_action='accept' then
    if v_task.dispatch_state<>'assigned' then
      raise exception 'This action has already been acknowledged or changed' using errcode='23514';
    end if;
  elsif v_action='en_route' then
    if v_task.dispatch_state<>'accepted' then
      raise exception 'Accept the task before going on the way' using errcode='23514';
    end if;
  elsif v_action='start' then
    if v_task.dispatch_state not in ('accepted','en_route','blocked') then
      raise exception 'Accept the task before starting work' using errcode='23514';
    end if;
  elsif v_action='block' then
    if v_task.dispatch_state not in ('accepted','en_route','working') then
      raise exception 'Only active field work can be marked blocked' using errcode='23514';
    end if;
    if v_note is null or pg_catalog.length(v_note)<3 then
      raise exception 'Explain what is blocking the field work' using errcode='23514';
    end if;
  else
    if v_task.dispatch_state<>'working' then
      raise exception 'Start the field work before recording the visit outcome' using errcode='23514';
    end if;
    if v_note is null or pg_catalog.length(v_note)<3 then
      raise exception 'Write the visit result before completing the field task' using errcode='23514';
    end if;
    select count(*)::integer into v_photo_count
    from public.crm_documents d
    where d.task_id=v_task_id
      and pg_catalog.lower(coalesce(d.mime_type,'')) like 'image/%';
    if v_photo_count<1 then
      raise exception 'Upload at least one field photo before completing the field task' using errcode='23514';
    end if;
  end if;

  perform pg_catalog.set_config('snacky.crm_dispatch_task_id',v_task_id::text,true);

  if v_action='accept' then
    update public.crm_tasks
    set dispatch_state='accepted',acknowledged_at=v_now,status='in_progress',
        updated_by=v_actor_member,updated_at=v_now
    where id=v_task_id;
  elsif v_action='en_route' then
    update public.crm_tasks
    set dispatch_state='en_route',en_route_at=v_now,status='in_progress',
        updated_by=v_actor_member,updated_at=v_now
    where id=v_task_id;
  elsif v_action='start' then
    update public.crm_tasks
    set dispatch_state='working',work_started_at=coalesce(work_started_at,v_now),
        status='in_progress',updated_by=v_actor_member,updated_at=v_now
    where id=v_task_id;
  elsif v_action='block' then
    update public.crm_tasks
    set dispatch_state='blocked',blocked_at=v_now,blocked_reason=v_note,
        dispatch_note=v_note,status='in_progress',updated_by=v_actor_member,updated_at=v_now
    where id=v_task_id;
  elsif v_action='fix' then
    update public.crm_tasks
    set dispatch_state='fixed',fixed_at=v_now,dispatch_note=v_note,status='completed',
        result=v_note,completed_at=v_now,completed_by=v_actor_member,
        updated_by=v_actor_member,updated_at=v_now
    where id=v_task_id;
  else
    update public.crm_tasks
    set dispatch_state=v_action,dispatch_note=v_note,status='completed',
        result=v_note,completed_at=v_now,completed_by=v_actor_member,
        updated_by=v_actor_member,updated_at=v_now
    where id=v_task_id;
  end if;

  perform pg_catalog.set_config('snacky.crm_dispatch_task_id','',true);

  -- A machine-only fault is closed atomically when its assigned operator
  -- records Fixed with a diagnosis and field photo (validated above).
  -- Never close customer complaints automatically, even if a machine was fixed.
  if v_action='fix'
    and v_issue.issue_type='machine_unavailable'
    and v_issue.archived_at is null
    and coalesce(v_issue.is_practice,false)=false
    and nullif(pg_catalog.btrim(v_issue.customer_name),'') is null
    and nullif(pg_catalog.btrim(v_issue.customer_phone),'') is null
    and nullif(pg_catalog.btrim(v_issue.customer_whatsapp),'') is null
    and v_issue.contact_channel='other'
    and exists(
      select 1 from public.crm_command_receipts receipt
      where receipt.action='machine.report'
        and receipt.response->>'id'=v_issue.id::text
    )
  then
    update public.issues
    set status='resolved',resolved_at=v_now,resolved_by=v_actor_member,
        resolution=v_note,is_waiting=false,waiting_on=null,
        next_action=null,next_action_date=null,
        updated_at=v_now,updated_by=v_actor_member
    where id=v_issue.id and status not in ('resolved','closed');
  end if;

  if v_action in ('accept','en_route','start','block') then
    update public.issues
    set status='in_progress',is_waiting=true,waiting_on='operator',
        next_action=case v_action
          when 'accept' then 'Operator accepted field visit'
          when 'en_route' then 'Operator is on the way'
          when 'start' then 'Operator is working on the machine'
          else 'Operator reported a field blocker'
        end,
        next_action_date=v_due,updated_at=v_now,updated_by=v_actor_member
    where id=v_task.issue_id and status not in ('resolved','closed');
  end if;

  if v_action='machine_offline' and v_issue.machine_id is not null then
    update public.machines
    set status='maintenance',updated_at=v_now
    where id=v_issue.machine_id and status not in ('retired','relocated');
  elsif v_action='fix' and v_issue.machine_id is not null then
    update public.machines
    set status='active',updated_at=v_now
    where id=v_issue.machine_id and status='maintenance';
  end if;

  select * into v_task from public.crm_tasks where id=v_task_id;

  v_response:=pg_catalog.jsonb_build_object(
    'ok',true,
    'request_id',v_request_id,
    'task_id',v_task_id,
    'action',v_action,
    'dispatch_state',v_task.dispatch_state,
    'status',v_task.status,
    'version',v_task.updated_at::text
  );
  update crm_dispatch_private.requests
  set response=v_response
  where request_id=v_request_id;
  return v_response;
end;
$function$
;

select pg_notify('pgrst','reload schema');
commit;
