-- Filename generated with Supabase CLI 2.117.0. Focus metadata only: no new leads/tasks seeded.
-- Native lead/task/stock/cash/route writers and the original CRM read remain unchanged.
set lock_timeout='3s';
set statement_timeout='45s';
create schema crm_lead_private;
revoke all on schema crm_lead_private from public,anon;
grant usage on schema crm_lead_private to authenticated;
create table crm_lead_private.focus (
 lead_id uuid primary key references public.location_pipeline_leads(id) on delete restrict,
 starts_on date not null, ends_on date not null check(ends_on>=starts_on),
 removed_at timestamptz, revision integer not null check(revision>0),
 updated_by uuid not null references public.team_members(id) on delete restrict,
 updated_at timestamptz not null default now()
);
create table crm_lead_private.receipts (
 id uuid primary key, actor uuid not null references auth.users(id) on delete restrict,
 request jsonb not null, response jsonb not null, created_at timestamptz not null default now()
);
alter table crm_lead_private.focus enable row level security;
alter table crm_lead_private.receipts enable row level security;
revoke all on all tables in schema crm_lead_private from public,anon,authenticated;
create function crm_lead_private.staff() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and public.snacky_crm_staff() and exists(
  select 1 from public.team_members t join public.profiles p on p.team_member_id=t.id
  where p.id=auth.uid() and p.active_status='active' and t.active and t.active_status='active');
$$;
create function crm_lead_private.assignee(m uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.team_members t join public.profiles p on p.team_member_id=t.id
 where t.id=m and t.active and t.active_status='active' and p.active_status='active'
 and (coalesce(t.roles::text[],'{}')||array[t.role::text]||coalesce(p.roles::text[],'{}')||array[p.role::text])&&array['owner','admin','supervisor','crm']);
$$;
create function crm_lead_private.command(p_request_id uuid,p_action text,p_items jsonb,p_assigned_to uuid,p_until date,p_next_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=public.snacky_current_team_member_id();today date:=(now() at time zone 'Africa/Tripoli')::date;
 receipt crm_lead_private.receipts; previous crm_lead_private.focus; lead public.location_pipeline_leads;
 entry jsonb; req jsonb; answer jsonb; ids uuid[]:='{}'; result jsonb; step text;
begin
 if not crm_lead_private.staff() or not public.snacky_crm_manager() then raise exception 'Active management access required' using errcode='42501';end if;
 if p_request_id is null or p_action not in ('set','clear') or p_action is null or jsonb_typeof(p_items) is distinct from 'array' then raise exception 'Invalid focus request' using errcode='22023';end if;
 if jsonb_array_length(p_items) not between 1 and 20 or octet_length(p_items::text)>16000 then raise exception 'Select between 1 and 20 places' using errcode='22023';end if;
 for entry in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(entry) is distinct from 'object' or entry-array['id','version','focus_revision']<>'{}' or (select count(*) from jsonb_object_keys(entry))<>3
   or nullif(entry->>'id','') is null or jsonb_typeof(entry->'version') is distinct from 'string' or nullif(entry->>'version','') is null
   or jsonb_typeof(entry->'focus_revision') is distinct from 'number' or entry->>'focus_revision' !~ '^\d+$' then raise exception 'Invalid selected record' using errcode='22023';end if;
  ids:=array_append(ids,(entry->>'id')::uuid);
 end loop;
 if cardinality(ids)<>(select count(distinct v) from unnest(ids) v) then raise exception 'Repeated selection' using errcode='22023';end if;
 req:=jsonb_build_object('action',p_action,'items',p_items,'assigned_to',p_assigned_to,'until',p_until,'next_action',p_next_action);
 perform pg_advisory_xact_lock(hashtextextended('crm-lead-focus:'||p_request_id::text,0));
 select * into receipt from crm_lead_private.receipts where id=p_request_id;
 if found then
  if receipt.actor<>auth.uid() or receipt.request is distinct from req then raise exception 'Request changed' using errcode='23505';end if;
  return receipt.response;
 end if;
 if p_action='set' then
  if p_assigned_to is null or not crm_lead_private.assignee(p_assigned_to) or p_until is null or p_until<today or p_until>today+90 or length(coalesce(p_next_action,''))>1000 then raise exception 'Choose an active employee and a focus end within 90 days' using errcode='22023';end if;
 elsif p_assigned_to is not null or p_until is not null or nullif(p_next_action,'') is not null then raise exception 'Clearing focus does not reassign or reschedule work' using errcode='22023';end if;
 -- Canonical lock order; a failure on ANY selected row rolls back the WHOLE command.
 for entry in select value from jsonb_array_elements(p_items) order by value->>'id' loop
  select * into lead from public.location_pipeline_leads where id=(entry->>'id')::uuid for update;
  if lead.id is null or not public.snacky_crm_allowed('lead',lead.id,true) then raise exception 'Lead access denied' using errcode='42501';end if;
  select * into previous from crm_lead_private.focus where lead_id=lead.id for update;
  if entry->>'version' is distinct from lead.updated_at::text or (entry->>'focus_revision')::integer is distinct from coalesce(previous.revision,0) then raise exception 'A selected lead changed; reload before saving' using errcode='40001';end if;
  if p_action='set' then
   if lead.is_archived or lead.status in ('machine_placed','rejected') then raise exception 'Installed, declined or archived places cannot be active prospecting focus' using errcode='22023';end if;
   step:=coalesce(nullif(trim(p_next_action),''),nullif(trim(lead.next_action),''),'جمع بيانات المكان وصاحب القرار وتسجيل الخطوة القادمة');
   -- Reuse the audited native assignment writer. Do not silently move existing deadlines.
   result:=public.snacky_crm_command_v1(gen_random_uuid(),'lead.save',lead.id,jsonb_build_object('version',lead.updated_at::text,'assigned_to',p_assigned_to,'next_action',step,'next_action_date',coalesce(lead.next_action_date,p_until)));
   if result->>'id' is distinct from lead.id::text then raise exception 'Assignment not confirmed';end if;
   insert into crm_lead_private.focus(lead_id,starts_on,ends_on,removed_at,revision,updated_by)
   values(lead.id,today,p_until,null,1,me) on conflict(lead_id) do update set starts_on=today,ends_on=p_until,removed_at=null,revision=crm_lead_private.focus.revision+1,updated_by=me,updated_at=now();
  else
   if previous.lead_id is null then raise exception 'There is no focus to clear' using errcode='22023';end if;
   update crm_lead_private.focus set removed_at=now(),revision=revision+1,updated_by=me,updated_at=now() where lead_id=lead.id;
  end if;
  perform public.snacky_crm_emit('lead',lead.id,'focus_'||p_action,
   case when p_action='set' then 'تركيز محدد حتى '||p_until::text||' / Focus through '||p_until::text else 'تم إلغاء التركيز؛ تبقى المتابعة والمسؤول / Focus cleared; assignment and follow-up retained' end,
   case when previous.lead_id is not null then to_jsonb(previous) end,(select to_jsonb(f) from crm_lead_private.focus f where lead_id=lead.id));
 end loop;
 answer:=jsonb_build_object('request_id',p_request_id,'action',p_action,'count',cardinality(ids),'ids',to_jsonb(ids));
 insert into crm_lead_private.receipts(id,actor,request,response) values(p_request_id,auth.uid(),req,answer);
 return answer;
end $$;
create function crm_lead_private.workspace(p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare today date:=(now() at time zone 'Africa/Tripoli')::date;clock time:=(now() at time zone 'Africa/Tripoli')::time;
 me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();
 q text:=left(trim(coalesce(p_filters->>'q','')),200);scope text:=coalesce(p_filters->>'scope','all');win text:=coalesce(p_filters->>'window','all');
 segment text:=coalesce(p_filters->>'group','all');focus_only boolean:=coalesce(p_filters->>'focus','')='active';
 off integer:=greatest(0,least(100000,coalesce((p_filters->>'offset')::integer,0))); rows jsonb;total integer;directory jsonb;assignees jsonb;
begin
 if not crm_lead_private.staff() then raise exception 'Active customer-relations access required' using errcode='42501';end if;
 if jsonb_typeof(p_filters) is distinct from 'object' or segment not in ('all','active','agreed','installed','declined') or scope not in ('all','mine') or win not in ('all','today','overdue','week','completed','attention') then raise exception 'Invalid lead filters' using errcode='22023';end if;
 with permitted as (
  select r.*,t.full_name as assigned_name,coalesce(f.revision,0) as focus_revision,f.starts_on as focus_start,f.ends_on as focus_until,
   coalesce(f.removed_at is null and today between f.starts_on and f.ends_on and not r.archived and r.status not in ('machine_placed','rejected'),false) as focused,
   ((r.due_date<today or (r.due_date=today and r.due_time<clock)) and r.status not in ('machine_placed','rejected')) as overdue,
   case r.status when 'machine_placed' then 'installed' when 'rejected' then 'declined' when 'accepted' then 'agreed' else 'active' end as lifecycle,
   (nullif(trim(r.data->>'contact_person_name'),'') is null or coalesce(nullif(trim(r.data->>'contact_phone'),''),nullif(trim(r.data->>'contact_whatsapp'),''),nullif(trim(r.data->>'contact_email'),'')) is null) as needs_research
  from public.crm_record_index r left join public.team_members t on t.id=r.assigned_to left join crm_lead_private.focus f on f.lead_id=r.id
  where r.kind='lead' and public.snacky_crm_allowed('lead',r.id)
   and (not r.archived or coalesce((p_filters->>'archived')::boolean,false)) and (not r.is_practice or coalesce((p_filters->>'practice')::boolean,false))
   and (scope<>'mine' or r.assigned_to=me) and (nullif(p_filters->>'assigned_to','') is null or r.assigned_to=(p_filters->>'assigned_to')::uuid)
 ), filtered as (
  select * from permitted r where (segment='all' or (segment='active' and lifecycle in ('active','agreed')) or lifecycle=segment) and (not focus_only or focused)
   and (nullif(p_filters->>'status','') is null or r.status=p_filters->>'status')
   and (nullif(p_filters->>'type','') is null or r.data->>'place_type'=p_filters->>'type')
   and (nullif(p_filters->>'area','') is null or r.data->>'area'=p_filters->>'area')
   and (nullif(p_filters->>'created_from','') is null or r.created_at>=((p_filters->>'created_from')::date::timestamp at time zone 'Africa/Tripoli'))
   and (nullif(p_filters->>'created_to','') is null or r.created_at<(((p_filters->>'created_to')::date+1)::timestamp at time zone 'Africa/Tripoli'))
   and (q='' or r.search_text ilike '%'||q||'%' or (length(coalesce(public.snacky_crm_phone_key(q),''))>=7 and public.snacky_crm_phone_key(r.data->>'contact_phone')=public.snacky_crm_phone_key(q))
    or exists(select 1 from public.crm_activities a where a.lead_id=r.id and public.snacky_crm_activity_visible(a.task_id,a.obligation_id,a.issue_id,a.lead_id,a.contact_id,a.location_id) and a.summary ilike '%'||q||'%'))
   and (win='all' or (win='today' and r.due_date=today) or (win='overdue' and r.overdue) or (win='week' and r.due_date between today and today+6)
    or (win='completed' and lifecycle in ('installed','declined')) or (win='attention' and lifecycle in ('active','agreed') and (focused or overdue or due_date=today)))
 ), ranked as (
  select r.*,case when archived or is_practice then 8 when focused then 0 when overdue then 1 when lifecycle='agreed' then 2 when lifecycle='installed' then 6 when lifecycle='declined' then 7
   when due_date=today then 3 when priority in ('urgent','critical','high') then 4 else 5 end as importance from filtered r
 ), page as (
  select * from ranked order by importance,case when focused then focus_until end nulls last,due_date nulls last,updated_at desc,id limit 40 offset off
 ) select (select count(*) from ranked),coalesce((select jsonb_agg(to_jsonb(p)-array['search_text','importance'] order by importance,case when focused then focus_until end nulls last,due_date nulls last,updated_at desc,id) from page p),'[]') into total,rows;
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.full_name,'role',t.role) order by t.full_name),'[]') into directory from public.team_members t where t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm','operator') or t.roles::text[]&&array['owner','admin','supervisor','crm','operator']);
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.full_name) order by t.full_name),'[]') into assignees from public.team_members t where manager and crm_lead_private.assignee(t.id);
 return jsonb_build_object('me',me,'manager',manager,'staff',true,'today',today,'rows',rows,'total',total,'offset',off,'page_size',40,'directory',directory,'focus_assignees',assignees,'focus_ready',true);
end $$;
create function public.snacky_crm_lead_desk_v1(p_filters jsonb default '{}') returns jsonb language sql stable security invoker set search_path='' as $$select crm_lead_private.workspace(p_filters);$$;
create function public.snacky_crm_lead_focus_command_v1(p_request_id uuid,p_action text,p_items jsonb,p_assigned_to uuid default null,p_until date default null,p_next_action text default null) returns jsonb language sql security invoker set search_path='' as $$select crm_lead_private.command(p_request_id,p_action,p_items,p_assigned_to,p_until,p_next_action);$$;
revoke all on all functions in schema crm_lead_private from public,anon,authenticated;
grant execute on function crm_lead_private.workspace(jsonb),crm_lead_private.command(uuid,text,jsonb,uuid,date,text) to authenticated;
revoke all on function public.snacky_crm_lead_desk_v1(jsonb),public.snacky_crm_lead_focus_command_v1(uuid,text,jsonb,uuid,date,text) from public,anon;
grant execute on function public.snacky_crm_lead_desk_v1(jsonb),public.snacky_crm_lead_focus_command_v1(uuid,text,jsonb,uuid,date,text) to authenticated;
-- Extend only the known CRM RPC allowlist. Refuse an unexpected guard instead of replacing it.
do $patch$
declare original text:=pg_get_functiondef('public.snacky_crm_api_request_guard()'::regprocedure); anchor text:='''/rpc/snacky_company_file_access'') then return;end if;';
begin
 if position(anchor in original)=0 then raise exception 'Review the current CRM API guard before installing lead focus';end if;
 execute replace(original,anchor,'''/rpc/snacky_company_file_access'',''/rpc/snacky_crm_lead_desk_v1'',''/rpc/snacky_crm_lead_focus_command_v1'') then return;end if;');
end $patch$;
notify pgrst,'reload schema';
reset lock_timeout;
reset statement_timeout;
