-- Operations reliability: shared issue release/reclaim, maintenance outcomes,
-- automatic CRM state, operator workload guardrails, and maintenance attention.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

alter table public.crm_tasks drop constraint if exists crm_tasks_dispatch_state_check;
alter table public.crm_tasks add constraint crm_tasks_dispatch_state_check
check (
  dispatch_state is null
  or dispatch_state in (
    'available','assigned','accepted','en_route','working','blocked','fixed',
    'needs_technician','needs_part','machine_offline'
  )
);

CREATE OR REPLACE FUNCTION crm_dispatch_private.guard_task()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_context text:=pg_catalog.current_setting('snacky.crm_dispatch_task_id',true);
  v_release_context text:=pg_catalog.current_setting('snacky.crm_queue_release_task_id',true);
  v_window interval;
begin
  if new.task_type <> 'field_action' then
    if new.dispatch_state is not null
      or new.ack_due_at is not null
      or new.acknowledged_at is not null
      or new.en_route_at is not null
      or new.work_started_at is not null
      or new.blocked_at is not null
      or new.fixed_at is not null
      or new.blocked_reason is not null
      or new.dispatch_note is not null
    then
      raise exception 'Dispatch fields are only valid for issue field actions' using errcode='23514';
    end if;
    return new;
  end if;

  v_window:=case new.priority
    when 'urgent' then interval '10 minutes'
    when 'high' then interval '20 minutes'
    when 'low' then interval '60 minutes'
    else interval '30 minutes'
  end;

  if tg_op='INSERT' then
    if new.issue_id is null then
      raise exception 'A dispatched field action must belong to a customer issue' using errcode='23514';
    end if;
    if new.dispatch_state is null then
      new.dispatch_state:='assigned';
      new.ack_due_at:=pg_catalog.clock_timestamp()+v_window;
    end if;
    return new;
  end if;

  if old.dispatch_state is null then
    if new.dispatch_state is not null then
      raise exception 'Legacy field actions cannot be silently converted to dispatch records' using errcode='23514';
    end if;
    return new;
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    if old.status='completed' or old.dispatch_state in ('fixed','needs_technician','needs_part','machine_offline') then
      raise exception 'Completed field work cannot be reassigned' using errcode='23514';
    end if;

    if new.assigned_to is null and v_release_context=old.id::text then
      if old.dispatch_state not in ('assigned','accepted','en_route') then
        raise exception 'Only unstarted field work can be released to the shared queue' using errcode='23514';
      end if;
      new.dispatch_state:='available';
      new.ack_due_at:=null;
      new.acknowledged_at:=null;
      new.en_route_at:=null;
      new.work_started_at:=null;
      new.blocked_at:=null;
      new.fixed_at:=null;
      new.blocked_reason:=null;
      new.status:='open';
      new.result:=null;
      new.completed_at:=null;
      new.completed_by:=null;
      return new;
    end if;

    new.dispatch_state:='assigned';
    new.ack_due_at:=pg_catalog.clock_timestamp()+v_window;
    new.acknowledged_at:=null;
    new.en_route_at:=null;
    new.work_started_at:=null;
    new.blocked_at:=null;
    new.fixed_at:=null;
    new.blocked_reason:=null;
    new.dispatch_note:=null;
    new.status:='open';
    new.result:=null;
    new.completed_at:=null;
    new.completed_by:=null;
    return new;
  end if;

  if v_context is distinct from old.id::text and (
       new.dispatch_state is distinct from old.dispatch_state
    or new.ack_due_at is distinct from old.ack_due_at
    or new.acknowledged_at is distinct from old.acknowledged_at
    or new.en_route_at is distinct from old.en_route_at
    or new.work_started_at is distinct from old.work_started_at
    or new.blocked_at is distinct from old.blocked_at
    or new.fixed_at is distinct from old.fixed_at
    or new.blocked_reason is distinct from old.blocked_reason
    or new.dispatch_note is distinct from old.dispatch_note
    or new.status is distinct from old.status
    or new.result is distinct from old.result
    or new.completed_at is distinct from old.completed_at
    or new.completed_by is distinct from old.completed_by
  ) then
    raise exception 'Use the operator dispatch controls for this field action' using errcode='42501';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.snacky_issue_field_queue_command_v1(p_action text, p_issue_id uuid DEFAULT NULL::uuid, p_task_id uuid DEFAULT NULL::uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
 me uuid:=public.snacky_current_team_member_id();
 issue public.issues;
 task public.crm_tasks;
 op record;
 v_priority text;
 v_title text;
 v_notes text;
 v_release_reason text;
 v_active_count integer;
 v_due date:=(now() at time zone 'Africa/Tripoli')::date;
 v_now timestamptz:=clock_timestamp();
begin
 if auth.uid() is null or me is null then raise exception 'Active staff access required' using errcode='42501';end if;

 if p_action='create' then
  if not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']) then
   raise exception 'Customer relations access required' using errcode='42501';
  end if;
  if p_issue_id is null or not public.snacky_crm_allowed('issue',p_issue_id,true) then
   raise exception 'Issue unavailable' using errcode='42501';
  end if;
  select * into issue from public.issues where id=p_issue_id for update;
  if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed') then
   raise exception 'Issue is not open' using errcode='23514';
  end if;
  if exists(
   select 1 from public.crm_tasks t
   where t.issue_id=p_issue_id and t.task_type='field_action'
     and t.archived_at is null and t.status<>'completed'
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
  v_title:=coalesce(nullif(trim(p_payload->>'title'),''),'Inspect and fix machine issue');
  v_notes:=nullif(trim(p_payload->>'notes'),'');

  insert into public.crm_tasks(
   title,issue_id,task_type,assigned_to,due_date,priority,notes,status,dispatch_state,
   created_by,updated_by,is_practice
  )
  values(
   v_title,p_issue_id,'field_action',null,v_due,v_priority,v_notes,'open','available',
   me,me,coalesce(issue.is_practice,false)
  )
  returning * into task;

  update public.issues
  set status='assigned',is_waiting=true,waiting_on='operator',
      next_action='Waiting for an operator to claim the machine issue',
      next_action_date=v_due,updated_at=v_now,updated_by=me
  where id=p_issue_id and status not in ('resolved','closed');

  for op in
   select t.id from public.team_members t
   where t.active and t.active_status='active'
     and (t.role::text='operator' or t.roles::text[]&&array['operator'])
  loop
   perform snacky_notice_private.emit('task',task.id,op.id,'available','Machine issue / مشكلة ماكينة','/operator/issues');
  end loop;

  return jsonb_build_object('ok',true,'action','create','task_id',task.id,'dispatch_state',task.dispatch_state);

 elsif p_action='claim' then
  if not public.snacky_current_profile_has_any_role(array['operator']) then
   raise exception 'Operator access required' using errcode='42501';
  end if;
  if p_task_id is null then raise exception 'Task required' using errcode='22023';end if;
  select * into task from public.crm_tasks where id=p_task_id for update;
  if not found or task.task_type<>'field_action' or task.archived_at is not null or task.status='completed' then
   raise exception 'Field work unavailable' using errcode='23514';
  end if;
  if task.assigned_to is not null or task.dispatch_state<>'available' then
   raise exception 'Another operator already claimed this issue' using errcode='40001';
  end if;

  select count(*)::integer into v_active_count
  from public.crm_tasks t
  where t.assigned_to=me and t.task_type='field_action'
    and t.archived_at is null and t.status<>'completed'
    and t.dispatch_state in ('assigned','accepted','en_route','working','blocked');
  if v_active_count>=3 then
   raise exception 'You already have 3 active machine issues. Finish or release one before claiming another.' using errcode='23514';
  end if;

  if task.priority='urgent' and exists(
   select 1 from public.crm_tasks t
   where t.assigned_to=me and t.task_type='field_action'
     and t.priority='urgent' and t.archived_at is null and t.status<>'completed'
     and t.dispatch_state in ('assigned','accepted','en_route','working','blocked')
  ) then
   raise exception 'Finish or release your active urgent machine issue before claiming another urgent issue.' using errcode='23514';
  end if;

  select * into issue from public.issues where id=task.issue_id for share;
  if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed') then
   raise exception 'Issue is no longer open' using errcode='23514';
  end if;

  update public.crm_tasks
  set assigned_to=me,updated_by=me,updated_at=v_now
  where id=task.id
  returning * into task;

  update public.issues
  set status='in_progress',is_waiting=true,waiting_on='operator',
      next_action='Operator claimed the field visit',
      next_action_date=v_due,updated_at=v_now,updated_by=me
  where id=task.issue_id and status not in ('resolved','closed');

  perform public.snacky_crm_emit(
   'issue',task.issue_id,'field_claimed','Operator claimed the machine issue',
   null,jsonb_build_object('task_id',task.id,'operator_id',me)
  );

  return jsonb_build_object('ok',true,'action','claim','task_id',task.id,'dispatch_state',task.dispatch_state,'assigned_to',task.assigned_to);

 elsif p_action='release' then
  if not public.snacky_current_profile_has_any_role(array['operator']) then
   raise exception 'Operator access required' using errcode='42501';
  end if;
  if p_task_id is null then raise exception 'Task required' using errcode='22023';end if;
  v_release_reason:=nullif(trim(p_payload->>'reason'),'');
  if v_release_reason is null or length(v_release_reason)<3 or length(v_release_reason)>1000 then
   raise exception 'Explain why you are releasing this issue' using errcode='23514';
  end if;

  select * into task from public.crm_tasks where id=p_task_id for update;
  if not found or task.task_type<>'field_action' or task.archived_at is not null or task.status='completed' then
   raise exception 'Field work unavailable' using errcode='23514';
  end if;
  if task.assigned_to is distinct from me then
   raise exception 'Only the operator who claimed this issue can release it' using errcode='42501';
  end if;
  if task.dispatch_state not in ('assigned','accepted','en_route') then
   raise exception 'Release is only available before field work starts' using errcode='23514';
  end if;

  select * into issue from public.issues where id=task.issue_id for share;
  if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed') then
   raise exception 'Issue is no longer open' using errcode='23514';
  end if;

  perform set_config('snacky.crm_queue_release_task_id',task.id::text,true);
  update public.crm_tasks
  set assigned_to=null,dispatch_state='available',ack_due_at=null,acknowledged_at=null,
      en_route_at=null,work_started_at=null,blocked_at=null,fixed_at=null,blocked_reason=null,
      dispatch_note='Released: '||v_release_reason,status='open',result=null,completed_at=null,completed_by=null,
      updated_by=me,updated_at=v_now
  where id=task.id
  returning * into task;
  perform set_config('snacky.crm_queue_release_task_id','',true);

  update public.issues
  set status='assigned',is_waiting=true,waiting_on='operator',
      next_action='Waiting for another operator after release',
      next_action_date=v_due,updated_at=v_now,updated_by=me
  where id=task.issue_id and status not in ('resolved','closed');

  perform public.snacky_crm_emit(
   'issue',task.issue_id,'field_released','Operator released field action: '||v_release_reason,
   null,jsonb_build_object('task_id',task.id,'operator_id',me,'reason',v_release_reason)
  );

  for op in
   select t.id from public.team_members t
   where t.active and t.active_status='active'
     and (t.role::text='operator' or t.roles::text[]&&array['operator'])
  loop
   perform snacky_notice_private.emit('task',task.id,op.id,'available','Machine issue / مشكلة ماكينة','/operator/issues');
  end loop;

  return jsonb_build_object('ok',true,'action','release','task_id',task.id,'dispatch_state',task.dispatch_state);

 else
  raise exception 'Unsupported queue action' using errcode='22023';
 end if;
end
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.snacky_crm_audit_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
 kind text;
 target uuid;
 summary text;
 me uuid:=public.snacky_current_team_member_id();
 b jsonb;
 a jsonb;
 issue_owner uuid;
 manager record;
 outcome text;
 next_step text;
 issue_practice boolean;
begin
 a:=to_jsonb(new);
 b:=case when tg_op='UPDATE' then to_jsonb(old) end;
 kind:=case tg_table_name
  when 'location_pipeline_leads' then 'lead'
  when 'issues' then 'issue'
  when 'location_relationships' then 'location'
  when 'crm_tasks' then 'task'
  when 'crm_contacts' then 'contact'
  when 'location_admin_obligations' then 'obligation'
  when 'crm_lead_bonus' then 'lead'
 end;
 target:=case tg_table_name
  when 'location_relationships' then (a->>'location_id')::uuid
  when 'crm_lead_bonus' then (a->>'lead_id')::uuid
  else (a->>'id')::uuid
 end;

 if b is not null and
    (b-array['updated_at','updated_by','updated_by_member_id'])=
    (a-array['updated_at','updated_by','updated_by_member_id'])
 then return new;end if;

 summary:=case
  when tg_op='INSERT' then 'Created'
  when b->>'assigned_to' is distinct from a->>'assigned_to'
    or b->>'assigned_to_user_id' is distinct from a->>'assigned_to_user_id'
    then 'Assignment changed'
  when b->>'status' is distinct from a->>'status'
    then 'Status: '||coalesce(b->>'status','')||' → '||coalesce(a->>'status','')
  else 'Record updated'
 end;

 if tg_table_name='crm_lead_bonus' then
  perform public.snacky_crm_emit(
   kind,target,'bonus_status','Bonus status: '||(a->>'status'),null,
   jsonb_build_object('eligible',a->'eligible','status',a->'status')
  );
  return new;
 end if;

 perform public.snacky_crm_emit(
  kind,target,case when tg_op='INSERT' then 'created' else 'updated' end,summary,b,a
 );

 if tg_table_name='crm_tasks'
   and a->>'task_type'='field_action'
   and a->>'status'='completed'
   and (b is null or b->>'status' is distinct from a->>'status')
 then
  outcome:=coalesce(a->>'dispatch_state','');
  if outcome='fixed' then
   update public.issues
   set field_completed_at=now(),is_waiting=false,waiting_on=null,
       status='in_progress',
       next_action='Contact customer after field action',
       next_action_date=(now() at time zone 'Africa/Tripoli')::date,
       updated_at=now(),updated_by=me
   where id=(a->>'issue_id')::uuid and status not in ('resolved','closed');

   perform public.snacky_crm_emit(
    'issue',(a->>'issue_id')::uuid,'field_completed',
    'Field action completed: '||(a->>'result'),null,
    jsonb_build_object('task_id',target,'performed_by',a->>'completed_by','outcome','fixed')
   );
  elsif outcome in ('needs_technician','needs_part','machine_offline') then
   next_step:=case outcome
    when 'needs_technician' then 'Arrange technician visit'
    when 'needs_part' then 'Arrange spare part and follow-up visit'
    else 'Machine offline — arrange maintenance before reopening'
   end;

   update public.issues
   set field_completed_at=now(),is_waiting=true,waiting_on='management',
       status='in_progress',next_action=next_step,
       next_action_date=(now() at time zone 'Africa/Tripoli')::date,
       updated_at=now(),updated_by=me
   where id=(a->>'issue_id')::uuid and status not in ('resolved','closed')
   returning assigned_to,coalesce(is_practice,false) into issue_owner,issue_practice;

   if issue_owner is not null then
    insert into public.crm_tasks(
     title,issue_id,task_type,assigned_to,due_date,priority,notes,status,
     created_by,updated_by,is_practice
    ) values(
     next_step,(a->>'issue_id')::uuid,'admin',issue_owner,
     (now() at time zone 'Africa/Tripoli')::date,
     case coalesce(a->>'priority','normal') when 'critical' then 'urgent' else coalesce(a->>'priority','normal') end,
     'Operator diagnosis: '||coalesce(a->>'result',''),'open',
     coalesce(me,issue_owner),coalesce(me,issue_owner),coalesce(issue_practice,false)
    );
   end if;

   perform public.snacky_crm_emit(
    'issue',(a->>'issue_id')::uuid,'maintenance_required',
    next_step||': '||coalesce(a->>'result',''),null,
    jsonb_build_object('task_id',target,'performed_by',a->>'completed_by','outcome',outcome)
   );

   if issue_owner is not null then
    perform snacky_notice_private.emit(
     'task',target,issue_owner,'maintenance_required',
     next_step||' / '||coalesce(a->>'result',''),
     '/issues/'||(a->>'issue_id')
    );
   end if;

   if outcome='machine_offline' or coalesce(a->>'priority','normal') in ('high','urgent','critical') then
    for manager in
     select t.id
     from public.team_members t
     where t.active and t.active_status='active'
       and (t.role::text in ('owner','admin') or t.roles::text[]&&array['owner','admin'])
       and t.id is distinct from issue_owner
    loop
     perform snacky_notice_private.emit(
      'task',target,manager.id,'maintenance_required_management',
      next_step||' / '||coalesce(a->>'result',''),
      '/issues/'||(a->>'issue_id')
     );
    end loop;
   end if;
  end if;
 end if;

 return new;
end
$function$;

CREATE OR REPLACE FUNCTION snacky_notice_private.eligible(n notifications)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s jsonb;roles text[];creator uuid;
begin
 if snacky_notice_private.member_user(n.recipient_member_id) is distinct from n.user_id then return false;end if;
 select array[p.role::text]||coalesce(p.roles::text[],'{}') into roles from public.profiles p where id=n.user_id;
 s:=snacky_notice_private.source(n.source_kind,n.source_id);if s is null then return false;end if;
 if n.source_kind='company' then return (s->>'active')::boolean and roles&&array(select jsonb_array_elements_text(s->'row'->'audience'));end if;

 if n.event_kind='available' then
  return n.source_kind='task'
   and roles&&array['operator']
   and (s->>'active')::boolean
   and s->>'member' is null
   and s->'row'->>'task_type'='field_action'
   and s->'row'->>'dispatch_state'='available'
   and s->'row'->>'status'='open';
 end if;

 if n.event_kind='unclaimed_overdue' then
  if n.source_kind<>'task' or not (roles&&array['owner','admin','supervisor','crm']) then return false;end if;
  return exists(
   select 1 from public.crm_tasks t join public.issues i on i.id=t.issue_id
   where t.id=n.source_id and t.task_type='field_action' and t.assigned_to is null
     and t.status='open' and t.dispatch_state='available'
     and t.created_at + snacky_notice_private.issue_field_delay(t.priority,'unclaimed')<=clock_timestamp()
     and t.archived_at is null and coalesce(t.is_practice,false)=false
     and i.assigned_to=n.recipient_member_id and i.status::text not in ('resolved','closed')
     and i.archived_at is null and coalesce(i.is_practice,false)=false
  );
 end if;

 if n.event_kind='operator_idle' then
  if n.source_kind<>'task' or not (roles&&array['operator']) then return false;end if;
  return exists(
   select 1 from public.crm_tasks t join public.issues i on i.id=t.issue_id
   where t.id=n.source_id and t.task_type='field_action' and t.assigned_to=n.recipient_member_id
     and t.status<>'completed' and t.work_started_at is null
     and t.archived_at is null and coalesce(t.is_practice,false)=false
     and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false
     and (
      (t.dispatch_state='assigned' and t.ack_due_at is not null and t.ack_due_at<=clock_timestamp())
      or (t.dispatch_state='accepted' and t.acknowledged_at is not null and t.acknowledged_at+snacky_notice_private.issue_field_delay(t.priority,'accepted')<=clock_timestamp())
      or (t.dispatch_state='en_route' and t.en_route_at is not null and t.en_route_at+snacky_notice_private.issue_field_delay(t.priority,'en_route')<=clock_timestamp())
     )
  );
 end if;

 if n.event_kind in ('field_blocked','field_blocked_management') then
  if n.source_kind<>'task' then return false;end if;
  if n.event_kind='field_blocked' and not (roles&&array['owner','admin','supervisor','crm']) then return false;end if;
  if n.event_kind='field_blocked_management' and not (roles&&array['owner','admin']) then return false;end if;
  return exists(
   select 1 from public.crm_tasks t join public.issues i on i.id=t.issue_id
   where t.id=n.source_id and t.task_type='field_action'
     and t.dispatch_state='blocked' and t.blocked_at is not null and t.status='in_progress'
     and t.archived_at is null and coalesce(t.is_practice,false)=false
     and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false
     and (
      (n.event_kind='field_blocked' and i.assigned_to=n.recipient_member_id)
      or (n.event_kind='field_blocked_management' and t.priority in ('high','urgent','critical'))
     )
  );
 end if;

 if n.event_kind in ('maintenance_required','maintenance_required_management') then
  if n.source_kind<>'task' then return false;end if;
  if n.event_kind='maintenance_required' and not (roles&&array['owner','admin','supervisor','crm']) then return false;end if;
  if n.event_kind='maintenance_required_management' and not (roles&&array['owner','admin']) then return false;end if;
  return exists(
   select 1 from public.crm_tasks t join public.issues i on i.id=t.issue_id
   where t.id=n.source_id and t.task_type='field_action'
     and t.status='completed'
     and t.dispatch_state in ('needs_technician','needs_part','machine_offline')
     and t.archived_at is null and coalesce(t.is_practice,false)=false
     and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false
     and (
      (n.event_kind='maintenance_required' and i.assigned_to=n.recipient_member_id)
      or (
       n.event_kind='maintenance_required_management'
       and (t.dispatch_state='machine_offline' or t.priority in ('high','urgent','critical'))
      )
     )
  );
 end if;

 if not (roles&&case
   when n.source_kind in ('route','instruction') then array['owner','admin','supervisor','operator']
   when n.source_kind in ('lead','location','obligation','routine') then array['owner','admin','supervisor','crm']
   else array['owner','admin','supervisor','crm','operator']
 end) then return false;end if;

 if coalesce(s->'row'->>'is_practice','false')='true'
   or coalesce(s->'row'->>'is_archived','false')='true'
   or s->'row'->>'archived_at' is not null
 then return false;end if;

 if n.event_kind='ack_overdue' then
  if not snacky_notice_private.escalation_generation_current(n) then return false;end if;
  if n.source_kind<>'task' or not (roles&&array['owner','admin','supervisor','crm']) then return false;end if;
  return exists(
   select 1
   from public.crm_tasks t
   join public.issues i on i.id=t.issue_id
   where t.id=n.source_id
     and t.task_type='field_action'
     and t.assigned_to is not null
     and t.priority in ('urgent','critical')
     and t.status='open'
     and t.dispatch_state='assigned'
     and t.ack_due_at is not null and t.ack_due_at<=clock_timestamp()
     and t.archived_at is null and coalesce(t.is_practice,false)=false
     and i.assigned_to=n.recipient_member_id
     and i.status::text not in ('resolved','closed','cancelled','canceled')
     and i.archived_at is null and coalesce(i.is_practice,false)=false
  );
 end if;
 if n.event_kind='removed' then return s->>'member' is distinct from n.recipient_member_id::text;end if;
 if n.event_kind='critical' then return (s->>'active')::boolean and s->>'member' is null and roles&&array['owner','admin'];end if;
 if n.event_kind='completed' then
  creator:=coalesce(nullif(s->'row'->>'created_by',''),nullif(s->'row'->>'created_by_member_id',''),nullif(s->'row'->>'reported_by',''))::uuid;
  return creator=n.recipient_member_id and s->'row'->>'status' in ('completed','resolved')
   and (n.source_kind<>'task' or roles&&array['owner','admin','supervisor','crm']);
 end if;
 if n.event_kind='cancelled' then return s->>'member'=n.recipient_member_id::text and s->'row'->>'status' in ('cancelled','canceled');end if;
 return s->>'member'=n.recipient_member_id::text and (s->>'active')::boolean;
end;
$function$;

CREATE OR REPLACE FUNCTION snacky_notice_private.emit(k text, i uuid, m uuid, e text, label text, href text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 u uuid:=snacky_notice_private.member_user(m);
 nid uuid;
 key text;
 en text;
 ar text;
 candidate public.notifications;
begin
 if u is null or not exists(select 1 from snacky_notice_private.settings where enabled) then return;end if;
 candidate.user_id:=u;
 candidate.recipient_member_id:=m;
 candidate.source_kind:=k;
 candidate.source_id:=i;
 candidate.event_kind:=e;
 if not coalesce(snacky_notice_private.eligible(candidate),false) then return;end if;
 key:=txid_current()::text||':'||k||':'||i::text||':'||m::text||':'||e;
 if e='changed' and exists(
   select 1 from public.notifications
   where event_key=txid_current()::text||':'||k||':'||i::text||':'||m::text||':assigned'
 ) then return;end if;

 en:=case e
  when 'available' then 'Machine issue available'
  when 'assigned' then 'New work assigned'
  when 'changed' then 'Your work was updated'
  when 'removed' then 'Assignment removed'
  when 'cancelled' then 'Work cancelled'
  when 'completed' then 'Assigned work completed'
  when 'field_completed' then 'Field action completed'
  when 'maintenance_required' then 'Machine maintenance required'
  when 'maintenance_required_management' then 'Machine needs management attention'
  when 'critical' then 'Urgent issue needs attention'
  when 'published' then 'New company update'
  else 'Snacky work update'
 end;
 ar:=case e
  when 'available' then 'بلاغ ماكينة متاح للاستلام'
  when 'assigned' then 'تم إسناد عمل إليك'
  when 'changed' then 'تم تحديث عملك'
  when 'removed' then 'تم إلغاء إسناد العمل إليك'
  when 'cancelled' then 'تم إلغاء العمل'
  when 'completed' then 'تم إنجاز العمل المسند'
  when 'field_completed' then 'تم إنجاز الإجراء الميداني'
  when 'maintenance_required' then 'الماكينة تحتاج صيانة'
  when 'maintenance_required_management' then 'الماكينة تحتاج متابعة الإدارة'
  when 'critical' then 'مشكلة عاجلة تحتاج اهتمامك'
  when 'published' then 'تحديث جديد من الشركة'
  else 'تحديث عمل سناكي'
 end;
 if k='route' and e='assigned' then en:='Route assigned';ar:='تم إسناد جولة إليك';end if;

 insert into public.notifications(
  user_id,type,title,message,action_url,event_key,source_kind,source_id,
  recipient_member_id,event_kind,title_ar,message_ar
 )
 values(
  u,'work_'||k||'_'||e,en,coalesce(label,'Snacky OS')||' — Open Snacky OS for details.',
  href,key,k,i,m,e,ar,coalesce(label,'سناكي')||' — افتح سناكي للاطلاع على التفاصيل.'
 )
 on conflict(event_key) where event_key is not null do nothing
 returning id into nid;

 if nid is not null then
  insert into snacky_notice_private.deliveries(notification_id,subscription_id)
   select nid,id from public.push_subscriptions where user_id=u and is_active
   on conflict do nothing;
  begin
   perform snacky_notice_private.wake();
  exception when others then
   raise warning 'Notification wake failed (%); queued delivery retained for retry',sqlstate;
  end;
 end if;
end
$function$;

CREATE OR REPLACE FUNCTION public.snacky_customer_support_dashboard_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
  me uuid := public.snacky_current_team_member_id();
  day date := (now() at time zone 'Africa/Tripoli')::date;
  result jsonb;
begin
  if me is null or not public.snacky_crm_staff() then
    raise exception 'Customer relations access required' using errcode='42501';
  end if;

  with issue_state as (
    select
      i.id,
      i.customer_name,
      i.customer_phone,
      i.customer_whatsapp,
      i.contact_channel,
      i.description,
      i.issue_type,
      i.status::text as status,
      i.priority::text as priority,
      i.location_id,
      l.name as location_name,
      i.next_action,
      i.next_action_date,
      i.is_waiting,
      nullif(trim(i.waiting_on),'') as waiting_on,
      i.updated_at,
      i.resolved_at,
      (
        exists (
          select 1
          from public.crm_tasks t
          where t.issue_id=i.id
            and t.task_type='field_action'
            and t.status<>'completed'
            and t.archived_at is null
            and t.dispatch_state in ('available','assigned','accepted','en_route','working','blocked')
        )
        or (coalesce(i.is_waiting,false) and lower(coalesce(i.waiting_on,'')) in ('operator','المشغل','المشغّل'))
      ) as waiting_operator,
      (
        coalesce(i.is_waiting,false)
        and (
          lower(coalesce(i.waiting_on,'')) in ('customer','client','العميل','عميل')
          or lower(coalesce(i.waiting_on,'')) like '%customer%'
          or coalesce(i.waiting_on,'') like '%العميل%'
        )
      ) as waiting_customer,
      (
        exists (
          select 1
          from public.crm_tasks t
          where t.issue_id=i.id
            and t.task_type='admin'
            and t.status<>'completed'
            and t.archived_at is null
        )
        or exists (
          select 1
          from public.crm_tasks t
          where t.issue_id=i.id
            and t.task_type='field_action'
            and t.status='completed'
            and t.archived_at is null
            and t.dispatch_state in ('needs_technician','needs_part','machine_offline')
        )
        or (coalesce(i.is_waiting,false) and lower(coalesce(i.waiting_on,'')) in ('management','manager','الإدارة','الادارة'))
      ) as needs_management
    from public.issues i
    left join public.locations l on l.id=i.location_id
    where i.assigned_to=me
      and i.archived_at is null
      and not coalesce(i.is_practice,false)
      and not coalesce(i.is_historical,false)
  ),
  active as (
    select *,
      (next_action_date is not null and next_action_date<day and status not in ('resolved','closed')) as overdue,
      (next_action_date=day and status not in ('resolved','closed')) as due_today
    from issue_state
    where status not in ('resolved','closed')
  ),
  recent as (
    select count(*)::int as count
    from issue_state
    where status in ('resolved','closed')
      and resolved_at>=now()-interval '7 days'
  ),
  counts as (
    select jsonb_build_object(
      'open', count(*)::int,
      'waiting_operator', count(*) filter(where waiting_operator)::int,
      'waiting_customer', count(*) filter(where waiting_customer)::int,
      'needs_management', count(*) filter(where needs_management)::int,
      'due_today', count(*) filter(where due_today)::int,
      'overdue', count(*) filter(where overdue)::int,
      'recent_resolved', (select count from recent)
    ) as value
    from active
  ),
  rows as (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.needs_management desc,x.overdue desc,x.due_today desc,x.updated_at asc),'[]'::jsonb) as value
    from (
      select id,customer_name,customer_phone,customer_whatsapp,contact_channel,description,issue_type,status,priority,
             location_id,location_name,next_action,next_action_date,is_waiting,waiting_on,waiting_operator,waiting_customer,
             needs_management,overdue,due_today,updated_at
      from active
      order by needs_management desc,overdue desc,due_today desc,updated_at asc
      limit 8
    ) x
  )
  select jsonb_build_object(
    'counts',(select value from counts),
    'rows',(select value from rows),
    'generated_at',now()
  ) into result;

  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.snacky_machine_maintenance_attention_v1()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_catalog'
AS $function$
with open_issue as (
 select i.id,i.machine_id,i.issue_type,i.priority::text priority,i.created_at,i.status::text status
 from public.issues i
 where i.machine_id is not null
   and i.archived_at is null
   and not coalesce(i.is_practice,false)
   and i.status::text not in ('resolved','closed')
),
maintenance_issue as (
 select distinct on (t.issue_id)
   t.issue_id,i.machine_id,t.id task_id,t.dispatch_state,t.result,t.completed_at,t.priority
 from public.crm_tasks t
 join public.issues i on i.id=t.issue_id
 where t.task_type='field_action'
   and t.dispatch_state in ('needs_technician','needs_part','machine_offline')
   and t.status='completed'
   and t.archived_at is null
   and i.status::text not in ('resolved','closed')
 order by t.issue_id,t.completed_at desc nulls last,t.created_at desc
),
repeat_groups as (
 select i.machine_id,i.issue_type,count(*)::int incident_count,max(i.created_at) latest_at
 from public.issues i
 where i.machine_id is not null
   and i.archived_at is null
   and not coalesce(i.is_practice,false)
   and i.created_at>=now()-interval '30 days'
 group by i.machine_id,i.issue_type
 having count(*)>=3
),
recent_fixed as (
 select count(*)::int count
 from public.crm_tasks t
 where t.task_type='field_action' and t.dispatch_state='fixed'
   and t.status='completed' and t.completed_at>=now()-interval '7 days'
   and t.archived_at is null
),
attention as (
 select m.id machine_id,'machine_down'::text reason,null::uuid issue_id,
        'Machine status is maintenance'::text detail,m.updated_at event_at,1 sort_order
 from public.machines m
 where m.status::text='maintenance'
 union all
 select mi.machine_id,'maintenance_required',mi.issue_id,
        case mi.dispatch_state
         when 'needs_technician' then 'Needs technician'
         when 'needs_part' then 'Needs spare part'
         else 'Machine offline'
        end||coalesce(' — '||nullif(mi.result,''),''),
        coalesce(mi.completed_at,now()),2
 from maintenance_issue mi
 union all
 select rg.machine_id,'repeat_failure',null::uuid,
        rg.incident_count::text||' '||rg.issue_type||' issues in 30 days',
        rg.latest_at,3
 from repeat_groups rg
 union all
 select oi.machine_id,'open_over_24h',oi.id,
        'Issue open more than 24 hours: '||oi.issue_type,
        oi.created_at,4
 from open_issue oi
 where oi.created_at<now()-interval '24 hours'
),
dedup as (
 select distinct on (machine_id,reason,coalesce(issue_id,'00000000-0000-0000-0000-000000000000'::uuid))
   machine_id,reason,issue_id,detail,event_at,sort_order
 from attention
 order by machine_id,reason,coalesce(issue_id,'00000000-0000-0000-0000-000000000000'::uuid),sort_order,event_at desc
)
select jsonb_build_object(
 'machines_down',(select count(*)::int from public.machines where status::text='maintenance'),
 'waiting_maintenance',(select count(*)::int from maintenance_issue),
 'repeat_failures',(select count(*)::int from repeat_groups),
 'open_over_24h',(select count(*)::int from open_issue where created_at<now()-interval '24 hours'),
 'recently_repaired',(select count from recent_fixed),
 'attention',coalesce((
   select jsonb_agg(jsonb_build_object(
    'machine_id',d.machine_id,'reason',d.reason,'issue_id',d.issue_id,
    'detail',d.detail,'event_at',d.event_at
   ) order by d.sort_order,d.event_at desc)
   from (select * from dedup order by sort_order,event_at desc limit 30) d
 ),'[]'::jsonb)
);
$function$;

revoke all on function public.snacky_issue_field_queue_command_v1(text,uuid,uuid,jsonb) from public;
grant execute on function public.snacky_issue_field_queue_command_v1(text,uuid,uuid,jsonb) to authenticated;

revoke all on function public.snacky_machine_maintenance_attention_v1() from public,anon;
grant execute on function public.snacky_machine_maintenance_attention_v1() to authenticated,service_role;

select pg_notify('pgrst','reload schema');
commit;
