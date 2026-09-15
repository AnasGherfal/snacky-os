-- A private projection, not a second copy of operational records.
create view public.crm_record_index as
select 'lead'::text as kind,l.id,l.place_name as title,concat_ws(' ',l.place_name,l.name_ar,l.contact_person_name,l.contact_phone,l.contact_whatsapp,l.contact_email,l.notes,l.area,l.attraction_notes) as search_text,
 l.converted_location_id as location_id,loc.name as location_name,null::uuid as machine_id,null::text as machine_name,
 l.status,l.priority,l.assigned_to_user_id as assigned_to,l.next_action,l.next_action_date as due_date,l.next_action_time as due_time,
 l.created_at,l.updated_at,l.is_practice,l.is_archived as archived,to_jsonb(l)||jsonb_build_object('version',l.updated_at::text) as data
from public.location_pipeline_leads l left join public.locations loc on loc.id=l.converted_location_id
union all
select 'issue',i.id,coalesce(nullif(i.description,''),i.issue_type),concat_ws(' ',i.customer_name,i.customer_phone,i.customer_whatsapp,i.description,i.issue_type,i.resolution,i.lane_number,m.name,loc.name),
 coalesce(i.location_id,m.location_id),loc.name,i.machine_id,m.name,case when i.status in ('resolved','closed') then 'resolved' when i.is_waiting then 'waiting' when i.status='assigned' then 'in_progress' else i.status::text end,
 i.priority::text,i.assigned_to,coalesce(i.next_action,'Follow up customer issue'),coalesce(i.next_action_date,(i.sla_due_at at time zone 'Africa/Tripoli')::date),null::time,
 i.created_at,i.updated_at,i.is_practice,i.archived_at is not null,to_jsonb(i)||jsonb_build_object('version',i.updated_at::text)
from public.issues i left join public.machines m on m.id=i.machine_id left join public.locations loc on loc.id=coalesce(i.location_id,m.location_id)
union all
select 'location',l.id,l.name,concat_ws(' ',l.name,l.address,l.contact_name,l.contact_phone,r.notes),l.id,l.name,null::uuid,null::text,l.status,'normal',r.assigned_to,r.next_action,r.next_action_date,r.next_action_time,
 l.created_at,coalesce(r.updated_at,l.updated_at),false,l.status='archived',jsonb_build_object('id',l.id,'name',l.name,'location_type',l.location_type,'address',l.address,'contact_name',l.contact_name,'contact_phone',l.contact_phone,'status',l.status,'contract_start',l.contract_start,'contract_end',l.contract_end,'rent_amount',l.rent_amount,'rent_type',l.rent_type,'relationship',to_jsonb(r),'version',r.updated_at::text)
from public.locations l left join public.location_relationships r on r.location_id=l.id
union all
select 'contact',c.id,c.name,concat_ws(' ',c.name,c.phone,c.whatsapp,c.email,c.organization,c.notes),null::uuid,c.organization,null::uuid,null::text,'active','normal',c.created_by,null::text,null::date,null::time,c.created_at,c.updated_at,false,c.archived_at is not null,to_jsonb(c)||jsonb_build_object('version',c.updated_at::text)
from public.crm_contacts c
union all
select 'task',t.id,t.title,concat_ws(' ',t.title,t.notes,t.result,l.place_name,i.description,loc.name,c.name),coalesce(t.location_id,i.location_id,m.location_id,o.location_id),loc.name,i.machine_id,m.name,t.status,t.priority,t.assigned_to,t.title,t.due_date,t.due_time,
 t.created_at,t.updated_at,t.is_practice,t.archived_at is not null,to_jsonb(t)||jsonb_build_object('version',t.updated_at::text,'related_title',coalesce(l.place_name,loc.name,c.name,i.description,o.title))
from public.crm_tasks t left join public.location_pipeline_leads l on l.id=t.lead_id left join public.issues i on i.id=t.issue_id left join public.machines m on m.id=i.machine_id left join public.location_admin_obligations o on o.id=t.obligation_id left join public.locations loc on loc.id=coalesce(t.location_id,i.location_id,m.location_id,o.location_id) left join public.crm_contacts c on c.id=t.contact_id
union all
select 'obligation',o.id,o.title,concat_ws(' ',o.title,o.notes,loc.name),o.location_id,loc.name,null::uuid,null::text,o.status,'normal',o.assigned_to,'Confirm location payment',o.due_date,null::time,
 o.created_at,o.updated_at,o.is_practice,o.status='cancelled',to_jsonb(o)||jsonb_build_object('version',o.updated_at::text)
from public.location_admin_obligations o join public.locations loc on loc.id=o.location_id;
revoke all on public.crm_record_index from public,anon,authenticated;

create or replace function public.snacky_crm_workspace_v1(p_section text,p_id uuid default null,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=public,pg_catalog as $$
declare me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();staff boolean:=public.snacky_crm_staff();owner_admin boolean:=public.snacky_current_profile_has_any_role(array['owner','admin']);
 day date:=(now() at time zone 'Africa/Tripoli')::date;clock time:=(now() at time zone 'Africa/Tripoli')::time;
 rows jsonb;counts jsonb;record jsonb;events jsonb;tasks jsonb;documents jsonb;contacts jsonb;related jsonb;machines jsonb;bonus jsonb;directory jsonb;options jsonb;
 q text:=left(trim(coalesce(p_filters->>'q','')),200);scope text:=coalesce(p_filters->>'scope','all');win text:=coalesce(p_filters->>'window','all');
 skip integer:=greatest(0,least(100000,coalesce((p_filters->>'offset')::integer,0)));total integer;source_leads uuid[];entity public.crm_record_index;
begin
 if me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then raise exception 'Active staff access required' using errcode='42501';end if;
 if p_section not in ('work','lead','issue','location','contact','task','obligation','search','management') then raise exception 'Unknown CRM section' using errcode='22023';end if;
 if not staff and p_section not in ('work','task','issue') then raise exception 'This section is not available to operators' using errcode='42501';end if;
 if p_section='management' and not manager then raise exception 'Management access required' using errcode='42501';end if;

 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.full_name,'role',t.role) order by t.full_name),'[]'::jsonb) into directory
 from public.team_members t where t.active and t.active_status='active' and (staff or t.id=me) and (t.role::text in ('owner','admin','supervisor','crm','operator') or t.roles::text[]&&array['owner','admin','supervisor','crm','operator']);
 if staff then
  options:=jsonb_build_object(
   'locations',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]'::jsonb) from public.locations where status<>'archived'),
   'machines',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'location_id',location_id,'status',status) order by name),'[]'::jsonb) from public.machines),
   'contacts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]'::jsonb) from public.crm_contacts where archived_at is null));
 else options:='{}'::jsonb;end if;

 if p_id is not null then
  if not public.snacky_crm_allowed(p_section,p_id) then raise exception 'Record unavailable or not assigned to you' using errcode='42501';end if;
  select * into entity from public.crm_record_index where kind=p_section and id=p_id;
  record:=to_jsonb(entity)-'search_text';
  if p_section='location' and not manager and entity.assigned_to is distinct from me then record:=jsonb_set(record,'{data}',(record->'data')-array['rent_amount','rent_type','contract_start','contract_end']);end if;
  record:=record||jsonb_build_object('can_edit',public.snacky_crm_allowed(p_section,p_id,true));
  source_leads:=case when p_section='location' then array(select id from public.location_pipeline_leads where converted_location_id=p_id and public.snacky_crm_allowed('lead',id)) else array[]::uuid[] end;
  select coalesce(jsonb_agg(e order by e.occurred_at desc),'[]'::jsonb) into events from (
   select id,activity_type,summary,actor_id,actor_name,occurred_at,before_data,after_data from public.crm_activities a
   where (case p_section when 'lead' then a.lead_id=p_id when 'issue' then a.issue_id=p_id when 'location' then (a.location_id=p_id or a.lead_id=any(source_leads)) when 'contact' then a.contact_id=p_id when 'obligation' then a.obligation_id=p_id when 'task' then a.task_id=p_id end)
   and (a.obligation_id is null or public.snacky_crm_allowed('obligation',a.obligation_id))
   order by occurred_at desc,id desc limit 100
  ) e;
  -- Preserve pre-existing lead activities; new note entries have a matching audit event.
  if p_section in ('lead','location') then
   events:=events||coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'activity_type',a.activity_type,'summary',a.summary,'actor_id',a.created_by_user_id,'actor_name',t.full_name,'occurred_at',a.occurred_at)) from public.location_pipeline_activities a left join public.team_members t on t.id=a.created_by_user_id where (a.lead_id=p_id or a.lead_id=any(source_leads)) and not exists(select 1 from public.crm_activities e where e.lead_id=a.lead_id and e.summary=a.summary and abs(extract(epoch from (e.created_at-a.created_at)))<5)), '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('version',t.updated_at::text) order by t.due_date,t.created_at),'[]'::jsonb) into tasks from public.crm_tasks t where (t.lead_id=p_id or t.issue_id=p_id or t.location_id=p_id or t.contact_id=p_id or t.obligation_id=p_id or t.lead_id=any(source_leads)) and public.snacky_crm_allowed('task',t.id);
  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at desc),'[]'::jsonb) into documents from public.crm_documents d where (d.lead_id=p_id or d.issue_id=p_id or d.location_id=p_id or d.contact_id=p_id or d.obligation_id=p_id or d.task_id=p_id or d.lead_id=any(source_leads));
  select coalesce(jsonb_agg(distinct to_jsonb(c)),'[]'::jsonb) into contacts from public.crm_contact_links x join public.crm_contacts c on c.id=x.contact_id where (x.lead_id=p_id or x.location_id=p_id or x.issue_id=p_id or x.lead_id=any(source_leads)) and staff;
  select coalesce(jsonb_agg(to_jsonb(r)-'search_text' order by r.updated_at desc),'[]'::jsonb) into related from public.crm_record_index r where (r.location_id=p_id or (p_section='contact' and r.id in (select coalesce(lead_id,location_id,issue_id) from public.crm_contact_links where contact_id=p_id))) and r.id<>p_id and public.snacky_crm_allowed(r.kind,r.id);
  if p_section in ('issue','location') then select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'machine_code',m.machine_code,'status',m.status,'online_status',m.vms_online_status,'last_status_at',m.last_vms_status_at,'installed_date',m.installed_date)),'[]'::jsonb) into machines from public.machines m where (p_section='location' and m.location_id=p_id) or (p_section='issue' and m.id=entity.machine_id);end if;
  if p_section='lead' and owner_admin then select to_jsonb(b) into bonus from public.crm_lead_bonus b where lead_id=p_id;end if;
  return jsonb_build_object('me',me,'manager',manager,'owner_admin',owner_admin,'staff',staff,'today',day,'directory',directory,'options',options,'record',record,'activities',events,'tasks',tasks,'documents',documents,'contacts',contacts,'related',related,'machines',machines,'bonus',bonus,'history_limit',100);
 end if;

 with permitted as (
  select r.*,t.full_name as assigned_name,
   (r.due_date<day or (r.due_date=day and r.due_time is not null and r.due_time<clock)) and r.status not in ('completed','resolved','closed','paid','not_applicable','cancelled','rejected','machine_placed') as overdue
  from public.crm_record_index r left join public.team_members t on t.id=r.assigned_to
  where public.snacky_crm_allowed(r.kind,r.id)
   and (not r.archived or coalesce((p_filters->>'archived')::boolean,false))
   and (not r.is_practice or coalesce((p_filters->>'practice')::boolean,false))
   and (scope<>'mine' or r.assigned_to=me)
   and (nullif(p_filters->>'assigned_to','') is null or r.assigned_to=(p_filters->>'assigned_to')::uuid)
 ),filtered as (
  select * from permitted r where
   (p_section in ('work','search','management') or r.kind=p_section)
   and (p_section not in ('work','management') or (r.kind in ('task','issue','obligation') or (r.kind in ('lead','location') and r.due_date is not null)))
   and (nullif(p_filters->>'status','') is null or r.status=p_filters->>'status')
   and (nullif(p_filters->>'location_id','') is null or r.location_id=(p_filters->>'location_id')::uuid)
   and (nullif(p_filters->>'machine_id','') is null or r.machine_id=(p_filters->>'machine_id')::uuid)
   and (nullif(p_filters->>'type','') is null or coalesce(r.data->>'place_type',r.data->>'issue_type',r.data->>'location_type',r.data->>'task_type')=p_filters->>'type')
   and (nullif(p_filters->>'area','') is null or r.data->>'area'=p_filters->>'area')
   and (nullif(p_filters->>'created_from','') is null or r.created_at>=(p_filters->>'created_from')::date)
   and (q='' or r.search_text ilike '%'||q||'%' or (length(coalesce(public.snacky_crm_phone_key(q),''))>=7 and public.snacky_crm_phone_key(coalesce(r.data->>'customer_phone',r.data->>'phone',r.data->>'contact_phone'))=public.snacky_crm_phone_key(q)) or exists(select 1 from public.crm_activities a where r.id=any(array[a.lead_id,a.issue_id,a.location_id,a.contact_id,a.task_id,a.obligation_id]) and a.summary ilike '%'||q||'%'))
   and (win='all' or (win='today' and r.due_date=day) or (win='overdue' and r.overdue) or (win='week' and r.due_date between day and day+6) or (win='completed' and r.status in ('completed','resolved','paid')) or (win='attention' and (r.overdue or r.due_date=day or (r.kind='issue' and r.status not in ('resolved','closed') and (r.updated_at<now()-interval '3 days' or r.data->>'field_completed_at' is not null)))))
 ) select (select count(*) from filtered),coalesce((select jsonb_agg(to_jsonb(x)-'search_text' order by x.overdue desc nulls last,x.due_date nulls last,x.updated_at desc) from (select * from filtered order by overdue desc nulls last,due_date nulls last,updated_at desc,id limit 40 offset skip) x),'[]'::jsonb),
  (select jsonb_build_object('issue_action',count(*) filter(where kind='issue' and status in ('open','in_progress')),'issue_waiting',count(*) filter(where kind='issue' and status='waiting'),'leads_today',count(*) filter(where kind='lead' and due_date=day),'leads_overdue',count(*) filter(where kind='lead' and overdue),'locations_today',count(*) filter(where kind='location' and due_date=day),'admin_today',count(*) filter(where kind='task' and data->>'task_type'='admin' and due_date=day and status<>'completed'),'rent_week',count(*) filter(where kind='obligation' and status='open' and due_date<=day+6),'meetings_today',count(*) filter(where kind='task' and data->>'task_type'='meeting' and due_date=day and status<>'completed'),'recent_completed',count(*) filter(where status in ('completed','resolved','paid') and updated_at>=now()-interval '7 days')) from permitted)
 into total,rows,counts;
 -- Safe commercial projection: unassigned staff do not see unrelated rent terms.
 if not manager then select coalesce(jsonb_agg(case when x->>'kind'='location' and x->>'assigned_to' is distinct from me::text then jsonb_set(x,'{data}',(x->'data')-array['rent_amount','rent_type','contract_start','contract_end']) else x end),'[]'::jsonb) into rows from jsonb_array_elements(rows) x;end if;
 if p_section='management' then
  select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.full_name,
   'issues_handled',(select count(*) from public.issues i where i.assigned_to=u.id and not i.is_practice),
   'issues_resolved',(select count(*) from public.issues i where i.resolved_by=u.id and not i.is_practice and i.resolved_at>=now()-interval '30 days'),
   'average_resolution_hours',(select round(avg(extract(epoch from(i.resolved_at-i.created_at))/3600)::numeric,1) from public.issues i where i.resolved_by=u.id and not i.is_practice and i.resolved_at>=now()-interval '30 days'),
   'leads_contacted',(select count(distinct a.lead_id) from public.crm_activities a join public.location_pipeline_leads l on l.id=a.lead_id where a.actor_id=u.id and a.activity_type in ('call','whatsapp','email','visit') and a.occurred_at>=now()-interval '30 days' and not l.is_practice),
   'proposals_sent',(select count(*) from public.crm_activities a join public.location_pipeline_leads l on l.id=a.lead_id where a.actor_id=u.id and a.activity_type='proposal' and a.occurred_at>=now()-interval '30 days' and not l.is_practice),
   'accepted',(select count(*) from public.location_pipeline_leads l where l.closed_by_member_id=u.id and not l.is_practice and l.accepted_at>=now()-interval '30 days'),
   'tasks_completed',(select count(*) from public.crm_tasks t where t.completed_by=u.id and not t.is_practice and t.completed_at>=now()-interval '30 days'),
   'overdue_followups',(select count(*) from public.crm_tasks t where t.assigned_to=u.id and not t.is_practice and t.status<>'completed' and t.due_date<day)
  ) order by u.full_name),'[]'::jsonb) into related from public.team_members u where u.active and (u.role::text in ('crm','operator') or u.roles::text[]&&array['crm','operator']);
 end if;
 return jsonb_build_object('me',me,'manager',manager,'owner_admin',owner_admin,'staff',staff,'today',day,'directory',directory,'options',options,'rows',rows,'counts',counts,'total',total,'offset',skip,'page_size',40,'performance',related);
end $$;
revoke all on function public.snacky_crm_workspace_v1(text,uuid,jsonb) from public,anon;
grant execute on function public.snacky_crm_workspace_v1(text,uuid,jsonb) to authenticated;

-- Attachments remain private, immutable and scoped to an authorized record.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('crm-documents','crm-documents',false,10000000,array['image/jpeg','image/png','image/webp','application/pdf']) on conflict(id) do nothing;
create policy crm_documents_upload on storage.objects for insert to authenticated with check(
 bucket_id='crm-documents' and split_part(name,'/',1)=auth.uid()::text
 and case when split_part(name,'/',3)~'^[0-9a-fA-F-]{36}$' then public.snacky_crm_allowed(split_part(name,'/',2),split_part(name,'/',3)::uuid,true) else false end
);
create policy crm_documents_read on storage.objects for select to authenticated using(
 bucket_id='crm-documents' and (split_part(name,'/',1)=auth.uid()::text or exists(select 1 from public.crm_documents d where d.object_path=name))
);

-- Restrict existing CRM records without changing their IDs or creating replacements.
drop policy if exists snacky_location_pipeline_leads_select on public.location_pipeline_leads;
create policy snacky_location_pipeline_leads_select on public.location_pipeline_leads for select to authenticated using(public.snacky_crm_allowed('lead',id));
drop policy if exists snacky_location_pipeline_leads_update on public.location_pipeline_leads;
create policy snacky_location_pipeline_leads_update on public.location_pipeline_leads for update to authenticated using(public.snacky_crm_allowed('lead',id,true)) with check(public.snacky_crm_staff());
drop policy if exists snacky_customer_issues_read on public.issues;
create policy snacky_customer_issues_read on public.issues for select to authenticated using(public.snacky_crm_allowed('issue',id));
-- Existing field-report creation is retained. Resolution/edit commands enforce ownership.
drop policy if exists snacky_customer_issues_update on public.issues;
create policy snacky_customer_issues_update on public.issues for update to authenticated using(public.snacky_crm_manager()) with check(public.snacky_crm_manager());
drop policy if exists snacky_location_pipeline_activities_select on public.location_pipeline_activities;
create policy snacky_location_pipeline_activities_select on public.location_pipeline_activities for select to authenticated using(public.snacky_crm_allowed('lead',lead_id));
drop policy if exists snacky_location_pipeline_activities_insert on public.location_pipeline_activities;
create policy snacky_location_pipeline_activities_insert on public.location_pipeline_activities for insert to authenticated with check(public.snacky_crm_allowed('lead',lead_id,true) and created_by_user_id=public.snacky_current_team_member_id());
