-- CRM -> operator field dispatch lifecycle.
-- Existing legacy field actions remain unchanged until a new assignment is created after this migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.crm_tasks
  add column if not exists dispatch_state text,
  add column if not exists ack_due_at timestamptz,
  add column if not exists acknowledged_at timestamptz,
  add column if not exists en_route_at timestamptz,
  add column if not exists work_started_at timestamptz,
  add column if not exists blocked_at timestamptz,
  add column if not exists fixed_at timestamptz,
  add column if not exists blocked_reason text,
  add column if not exists dispatch_note text;

alter table public.crm_tasks
  drop constraint if exists crm_tasks_dispatch_state_check;
alter table public.crm_tasks
  add constraint crm_tasks_dispatch_state_check
  check (dispatch_state is null or dispatch_state in ('assigned','accepted','en_route','working','blocked','fixed'));

create index if not exists crm_tasks_issue_dispatch_idx
  on public.crm_tasks(issue_id,dispatch_state,updated_at desc)
  where task_type='field_action' and archived_at is null;
create index if not exists crm_tasks_assignee_dispatch_idx
  on public.crm_tasks(assigned_to,dispatch_state,ack_due_at)
  where task_type='field_action' and archived_at is null and dispatch_state is not null;

create schema if not exists crm_dispatch_private;

create table if not exists crm_dispatch_private.requests(
  request_id uuid primary key,
  actor_user_id uuid not null references public.profiles(id),
  task_id uuid not null references public.crm_tasks(id),
  request jsonb not null,
  response jsonb,
  created_at timestamptz not null default now()
);
alter table crm_dispatch_private.requests enable row level security;
revoke all on crm_dispatch_private.requests from public,anon,authenticated;

create or replace function crm_dispatch_private.guard_task()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_context text:=pg_catalog.current_setting('snacky.crm_dispatch_task_id',true);
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

  -- Legacy field actions remain on their existing workflow unless they were
  -- created with dispatch_state after this release.
  if old.dispatch_state is null then
    if new.dispatch_state is not null then
      raise exception 'Legacy field actions cannot be silently converted to dispatch records' using errcode='23514';
    end if;
    return new;
  end if;

  -- A real reassignment is a fresh handoff. Keep the old history in CRM audit,
  -- but the new assignee starts from Assigned and must acknowledge it.
  if new.assigned_to is distinct from old.assigned_to then
    if old.status='completed' or old.dispatch_state='fixed' then
      raise exception 'Completed field work cannot be reassigned' using errcode='23514';
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
$$;
revoke all on function crm_dispatch_private.guard_task() from public,anon,authenticated;

drop trigger if exists crm_dispatch_guard_v1 on public.crm_tasks;
create trigger crm_dispatch_guard_v1
before insert or update on public.crm_tasks
for each row execute function crm_dispatch_private.guard_task();

create or replace function crm_dispatch_private.command(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
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
    or v_action not in ('accept','en_route','start','block','fix')
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
      raise exception 'Start the field work before marking it fixed' using errcode='23514';
    end if;
    if v_note is null or pg_catalog.length(v_note)<3 then
      raise exception 'Write what was fixed before completing the task' using errcode='23514';
    end if;
    select count(*)::integer into v_photo_count
    from public.crm_documents d
    where d.task_id=v_task_id
      and pg_catalog.lower(coalesce(d.mime_type,'')) like 'image/%';
    if v_photo_count<1 then
      raise exception 'Upload at least one field photo before marking the task fixed' using errcode='23514';
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
  else
    update public.crm_tasks
    set dispatch_state='fixed',fixed_at=v_now,dispatch_note=v_note,status='completed',
        result=v_note,completed_at=v_now,completed_by=v_actor_member,
        updated_by=v_actor_member,updated_at=v_now
    where id=v_task_id;
  end if;

  -- Do not let this scoped trigger bypass leak into another CRM command that
  -- happens to execute later in the same transaction.
  perform pg_catalog.set_config('snacky.crm_dispatch_task_id','',true);

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
$$;

revoke all on function crm_dispatch_private.command(jsonb) from public,anon,authenticated;
grant usage on schema crm_dispatch_private to authenticated;
grant execute on function crm_dispatch_private.command(jsonb) to authenticated;

create or replace function public.snacky_issue_dispatch_command_v1(p_command jsonb)
returns jsonb
language sql
security invoker
set search_path=''
as $$select crm_dispatch_private.command(p_command);$$;
revoke all on function public.snacky_issue_dispatch_command_v1(jsonb) from public,anon;
grant execute on function public.snacky_issue_dispatch_command_v1(jsonb) to authenticated;

-- Preserve every currently installed CRM/buying/company allowlist entry and add
-- only the scoped dispatch RPC for pure CRM accounts.
create or replace function public.snacky_crm_api_request_guard()
returns void
language plpgsql
security definer
set search_path=public,pg_catalog
as $$
declare path text:=coalesce(current_setting('request.path',true),'');
 method text:=upper(coalesce(current_setting('request.method',true),''));
begin
 if not public.snacky_crm_is_limited() then return;end if;
 if path in ('/rpc/snacky_buying_sources_v1','/rest/v1/rpc/snacky_buying_sources_v1')
   and buying_private.member() is not null then return;end if;
 if path in ('/rpc/snacky_buying_workspace_v1','/rpc/snacky_buying_command_v1',
             '/rest/v1/rpc/snacky_buying_workspace_v1','/rest/v1/rpc/snacky_buying_command_v1')
   and buying_private.member() is not null then return;end if;
 if not public.snacky_current_profile_has_any_role(array['crm']) then
  raise exception 'This account is inactive' using errcode='42501';
 end if;
 path:=regexp_replace(path,'^/rest/v1','');
 if path in (
  '/rpc/snacky_crm_workspace_v1','/rpc/snacky_crm_command_v1',
  '/rpc/snacky_crm_timeline_v1','/rpc/snacky_crm_allowed',
  '/rpc/snacky_current_team_member_id','/rpc/snacky_current_profile_has_any_role',
  '/rpc/snacky_company_workspace_v1','/rpc/snacky_company_command_v1',
  '/rpc/snacky_company_notices_v1','/rpc/snacky_company_file_v1',
  '/rpc/snacky_company_file_access','/rpc/snacky_crm_lead_desk_v1',
  '/rpc/snacky_crm_lead_focus_command_v1','/rpc/snacky_issue_dispatch_command_v1'
 ) then return;end if;
 if method in ('GET','HEAD') and path in (
  '/profiles','/team_members','/crm_documents',
  '/investor_agreements','/investor_monthly_statements','/investor_payments',
  '/investor_contributions','/investor_historical_months'
 ) then return;end if;
 raise exception 'Use the assigned Customer Relations workspace for this account' using errcode='42501';
end;
$$;
revoke all on function public.snacky_crm_api_request_guard() from public;
grant execute on function public.snacky_crm_api_request_guard() to authenticated,anon,service_role;

select pg_notify('pgrst','reload schema');
commit;
