-- Filename generated earlier by Supabase CLI. Additive; no live rules/jobs seeded.
-- Existing task, route, cash, inventory and payment command functions stay unchanged.
set lock_timeout = '3s';
set statement_timeout = '45s';
do $$begin
 if to_regprocedure('public.snacky_crm_workspace_v1(text,uuid,jsonb)') is null
 or to_regprocedure('public.snacky_crm_command_v1(uuid,text,uuid,jsonb)') is null then
  raise exception 'Install the connected-relations release before recurring work.' using errcode='55000';
 end if;
end $$;
create schema crm_automation_private;
revoke all on schema crm_automation_private from public,anon;
grant usage on schema crm_automation_private to authenticated;
create table crm_automation_private.settings (
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 last_attempt_at timestamptz,last_success_at timestamptz,last_result jsonb,
 updated_by uuid references public.team_members(id), updated_at timestamptz not null default now()
);
insert into crm_automation_private.settings(singleton) values(true);
create table crm_automation_private.routines (
 id uuid primary key, title text not null check(length(trim(title)) between 1 and 240),
 instructions text not null default '' check(length(instructions)<=4000),
 target_kind text not null check(target_kind in ('none','lead','location','issue','obligation')),
 target_id uuid, assigned_to uuid not null references public.team_members(id) on delete restrict,
 cadence text not null check(cadence in ('days','weeks','months')),
 every integer not null check(every between 1 and 365),
 start_on date not null, end_on date, next_due_on date not null,
 notice_days integer not null default 0 check(notice_days between 0 and 30),
 paused boolean not null default true, revision integer not null default 1,
 created_by uuid not null references public.team_members(id) on delete restrict,
 updated_by uuid not null references public.team_members(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 last_checked_at timestamptz,blocked_reason text,
 check((target_kind='none')=(target_id is null)),check(end_on is null or end_on>=start_on),
 check(start_on between date '2000-01-01' and date '2100-12-31'),
 check(end_on is null or end_on<=date '2100-12-31'),check(revision>0)
);
create table crm_automation_private.occurrences (
 routine_id uuid not null references crm_automation_private.routines(id) on delete restrict,
 due_on date not null, task_id uuid not null unique references public.crm_tasks(id) on delete restrict,
 skipped_cycles integer not null default 0 check(skipped_cycles>=0),
 generated_at timestamptz not null default now(),primary key(routine_id,due_on)
);
create table crm_automation_private.receipts (
 id uuid primary key, actor uuid not null references auth.users(id) on delete restrict,
 request jsonb not null,response jsonb not null,created_at timestamptz not null default now()
);
do $$declare t text;begin
 foreach t in array array['settings','routines','occurrences','receipts'] loop
  execute format('alter table crm_automation_private.%I enable row level security',t);
  execute format('revoke all on crm_automation_private.%I from public,anon,authenticated',t);
 end loop;
end $$;
create index crm_routines_due on crm_automation_private.routines(next_due_on,last_checked_at) where not paused;

create function crm_automation_private.member_roles(m uuid) returns text[]
language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(distinct r),'{}'::text[])
 from public.team_members t join public.profiles p on p.team_member_id=t.id,
 lateral unnest(coalesce(p.roles::text[],'{}')||array[p.role::text]||coalesce(t.roles::text[],'{}')||array[t.role::text]) r
 where t.id=m and t.active is not false and t.active_status='active' and p.active_status='active';
$$;
create function crm_automation_private.manager() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and public.snacky_current_profile_has_any_role(array['owner','admin','supervisor'])
 and crm_automation_private.member_roles(public.snacky_current_team_member_id())&&array['owner','admin','supervisor'];
$$;
-- Schedules never widen an assignee's access to a source record.
create function crm_automation_private.can_follow(m uuid,k text,i uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare roles text[]:=crm_automation_private.member_roles(m);manage boolean;
begin
 if not roles&&array['owner','admin','supervisor','crm'] then return false;end if;
 manage:=roles&&array['owner','admin','supervisor'];
 if k='none' then return i is null;
 elsif k='lead' then return exists(select 1 from public.location_pipeline_leads where id=i and not is_archived and not is_practice and status not in ('rejected','accepted','machine_placed') and (manage or assigned_to_user_id=m or (assigned_to_user_id is null and created_by_member_id=m)));
 elsif k='location' then return exists(select 1 from public.locations l left join public.location_relationships r on r.location_id=l.id where l.id=i and l.status not in ('archived','inactive') and (manage or r.assigned_to=m));
 elsif k='issue' then return exists(select 1 from public.issues where id=i and archived_at is null and not is_practice and status not in ('resolved','closed') and (manage or assigned_to=m));
 elsif k='obligation' then return exists(select 1 from public.location_admin_obligations where id=i and not is_practice and status not in ('cancelled','not_applicable') and finance_verified_at is null and (manage or assigned_to=m));
 end if;return false;
end $$;
-- Re-anchor monthly dates to the ORIGINAL day: Jan 31 -> Feb 28 -> Mar 31.
create function crm_automation_private.next_date(d date,c text,n integer,anchor date) returns date
language plpgsql immutable set search_path='' as $$
declare first_day date;last_day date;
begin
 if n not between 1 and 365 or c not in ('days','weeks','months') then raise exception 'Invalid recurrence' using errcode='22023';end if;
 if c='days' then return d+n;elsif c='weeks' then return d+7*n;end if;
 first_day:=(date_trunc('month',d)+make_interval(months=>n))::date;
 last_day:=(first_day+interval '1 month - 1 day')::date;
 return first_day+least(extract(day from anchor)::int,extract(day from last_day)::int)-1;
end $$;
create function crm_automation_private.audit(i uuid,a text,b jsonb,c jsonb) returns void
language sql security definer set search_path='' as $$
 insert into public.system_activity_logs(actor_user_id,actor_team_member_id,actor_name,action,entity_type,entity_id,summary,before_data,after_data,metadata)
 values(auth.uid(),public.snacky_current_team_member_id(),case when auth.uid() is null then 'Snacky scheduler' else (select full_name from public.team_members where id=public.snacky_current_team_member_id()) end,
 a,'crm_routine',i,a,b,c,'{"origin":"crm_recurring_management"}');
$$;
create function crm_automation_private.command(request_id uuid,action text,item_id uuid,expected_revision integer,p jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=public.snacky_current_team_member_id();old crm_automation_private.routines;newrow crm_automation_private.routines;
 receipt crm_automation_private.receipts;req jsonb;answer jsonb;today date:=(now() at time zone 'Africa/Tripoli')::date;
begin
 if not crm_automation_private.manager() then raise exception 'Active management access required' using errcode='42501';end if;
 if request_id is null or item_id is null or action not in ('save','pause','resume','engine.pause','engine.resume') or jsonb_typeof(p) is distinct from 'object' or octet_length(p::text)>16000 then raise exception 'Invalid request' using errcode='22023';end if;
 req:=jsonb_build_object('action',action,'id',item_id,'revision',expected_revision,'payload',p);
 perform pg_advisory_xact_lock(hashtextextended('crm-routine-command:'||request_id::text,0));
 select * into receipt from crm_automation_private.receipts where id=request_id;
 if found then
  if receipt.actor<>auth.uid() or receipt.request<>req then raise exception 'Request identity conflict' using errcode='23505';end if;
  return receipt.response;
 end if;
 if action like 'engine.%' then
  if not public.snacky_current_profile_has_any_role(array['owner','admin']) then raise exception 'Owner/admin only' using errcode='42501';end if;
  update crm_automation_private.settings set enabled=(action='engine.resume'),updated_by=me,updated_at=now() where singleton;
  perform crm_automation_private.audit(item_id,action,null,jsonb_build_object('enabled',action='engine.resume'));
  answer:=jsonb_build_object('id',item_id,'request_id',request_id);
 else
  select * into old from crm_automation_private.routines where id=item_id for update;
  if (old.id is null and (action<>'save' or expected_revision is distinct from 0)) or (old.id is not null and old.revision is distinct from expected_revision) then raise exception 'Record changed. Reload before editing.' using errcode='40001';end if;
  if action='save' then
   if p-array['title','instructions','target_kind','target_id','assigned_to','cadence','every','start_on','end_on','notice_days']<>'{}' then raise exception 'Unsupported fields' using errcode='22023';end if;
   if (select count(*) from jsonb_object_keys(p))<>10 then raise exception 'Complete all schedule fields' using errcode='22023';end if;
   newrow:=old;
   newrow.id:=item_id;newrow.title:=trim(p->>'title');newrow.instructions:=coalesce(p->>'instructions','');
   newrow.target_kind:=p->>'target_kind';newrow.target_id:=nullif(p->>'target_id','')::uuid;newrow.assigned_to:=(p->>'assigned_to')::uuid;
   newrow.cadence:=p->>'cadence';newrow.every:=(p->>'every')::integer;
   newrow.start_on:=(p->>'start_on')::date;newrow.end_on:=nullif(p->>'end_on','')::date;newrow.notice_days:=(p->>'notice_days')::integer;
   if newrow.title is null or length(newrow.title) not between 1 and 240 or length(newrow.instructions)>4000 or newrow.cadence not in ('days','weeks','months') or newrow.every not between 1 and 365 or newrow.notice_days not between 0 and 30 then raise exception 'Invalid schedule fields' using errcode='22023';end if;
   if newrow.start_on is null or (old.id is null and newrow.start_on<today) or newrow.start_on not between date '2000-01-01' and date '2100-12-31' or (newrow.end_on is not null and newrow.end_on<newrow.start_on) then raise exception 'Invalid start/end date' using errcode='22023';end if;
   if not crm_automation_private.can_follow(newrow.assigned_to,newrow.target_kind,newrow.target_id) then raise exception 'Choose an active relations employee with ownership of this open record' using errcode='22023';end if;
   if exists(select 1 from crm_automation_private.occurrences where routine_id=item_id) and
    (old.cadence,old.every,old.start_on,old.target_kind,old.target_id) is distinct from (newrow.cadence,newrow.every,newrow.start_on,newrow.target_kind,newrow.target_id) then
    raise exception 'Keep the history: pause this routine and create another to change its schedule or source' using errcode='22023';end if;
   if old.id is null then
    insert into crm_automation_private.routines(id,title,instructions,target_kind,target_id,assigned_to,cadence,every,start_on,end_on,next_due_on,notice_days,created_by,updated_by)
    values(item_id,newrow.title,newrow.instructions,newrow.target_kind,newrow.target_id,newrow.assigned_to,newrow.cadence,newrow.every,newrow.start_on,newrow.end_on,newrow.start_on,newrow.notice_days,me,me) returning * into newrow;
   else
    update crm_automation_private.routines set title=newrow.title,instructions=newrow.instructions,target_kind=newrow.target_kind,target_id=newrow.target_id,assigned_to=newrow.assigned_to,
     cadence=newrow.cadence,every=newrow.every,start_on=newrow.start_on,end_on=newrow.end_on,notice_days=newrow.notice_days,
     next_due_on=case when (old.start_on,old.cadence,old.every) is distinct from (newrow.start_on,newrow.cadence,newrow.every) then newrow.start_on else next_due_on end,
     revision=revision+1,updated_at=now(),updated_by=me,blocked_reason=null where id=item_id returning * into newrow;
   end if;
  else
   if action='resume' and not crm_automation_private.can_follow(old.assigned_to,old.target_kind,old.target_id) then raise exception 'The assignee or source is unavailable; review the routine first' using errcode='22023';end if;
   update crm_automation_private.routines set paused=(action='pause'),revision=revision+1,updated_at=now(),updated_by=me,blocked_reason=null where id=item_id returning * into newrow;
  end if;
  perform crm_automation_private.audit(item_id,'routine.'||action,case when old.id is not null then to_jsonb(old) end,to_jsonb(newrow));
  answer:=jsonb_build_object('id',item_id,'request_id',request_id,'revision',newrow.revision);
 end if;
 insert into crm_automation_private.receipts(id,actor,request,response) values(request_id,auth.uid(),req,answer);
 return answer;
end $$;
-- Only a database job/operator can invoke this worker. No browser/public RPC grant.
create function crm_automation_private.tick(p_now timestamptz default clock_timestamp()) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r crm_automation_private.routines;today date:=(p_now at time zone 'Africa/Tripoli')::date;
 due date;following date;task uuid;skipped integer;made integer:=0;blocked integer:=0;errors integer:=0;result jsonb;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('snacky-crm-recurring-worker',0)) then return '{"busy":true}';end if;
 if not (select enabled from crm_automation_private.settings where singleton) then return '{"disabled":true}';end if;
 update crm_automation_private.settings set last_attempt_at=p_now where singleton;
 for r in select * from crm_automation_private.routines where not paused and next_due_on<=today+notice_days and (end_on is null or next_due_on<=end_on)
  order by last_checked_at nulls first,next_due_on,id limit 200 for update skip locked loop
  begin
   update crm_automation_private.routines set last_checked_at=p_now where id=r.id;
   if not crm_automation_private.can_follow(r.assigned_to,r.target_kind,r.target_id) then
    update crm_automation_private.routines set blocked_reason='source_or_assignee_unavailable' where id=r.id;blocked:=blocked+1;continue;
   end if;
   if exists(select 1 from crm_automation_private.occurrences o join public.crm_tasks t on t.id=o.task_id where o.routine_id=r.id and t.status<>'completed' and t.archived_at is null) then
    update crm_automation_private.routines set blocked_reason='unfinished_followup' where id=r.id;blocked:=blocked+1;continue;
   end if;
   due:=r.next_due_on;skipped:=0;
   -- A delayed scheduler emits one actionable catch-up, not hundreds of old tasks.
   loop
    following:=crm_automation_private.next_date(due,r.cadence,r.every,r.start_on);
    exit when following>today or (r.end_on is not null and following>r.end_on);
    due:=following;skipped:=skipped+1;
    if skipped>37000 then raise exception 'Schedule bound exceeded';end if;
   end loop;
   insert into public.crm_tasks(title,notes,task_type,assigned_to,due_date,lead_id,location_id,issue_id,obligation_id,priority,is_practice)
   values(r.title,r.instructions||E'\n\nRecurring responsibility / مسؤولية دورية','follow_up',r.assigned_to,due,
    case when r.target_kind='lead' then r.target_id end,case when r.target_kind='location' then r.target_id end,
    case when r.target_kind='issue' then r.target_id end,case when r.target_kind='obligation' then r.target_id end,'normal',false) returning id into task;
   insert into crm_automation_private.occurrences(routine_id,due_on,task_id,skipped_cycles,generated_at) values(r.id,due,task,skipped,p_now);
   update crm_automation_private.routines set next_due_on=following,blocked_reason=null where id=r.id;
   made:=made+1;
  exception when others then
   -- Subtransaction rolls back both the task AND occurrence, never a half-save.
   update crm_automation_private.routines set last_checked_at=p_now,blocked_reason='generation_error:'||sqlstate where id=r.id;errors:=errors+1;
  end;
 end loop;
 result:=jsonb_build_object('generated',made,'blocked',blocked,'errors',errors,'checked_at',p_now);
 update crm_automation_private.settings set last_result=result,last_success_at=case when errors=0 then p_now else last_success_at end where singleton;
 return result;
end $$;

create function crm_automation_private.workspace(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare offset_rows integer:=greatest(0,least(100000,coalesce((p_filters->>'offset')::int,0)));rows jsonb;total integer;directory jsonb;targets jsonb;scheduled boolean:=false;
begin
 if not crm_automation_private.manager() then raise exception 'Active management access required' using errcode='42501';end if;
 with selected as (select r.*,t.full_name as assigned_name,
  (select title from public.crm_record_index x where x.id=r.target_id and x.kind=r.target_kind) as target_title,
  (select jsonb_agg(v) from (select o.due_on,o.task_id,o.skipped_cycles,t.status,t.archived_at,t.assigned_to,(select full_name from public.team_members where id=t.assigned_to) as assigned_name from crm_automation_private.occurrences o join public.crm_tasks t on t.id=o.task_id where o.routine_id=r.id order by o.due_on desc limit 5) v) as recent_work
  from crm_automation_private.routines r join public.team_members t on t.id=r.assigned_to
  where (coalesce(p_filters->>'q','')='' or position(lower(p_filters->>'q') in lower(r.title))>0)
  and (coalesce(p_filters->>'state','')='' or (p_filters->>'state'='paused' and r.paused) or (p_filters->>'state'='active' and not r.paused)))
 select (select count(*) from selected),coalesce((select jsonb_agg(v) from (select * from selected order by created_at desc,id limit 20 offset offset_rows) v),'[]') into total,rows;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name) order by full_name),'[]') into directory from public.team_members where crm_automation_private.member_roles(id)&&array['owner','admin','supervisor','crm'];
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'title',title,'assigned_to',assigned_to) order by kind,title),'[]') into targets from public.crm_record_index
 where kind in ('lead','location','issue','obligation') and not archived and not is_practice and status not in ('completed','resolved','closed','not_applicable','cancelled','rejected','machine_placed','accepted');
 if to_regclass('cron.job') is not null then execute $q$select exists(select 1 from cron.job where jobname='snacky-crm-recurring' and active and command='select crm_automation_private.tick();')$q$ into scheduled;end if;
 return jsonb_build_object('rows',rows,'total',total,'offset',offset_rows,'directory',directory,'targets',targets,'today',(now() at time zone 'Africa/Tripoli')::date,'engine',(select to_jsonb(s) from crm_automation_private.settings s where singleton),'scheduled',scheduled);
end $$;
create function crm_automation_private.overview(p_filters jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare today date:=(now() at time zone 'Africa/Tripoli')::date;period integer:=coalesce((p_filters->>'days')::int,7);starts timestamptz;ends timestamptz;
 mode text:=coalesce(p_filters->>'focus','attention');employee uuid:=nullif(p_filters->>'employee','')::uuid;off int:=greatest(0,least(100000,coalesce((p_filters->>'offset')::int,0)));
 cards jsonb;queue jsonb;activity jsonb;total int;metrics jsonb;people jsonb;
begin
 if not crm_automation_private.manager() then raise exception 'Active management access required' using errcode='42501';end if;
 if period not in (1,7,30) or mode not in ('attention','overdue','unowned','waiting','customer','rent','management') then raise exception 'Invalid filters' using errcode='22023';end if;
 starts:=(today-(period-1))::timestamp at time zone 'Africa/Tripoli';ends:=(today+1)::timestamp at time zone 'Africa/Tripoli';
 with records as (
  select x.*,
   (due_date<today or (due_date=today and due_time<(now() at time zone 'Africa/Tripoli')::time)) as overdue,
   (assigned_to is null or (kind in ('lead','location','issue') and (due_date is null or nullif(trim(next_action),'') is null))) as unowned,
   (kind='issue' and status='waiting' and (due_date is null or due_date<=today)) as waiting,
   (kind='issue' and data->>'field_completed_at' is not null) as customer,
   (kind='obligation' and ((status='open' and due_date<=today+7) or (status='paid' and data->>'finance_verified_at' is null))) as rent,
   (kind='task' and crm_automation_private.member_roles(assigned_to)&&array['owner','admin','supervisor']) as management
  from public.crm_record_index x where not archived and not is_practice and kind in ('lead','location','issue','task','obligation')
  and status not in ('completed','resolved','closed','not_applicable','cancelled','rejected','machine_placed','accepted')
  and not(kind='obligation' and data->>'finance_verified_at' is not null)
  and (employee is null or assigned_to=employee)
 ),selected as (
  select * from records where case mode when 'overdue' then overdue when 'unowned' then unowned when 'waiting' then waiting when 'customer' then customer when 'rent' then rent when 'management' then management else overdue or unowned or waiting or customer or rent or management end
 ) select (select jsonb_build_object('overdue',count(*) filter(where overdue),'unowned',count(*) filter(where unowned),'waiting',count(*) filter(where waiting),'customer',count(*) filter(where customer),'rent',count(*) filter(where rent),'management',count(*) filter(where management)) from records),
  (select count(*) from selected),coalesce((select jsonb_agg(v) from (select s.kind,s.id,s.title,s.status,s.due_date,s.next_action,s.assigned_to,t.full_name as assigned_name,s.overdue,s.unowned,s.waiting,s.customer,s.rent,s.management,s.location_name from selected s left join public.team_members t on t.id=s.assigned_to order by s.overdue desc nulls last,s.due_date nulls last,s.id limit 30 offset off)v),'[]') into cards,total,queue;
 select jsonb_build_object(
  'leads_contacted',(select count(distinct a.lead_id) from public.crm_activities a join public.location_pipeline_leads l on l.id=a.lead_id where not l.is_practice and a.activity_type in ('call','whatsapp','email','visit') and a.occurred_at>=starts and a.occurred_at<ends and (employee is null or a.actor_id=employee)),
  'visits',(select count(*) from public.crm_activities a join public.location_pipeline_leads l on l.id=a.lead_id where not l.is_practice and a.activity_type='visit' and a.occurred_at>=starts and a.occurred_at<ends and (employee is null or a.actor_id=employee)),
  'tasks_completed',(select count(*) from public.crm_tasks t where not t.is_practice and t.status='completed' and t.completed_at>=starts and t.completed_at<ends and (employee is null or t.completed_by=employee)),
  'issues_resolved',(select count(*) from public.issues i where not i.is_practice and i.status in ('resolved','closed') and i.resolved_at>=starts and i.resolved_at<ends and (employee is null or i.resolved_by=employee))) into metrics;
 select coalesce(jsonb_agg(v),'[]') into activity from (select a.id,a.activity_type,a.summary,a.actor_name,a.occurred_at,
  case when a.task_id is not null then 'task' when a.obligation_id is not null then 'obligation' when a.issue_id is not null then 'issue' when a.lead_id is not null then 'lead' when a.contact_id is not null then 'contact' else 'location' end as kind,
  coalesce(a.task_id,a.obligation_id,a.issue_id,a.lead_id,a.contact_id,a.location_id) as record_id
  from public.crm_activities a where a.occurred_at>=starts and a.occurred_at<ends and (employee is null or a.actor_id=employee)
   and public.snacky_crm_activity_visible(a.task_id,a.obligation_id,a.issue_id,a.lead_id,a.contact_id,a.location_id)
   and not exists(select 1 from public.crm_record_index x where x.is_practice and x.id=any(array[a.task_id,a.obligation_id,a.issue_id,a.lead_id]))
  order by a.occurred_at desc,a.id desc limit 20)v;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name) order by full_name),'[]') into people from public.team_members where active is not false and active_status='active' and (role::text=any(array['owner','admin','supervisor','crm','operator']) or roles::text[]&&array['owner','admin','supervisor','crm','operator']);
 return jsonb_build_object('today',today,'days',period,'metrics',metrics,'cards',cards,'queue',queue,'total',total,'offset',off,'activity',activity,'people',people);
end $$;
create function public.snacky_crm_routines_v1(p_filters jsonb default '{}') returns jsonb language sql stable security invoker set search_path='' as $$select crm_automation_private.workspace(p_filters);$$;
create function public.snacky_crm_routine_command_v1(p_request_id uuid,p_action text,p_id uuid,p_revision integer,p_payload jsonb default '{}') returns jsonb language sql security invoker set search_path='' as $$select crm_automation_private.command(p_request_id,p_action,p_id,p_revision,p_payload);$$;
create function public.snacky_crm_management_v2(p_filters jsonb default '{}') returns jsonb language sql stable security invoker set search_path='' as $$select crm_automation_private.overview(p_filters);$$;
revoke all on all functions in schema crm_automation_private from public,anon,authenticated;
grant execute on function crm_automation_private.workspace(jsonb),crm_automation_private.command(uuid,text,uuid,integer,jsonb),crm_automation_private.overview(jsonb) to authenticated;
revoke all on function public.snacky_crm_routines_v1(jsonb),public.snacky_crm_routine_command_v1(uuid,text,uuid,integer,jsonb),public.snacky_crm_management_v2(jsonb) from public,anon;
grant execute on function public.snacky_crm_routines_v1(jsonb),public.snacky_crm_routine_command_v1(uuid,text,uuid,integer,jsonb),public.snacky_crm_management_v2(jsonb) to authenticated;
notify pgrst,'reload schema';
reset lock_timeout;
reset statement_timeout;
