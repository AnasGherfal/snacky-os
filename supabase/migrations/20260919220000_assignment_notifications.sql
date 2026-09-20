-- Assignment alerts are committed with the work record. Delivery is independent.
-- No backfill: installation does not notify staff about old assignments.
create schema if not exists snacky_notice_private;
revoke all on schema snacky_notice_private from public, anon, authenticated;
grant usage on schema snacky_notice_private to service_role;
create table if not exists snacky_notice_private.settings (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 token_hash text, activated_at timestamptz, last_worker_at timestamptz, last_wake_at timestamptz
);
insert into snacky_notice_private.settings(singleton) values(true) on conflict do nothing;
alter table public.notifications add column if not exists event_key text,
 add column if not exists source_kind text, add column if not exists source_id uuid,
 add column if not exists recipient_member_id uuid, add column if not exists event_kind text,
 add column if not exists title_ar text, add column if not exists message_ar text;
create unique index if not exists snacky_notice_event_unique on public.notifications(event_key) where event_key is not null;
alter table public.push_subscriptions add column if not exists locale text not null default 'ar';
create table if not exists snacky_notice_private.deliveries (
 id uuid primary key default gen_random_uuid(), notification_id uuid not null references public.notifications(id) on delete cascade,
 subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
 status text not null default 'queued' check(status in ('queued','sending','retry','accepted','skipped','failed')),
 attempts integer not null default 0, available_at timestamptz not null default now(),
 lease_id uuid, lease_until timestamptz, last_error text, accepted_at timestamptz,
 created_at timestamptz not null default now(), unique(notification_id,subscription_id)
);
create index if not exists snacky_notice_pending on snacky_notice_private.deliveries(status,available_at);
alter table snacky_notice_private.settings enable row level security;
alter table snacky_notice_private.deliveries enable row level security;
revoke all on all tables in schema snacky_notice_private from public,anon,authenticated;
grant all on all tables in schema snacky_notice_private to service_role;

create or replace function snacky_notice_private.member_user(m uuid) returns uuid
language sql volatile security definer set search_path='' as $$
 select p.id from public.profiles p join public.team_members t on t.id=p.team_member_id
 where t.id=m and t.active is not false and t.active_status='active' and p.active_status='active'
 and (t.auth_user_id is null or t.auth_user_id=p.id) order by p.id limit 1;
$$;
-- Read only explicitly supported assignment sources; no caller-supplied SQL identifiers.
create or replace function snacky_notice_private.source(k text,i uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare s text:='public';t text;pk text:='id';a text:='assigned_to';r jsonb;href text;label text;active boolean;
begin
 case k
 when 'route' then t:='routes';a:='operator_id';href:='/operator/routes/';
 when 'lead' then t:='location_pipeline_leads';a:='assigned_to_user_id';href:='/locations-pipeline/';
 when 'issue' then t:='issues';href:='/issues/';
 when 'task' then t:='crm_tasks';href:='/follow-ups/';
 when 'location' then t:='location_relationships';pk:='location_id';href:='/relationships/';
 when 'obligation' then t:='location_admin_obligations';href:='/relationships/obligations/';
 when 'routine' then s:='crm_automation_private';t:='routines';href:='/my-work';
 when 'instruction' then t:='operator_instructions';a:='operator_id';href:='/operator/routes';
 when 'company' then
  if to_regclass('company_private.items') is null then return null;end if;
  execute 'select jsonb_build_object(''row'',v.data,''active'',not x.archived,''version'',x.current_version,''href'',''/company/items/''||x.id::text) from company_private.items x join company_private.versions v on v.item_id=x.id and v.version=x.current_version where x.id=$1' into r using i;
  return r;
 else return null;
 end case;
 if to_regclass(format('%I.%I',s,t)) is null then return null;end if;
 execute format('select to_jsonb(x) from %I.%I x where %I=$1',s,t,pk) into r using i;
 if r is null then return null;end if;
 active:=coalesce(r->>'is_practice','false')<>'true' and coalesce(r->>'is_archived','false')<>'true'
   and r->>'archived_at' is null and coalesce(r->>'paused','false')<>'true';
 if k='route' then active:=active and coalesce(r->>'status','draft') not in ('draft','completed','verified','payroll_pending','paid','reviewed','disputed','cancelled','canceled','archived','deleted');
 else active:=active and coalesce(r->>'status','open') not in ('completed','cancelled','closed','resolved','rejected','machine_placed','paid','not_applicable');end if;
 label:=left(coalesce(nullif(r->>'place_name',''),nullif(r->>'title',''),nullif(r->>'route_date',''),nullif(r->>'issue_type',''),'Snacky OS'),160);
 if k='location' then select left(name,160) into label from public.locations where id=i;end if;
 return jsonb_build_object('row',r,'member',r->>a,'active',active,'label',label,'href',href||case when k in ('routine','instruction') then '' else i::text end);
end $$;

-- The optional networking migration replaces this no-op. Network failures must
-- never roll back route, CRM, inventory or money operations.
do $setup$begin
 if to_regprocedure('snacky_notice_private.wake()') is null then
  execute $body$create function snacky_notice_private.wake() returns void language plpgsql security definer set search_path='' as 'begin return;end'$body$;
 end if;
end $setup$;

create or replace function snacky_notice_private.emit(k text,i uuid,m uuid,e text,label text,href text) returns void
language plpgsql security definer set search_path='' as $$
declare u uuid:=snacky_notice_private.member_user(m);nid uuid;key text;en text;ar text;candidate public.notifications;
begin
 if u is null or not exists(select 1 from snacky_notice_private.settings where enabled) then return;end if;
 candidate.user_id:=u;candidate.recipient_member_id:=m;candidate.source_kind:=k;candidate.source_id:=i;candidate.event_kind:=e;
 if not coalesce(snacky_notice_private.eligible(candidate),false) then return;end if;
 key:=txid_current()::text||':'||k||':'||i::text||':'||m::text||':'||e;
 if e='changed' and exists(select 1 from public.notifications where event_key=txid_current()::text||':'||k||':'||i::text||':'||m::text||':assigned') then return;end if;
 en:=case e when 'assigned' then 'New work assigned' when 'changed' then 'Your work was updated' when 'removed' then 'Assignment removed' when 'cancelled' then 'Work cancelled' when 'completed' then 'Assigned work completed' when 'field_completed' then 'Field action completed' when 'critical' then 'Urgent issue needs attention' when 'published' then 'New company update' else 'Snacky work update' end;
 ar:=case e when 'assigned' then 'تم إسناد عمل إليك' when 'changed' then 'تم تحديث عملك' when 'removed' then 'تم إلغاء إسناد العمل إليك' when 'cancelled' then 'تم إلغاء العمل' when 'completed' then 'تم إنجاز العمل المسند' when 'field_completed' then 'تم إنجاز الإجراء الميداني' when 'critical' then 'مشكلة عاجلة تحتاج اهتمامك' when 'published' then 'تحديث جديد من الشركة' else 'تحديث عمل سناكي' end;
 if k='route' and e='assigned' then en:='Route assigned';ar:='تم إسناد جولة إليك';end if;
 insert into public.notifications(user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar)
 values(u,'work_'||k||'_'||e,en,coalesce(label,'Snacky OS')||' — Open Snacky OS for details.',href,key,k,i,m,e,ar,coalesce(label,'سناكي')||' — افتح سناكي للاطلاع على التفاصيل.')
 on conflict(event_key) where event_key is not null do nothing returning id into nid;
 if nid is not null then
  insert into snacky_notice_private.deliveries(notification_id,subscription_id)
   select nid,id from public.push_subscriptions where user_id=u and is_active on conflict do nothing;
  begin perform snacky_notice_private.wake();exception when others then raise warning 'Notification wake failed (%); queued delivery retained for retry',sqlstate;end;
 end if;
end $$;

create or replace function snacky_notice_private.assignment_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text:=tg_argv[0];j jsonb:=to_jsonb(new);o jsonb:=case when tg_op='UPDATE' then to_jsonb(old) else '{}'::jsonb end;
 i uuid:=coalesce(nullif(j->>'id',''),j->>'location_id')::uuid;src jsonb;prev uuid;who uuid;creator uuid;issue_owner uuid;man record;oldactive boolean;
begin
 if not exists(select 1 from snacky_notice_private.settings where enabled) then return new;end if;
 src:=snacky_notice_private.source(k,i);if src is null then return new;end if;
 who:=nullif(src->>'member','')::uuid;
 prev:=nullif(case k when 'route' then o->>'operator_id' when 'instruction' then o->>'operator_id' when 'lead' then o->>'assigned_to_user_id' else o->>'assigned_to' end,'')::uuid;
 if coalesce(j->>'is_practice','false')='true' or coalesce(j->>'is_archived','false')='true' or j->>'archived_at' is not null then return new;end if;
 oldactive:=tg_op='UPDATE' and coalesce(o->>'status','open') not in ('draft','completed','cancelled','canceled','resolved','closed','paid','not_applicable','rejected','machine_placed') and coalesce(o->>'paused','false')<>'true';
 if (src->>'active')::boolean and who is not null then
  if tg_op='INSERT' or who is distinct from prev or not oldactive then
   perform snacky_notice_private.emit(k,i,who,'assigned',src->>'label',src->>'href');
  elsif (j->>'priority' in ('high','urgent','critical') and j->>'priority' is distinct from o->>'priority')
   or (j->>'route_date' is distinct from o->>'route_date') or (j->>'due_date' is distinct from o->>'due_date')
   or (j->>'due_time' is distinct from o->>'due_time') or (j->>'due_at' is distinct from o->>'due_at')
   or (j->>'next_action_date' is distinct from o->>'next_action_date') or (j->>'next_action_time' is distinct from o->>'next_action_time') then
   perform snacky_notice_private.emit(k,i,who,'changed',src->>'label',src->>'href');
  end if;
 end if;
 if tg_op='UPDATE' and prev is not null and who is distinct from prev and oldactive then
  perform snacky_notice_private.emit(k,i,prev,'removed',src->>'label',case when k='route' then '/operator/routes' else '/my-work' end);
 end if;
 if tg_op='UPDATE' and j->>'status' in ('cancelled','canceled') and j->>'status' is distinct from o->>'status' then
  perform snacky_notice_private.emit(k,i,coalesce(who,prev),'cancelled',src->>'label',case when k='route' then '/operator/routes' else '/my-work' end);
 end if;
 if tg_op='UPDATE' and j->>'status' in ('completed','resolved') and j->>'status' is distinct from o->>'status' then
  creator:=coalesce(nullif(j->>'created_by',''),nullif(j->>'created_by_member_id',''),nullif(j->>'reported_by',''))::uuid;
  if k='task' and j->>'task_type'='field_action' and j->>'issue_id' is not null then
   select assigned_to into issue_owner from public.issues where id=(j->>'issue_id')::uuid;
   if issue_owner is distinct from who then
    perform snacky_notice_private.emit('issue',(j->>'issue_id')::uuid,issue_owner,'field_completed','Customer issue / مشكلة عميل','/issues/'||(j->>'issue_id'));
   end if;
  end if;
  -- One result alert when the assigning employee also owns the customer issue.
  if creator is distinct from who and creator is distinct from issue_owner then
   perform snacky_notice_private.emit(k,i,creator,'completed',src->>'label',case when k='route' then '/routes/'||i::text else src->>'href' end);
  end if;
 end if;
 -- Escalate only new/escalated unassigned urgent issues, not every routine save.
 if k='issue' and who is null and j->>'priority' in ('urgent','critical') and (tg_op='INSERT' or j->>'priority' is distinct from o->>'priority') then
  for man in select t.id from public.team_members t where t.active is not false and t.active_status='active' and (t.role::text in ('owner','admin') or t.roles::text[]&&array['owner','admin']) loop
   perform snacky_notice_private.emit(k,i,man.id,'critical',src->>'label','/issues/'||i::text);
  end loop;
 end if;
 return new;
end $$;

-- Publication uses only the published version and its explicit audience, never drafts.
create or replace function snacky_notice_private.company_published() returns trigger
language plpgsql security definer set search_path='' as $$
declare src jsonb;person record;
begin
 if new.archived or new.current_version=0 or (tg_op='UPDATE' and new.current_version=old.current_version) then return new;end if;
 src:=snacky_notice_private.source('company',new.id);
 if coalesce(src->'row'->>'notify','false')<>'true' then return new;end if;
 for person in select t.id from public.team_members t join public.profiles p on p.team_member_id=t.id
 where p.active_status='active' and t.active_status='active' and t.active is not false
 and (array[p.role::text]||coalesce(p.roles::text[],'{}'))&&array(select jsonb_array_elements_text(src->'row'->'audience')) loop
  perform snacky_notice_private.emit('company',new.id,person.id,'published',coalesce(nullif(src->'row'->>'title_ar',''),src->'row'->>'title_en'),src->>'href');
 end loop;
 return new;
end $$;

-- Install on all real assignment modules; optional modules are not created here.
do $$declare x record;begin
 for x in select * from (values
 ('route','public','routes'),('lead','public','location_pipeline_leads'),('issue','public','issues'),
 ('task','public','crm_tasks'),('location','public','location_relationships'),('obligation','public','location_admin_obligations'),
 ('routine','crm_automation_private','routines'),('instruction','public','operator_instructions'))v(k,s,t) loop
 if to_regclass(format('%I.%I',x.s,x.t)) is not null then
  execute format('drop trigger if exists snacky_assignment_notice on %I.%I',x.s,x.t);
  execute format('create trigger snacky_assignment_notice after insert or update on %I.%I for each row execute function snacky_notice_private.assignment_changed(%L)',x.s,x.t,x.k);
 end if;end loop;
 if to_regclass('company_private.items') is not null then
  execute 'drop trigger if exists snacky_company_notice on company_private.items';
  execute 'create trigger snacky_company_notice after insert or update on company_private.items for each row execute function snacky_notice_private.company_published()';
 end if;
end $$;

create or replace function snacky_notice_private.eligible(n public.notifications) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare s jsonb;roles text[];creator uuid;
begin
 if snacky_notice_private.member_user(n.recipient_member_id) is distinct from n.user_id then return false;end if;
 select array[p.role::text]||coalesce(p.roles::text[],'{}') into roles from public.profiles p where id=n.user_id;
 s:=snacky_notice_private.source(n.source_kind,n.source_id);if s is null then return false;end if;
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
end $$;

create or replace function public.snacky_notification_delivery_mode_v1() returns boolean
language sql stable security definer set search_path='' as $$select activated_at is not null from snacky_notice_private.settings where singleton$$;
create or replace function public.snacky_notification_worker_start_v1(p_token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cfg snacky_notice_private.settings;
begin
 if p_token is null or p_token!~'^[a-f0-9]{64}$' then return jsonb_build_object('authorized',false);end if;
 select * into cfg from snacky_notice_private.settings where singleton for update;
 if cfg.token_hash is null or cfg.token_hash<>encode(sha256(convert_to(p_token,'UTF8')),'hex') then return jsonb_build_object('authorized',false);end if;
 -- First callback is the deployment handshake. Later administrative pauses persist.
 update snacky_notice_private.settings set enabled=case when activated_at is null then true else enabled end,activated_at=coalesce(activated_at,now()),last_worker_at=now() where singleton returning * into cfg;
 return jsonb_build_object('authorized',true,'enabled',cfg.enabled);
end $$;
create or replace function public.snacky_claim_notification_deliveries_v1(p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from snacky_notice_private.settings where enabled) then return '[]';end if;
 update snacky_notice_private.deliveries d set status='skipped',last_error='expired_or_no_longer_assigned',lease_id=null,lease_until=null
 from public.notifications n,public.push_subscriptions s
 where d.notification_id=n.id and s.id=d.subscription_id and d.status in ('queued','retry','sending')
 and (n.created_at<now()-interval '24 hours' or not s.is_active or s.user_id<>n.user_id or not coalesce(snacky_notice_private.eligible(n),false));
 update snacky_notice_private.deliveries set status='failed',last_error='retry_limit_reached',lease_id=null,lease_until=null
 where status='sending' and lease_until<now() and attempts>=5;
 with candidates as (
 select id from snacky_notice_private.deliveries where attempts<5 and ((status in ('queued','retry') and available_at<=now()) or (status='sending' and lease_until<now()))
 order by available_at,id for update skip locked limit greatest(1,least(coalesce(p_limit,20),50))
 ),claimed as (
 update snacky_notice_private.deliveries d set status='sending',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes'
 from candidates c where c.id=d.id returning d.id,d.lease_id)
 select coalesce(jsonb_agg(to_jsonb(claimed)),'[]') into result from claimed;
 return result;
end $$;
create or replace function public.snacky_notification_delivery_payload_v1(p_id uuid,p_lease uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('subscription',jsonb_build_object('id',s.id,'endpoint',s.endpoint,'p256dh',s.p256dh,'auth',s.auth,'is_active',s.is_active),
 'payload',jsonb_build_object('notificationId',n.id,'type',n.type,'title',case when s.locale='ar' then coalesce(n.title_ar,n.title) else n.title end,
 'body',case when s.locale='ar' then coalesce(n.message_ar,n.message) else n.message end,'url',n.action_url,'lang',s.locale,'dir',case when s.locale='ar' then 'rtl' else 'ltr' end))
 from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id join public.push_subscriptions s on s.id=d.subscription_id
 where d.id=p_id and d.lease_id=p_lease and d.status='sending' and d.lease_until>now() and s.is_active and s.user_id=n.user_id
 and n.created_at>now()-interval '24 hours' and snacky_notice_private.eligible(n) and exists(select 1 from snacky_notice_private.settings where enabled);
$$;
create or replace function public.snacky_finish_notification_delivery_v1(p_id uuid,p_lease uuid,p_result text,p_error text default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
 if p_result not in ('accepted','retry','skipped','failed') then raise exception 'Invalid notification outcome';end if;
 update snacky_notice_private.deliveries set status=case when p_result='retry' and attempts>=5 then 'failed' else p_result end,
 available_at=now()+make_interval(secs=>least(900,power(2,attempts)::integer*15)),accepted_at=case when p_result='accepted' then now() else null end,
 last_error=case when p_error~'^[a-z0-9_]{1,80}$' then p_error else null end,lease_id=null,lease_until=null
 where id=p_id and lease_id=p_lease and status='sending' returning id into changed;
 return changed is not null;
end $$;
create or replace function public.snacky_notification_health_v1() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',c.enabled,'worker_recent',c.last_worker_at>now()-interval '3 minutes',
 'pending',(select count(*) from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.user_id=auth.uid() and d.status in ('queued','sending','retry')),
 'failed',(select count(*) from snacky_notice_private.deliveries d join public.notifications n on n.id=d.notification_id where n.user_id=auth.uid() and d.status='failed'))
 from snacky_notice_private.settings c where singleton and exists(select 1 from public.profiles where id=auth.uid() and active_status='active');
$$;
revoke all on all functions in schema snacky_notice_private from public,anon,authenticated;
revoke all on function public.snacky_notification_delivery_mode_v1(),public.snacky_notification_worker_start_v1(text),public.snacky_claim_notification_deliveries_v1(integer),public.snacky_notification_delivery_payload_v1(uuid,uuid),public.snacky_finish_notification_delivery_v1(uuid,uuid,text,text),public.snacky_notification_health_v1() from public,anon,authenticated;
grant execute on function public.snacky_notification_delivery_mode_v1(),public.snacky_notification_worker_start_v1(text),public.snacky_claim_notification_deliveries_v1(integer),public.snacky_notification_delivery_payload_v1(uuid,uuid),public.snacky_finish_notification_delivery_v1(uuid,uuid,text,text),public.snacky_notification_health_v1() to service_role;
grant execute on function public.snacky_notification_delivery_mode_v1(),public.snacky_notification_health_v1() to authenticated;
select pg_notify('pgrst','reload schema');
