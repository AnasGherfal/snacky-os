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

select pg_notify('pgrst','reload schema');
commit;
