-- Shared operator claim queue for CRM machine issues.
-- CRM creates unassigned field work; all active operators are notified and one can claim it atomically.

create or replace function snacky_notice_private.eligible(n public.notifications)
returns boolean
language plpgsql
security definer
set search_path to ''
as $function$
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
 if not (roles&&case when n.source_kind in ('route','instruction') then array['owner','admin','supervisor','operator'] when n.source_kind in ('lead','location','obligation','routine') then array['owner','admin','supervisor','crm'] else array['owner','admin','supervisor','crm','operator'] end) then return false;end if;
 if coalesce(s->'row'->>'is_practice','false')='true' or coalesce(s->'row'->>'is_archived','false')='true' or s->'row'->>'archived_at' is not null then return false;end if;
 if n.event_kind='ack_overdue' then
  if not snacky_notice_private.escalation_generation_current(n) then return false;end if;
  if n.source_kind<>'task' or not (roles&&array['owner','admin','supervisor','crm']) then return false;end if;
  return exists(
   select 1 from public.crm_tasks t join public.issues i on i.id=t.issue_id
   where t.id=n.source_id and t.task_type='field_action' and t.assigned_to is not null
     and t.priority in ('urgent','critical') and t.status='open' and t.dispatch_state='assigned'
     and t.ack_due_at is not null and t.ack_due_at<=clock_timestamp()
     and t.archived_at is null and coalesce(t.is_practice,false)=false
     and i.assigned_to=n.recipient_member_id and i.status::text not in ('resolved','closed','cancelled','canceled')
     and i.archived_at is null and coalesce(i.is_practice,false)=false
  );
 end if;
 if n.event_kind='removed' then return s->>'member' is distinct from n.recipient_member_id::text;end if;
 if n.event_kind='critical' then return (s->>'active')::boolean and s->>'member' is null and roles&&array['owner','admin'];end if;
 if n.event_kind='completed' then
  creator:=coalesce(nullif(s->'row'->>'created_by',''),nullif(s->'row'->>'created_by_member_id',''),nullif(s->'row'->>'reported_by',''))::uuid;
  return creator=n.recipient_member_id and s->'row'->>'status' in ('completed','resolved') and (n.source_kind<>'task' or roles&&array['owner','admin','supervisor','crm']);
 end if;
 if n.event_kind='cancelled' then return s->>'member'=n.recipient_member_id::text and s->'row'->>'status' in ('cancelled','canceled');end if;
 return s->>'member'=n.recipient_member_id::text and (s->>'active')::boolean;
end;
$function$;

create or replace function snacky_notice_private.emit(k text, i uuid, m uuid, e text, label text, href text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare u uuid:=snacky_notice_private.member_user(m);nid uuid;key text;en text;ar text;candidate public.notifications;
begin
 if u is null or not exists(select 1 from snacky_notice_private.settings where enabled) then return;end if;
 candidate.user_id:=u;candidate.recipient_member_id:=m;candidate.source_kind:=k;candidate.source_id:=i;candidate.event_kind:=e;
 if not coalesce(snacky_notice_private.eligible(candidate),false) then return;end if;
 key:=txid_current()::text||':'||k||':'||i::text||':'||m::text||':'||e;
 if e='changed' and exists(select 1 from public.notifications where event_key=txid_current()::text||':'||k||':'||i::text||':'||m::text||':assigned') then return;end if;
 en:=case e when 'available' then 'Machine issue available' when 'assigned' then 'New work assigned' when 'changed' then 'Your work was updated' when 'removed' then 'Assignment removed' when 'cancelled' then 'Work cancelled' when 'completed' then 'Assigned work completed' when 'field_completed' then 'Field action completed' when 'critical' then 'Urgent issue needs attention' when 'published' then 'New company update' else 'Snacky work update' end;
 ar:=case e when 'available' then 'بلاغ ماكينة متاح للاستلام' when 'assigned' then 'تم إسناد عمل إليك' when 'changed' then 'تم تحديث عملك' when 'removed' then 'تم إلغاء إسناد العمل إليك' when 'cancelled' then 'تم إلغاء العمل' when 'completed' then 'تم إنجاز العمل المسند' when 'field_completed' then 'تم إنجاز الإجراء الميداني' when 'critical' then 'مشكلة عاجلة تحتاج اهتمامك' when 'published' then 'تحديث جديد من الشركة' else 'تحديث عمل سناكي' end;
 if k='route' and e='assigned' then en:='Route assigned';ar:='تم إسناد جولة إليك';end if;
 insert into public.notifications(user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar)
 values(u,'work_'||k||'_'||e,en,coalesce(label,'Snacky OS')||' — Open Snacky OS for details.',href,key,k,i,m,e,ar,coalesce(label,'سناكي')||' — افتح سناكي للاطلاع على التفاصيل.')
 on conflict(event_key) where event_key is not null do nothing returning id into nid;
 if nid is not null then
  insert into snacky_notice_private.deliveries(notification_id,subscription_id)
   select nid,id from public.push_subscriptions where user_id=u and is_active on conflict do nothing;
  begin perform snacky_notice_private.wake();exception when others then raise warning 'Notification wake failed (%); queued delivery retained for retry',sqlstate;end;
 end if;
end
$function$;

create or replace function public.snacky_issue_field_queue_command_v1(
 p_action text,p_issue_id uuid default null,p_task_id uuid default null,p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_catalog'
as $function$
declare
 me uuid:=public.snacky_current_team_member_id(); issue public.issues; task public.crm_tasks; op record;
 v_priority text;v_title text;v_notes text;v_due date:=(now() at time zone 'Africa/Tripoli')::date;
begin
 if auth.uid() is null or me is null then raise exception 'Active staff access required' using errcode='42501';end if;
 if p_action='create' then
  if not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']) then raise exception 'Customer relations access required' using errcode='42501';end if;
  if p_issue_id is null or not public.snacky_crm_allowed('issue',p_issue_id,true) then raise exception 'Issue unavailable' using errcode='42501';end if;
  select * into issue from public.issues where id=p_issue_id for update;
  if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed') then raise exception 'Issue is not open' using errcode='23514';end if;
  if exists(select 1 from public.crm_tasks t where t.issue_id=p_issue_id and t.task_type='field_action' and t.archived_at is null and t.status<>'completed') then raise exception 'This issue already has active field work' using errcode='23505';end if;
  v_priority:=case coalesce(nullif(p_payload->>'priority',''),issue.priority::text,'normal') when 'critical' then 'urgent' when 'urgent' then 'urgent' when 'high' then 'high' when 'low' then 'low' else 'normal' end;
  v_title:=coalesce(nullif(trim(p_payload->>'title'),''),'Inspect and fix machine issue');v_notes:=nullif(trim(p_payload->>'notes'),'');
  insert into public.crm_tasks(title,issue_id,task_type,assigned_to,due_date,priority,notes,status,dispatch_state,created_by,updated_by,is_practice)
  values(v_title,p_issue_id,'field_action',null,v_due,v_priority,v_notes,'open','available',me,me,coalesce(issue.is_practice,false)) returning * into task;
  for op in select t.id from public.team_members t where t.active and t.active_status='active' and (t.role::text='operator' or t.roles::text[]&&array['operator']) loop
   perform snacky_notice_private.emit('task',task.id,op.id,'available','Machine issue / مشكلة ماكينة','/operator/issues');
  end loop;
  return jsonb_build_object('ok',true,'action','create','task_id',task.id,'dispatch_state',task.dispatch_state);
 elsif p_action='claim' then
  if not public.snacky_current_profile_has_any_role(array['operator']) then raise exception 'Operator access required' using errcode='42501';end if;
  if p_task_id is null then raise exception 'Task required' using errcode='22023';end if;
  select * into task from public.crm_tasks where id=p_task_id for update;
  if not found or task.task_type<>'field_action' or task.archived_at is not null or task.status='completed' then raise exception 'Field work unavailable' using errcode='23514';end if;
  if task.assigned_to is not null or task.dispatch_state<>'available' then raise exception 'Another operator already claimed this issue' using errcode='40001';end if;
  select * into issue from public.issues where id=task.issue_id for share;
  if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed') then raise exception 'Issue is no longer open' using errcode='23514';end if;
  update public.crm_tasks set assigned_to=me,updated_by=me,updated_at=clock_timestamp() where id=task.id returning * into task;
  return jsonb_build_object('ok',true,'action','claim','task_id',task.id,'dispatch_state',task.dispatch_state,'assigned_to',task.assigned_to);
 else raise exception 'Unsupported queue action' using errcode='22023';end if;
end
$function$;

revoke all on function public.snacky_issue_field_queue_command_v1(text,uuid,uuid,jsonb) from public;
grant execute on function public.snacky_issue_field_queue_command_v1(text,uuid,uuid,jsonb) to authenticated;
