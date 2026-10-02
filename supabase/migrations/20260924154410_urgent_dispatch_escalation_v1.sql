-- Urgent field-action acknowledgement escalation.
-- Reuses the existing Snacky notification worker/outbox; starts disabled.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists snacky_notice_private.dispatch_escalation_settings(
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  last_scan_at timestamptz,
  last_result jsonb
);
insert into snacky_notice_private.dispatch_escalation_settings(singleton)
values(true) on conflict(singleton) do nothing;

create table if not exists snacky_notice_private.dispatch_escalation_receipts(
  task_id uuid not null references public.crm_tasks(id) on delete cascade,
  assignee_member_id uuid not null references public.team_members(id),
  issue_id uuid not null references public.issues(id) on delete cascade,
  recipient_member_id uuid not null references public.team_members(id),
  ack_due_at timestamptz not null,
  stage text not null default 'ack_overdue' check(stage='ack_overdue'),
  notification_id uuid references public.notifications(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key(task_id,assignee_member_id,ack_due_at,stage,recipient_member_id)
);
create index if not exists dispatch_escalation_receipt_issue
  on snacky_notice_private.dispatch_escalation_receipts(issue_id,created_at desc);

alter table snacky_notice_private.dispatch_escalation_settings enable row level security;
alter table snacky_notice_private.dispatch_escalation_receipts enable row level security;
revoke all on snacky_notice_private.dispatch_escalation_settings,
  snacky_notice_private.dispatch_escalation_receipts from public,anon,authenticated;
grant all on snacky_notice_private.dispatch_escalation_settings,
  snacky_notice_private.dispatch_escalation_receipts to service_role;

-- Delivery-time eligibility is stricter than queue-time eligibility. If an
-- operator accepts, is reassigned, the issue closes, or either record is
-- archived/practice, a queued overdue reminder is skipped.
create or replace function snacky_notice_private.eligible(n public.notifications)
returns boolean
language plpgsql volatile security definer
set search_path=''
as $$
declare s jsonb;roles text[];creator uuid;
begin
 if snacky_notice_private.member_user(n.recipient_member_id) is distinct from n.user_id then return false;end if;
 select array[p.role::text]||coalesce(p.roles::text[],'{}') into roles from public.profiles p where id=n.user_id;
 s:=snacky_notice_private.source(n.source_kind,n.source_id);if s is null then return false;end if;
 if n.source_kind='company' then return (s->>'active')::boolean and roles&&array(select jsonb_array_elements_text(s->'row'->'audience'));end if;
 if not (roles&&case when n.source_kind in ('route','instruction') then array['owner','admin','supervisor','operator'] when n.source_kind in ('lead','location','obligation','routine') then array['owner','admin','supervisor','crm'] else array['owner','admin','supervisor','crm','operator'] end) then return false;end if;
 if coalesce(s->'row'->>'is_practice','false')='true' or coalesce(s->'row'->>'is_archived','false')='true' or s->'row'->>'archived_at' is not null then return false;end if;
 if n.event_kind='ack_overdue' then
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
  return creator=n.recipient_member_id and s->'row'->>'status' in ('completed','resolved') and (n.source_kind<>'task' or roles&&array['owner','admin','supervisor','crm']);
 end if;
 if n.event_kind='cancelled' then return s->>'member'=n.recipient_member_id::text and s->'row'->>'status' in ('cancelled','canceled');end if;
 return s->>'member'=n.recipient_member_id::text and (s->>'active')::boolean;
end;
$$;

create or replace function snacky_notice_private.process_dispatch_escalations(p_now timestamptz default clock_timestamp())
returns jsonb
language plpgsql security definer
set search_path=''
as $$
declare
  r record;
  v_notification uuid;
  v_key text;
  v_created integer:=0;
  v_no_device integer:=0;
  v_missing_recipient integer:=0;
  v_checked integer:=0;
  v_result jsonb;
begin
 if not exists(select 1 from snacky_notice_private.dispatch_escalation_settings where singleton and enabled) then
  return jsonb_build_object('disabled',true);
 end if;
 if not exists(select 1 from snacky_notice_private.settings where singleton and enabled) then
  return jsonb_build_object('notifications_paused',true);
 end if;
 if not pg_try_advisory_xact_lock(hashtextextended('snacky:urgent-dispatch-escalation',0)) then
  return jsonb_build_object('busy',true);
 end if;

 select count(*)::integer into v_missing_recipient
 from public.crm_tasks t
 join public.issues i on i.id=t.issue_id
 where t.task_type='field_action' and t.priority in ('urgent','critical')
   and t.status='open' and t.dispatch_state='assigned'
   and t.ack_due_at is not null and t.ack_due_at<=p_now
   and t.archived_at is null and coalesce(t.is_practice,false)=false
   and i.status::text not in ('resolved','closed','cancelled','canceled')
   and i.archived_at is null and coalesce(i.is_practice,false)=false
   and (
     i.assigned_to is null
     or not exists(
       select 1 from public.team_members tm
       join public.profiles p on p.team_member_id=tm.id
       where tm.id=i.assigned_to
         and tm.active is not false and tm.active_status='active'
         and p.active_status='active'
         and (tm.auth_user_id is null or tm.auth_user_id=p.id)
         and (
           array[p.role::text]||coalesce(p.roles::text[],'{}')||
           array[tm.role::text]||coalesce(tm.roles::text[],'{}')
         )&&array['owner','admin','supervisor','crm']
     )
   );

 for r in
  select t.id task_id,t.title,t.assigned_to assignee_member_id,t.ack_due_at,
         i.id issue_id,i.assigned_to recipient_member_id,p.id recipient_user_id
  from public.crm_tasks t
  join public.issues i on i.id=t.issue_id
  join public.team_members tm on tm.id=i.assigned_to
    and tm.active is not false and tm.active_status='active'
  join public.profiles p on p.team_member_id=tm.id
    and p.active_status='active' and (tm.auth_user_id is null or tm.auth_user_id=p.id)
  where t.task_type='field_action'
    and t.priority in ('urgent','critical')
    and t.status='open'
    and t.dispatch_state='assigned'
    and t.assigned_to is not null
    and t.ack_due_at is not null and t.ack_due_at<=p_now
    and t.archived_at is null and coalesce(t.is_practice,false)=false
    and i.status::text not in ('resolved','closed','cancelled','canceled')
    and i.archived_at is null and coalesce(i.is_practice,false)=false
    and (
      array[p.role::text]||coalesce(p.roles::text[],'{}')||
      array[tm.role::text]||coalesce(tm.roles::text[],'{}')
    )&&array['owner','admin','supervisor','crm']
  order by t.ack_due_at,t.id
  limit 100
 loop
  v_checked:=v_checked+1;
  insert into snacky_notice_private.dispatch_escalation_receipts(
    task_id,assignee_member_id,issue_id,recipient_member_id,ack_due_at
  ) values(r.task_id,r.assignee_member_id,r.issue_id,r.recipient_member_id,r.ack_due_at)
  on conflict do nothing;
  if not found then continue;end if;

  v_key:='dispatch_ack_overdue:'||r.task_id::text||':'||r.assignee_member_id::text||':'||
    r.ack_due_at::text||':'||r.recipient_member_id::text;
  v_notification:=null;
  insert into public.notifications(
    user_id,type,title,message,action_url,event_key,source_kind,source_id,
    recipient_member_id,event_kind,title_ar,message_ar
  ) values(
    r.recipient_user_id,'work_task_ack_overdue','Urgent field task not accepted',
    left(coalesce(r.title,'Urgent field task'),160)||' — The operator has not accepted this urgent task. Open Snacky OS to contact or reassign.',
    '/issues/'||r.issue_id::text,v_key,'task',r.task_id,
    r.recipient_member_id,'ack_overdue','مهمة ميدانية عاجلة لم يتم قبولها',
    left(coalesce(r.title,'مهمة ميدانية عاجلة'),160)||' — لم يقبل المشغّل هذه المهمة العاجلة. افتح سناكي للتواصل معه أو إعادة الإسناد.'
  )
  on conflict(event_key) where event_key is not null do nothing
  returning id into v_notification;

  if v_notification is null then
    select id into v_notification from public.notifications where event_key=v_key;
  end if;
  update snacky_notice_private.dispatch_escalation_receipts
  set notification_id=v_notification
  where task_id=r.task_id and assignee_member_id=r.assignee_member_id
    and ack_due_at=r.ack_due_at and recipient_member_id=r.recipient_member_id
    and stage='ack_overdue';

  if v_notification is not null then
    insert into snacky_notice_private.deliveries(notification_id,subscription_id)
    select v_notification,s.id
    from public.push_subscriptions s
    where s.user_id=r.recipient_user_id and s.is_active
    on conflict do nothing;
    if not exists(select 1 from public.push_subscriptions s where s.user_id=r.recipient_user_id and s.is_active) then
      v_no_device:=v_no_device+1;
    end if;
    begin
      perform snacky_notice_private.wake();
    exception when others then
      raise warning 'Escalation notification wake failed (%); persisted notification remains available',sqlstate;
    end;
  end if;
  v_created:=v_created+1;
 end loop;

 v_result:=jsonb_build_object(
  'generated',v_created,'checked',v_checked,'no_device',v_no_device,
  'missing_recipient',v_missing_recipient,'checked_at',p_now
 );
 update snacky_notice_private.dispatch_escalation_settings
 set last_scan_at=p_now,last_result=v_result where singleton;
 return v_result;
end;
$$;

revoke all on function snacky_notice_private.process_dispatch_escalations(timestamptz)
from public,anon,authenticated;
grant execute on function snacky_notice_private.process_dispatch_escalations(timestamptz)
to service_role;

create or replace function public.snacky_process_dispatch_escalations_v1(p_now timestamptz default null)
returns jsonb
language sql security invoker
set search_path=''
as $$
 select snacky_notice_private.process_dispatch_escalations(coalesce(p_now,clock_timestamp()));
$$;
revoke all on function public.snacky_process_dispatch_escalations_v1(timestamptz)
from public,anon,authenticated;
grant execute on function public.snacky_process_dispatch_escalations_v1(timestamptz)
to service_role;

select pg_notify('pgrst','reload schema');
commit;
