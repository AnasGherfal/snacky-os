-- Restore CRM-owned machine issue dispatch.
-- Customer Relations chooses the operator; operators no longer claim from a shared queue.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

-- Preserve old shared-queue records for audit, but remove them from active work so
-- CRM can make an explicit operator assignment instead.
with stale as (
  select id,issue_id
  from public.crm_tasks
  where task_type='field_action'
    and dispatch_state='available'
    and assigned_to is null
    and archived_at is null
    and status<>'completed'
), archived as (
  update public.crm_tasks t
  set archived_at=pg_catalog.clock_timestamp(),
      updated_at=pg_catalog.clock_timestamp()
  from stale s
  where t.id=s.id
  returning t.issue_id
)
update public.issues i
set status='open',
    is_waiting=false,
    waiting_on=null,
    next_action='Customer Relations to assign an operator field visit',
    next_action_date=(pg_catalog.clock_timestamp() at time zone 'Africa/Tripoli')::date,
    updated_at=pg_catalog.clock_timestamp()
where i.id in (select issue_id from archived where issue_id is not null)
  and i.status not in ('resolved','closed');

create or replace function public.snacky_issue_field_queue_command_v1(
  p_action text,
  p_issue_id uuid default null::uuid,
  p_task_id uuid default null::uuid,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_catalog'
as $function$
declare
  me uuid:=public.snacky_current_team_member_id();
  issue public.issues;
  task public.crm_tasks;
  op public.team_members;
  v_operator_id uuid;
  v_priority text;
  v_title text;
  v_notes text;
  v_due date:=(pg_catalog.clock_timestamp() at time zone 'Africa/Tripoli')::date;
  v_now timestamptz:=pg_catalog.clock_timestamp();
begin
  if auth.uid() is null or me is null then
    raise exception 'Active staff access required' using errcode='42501';
  end if;

  if p_action<>'create' then
    raise exception 'Only CRM field assignment is supported' using errcode='22023';
  end if;

  if not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']) then
    raise exception 'Customer relations access required' using errcode='42501';
  end if;

  if p_issue_id is null or not public.snacky_crm_allowed('issue',p_issue_id,true) then
    raise exception 'Issue unavailable' using errcode='42501';
  end if;

  begin
    v_operator_id:=(p_payload->>'operator_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid operator' using errcode='22023';
  end;
  if v_operator_id is null then
    raise exception 'Choose an operator' using errcode='22023';
  end if;

  select * into op
  from public.team_members t
  where t.id=v_operator_id
    and t.active
    and t.active_status='active'
    and (t.role::text='operator' or t.roles::text[]&&array['operator'])
  for share;
  if not found then
    raise exception 'The selected operator is not active' using errcode='23514';
  end if;

  select * into issue
  from public.issues
  where id=p_issue_id
  for update;
  if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed') then
    raise exception 'Issue is not open' using errcode='23514';
  end if;

  if exists(
    select 1
    from public.crm_tasks t
    where t.issue_id=p_issue_id
      and t.task_type='field_action'
      and t.archived_at is null
      and t.status<>'completed'
  ) then
    raise exception 'This issue already has active field work' using errcode='23505';
  end if;

  v_priority:=case coalesce(nullif(p_payload->>'priority',''),issue.priority::text,'normal')
    when 'critical' then 'urgent'
    when 'urgent' then 'urgent'
    when 'high' then 'high'
    when 'low' then 'low'
    else 'normal'
  end;
  v_title:=coalesce(nullif(pg_catalog.btrim(p_payload->>'title'),''),'Inspect and fix machine issue');
  v_notes:=nullif(pg_catalog.btrim(p_payload->>'notes'),'');
  if pg_catalog.length(coalesce(v_notes,''))>2000 then
    raise exception 'Instructions are too long' using errcode='22023';
  end if;

  -- dispatch_state is intentionally omitted: the existing dispatch guard turns
  -- a new assigned field action into state=assigned and sets its acknowledgement deadline.
  insert into public.crm_tasks(
    title,issue_id,task_type,assigned_to,due_date,priority,notes,status,
    created_by,updated_by,is_practice
  )
  values(
    v_title,p_issue_id,'field_action',v_operator_id,v_due,v_priority,v_notes,'open',
    me,me,coalesce(issue.is_practice,false)
  )
  returning * into task;

  update public.issues
  set status='assigned',
      is_waiting=true,
      waiting_on='operator',
      next_action='Operator field visit assigned by Customer Relations',
      next_action_date=v_due,
      updated_at=v_now,
      updated_by=me
  where id=p_issue_id
    and status not in ('resolved','closed');

  perform public.snacky_crm_emit(
    'issue',
    p_issue_id,
    'field_assigned',
    'Operator field visit assigned',
    null,
    jsonb_build_object('task_id',task.id,'operator_id',v_operator_id)
  );

  return jsonb_build_object(
    'ok',true,
    'action','create',
    'task_id',task.id,
    'dispatch_state',task.dispatch_state,
    'assigned_to',task.assigned_to
  );
end
$function$;

revoke all on function public.snacky_issue_field_queue_command_v1(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.snacky_issue_field_queue_command_v1(text,uuid,uuid,jsonb) to authenticated;

-- The quick CRM machine-report action records the issue only. It must not bypass
-- named assignment by broadcasting or auto-creating operator field work.
create or replace function public.snacky_report_machine_issue_v1(
  p_request_id uuid,
  p_machine_id uuid,
  p_description text,
  p_priority text default 'high'
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor uuid:=auth.uid();
  v_me uuid;
  v_request jsonb;
  v_saved public.crm_command_receipts%rowtype;
  v_machine public.machines%rowtype;
  v_issue public.issues%rowtype;
  v_response jsonb;
  v_priority text:=pg_catalog.lower(pg_catalog.btrim(pg_catalog.coalesce(p_priority,'high')));
  v_description text:=pg_catalog.nullif(pg_catalog.btrim(pg_catalog.coalesce(p_description,'')),'');
  v_has_field_work boolean:=false;
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
    and pg_catalog.coalesce(i.is_practice,false)=false
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

  select exists(
    select 1
    from public.crm_tasks t
    where t.issue_id=v_issue.id
      and t.task_type='field_action'
      and t.archived_at is null
      and t.status<>'completed'
  ) into v_has_field_work;

  if not v_has_field_work then
    update public.issues
    set is_waiting=false,
        waiting_on=null,
        next_action='Customer Relations to assign an operator field visit',
        next_action_date=(pg_catalog.clock_timestamp() at time zone 'Africa/Tripoli')::date,
        updated_at=pg_catalog.clock_timestamp(),
        updated_by=v_me
    where id=v_issue.id
      and status not in ('resolved','closed');
  end if;

  v_response:=pg_catalog.jsonb_build_object(
    'ok',true,
    'id',v_issue.id,
    'kind','issue',
    'machine_id',v_machine.id,
    'machine_name',pg_catalog.coalesce(pg_catalog.nullif(v_machine.name,''),v_machine.machine_code),
    'operator_notified',false,
    'needs_field_assignment',not v_has_field_work
  );

  insert into public.crm_command_receipts(id,actor_user_id,action,request,response)
  values(p_request_id,v_actor,'machine.report',v_request,v_response);

  return v_response;
end
$function$;

revoke all on function public.snacky_report_machine_issue_v1(uuid,uuid,text,text) from public,anon;
grant execute on function public.snacky_report_machine_issue_v1(uuid,uuid,text,text) to authenticated,service_role;

select pg_notify('pgrst','reload schema');
commit;
