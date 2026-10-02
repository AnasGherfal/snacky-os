-- Historical rent remains visible to the current relationship owner, but old ownership stays accurate.
-- Obligation date filters use the rent/payment due date, not the record creation timestamp.
-- Historical paid rent is excluded from Finance-attention management queues.
set lock_timeout = '3s';
set statement_timeout = '45s';

CREATE OR REPLACE FUNCTION public.snacky_crm_allowed(p_kind text, p_id uuid, p_write boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();staff boolean:=public.snacky_crm_staff();
begin
 if me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then return false;end if;
 if p_kind='lead' then return exists(select 1 from public.location_pipeline_leads l where l.id=p_id and (manager or (staff and (case when p_write then l.assigned_to_user_id=me or (l.assigned_to_user_id is null and l.created_by_member_id=me) else l.visibility='team' or l.assigned_to_user_id=me or l.created_by_member_id=me end))));
 elsif p_kind='issue' then return exists(select 1 from public.issues i where i.id=p_id and (manager or (staff and (not p_write or i.assigned_to=me or (i.assigned_to is null and i.reported_by=me))) or (not p_write and (i.reported_by=me or exists(select 1 from public.crm_tasks t where t.issue_id=i.id and t.assigned_to=me and t.archived_at is null)))));
 elsif p_kind='location' then return exists(select 1 from public.locations l where l.id=p_id and (manager or (staff and (not p_write or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)))));
 elsif p_kind='contact' then return staff and exists(select 1 from public.crm_contacts c where c.id=p_id);
 elsif p_kind='obligation' then return exists(select 1 from public.location_admin_obligations o where o.id=p_id and (manager or (staff and (o.assigned_to=me or (not p_write and o.is_historical and exists(select 1 from public.location_relationships r where r.location_id=o.location_id and r.assigned_to=me))))));
 elsif p_kind='task' then return exists(select 1 from public.crm_tasks t where t.id=p_id and (manager or t.assigned_to=me or (staff and (t.created_by=me or public.snacky_crm_allowed('issue',t.issue_id,true) or public.snacky_crm_allowed('lead',t.lead_id,true) or public.snacky_crm_allowed('location',t.location_id,true) or public.snacky_crm_allowed('obligation',t.obligation_id,true)))));
 end if;
 return false;
end $function$;


CREATE OR REPLACE FUNCTION public.snacky_crm_workspace_v1(p_section text, p_id uuid DEFAULT NULL::uuid, p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();staff boolean:=public.snacky_crm_staff();owner_admin boolean:=public.snacky_current_profile_has_any_role(array['owner','admin']);
 day date:=(now() at time zone 'Africa/Tripoli')::date;clock time:=(now() at time zone 'Africa/Tripoli')::time;
 rows jsonb;counts jsonb;record jsonb;events jsonb;history_page jsonb;tasks jsonb;documents jsonb;contacts jsonb;related jsonb;machines jsonb;bonus jsonb;directory jsonb;options jsonb;
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
   'contacts',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) order by name),'[]'::jsonb) from public.crm_contacts where archived_at is null and public.snacky_crm_allowed('contact',id)));
 else options:='{}'::jsonb;end if;

 if p_id is not null then
  if not public.snacky_crm_allowed(p_section,p_id) then raise exception 'Record unavailable or not assigned to you' using errcode='42501';end if;
  select * into entity from public.crm_record_index where kind=p_section and id=p_id;
  record:=to_jsonb(entity)-'search_text';
  if p_section='location' and not manager and entity.assigned_to is distinct from me then record:=jsonb_set(record,'{data}',(record->'data')-array['rent_amount','rent_type','contract_start','contract_end']);end if;
  record:=record||jsonb_build_object('can_edit',public.snacky_crm_allowed(p_section,p_id,true));
  source_leads:=case when p_section='location' then array(select id from public.location_pipeline_leads where converted_location_id=p_id and public.snacky_crm_allowed('lead',id)) else array[]::uuid[] end;
  history_page:=public.snacky_crm_timeline_v1(p_section,p_id,greatest(0,least(100000,coalesce((p_filters->>'history_offset')::integer,0))));
  events:=history_page->'rows';
  select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('version',t.updated_at::text) order by t.due_date,t.created_at),'[]'::jsonb) into tasks from public.crm_tasks t where (t.lead_id=p_id or t.issue_id=p_id or t.location_id=p_id or t.contact_id=p_id or t.obligation_id=p_id or t.lead_id=any(source_leads)) and public.snacky_crm_allowed('task',t.id);
  select coalesce(jsonb_agg(to_jsonb(d) order by d.created_at desc),'[]'::jsonb) into documents from public.crm_documents d where (d.lead_id=p_id or d.issue_id=p_id or d.location_id=p_id or d.contact_id=p_id or d.obligation_id=p_id or d.task_id=p_id or d.lead_id=any(source_leads));
  select coalesce(jsonb_agg(distinct to_jsonb(c)),'[]'::jsonb) into contacts from public.crm_contact_links x join public.crm_contacts c on c.id=x.contact_id where (x.lead_id=p_id or x.location_id=p_id or x.issue_id=p_id or x.lead_id=any(source_leads)) and staff;
  select coalesce(jsonb_agg(to_jsonb(r)-'search_text' order by r.updated_at desc),'[]'::jsonb) into related from public.crm_record_index r where (r.location_id=p_id or (p_section='contact' and r.id in (select coalesce(lead_id,location_id,issue_id) from public.crm_contact_links where contact_id=p_id))) and r.id<>p_id and public.snacky_crm_allowed(r.kind,r.id);
  if p_section in ('issue','location') then select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',m.name,'machine_code',m.machine_code,'status',m.status,'online_status',m.vms_online_status,'last_status_at',m.last_vms_status_at,'installed_date',m.installed_date)),'[]'::jsonb) into machines from public.machines m where (p_section='location' and m.location_id=p_id) or (p_section='issue' and m.id=entity.machine_id);end if;
  if p_section='lead' and owner_admin then select to_jsonb(b) into bonus from public.crm_lead_bonus b where lead_id=p_id;end if;
  if p_section='obligation' and owner_admin then
   options:=options||jsonb_build_object('finance_payments',coalesce((
    select jsonb_agg(jsonb_build_object('id',f.id,'date',f.transaction_date,'amount',f.amount,'description',f.description) order by f.transaction_date desc,f.id)
    from public.financial_transactions f join public.location_admin_obligations o on o.id=p_id
    where o.status='paid' and f.direction='money_out' and f.transaction_effect='expense' and f.currency='LYD'
     and f.amount=o.amount_lyd and f.related_location_id=o.location_id and f.transaction_date=o.payment_date
     and f.transaction_status='active' and not coalesce(f.is_void,false) and f.voided_at is null
     and not coalesce(f.needs_review,true) and f.review_status in ('confirmed','reviewed')
     and not exists(select 1 from public.location_admin_obligations x where x.finance_transaction_id=f.id and x.id<>o.id)
   ),'[]'::jsonb));
  end if;
  if not manager then
   select coalesce(jsonb_agg(case when x->>'kind'='location' and x->>'assigned_to' is distinct from me::text
    then jsonb_set(x,'{data}',(x->'data')-array['rent_amount','rent_type','contract_start','contract_end']) else x end),'[]'::jsonb)
    into related from jsonb_array_elements(coalesce(related,'[]'::jsonb)) x;
  end if;

  return jsonb_build_object('me',me,'manager',manager,'owner_admin',owner_admin,'staff',staff,'today',day,'directory',directory,'options',options,'record',record,'activities',events,'tasks',tasks,'documents',documents,'contacts',contacts,'related',related,'machines',machines,'bonus',bonus,'history_total',history_page->'total','history_offset',history_page->'offset','history_page_size',40);
 end if;

 with permitted as (
  select r.*,t.full_name as assigned_name,
   (r.due_date<day or (r.due_date=day and r.due_time is not null and r.due_time<clock)) and r.status not in ('completed','resolved','closed','paid','not_applicable','cancelled','rejected','machine_placed','accepted') as overdue
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
   and (nullif(p_filters->>'created_from','') is null or case when r.kind='obligation' then r.due_date>=(p_filters->>'created_from')::date else r.created_at>=(p_filters->>'created_from')::date end)
   and (nullif(p_filters->>'created_to','') is null or case when r.kind='obligation' then r.due_date<=(p_filters->>'created_to')::date else r.created_at<((p_filters->>'created_to')::date+1) end)
   and (nullif(p_filters->>'agreement_type','') is null or r.data->'relationship'->>'agreement_type'=p_filters->>'agreement_type')
   and (coalesce(p_filters->>'open_issues','false')<>'true' or exists(select 1 from public.issues i where coalesce(i.location_id,(select m.location_id from public.machines m where m.id=i.machine_id))=r.location_id and i.status not in ('resolved','closed') and i.archived_at is null and public.snacky_crm_allowed('issue',i.id)))
   and (q='' or r.search_text ilike '%'||q||'%' or (length(coalesce(public.snacky_crm_phone_key(q),''))>=7 and public.snacky_crm_phone_key(coalesce(r.data->>'customer_phone',r.data->>'phone',r.data->>'contact_phone'))=public.snacky_crm_phone_key(q)) or exists(select 1 from public.crm_activities a where r.id=any(array[a.lead_id,a.issue_id,a.location_id,a.contact_id,a.task_id,a.obligation_id]) and public.snacky_crm_activity_visible(a.task_id,a.obligation_id,a.issue_id,a.lead_id,a.contact_id,a.location_id) and a.summary ilike '%'||q||'%'))
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
end $function$;


CREATE OR REPLACE FUNCTION crm_automation_private.overview(p_filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
   (kind='obligation' and coalesce((data->>'is_historical')::boolean,false)=false and ((status='open' and due_date<=today+7) or (status='paid' and data->>'finance_verified_at' is null))) as rent,
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
end $function$;


revoke all on function public.snacky_crm_allowed(text,uuid,boolean) from public,anon;
grant execute on function public.snacky_crm_allowed(text,uuid,boolean) to authenticated;
revoke all on function public.snacky_crm_workspace_v1(text,uuid,jsonb) from public,anon;
grant execute on function public.snacky_crm_workspace_v1(text,uuid,jsonb) to authenticated;
