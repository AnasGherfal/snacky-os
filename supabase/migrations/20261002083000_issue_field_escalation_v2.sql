-- CRM machine-issue safeguards: timed field escalation.
-- Reuses the existing once-per-minute notification worker and private outbox.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists snacky_notice_private.issue_field_escalation_receipts(
  task_id uuid not null references public.crm_tasks(id) on delete cascade,
  issue_id uuid not null references public.issues(id) on delete cascade,
  stage text not null check(stage in ('unclaimed_overdue','operator_idle','field_blocked','field_blocked_management')),
  generation_key text not null,
  recipient_member_id uuid not null references public.team_members(id),
  notification_id uuid references public.notifications(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key(task_id,stage,generation_key,recipient_member_id)
);
alter table snacky_notice_private.issue_field_escalation_receipts enable row level security;
revoke all on snacky_notice_private.issue_field_escalation_receipts from public,anon,authenticated;
grant all on snacky_notice_private.issue_field_escalation_receipts to service_role;

create or replace function snacky_notice_private.issue_field_delay(p_priority text,p_stage text)
returns interval
language sql immutable
set search_path=''
as $$
 select case p_stage
  when 'unclaimed' then case p_priority when 'urgent' then interval '10 minutes' when 'high' then interval '15 minutes' when 'low' then interval '30 minutes' else interval '20 minutes' end
  when 'accepted' then case p_priority when 'urgent' then interval '15 minutes' when 'high' then interval '20 minutes' when 'low' then interval '60 minutes' else interval '30 minutes' end
  when 'en_route' then case p_priority when 'urgent' then interval '30 minutes' when 'high' then interval '45 minutes' when 'low' then interval '90 minutes' else interval '60 minutes' end
  else interval '30 minutes'
 end
$$;

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

 if not (roles&&case when n.source_kind in ('route','instruction') then array['owner','admin','supervisor','operator'] when n.source_kind in ('lead','location','obligation','routine') then array['owner','admin','supervisor','crm'] else array['owner','admin','supervisor','crm','operator'] end) then return false;end if;
 if coalesce(s->'row'->>'is_practice','false')='true' or coalesce(s->'row'->>'is_archived','false')='true' or s->'row'->>'archived_at' is not null then return false;end if;
 if n.event_kind='ack_overdue' then
  if not snacky_notice_private.escalation_generation_current(n) then return false;end if;
  if n.source_kind<>'task' or not (roles&&array['owner','admin','supervisor','crm']) then return false;end if;
  return exists(
   select 1 from public.crm_tasks t
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
  return creator=n.recipient_member_id and s->'row'->>'status' in ('completed','resolved') and (n.source_kind<>'task' or roles&&array['owner','admin','supervisor','crm']);
 end if;
 if n.event_kind='cancelled' then return s->>'member'=n.recipient_member_id::text and s->'row'->>'status' in ('cancelled','canceled');end if;
 return s->>'member'=n.recipient_member_id::text and (s->>'active')::boolean;
end;
$function$;

create or replace function snacky_notice_private.process_issue_field_escalations(p_now timestamptz default clock_timestamp())
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
 r record; v_notification uuid; v_key text; v_created integer:=0; v_checked integer:=0; v_no_device integer:=0;
 v_title text; v_title_ar text; v_message text; v_message_ar text; v_href text;
begin
 if not exists(select 1 from snacky_notice_private.settings where singleton and enabled) then return jsonb_build_object('notifications_paused',true);end if;
 if not pg_try_advisory_xact_lock(hashtextextended('snacky:issue-field-escalation',0)) then return jsonb_build_object('busy',true);end if;

 for r in
  with candidates as (
   select t.id task_id,t.issue_id,t.priority,t.title,t.created_at generation_at,'unclaimed_overdue'::text stage,
          t.created_at::text generation_key,i.assigned_to recipient_member_id,p.id recipient_user_id
   from public.crm_tasks t
   join public.issues i on i.id=t.issue_id
   join public.team_members tm on tm.id=i.assigned_to and tm.active is not false and tm.active_status='active'
   join public.profiles p on p.team_member_id=tm.id and p.active_status='active'
   where t.task_type='field_action' and t.status='open' and t.dispatch_state='available' and t.assigned_to is null
    and t.created_at+snacky_notice_private.issue_field_delay(t.priority,'unclaimed')<=p_now
    and t.archived_at is null and coalesce(t.is_practice,false)=false
    and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false

   union all

   select t.id,t.issue_id,t.priority,t.title,
          coalesce(t.ack_due_at,t.acknowledged_at,t.en_route_at,t.updated_at),'operator_idle',
          t.dispatch_state||':'||coalesce(t.ack_due_at,t.acknowledged_at,t.en_route_at,t.updated_at)::text||':'||t.assigned_to::text,
          t.assigned_to,p.id
   from public.crm_tasks t
   join public.issues i on i.id=t.issue_id
   join public.team_members tm on tm.id=t.assigned_to and tm.active is not false and tm.active_status='active'
   join public.profiles p on p.team_member_id=tm.id and p.active_status='active'
   where t.task_type='field_action' and t.assigned_to is not null and t.status<>'completed' and t.work_started_at is null
    and t.archived_at is null and coalesce(t.is_practice,false)=false
    and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false
    and (
      (t.dispatch_state='assigned' and t.ack_due_at is not null and t.ack_due_at<=p_now)
      or (t.dispatch_state='accepted' and t.acknowledged_at is not null and t.acknowledged_at+snacky_notice_private.issue_field_delay(t.priority,'accepted')<=p_now)
      or (t.dispatch_state='en_route' and t.en_route_at is not null and t.en_route_at+snacky_notice_private.issue_field_delay(t.priority,'en_route')<=p_now)
    )

   union all

   select t.id,t.issue_id,t.priority,t.title,t.blocked_at,'field_blocked',t.blocked_at::text,
          i.assigned_to,p.id
   from public.crm_tasks t
   join public.issues i on i.id=t.issue_id
   join public.team_members tm on tm.id=i.assigned_to and tm.active is not false and tm.active_status='active'
   join public.profiles p on p.team_member_id=tm.id and p.active_status='active'
   where t.task_type='field_action' and t.dispatch_state='blocked' and t.blocked_at is not null and t.status='in_progress'
    and t.archived_at is null and coalesce(t.is_practice,false)=false
    and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false

   union all

   select t.id,t.issue_id,t.priority,t.title,t.blocked_at,'field_blocked_management',
          t.blocked_at::text,tm.id,p.id
   from public.crm_tasks t
   join public.issues i on i.id=t.issue_id
   join public.team_members tm on tm.active is not false and tm.active_status='active'
    and (tm.role::text in ('owner','admin') or tm.roles::text[]&&array['owner','admin'])
   join public.profiles p on p.team_member_id=tm.id and p.active_status='active'
   where t.task_type='field_action' and t.dispatch_state='blocked' and t.blocked_at is not null and t.status='in_progress'
    and t.priority in ('high','urgent','critical') and tm.id is distinct from i.assigned_to
    and t.archived_at is null and coalesce(t.is_practice,false)=false
    and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false
  )
  select * from candidates order by generation_at,task_id,recipient_member_id limit 200
 loop
  v_checked:=v_checked+1;
  insert into snacky_notice_private.issue_field_escalation_receipts(task_id,issue_id,stage,generation_key,recipient_member_id)
  values(r.task_id,r.issue_id,r.stage,r.generation_key,r.recipient_member_id)
  on conflict do nothing;
  if not found then continue;end if;

  if r.stage='unclaimed_overdue' then
   v_title:='Machine issue still unclaimed';v_title_ar:='بلاغ ماكينة لم يستلمه أحد';
   v_message:=left(coalesce(r.title,'Machine issue'),160)||' — No operator has claimed it yet.';
   v_message_ar:=left(coalesce(r.title,'بلاغ ماكينة'),160)||' — لم يستلم أي مشغّل البلاغ حتى الآن.';
   v_href:='/issues/'||r.issue_id::text;
  elsif r.stage='operator_idle' then
   v_title:='Claimed issue needs action';v_title_ar:='بلاغ مستلم يحتاج إجراء';
   v_message:=left(coalesce(r.title,'Machine issue'),160)||' — Open Snacky OS and continue the field task.';
   v_message_ar:=left(coalesce(r.title,'بلاغ ماكينة'),160)||' — افتح سناكي وأكمل الإجراء الميداني.';
   v_href:='/follow-ups/'||r.task_id::text;
  else
   v_title:='Field work blocked';v_title_ar:='العمل الميداني متوقف';
   v_message:=left(coalesce(r.title,'Machine issue'),160)||' — The operator reported a blocker. Review the issue.';
   v_message_ar:=left(coalesce(r.title,'بلاغ ماكينة'),160)||' — سجّل المشغّل عائقاً. راجع البلاغ.';
   v_href:='/issues/'||r.issue_id::text;
  end if;

  v_key:='issue_field_escalation:'||r.stage||':'||r.task_id::text||':'||r.generation_key||':'||r.recipient_member_id::text;
  v_notification:=null;
  insert into public.notifications(user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar)
  values(r.recipient_user_id,'work_task_'||r.stage,v_title,v_message,v_href,v_key,'task',r.task_id,r.recipient_member_id,r.stage,v_title_ar,v_message_ar)
  on conflict(event_key) where event_key is not null do nothing returning id into v_notification;
  if v_notification is null then select id into v_notification from public.notifications where event_key=v_key;end if;

  update snacky_notice_private.issue_field_escalation_receipts set notification_id=v_notification
  where task_id=r.task_id and stage=r.stage and generation_key=r.generation_key and recipient_member_id=r.recipient_member_id;

  if v_notification is not null then
   insert into snacky_notice_private.deliveries(notification_id,subscription_id)
   select v_notification,id from public.push_subscriptions where user_id=r.recipient_user_id and is_active
   on conflict do nothing;
   if not exists(select 1 from public.push_subscriptions where user_id=r.recipient_user_id and is_active) then v_no_device:=v_no_device+1;end if;
   begin perform snacky_notice_private.wake();exception when others then raise warning 'Issue field escalation wake failed (%); notification remains queued',sqlstate;end;
  end if;
  v_created:=v_created+1;
 end loop;

 return jsonb_build_object('generated',v_created,'checked',v_checked,'no_device',v_no_device,'checked_at',p_now);
end;
$function$;

revoke all on function snacky_notice_private.process_issue_field_escalations(timestamptz) from public,anon,authenticated;
grant execute on function snacky_notice_private.process_issue_field_escalations(timestamptz) to service_role;

create or replace function public.snacky_process_issue_field_escalations_v1(p_now timestamptz default null)
returns jsonb
language sql security invoker
set search_path=''
as $$ select snacky_notice_private.process_issue_field_escalations(coalesce(p_now,clock_timestamp())); $$;
revoke all on function public.snacky_process_issue_field_escalations_v1(timestamptz) from public,anon,authenticated;
grant execute on function public.snacky_process_issue_field_escalations_v1(timestamptz) to service_role;

select pg_notify('pgrst','reload schema');
commit;
