-- Operator-claimed CRM machine visits.
-- CRM owns the customer issue. Physical field work is broadcast unassigned,
-- visible to all active operators, and atomically claimed by the first operator.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.crm_tasks drop constraint if exists crm_tasks_dispatch_state_check;
alter table public.crm_tasks add constraint crm_tasks_dispatch_state_check
 check (dispatch_state is null or dispatch_state in ('available','assigned','accepted','en_route','working','blocked','fixed'));

create index if not exists crm_tasks_available_dispatch_idx
 on public.crm_tasks(priority,due_date,created_at)
 where task_type='field_action' and assigned_to is null and dispatch_state='available' and archived_at is null;


-- Preserve the existing CRM validator, with one narrow exception:
-- an issue field_action may be unassigned only while it is in the available claim queue.
create or replace function public.snacky_crm_validate_record()
returns trigger
language plpgsql
security definer
set search_path=public,pg_catalog
as $
declare a jsonb:=to_jsonb(new);b jsonb:=case when tg_op='UPDATE' then to_jsonb(old) end;assignee uuid;
begin
 if tg_table_name='location_pipeline_leads' then
  if length(trim(a->>'place_name')) not between 1 and 200 then raise exception 'Place name must be 1–200 characters';end if;
  if tg_op='UPDATE' and (a->>'id' is distinct from b->>'id' or a->>'created_by_member_id' is distinct from b->>'created_by_member_id') then raise exception 'Original lead identity and creator cannot be changed';end if;
  if coalesce((a->>'is_practice')::boolean,false) and a->>'converted_location_id' is not null then raise exception 'Practice leads cannot become real locations';end if;
 elsif tg_table_name='crm_tasks' then
  assignee:=nullif(a->>'assigned_to','')::uuid;
  if assignee is null then
   if a->>'task_type'<>'field_action' or a->>'issue_id' is null or a->>'dispatch_state'<>'available' then
    raise exception 'Choose an active team member who can perform this work';
   end if;
  else
   if not exists(select 1 from public.team_members t where t.id=assignee and t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm','operator') or t.roles::text[]&&array['owner','admin','supervisor','crm','operator'])) then raise exception 'Choose an active team member who can perform this work';end if;
   if not exists(select 1 from public.team_members t where t.id=assignee and (t.role::text in ('owner','admin','supervisor','crm') or coalesce(t.roles::text[],'{}')&&array['owner','admin','supervisor','crm'])) and (a->>'task_type'<>'field_action' or a->>'issue_id' is null) then raise exception 'Operators may only receive issue field actions';end if;
  end if;
  if a->>'status'='completed' and nullif(trim(a->>'result'),'') is null then raise exception 'Write the result before completing the task';end if;
  if b is not null and (a->>'created_by' is distinct from b->>'created_by' or a->>'issue_id' is distinct from b->>'issue_id' or a->>'lead_id' is distinct from b->>'lead_id' or a->>'location_id' is distinct from b->>'location_id' or a->>'obligation_id' is distinct from b->>'obligation_id') then raise exception 'Work history cannot be moved to an unrelated record';end if;
 elsif tg_table_name='crm_lead_bonus' then
  if a->>'status' in ('approved','paid') and not exists(select 1 from public.location_pipeline_leads l where l.id=(a->>'lead_id')::uuid and l.status in ('accepted','machine_placed') and not l.is_practice) then raise exception 'Approve bonuses only for accepted real locations';end if;
 elsif tg_table_name='location_admin_obligations' then
  assignee:=(a->>'assigned_to')::uuid;
  if not exists(select 1 from public.team_members t where t.id=assignee and t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm') or t.roles::text[]&&array['owner','admin','supervisor','crm'])) then raise exception 'Choose an active customer-relations employee for the obligation';end if;
  if a->>'finance_transaction_id' is not null and (b is null or a->>'finance_transaction_id' is distinct from b->>'finance_transaction_id') then
   perform 1 from public.financial_transactions f where f.id=(a->>'finance_transaction_id')::uuid and f.direction='money_out' and f.currency='LYD' and f.amount=(a->>'amount_lyd')::numeric and f.related_location_id=(a->>'location_id')::uuid and f.transaction_date=(a->>'payment_date')::date and f.transaction_status='active' and not coalesce(f.is_void,false) and f.voided_at is null and not coalesce(f.needs_review,true) for update;
   if not found then raise exception 'Matching Finance payment changed; verification stopped';end if;
  end if;
 end if;
 return new;
end;
$;

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
 if new.task_type<>'field_action' then
  if new.dispatch_state is not null or new.ack_due_at is not null or new.acknowledged_at is not null
   or new.en_route_at is not null or new.work_started_at is not null or new.blocked_at is not null
   or new.fixed_at is not null or new.blocked_reason is not null or new.dispatch_note is not null
  then raise exception 'Dispatch fields are only valid for issue field actions' using errcode='23514';end if;
  return new;
 end if;

 v_window:=case new.priority when 'urgent' then interval '10 minutes' when 'high' then interval '20 minutes'
  when 'low' then interval '60 minutes' else interval '30 minutes' end;

 if tg_op='INSERT' then
  if new.issue_id is null then raise exception 'A dispatched field action must belong to a customer issue' using errcode='23514';end if;
  if new.dispatch_state is null then
   if new.assigned_to is null then
    new.dispatch_state:='available';new.ack_due_at:=null;
   else
    new.dispatch_state:='assigned';new.ack_due_at:=pg_catalog.clock_timestamp()+v_window;
   end if;
  end if;
  if new.dispatch_state='available' and new.assigned_to is not null then
   raise exception 'Available field work must be unassigned' using errcode='23514';
  end if;
  if new.dispatch_state='assigned' and new.assigned_to is null then
   raise exception 'Assigned field work requires an assignee' using errcode='23514';
  end if;
  return new;
 end if;

 if old.dispatch_state is null then
  if new.dispatch_state is not null then raise exception 'Legacy field actions cannot be silently converted to dispatch records' using errcode='23514';end if;
  return new;
 end if;

 -- The claim command is the only path that may atomically bind an available task.
 if new.assigned_to is distinct from old.assigned_to
    and v_context=old.id::text
    and old.dispatch_state='available'
    and old.assigned_to is null
    and new.assigned_to is not null then
  return new;
 end if;

 -- Retain the old managed reassignment behavior for legacy/admin recovery paths.
 if new.assigned_to is distinct from old.assigned_to then
  if old.status='completed' or old.dispatch_state='fixed' then
   raise exception 'Completed field work cannot be reassigned' using errcode='23514';
  end if;
  new.dispatch_state:='assigned';
  new.ack_due_at:=pg_catalog.clock_timestamp()+v_window;
  new.acknowledged_at:=null;new.en_route_at:=null;new.work_started_at:=null;
  new.blocked_at:=null;new.fixed_at:=null;new.blocked_reason:=null;new.dispatch_note:=null;
  new.status:='open';new.result:=null;new.completed_at:=null;new.completed_by:=null;
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
 ) then raise exception 'Use the operator dispatch controls for this field action' using errcode='42501';end if;
 return new;
end;
$$;

create or replace function crm_dispatch_private.command(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
 v_actor_user uuid:=auth.uid();v_actor_member uuid;v_request_id uuid;v_task_id uuid;v_action text;v_version text;v_note text;
 v_task public.crm_tasks%rowtype;v_issue public.issues%rowtype;v_saved crm_dispatch_private.requests%rowtype;
 v_response jsonb;v_now timestamptz:=pg_catalog.clock_timestamp();v_photo_count integer;
begin
 if v_actor_user is null then raise exception 'Sign in required' using errcode='42501';end if;
 v_actor_member:=public.snacky_current_team_member_id();
 if v_actor_member is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator'])
 then raise exception 'Active staff access required' using errcode='42501';end if;
 if p_command is null or pg_catalog.jsonb_typeof(p_command)<>'object' or pg_catalog.octet_length(p_command::text)>12000
 then raise exception 'Invalid dispatch command' using errcode='22023';end if;
 begin v_request_id:=(p_command->>'request_id')::uuid;v_task_id:=(p_command->>'task_id')::uuid;
 exception when invalid_text_representation then raise exception 'Valid request and task IDs are required' using errcode='22023';end;
 v_action:=pg_catalog.lower(pg_catalog.btrim(coalesce(p_command->>'action','')));
 v_version:=nullif(p_command->>'version','');v_note:=nullif(pg_catalog.btrim(coalesce(p_command->>'note','')),'');
 if v_request_id is null or v_task_id is null or v_action not in ('claim','accept','en_route','start','block','fix')
 then raise exception 'Invalid dispatch command' using errcode='22023';end if;
 if pg_catalog.length(coalesce(v_note,''))>2000 then raise exception 'Dispatch note is too long' using errcode='22023';end if;

 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('snacky:crm-dispatch:'||v_request_id::text,0));
 select * into v_saved from crm_dispatch_private.requests where request_id=v_request_id for update;
 if found then
  if v_saved.actor_user_id is distinct from v_actor_user or v_saved.task_id is distinct from v_task_id or v_saved.request is distinct from p_command
  then raise exception 'This request ID was already used for another dispatch action' using errcode='23505';end if;
  if v_saved.response is not null then return v_saved.response;end if;
 else
  insert into crm_dispatch_private.requests(request_id,actor_user_id,task_id,request) values(v_request_id,v_actor_user,v_task_id,p_command);
 end if;

 select * into v_task from public.crm_tasks where id=v_task_id for update;
 if not found or v_task.task_type<>'field_action' or v_task.issue_id is null or v_task.dispatch_state is null or v_task.archived_at is not null
 then raise exception 'This field action is not available for dispatch' using errcode='23514';end if;
 if v_version is null or v_version is distinct from v_task.updated_at::text
 then raise exception 'This field action changed. Reload before continuing' using errcode='40001';end if;

 select * into v_issue from public.issues where id=v_task.issue_id for share;
 if not found or v_issue.archived_at is not null or v_issue.status::text in ('resolved','closed')
 then raise exception 'The customer issue is no longer open for field work' using errcode='23514';end if;

 if v_action='claim' then
  if not public.snacky_current_profile_has_any_role(array['operator']) then
   raise exception 'Only an active operator can claim this visit' using errcode='42501';
  end if;
  if v_task.dispatch_state<>'available' or v_task.assigned_to is not null then
   raise exception 'This visit was already claimed' using errcode='40001';
  end if;
 else
  if v_task.assigned_to is distinct from v_actor_member then
   raise exception 'Only the operator who claimed this visit can report it' using errcode='42501';
  end if;
  if v_action='accept' then
   if v_task.dispatch_state<>'assigned' then raise exception 'This action has already been acknowledged or changed' using errcode='23514';end if;
  elsif v_action='en_route' then
   if v_task.dispatch_state<>'accepted' then raise exception 'Claim or accept the task before going on the way' using errcode='23514';end if;
  elsif v_action='start' then
   if v_task.dispatch_state not in ('accepted','en_route','blocked') then raise exception 'Claim or accept the task before starting work' using errcode='23514';end if;
  elsif v_action='block' then
   if v_task.dispatch_state not in ('accepted','en_route','working') then raise exception 'Only active field work can be marked blocked' using errcode='23514';end if;
   if v_note is null or pg_catalog.length(v_note)<3 then raise exception 'Explain what is blocking the field work' using errcode='23514';end if;
  else
   if v_task.dispatch_state<>'working' then raise exception 'Start the field work before marking it fixed' using errcode='23514';end if;
   if v_note is null or pg_catalog.length(v_note)<3 then raise exception 'Write what was fixed before completing the task' using errcode='23514';end if;
   select count(*)::integer into v_photo_count from public.crm_documents d
    where d.task_id=v_task_id and pg_catalog.lower(coalesce(d.mime_type,'')) like 'image/%';
   if v_photo_count<1 then raise exception 'Upload at least one field photo before marking the task fixed' using errcode='23514';end if;
  end if;
 end if;

 perform pg_catalog.set_config('snacky.crm_dispatch_task_id',v_task_id::text,true);
 if v_action='claim' then
  update public.crm_tasks set assigned_to=v_actor_member,dispatch_state='accepted',ack_due_at=null,
   acknowledged_at=v_now,status='in_progress',updated_by=v_actor_member,updated_at=v_now where id=v_task_id;
 elsif v_action='accept' then
  update public.crm_tasks set dispatch_state='accepted',acknowledged_at=v_now,status='in_progress',updated_by=v_actor_member,updated_at=v_now where id=v_task_id;
 elsif v_action='en_route' then
  update public.crm_tasks set dispatch_state='en_route',en_route_at=v_now,status='in_progress',updated_by=v_actor_member,updated_at=v_now where id=v_task_id;
 elsif v_action='start' then
  update public.crm_tasks set dispatch_state='working',work_started_at=coalesce(work_started_at,v_now),status='in_progress',updated_by=v_actor_member,updated_at=v_now where id=v_task_id;
 elsif v_action='block' then
  update public.crm_tasks set dispatch_state='blocked',blocked_at=v_now,blocked_reason=v_note,dispatch_note=v_note,status='in_progress',updated_by=v_actor_member,updated_at=v_now where id=v_task_id;
 else
  update public.crm_tasks set dispatch_state='fixed',fixed_at=v_now,dispatch_note=v_note,status='completed',result=v_note,
   completed_at=v_now,completed_by=v_actor_member,updated_by=v_actor_member,updated_at=v_now where id=v_task_id;
 end if;
 perform pg_catalog.set_config('snacky.crm_dispatch_task_id','',true);
 select * into v_task from public.crm_tasks where id=v_task_id;
 v_response:=pg_catalog.jsonb_build_object('ok',true,'request_id',v_request_id,'task_id',v_task_id,'action',v_action,
  'assigned_to',v_task.assigned_to,'dispatch_state',v_task.dispatch_state,'status',v_task.status,'version',v_task.updated_at::text);
 update crm_dispatch_private.requests set response=v_response where request_id=v_request_id;
 return v_response;
end;
$$;

create or replace function public.snacky_crm_allowed(p_kind text,p_id uuid,p_write boolean default false)
returns boolean
language plpgsql stable security definer
set search_path=public,pg_catalog
as $$
declare me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();staff boolean:=public.snacky_crm_staff();
begin
 if me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then return false;end if;
 if p_kind='lead' then return exists(select 1 from public.location_pipeline_leads l where l.id=p_id and (manager or (staff and (case when p_write then l.assigned_to_user_id=me or (l.assigned_to_user_id is null and l.created_by_member_id=me) else l.visibility='team' or l.assigned_to_user_id=me or l.created_by_member_id=me end))));
 elsif p_kind='issue' then return exists(select 1 from public.issues i where i.id=p_id and (manager or (staff and (not p_write or i.assigned_to=me or (i.assigned_to is null and i.reported_by=me))) or (not p_write and (i.reported_by=me or exists(select 1 from public.crm_tasks t where t.issue_id=i.id and t.assigned_to=me and t.archived_at is null)))));
 elsif p_kind='location' then return exists(select 1 from public.locations l where l.id=p_id and (manager or (staff and (not p_write or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)))));
 elsif p_kind='contact' then return staff and exists(select 1 from public.crm_contacts c where c.id=p_id);
 elsif p_kind='obligation' then return exists(select 1 from public.location_admin_obligations o where o.id=p_id and (manager or (staff and (o.assigned_to=me or (not p_write and o.is_historical and exists(select 1 from public.location_relationships r where r.location_id=o.location_id and r.assigned_to=me))))));
 elsif p_kind='task' then return exists(select 1 from public.crm_tasks t where t.id=p_id and (
   manager or t.assigned_to=me
   or (not p_write and public.snacky_current_profile_has_any_role(array['operator']) and t.task_type='field_action' and t.dispatch_state='available' and t.assigned_to is null and t.archived_at is null)
   or (staff and (t.created_by=me or public.snacky_crm_allowed('issue',t.issue_id,true) or public.snacky_crm_allowed('lead',t.lead_id,true) or public.snacky_crm_allowed('location',t.location_id,true) or public.snacky_crm_allowed('obligation',t.obligation_id,true)))
  ));
 end if;
 return false;
end;
$$;

create or replace function public.snacky_issue_field_broadcast_v1(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path=public,pg_catalog
as $$
declare
 me uuid:=public.snacky_current_team_member_id();rid uuid;v_issue_id uuid;title text;due_date date;priority text;notes text;
 issue public.issues%rowtype;task public.crm_tasks%rowtype;receipt public.crm_command_receipts;req jsonb;answer jsonb;
begin
 if me is null or not public.snacky_crm_staff() then raise exception 'Customer relations access required' using errcode='42501';end if;
 if p_request is null or jsonb_typeof(p_request)<>'object' or octet_length(p_request::text)>12000 then raise exception 'Invalid field broadcast' using errcode='22023';end if;
 begin rid:=(p_request->>'request_id')::uuid;v_issue_id:=(p_request->>'issue_id')::uuid;due_date:=(p_request->>'due_date')::date;
 exception when others then raise exception 'Valid request, issue and date are required' using errcode='22023';end;
 title:=trim(coalesce(p_request->>'title',''));priority:=lower(trim(coalesce(p_request->>'priority','normal')));notes:=nullif(trim(coalesce(p_request->>'notes','')),'');
 if rid is null or v_issue_id is null or length(title)<3 or length(title)>300 or priority not in ('low','normal','high','urgent') or length(coalesce(notes,''))>3000
 then raise exception 'Invalid field broadcast' using errcode='22023';end if;
 req:=p_request;
 perform pg_advisory_xact_lock(hashtext('crm-field-broadcast'),hashtext(rid::text));
 select * into receipt from public.crm_command_receipts where id=rid for update;
 if found then
  if receipt.actor_user_id<>auth.uid() or receipt.action<>'field.broadcast' or receipt.request is distinct from req
  then raise exception 'Saved request does not match' using errcode='23505';end if;
  return receipt.response;
 end if;
 select * into issue from public.issues where id=v_issue_id for update;
 if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed')
 then raise exception 'Customer issue is not open' using errcode='23514';end if;
 if not public.snacky_crm_allowed('issue',v_issue_id,true) then raise exception 'This issue belongs to another employee' using errcode='42501';end if;
 if exists(select 1 from public.crm_tasks t where t.issue_id=v_issue_id and t.task_type='field_action' and t.archived_at is null and t.status<>'completed' and coalesce(t.dispatch_state,'')<>'fixed')
 then raise exception 'A field visit is already active for this issue' using errcode='23505';end if;
 insert into public.crm_tasks(title,issue_id,task_type,assigned_to,due_date,priority,notes,created_by,updated_by,is_practice)
 values(title,v_issue_id,'field_action',null,due_date,priority,notes,me,me,issue.is_practice) returning * into task;
 perform public.snacky_crm_emit('issue',v_issue_id,'field_broadcast','Field visit sent to all operators',null,
  jsonb_build_object('task_id',task.id,'priority',priority,'due_date',due_date));
 answer:=jsonb_build_object('ok',true,'request_id',rid,'issue_id',v_issue_id,'task_id',task.id,'version',task.updated_at::text);
 insert into public.crm_command_receipts(id,actor_user_id,action,request,response) values(rid,auth.uid(),'field.broadcast',req,answer);
 return answer;
end;
$$;
revoke all on function public.snacky_issue_field_broadcast_v1(jsonb) from public,anon;
grant execute on function public.snacky_issue_field_broadcast_v1(jsonb) to authenticated;

create or replace function public.snacky_operator_field_queue_v1()
returns jsonb
language plpgsql
stable security definer
set search_path=''
as $$
declare result jsonb;
begin
 if public.snacky_current_team_member_id() is null or not public.snacky_current_profile_has_any_role(array['operator'])
 then raise exception 'Operator access required' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object(
  'id',t.id,'issue_id',t.issue_id,'assigned_to',t.assigned_to,'title',t.title,'priority',t.priority,'status',t.status,
  'dispatch_state',t.dispatch_state,'ack_due_at',t.ack_due_at,'acknowledged_at',t.acknowledged_at,'en_route_at',t.en_route_at,
  'work_started_at',t.work_started_at,'blocked_at',t.blocked_at,'fixed_at',t.fixed_at,'blocked_reason',t.blocked_reason,
  'dispatch_note',t.dispatch_note,'result',t.result,'updated_at',t.updated_at,'version',t.updated_at::text,
  'created_at',t.created_at,'location_name',loc.name,'machine_name',m.name,'issue_description',i.description,'issue_type',i.issue_type
 ) order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,t.due_date,t.created_at),'[]'::jsonb)
 into result
 from public.crm_tasks t
 join public.issues i on i.id=t.issue_id
 left join public.machines m on m.id=i.machine_id
 left join public.locations loc on loc.id=coalesce(i.location_id,m.location_id)
 where t.task_type='field_action' and t.dispatch_state='available' and t.assigned_to is null and t.archived_at is null
  and t.status='open' and not t.is_practice and i.archived_at is null and i.status::text not in ('resolved','closed');
 return result;
end;
$$;
revoke all on function public.snacky_operator_field_queue_v1() from public,anon;
grant execute on function public.snacky_operator_field_queue_v1() to authenticated;

create or replace function snacky_notice_private.emit(k text,i uuid,m uuid,e text,label text,href text)
returns void
language plpgsql security definer set search_path=''
as $$
declare u uuid:=snacky_notice_private.member_user(m);nid uuid;key text;en text;ar text;candidate public.notifications;
begin
 if u is null or not exists(select 1 from snacky_notice_private.settings where enabled) then return;end if;
 candidate.user_id:=u;candidate.recipient_member_id:=m;candidate.source_kind:=k;candidate.source_id:=i;candidate.event_kind:=e;
 if not coalesce(snacky_notice_private.eligible(candidate),false) then return;end if;
 key:=txid_current()::text||':'||k||':'||i::text||':'||m::text||':'||e;
 if e='changed' and exists(select 1 from public.notifications where event_key=txid_current()::text||':'||k||':'||i::text||':'||m::text||':assigned') then return;end if;
 en:=case e when 'available' then 'Machine issue available' when 'assigned' then 'New work assigned' when 'changed' then 'Your work was updated' when 'removed' then 'Assignment removed' when 'cancelled' then 'Work cancelled' when 'completed' then 'Assigned work completed' when 'field_completed' then 'Field action completed' when 'critical' then 'Urgent issue needs attention' when 'published' then 'New company update' else 'Snacky work update' end;
 ar:=case e when 'available' then 'مشكلة ماكينة متاحة للاستلام' when 'assigned' then 'تم إسناد عمل إليك' when 'changed' then 'تم تحديث عملك' when 'removed' then 'تم إلغاء إسناد العمل إليك' when 'cancelled' then 'تم إلغاء العمل' when 'completed' then 'تم إنجاز العمل المسند' when 'field_completed' then 'تم إنجاز الإجراء الميداني' when 'critical' then 'مشكلة عاجلة تحتاج اهتمامك' when 'published' then 'تحديث جديد من الشركة' else 'تحديث عمل سناكي' end;
 if k='route' and e='assigned' then en:='Route assigned';ar:='تم إسناد جولة إليك';end if;
 insert into public.notifications(user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar)
 values(u,'work_'||k||'_'||e,en,coalesce(label,'Snacky OS')||' — Open Snacky OS for details.',href,key,k,i,m,e,ar,coalesce(label,'سناكي')||' — افتح سناكي للاطلاع على التفاصيل.')
 on conflict(event_key) where event_key is not null do nothing returning id into nid;
 if nid is not null then
  insert into snacky_notice_private.deliveries(notification_id,subscription_id)
   select nid,id from public.push_subscriptions where user_id=u and is_active on conflict do nothing;
  begin perform snacky_notice_private.wake();exception when others then raise warning 'Notification wake failed (%); queued delivery retained for retry',sqlstate;end;
 end if;
end;
$$;

create or replace function snacky_notice_private.eligible(n public.notifications)
returns boolean
language plpgsql volatile security definer set search_path=''
as $$
declare s jsonb;roles text[];creator uuid;
begin
 if snacky_notice_private.member_user(n.recipient_member_id) is distinct from n.user_id then return false;end if;
 select array[p.role::text]||coalesce(p.roles::text[],'{}') into roles from public.profiles p where id=n.user_id;
 s:=snacky_notice_private.source(n.source_kind,n.source_id);if s is null then return false;end if;
 if n.event_kind='available' then
  return n.source_kind='task' and roles&&array['operator'] and (s->>'active')::boolean
   and s->>'member' is null and s->'row'->>'task_type'='field_action' and s->'row'->>'dispatch_state'='available';
 end if;
 if n.source_kind='company' then return (s->>'active')::boolean and roles&&array(select jsonb_array_elements_text(s->'row'->'audience'));end if;
 if not (roles&&case when n.source_kind in ('route','instruction') then array['owner','admin','supervisor','operator'] when n.source_kind in ('lead','location','obligation','routine') then array['owner','admin','supervisor','crm'] else array['owner','admin','supervisor','crm','operator'] end) then return false;end if;
 if coalesce(s->'row'->>'is_practice','false')='true' or coalesce(s->'row'->>'is_archived','false')='true' or s->'row'->>'archived_at' is not null then return false;end if;
 if n.event_kind='removed' then return s->>'member' is distinct from n.recipient_member_id::text;end if;
 if n.event_kind='critical' then return (s->>'active')::boolean and s->>'member' is null and roles&&array['owner','admin'];end if;
 if n.event_kind='completed' then
  creator:=coalesce(nullif(s->'row'->>'created_by',''),nullif(s->'row'->>'created_by_member_id',''),nullif(s->'row'->>'reported_by',''))::uuid;
  return creator=n.recipient_member_id and s->'row'->>'status' in ('completed','resolved') and (n.source_kind<>'task' or roles&&array['owner','admin','supervisor','crm']);
 end if;
 if n.event_kind='cancelled' then return s->>'member'=n.recipient_member_id::text and s->'row'->>'status' in ('cancelled','canceled');end if;
 return s->>'member'=n.recipient_member_id::text and (s->>'active')::boolean;
end;
$$;

create or replace function snacky_notice_private.field_available()
returns trigger
language plpgsql security definer set search_path=''
as $$
declare op record;label text;loc_name text;machine_name text;
begin
 if new.task_type<>'field_action' or new.dispatch_state<>'available' or new.assigned_to is not null or new.archived_at is not null then return new;end if;
 if tg_op='UPDATE' and old.dispatch_state='available' and old.assigned_to is null then return new;end if;
 select l.name,m.name into loc_name,machine_name
 from public.issues i left join public.machines m on m.id=i.machine_id left join public.locations l on l.id=coalesce(i.location_id,m.location_id)
 where i.id=new.issue_id;
 label:=left(concat_ws(' · ',coalesce(loc_name,'Customer issue'),machine_name,new.title),160);
 for op in select t.id from public.team_members t where t.active is not false and t.active_status='active'
  and (t.role::text='operator' or t.roles::text[]&&array['operator'])
 loop
  perform snacky_notice_private.emit('task',new.id,op.id,'available',label,'/follow-ups/'||new.id::text);
 end loop;
 return new;
end;
$$;
drop trigger if exists snacky_field_available_notice on public.crm_tasks;
create trigger snacky_field_available_notice after insert or update on public.crm_tasks
for each row execute function snacky_notice_private.field_available();

create or replace function public.snacky_crm_api_request_guard()
returns void
language plpgsql
security definer
set search_path=public,pg_catalog
as $$
declare path text:=coalesce(current_setting('request.path',true),'');method text:=upper(coalesce(current_setting('request.method',true),''));
begin
 if not public.snacky_crm_is_limited() then return;end if;
 if path in ('/rpc/snacky_buying_sources_v1','/rest/v1/rpc/snacky_buying_sources_v1') and buying_private.member() is not null then return;end if;
 if path in ('/rpc/snacky_buying_workspace_v1','/rpc/snacky_buying_command_v1','/rest/v1/rpc/snacky_buying_workspace_v1','/rest/v1/rpc/snacky_buying_command_v1') and buying_private.member() is not null then return;end if;
 if not public.snacky_current_profile_has_any_role(array['crm']) then raise exception 'This account is inactive' using errcode='42501';end if;
 path:=regexp_replace(path,'^/rest/v1','');
 if path in (
  '/rpc/snacky_crm_workspace_v1','/rpc/snacky_crm_command_v1','/rpc/snacky_crm_timeline_v1','/rpc/snacky_crm_allowed',
  '/rpc/snacky_current_team_member_id','/rpc/snacky_current_profile_has_any_role','/rpc/snacky_company_workspace_v1',
  '/rpc/snacky_company_command_v1','/rpc/snacky_company_notices_v1','/rpc/snacky_company_file_v1','/rpc/snacky_company_file_access',
  '/rpc/snacky_crm_lead_desk_v1','/rpc/snacky_crm_lead_focus_command_v1','/rpc/snacky_issue_dispatch_command_v1',
  '/rpc/snacky_issue_field_broadcast_v1'
 ) then return;end if;
 if method in ('GET','HEAD') and path in ('/profiles','/team_members','/crm_documents','/investor_agreements','/investor_monthly_statements','/investor_payments','/investor_contributions','/investor_historical_months') then return;end if;
 raise exception 'Use the assigned Customer Relations workspace for this account' using errcode='42501';
end;
$$;

revoke all on all functions in schema snacky_notice_private from public,anon,authenticated;
select pg_notify('pgrst','reload schema');
commit;
