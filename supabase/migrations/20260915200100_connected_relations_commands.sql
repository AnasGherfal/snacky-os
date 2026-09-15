-- Versioned, idempotent commands. No inventory, cash movement or payroll writes.
create or replace function public.snacky_crm_emit(p_kind text,p_id uuid,p_action text,p_summary text,p_before jsonb default null,p_after jsonb default null)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare me uuid:=public.snacky_current_team_member_id(); actor text; l uuid;i uuid;o uuid;c uuid;t uuid;s uuid;
begin
 select full_name into actor from public.team_members where id=me;
 l:=case when p_kind='lead' then p_id end;i:=case when p_kind='issue' then p_id end;
 s:=case when p_kind='location' then p_id end;c:=case when p_kind='contact' then p_id end;
 o:=case when p_kind='obligation' then p_id end;t:=case when p_kind='task' then p_id end;
 if t is not null then select lead_id,issue_id,location_id,contact_id,obligation_id into l,i,s,c,o from public.crm_tasks where id=t;end if;
 if o is not null then select location_id into s from public.location_admin_obligations where id=o;end if;
 if i is not null then select coalesce(x.location_id,m.location_id) into s from public.issues x left join public.machines m on m.id=x.machine_id where x.id=i;end if;
 insert into public.crm_activities(lead_id,issue_id,location_id,contact_id,obligation_id,task_id,activity_type,summary,actor_id,actor_name,before_data,after_data)
 values(l,i,s,c,o,t,p_action,p_summary,me,actor,p_before,p_after);
 insert into public.system_activity_logs(actor_user_id,actor_team_member_id,actor_name,action,entity_type,entity_id,summary,before_data,after_data,metadata)
 values(auth.uid(),me,actor,p_action,'crm_'||p_kind,p_id,p_summary,p_before,p_after,'{"origin":"connected_relations"}'::jsonb);
end $$;
revoke all on function public.snacky_crm_emit(text,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;

create or replace function public.snacky_crm_audit_change()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare kind text;target uuid;summary text;me uuid:=public.snacky_current_team_member_id();before_value jsonb;after_value jsonb;
begin
 kind:=case tg_table_name when 'location_pipeline_leads' then 'lead' when 'issues' then 'issue' when 'location_relationships' then 'location' when 'crm_tasks' then 'task' when 'crm_contacts' then 'contact' when 'location_admin_obligations' then 'obligation' when 'crm_lead_bonus' then 'lead' end;
 target:=case tg_table_name when 'location_relationships' then (to_jsonb(new)->>'location_id')::uuid when 'crm_lead_bonus' then (to_jsonb(new)->>'lead_id')::uuid else (to_jsonb(new)->>'id')::uuid end;
 before_value:=case when tg_op='UPDATE' then to_jsonb(old) end;after_value:=to_jsonb(new);
 if before_value is not null and (before_value-array['updated_at','updated_by','updated_by_member_id'])=(after_value-array['updated_at','updated_by','updated_by_member_id']) then return new;end if;
 summary:=case when tg_op='INSERT' then 'Created' when before_value->>'assigned_to' is distinct from after_value->>'assigned_to' or before_value->>'assigned_to_user_id' is distinct from after_value->>'assigned_to_user_id' then 'Assignment changed' when before_value->>'status' is distinct from after_value->>'status' then 'Status: '||coalesce(before_value->>'status','')||' → '||coalesce(after_value->>'status','') else 'Record updated' end;
 if tg_table_name='crm_lead_bonus' then
  -- Do not expose bonus amounts through the general relationship timeline.
  perform public.snacky_crm_emit(kind,target,'bonus_status','Bonus status: '||new.status,null,jsonb_build_object('eligible',new.eligible,'status',new.status));return new;
 end if;
 perform public.snacky_crm_emit(kind,target,case when tg_op='INSERT' then 'created' else 'updated' end,summary,before_value,after_value);
 if tg_table_name='crm_tasks' and new.task_type='field_action' and new.status='completed' and (tg_op='INSERT' or old.status is distinct from new.status) then
  update public.issues set field_completed_at=now(),is_waiting=false,waiting_on=null,next_action='Contact customer after field action',next_action_date=(now() at time zone 'Africa/Tripoli')::date,updated_at=now(),updated_by=me where id=new.issue_id and status not in ('resolved','closed');
  perform public.snacky_crm_emit('issue',new.issue_id,'field_completed','Field action completed: '||new.result,null,jsonb_build_object('task_id',new.id,'performed_by',new.completed_by));
 end if;
 return new;
end $$;
revoke all on function public.snacky_crm_audit_change() from public,anon,authenticated;
do $$declare tbl text;begin
 foreach tbl in array array['location_pipeline_leads','issues','location_relationships','crm_tasks','crm_contacts','location_admin_obligations','crm_lead_bonus'] loop
  execute format('create trigger crm_audit_change after insert or update on public.%I for each row execute function public.snacky_crm_audit_change()',tbl);
 end loop;
end $$;

create or replace function public.snacky_crm_command_v1(p_command_id uuid,p_action text,p_id uuid,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();staff boolean:=public.snacky_crm_staff();
 p jsonb:=coalesce(p_payload,'{}'::jsonb);req jsonb;receipt public.crm_command_receipts;answer jsonb;target uuid:=p_id;kind text;assignee uuid;related uuid;new_location uuid;
 lead public.location_pipeline_leads;issue public.issues;task public.crm_tasks;obligation public.location_admin_obligations;contact public.crm_contacts;
 previous jsonb;allowed text[];day date:=(now() at time zone 'Africa/Tripoli')::date;document_path text;method text;
begin
 if p_command_id is null or me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then raise exception 'Active staff access is required' using errcode='42501';end if;
 if jsonb_typeof(p)<>'object' or octet_length(p::text)>20000 then raise exception 'Invalid record data' using errcode='22023';end if;
 req:=jsonb_build_object('action',p_action,'id',p_id,'payload',p);
 perform pg_advisory_xact_lock(hashtext('crm-command'),hashtext(p_command_id::text));
 select * into receipt from public.crm_command_receipts where id=p_command_id;
 if found then
  if receipt.actor_user_id<>auth.uid() or receipt.request is distinct from req then raise exception 'Saved request does not match. Reload the record before retrying' using errcode='23505';end if;
  return receipt.response;
 end if;

 if p_action='lead.save' then
  if not staff then raise exception 'Customer relations access required' using errcode='42501';end if;
  allowed:=array['place_name','place_type','status','assigned_to','area','city','address_text','google_maps_url','name_ar','website','social_links','attraction_notes','contact_person_name','contact_person_job_title','contact_phone','contact_whatsapp','contact_email','reception_phone','source','source_detail','estimated_traffic','rent_expectation','next_action','next_action_date','next_action_time','notes','visibility','is_practice','version'];
  if p-allowed<>'{}'::jsonb then raise exception 'Unsupported lead fields' using errcode='22023';end if;
  if target is not null then
   select * into lead from public.location_pipeline_leads where id=target for update;
   if not public.snacky_crm_allowed('lead',target,true) then raise exception 'This lead belongs to another employee' using errcode='42501';end if;
   if p->>'version' is distinct from lead.updated_at::text then raise exception 'This lead changed. Reload before saving' using errcode='40001';end if;
   if lead.is_archived then raise exception 'Restore the archived lead before editing';end if;
  end if;
  assignee:=coalesce(nullif(p->>'assigned_to','')::uuid,lead.assigned_to_user_id,me);
  if not exists(select 1 from public.team_members t where t.id=assignee and t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm') or t.roles::text[]&&array['owner','admin','supervisor','crm'])) then raise exception 'Choose an active customer relations employee';end if;
  if coalesce((p->>'is_practice')::boolean,false) and not manager and not coalesce(lead.is_practice,false) then raise exception 'Only management can create practice records';end if;
  if target is null then
   insert into public.location_pipeline_leads(place_name,place_type,status,assigned_to_user_id,created_by_member_id,updated_by_member_id,source,priority,is_practice)
   values(trim(p->>'place_name'),coalesce(nullif(p->>'place_type',''),'other')::public.location_type,'want_to_contact',assignee,me,me,coalesce(nullif(p->>'source',''),'manual'),'normal',coalesce((p->>'is_practice')::boolean,false)) returning * into lead;
   target:=lead.id;
  end if;
  if coalesce(p->>'status',lead.status)='machine_placed' and lead.converted_location_id is null then raise exception 'Convert an accepted lead instead of marking a machine as placed';end if;
  -- Partial saves preserve unspecified fields. Assignment uses the same team ID everywhere.
  select * into lead from jsonb_populate_record(lead,p-array['assigned_to','is_practice','version']);
  lead.google_maps_url:=nullif(trim(lead.google_maps_url),'');lead.website:=nullif(trim(lead.website),'');
  if lead.google_maps_url is not null and lead.google_maps_url!~'^https?://' then raise exception 'Map links must use http or https';end if;
  if lead.website is not null and lead.website!~'^https?://' then raise exception 'Website links must use http or https';end if;
  update public.location_pipeline_leads set place_name=trim(lead.place_name),place_type=lead.place_type,status=lead.status,assigned_to_user_id=assignee,
   area=lead.area,city=lead.city,address_text=lead.address_text,google_maps_url=lead.google_maps_url,name_ar=lead.name_ar,website=lead.website,social_links=lead.social_links,attraction_notes=lead.attraction_notes,
   contact_person_name=lead.contact_person_name,contact_person_job_title=lead.contact_person_job_title,contact_phone=lead.contact_phone,contact_whatsapp=lead.contact_whatsapp,contact_email=lead.contact_email,reception_phone=lead.reception_phone,
   source=lead.source,source_detail=lead.source_detail,estimated_traffic=lead.estimated_traffic,rent_expectation=lead.rent_expectation,next_action=lead.next_action,next_action_date=lead.next_action_date,next_follow_up_date=lead.next_action_date,next_action_time=lead.next_action_time,notes=lead.notes,visibility=lead.visibility,
   accepted_at=case when lead.status='accepted' then coalesce(accepted_at,now()) else accepted_at end,closed_by_member_id=case when lead.status='accepted' then coalesce(closed_by_member_id,me) else closed_by_member_id end,
   updated_by_member_id=me,updated_at=now(),last_activity_at=now() where id=target;
  kind:='lead';

 elsif p_action='issue.save' then
  if not staff then raise exception 'Customer relations access required' using errcode='42501';end if;
  allowed:=array['customer_name','customer_phone','customer_whatsapp','contact_channel','location_id','machine_id','product_id','lane_number','issue_type','description','amount_involved_lyd','happened_at','assigned_to','status','priority','waiting_on','next_action','next_action_date','resolution','refund_amount_lyd','is_practice','version'];
  if p-allowed<>'{}'::jsonb then raise exception 'Unsupported issue fields' using errcode='22023';end if;
  if target is not null then
   select * into issue from public.issues where id=target for update;
   if not public.snacky_crm_allowed('issue',target,true) then raise exception 'This issue belongs to another employee' using errcode='42501';end if;
   if p->>'version' is distinct from issue.updated_at::text then raise exception 'Issue changed. Reload before saving' using errcode='40001';end if;
   if issue.archived_at is not null then raise exception 'Restore this issue before editing';end if;
  end if;
  assignee:=coalesce(nullif(p->>'assigned_to','')::uuid,issue.assigned_to,me);
  if not exists(select 1 from public.team_members t where t.id=assignee and t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm') or t.roles::text[]&&array['owner','admin','supervisor','crm'])) then raise exception 'Assign customer ownership to an active relations employee; use a field task for the operator';end if;
  if target is null then
   if length(coalesce(public.snacky_crm_phone_key(p->>'customer_phone'),''))<7 or nullif(p->>'location_id','') is null or nullif(trim(p->>'description'),'') is null then raise exception 'Phone, location and problem are required';end if;
   if coalesce((p->>'is_practice')::boolean,false) and not manager then raise exception 'Only management can create practice records';end if;
   insert into public.issues(issue_type,customer_phone,description,location_id,reported_by,assigned_to,is_practice) values(coalesce(p->>'issue_type','other'),p->>'customer_phone',p->>'description',(p->>'location_id')::uuid,me,assignee,coalesce((p->>'is_practice')::boolean,false)) returning * into issue;
   target:=issue.id;
  end if;
  select * into issue from jsonb_populate_record(issue,p-array['status','assigned_to','is_practice','version']);
  if issue.machine_id is not null and not exists(select 1 from public.machines m where m.id=issue.machine_id and m.location_id=issue.location_id) then raise exception 'Choose a machine at this location';end if;
  if coalesce(p->>'status','open') not in ('open','in_progress','waiting','resolved') then raise exception 'Choose New, In Progress, Waiting or Resolved';end if;
  if p->>'status'='waiting' and nullif(trim(p->>'waiting_on'),'') is null then raise exception 'Explain who or what you are waiting for';end if;
  if p->>'status'='resolved' then
   if nullif(trim(issue.resolution),'') is null then raise exception 'Describe the resolution';end if;
   if exists(select 1 from public.crm_tasks t where t.issue_id=target and t.task_type='field_action' and t.status<>'completed' and t.archived_at is null) then raise exception 'Complete or cancel the pending field action before resolving';end if;
  end if;
  update public.issues set customer_name=issue.customer_name,customer_phone=issue.customer_phone,customer_whatsapp=issue.customer_whatsapp,contact_channel=issue.contact_channel,location_id=issue.location_id,machine_id=issue.machine_id,product_id=issue.product_id,lane_number=issue.lane_number,issue_type=issue.issue_type,description=issue.description,amount_involved_lyd=issue.amount_involved_lyd,happened_at=issue.happened_at,assigned_to=assignee,priority=issue.priority,
   status=case when p->>'status'='waiting' then 'in_progress'::public.issue_status else coalesce((p->>'status')::public.issue_status,issue.status) end,
   is_waiting=coalesce(p->>'status'='waiting',false),waiting_on=case when p->>'status'='waiting' then issue.waiting_on end,next_action=issue.next_action,next_action_date=issue.next_action_date,resolution=issue.resolution,refund_amount_lyd=issue.refund_amount_lyd,
   resolved_at=case when p->>'status'='resolved' then coalesce(resolved_at,now()) else null end,resolved_by=case when p->>'status'='resolved' then coalesce(resolved_by,me) else null end,updated_at=now(),updated_by=me where id=target;
  kind:='issue';

 elsif p_action='task.save' then
  if target is null and not staff then raise exception 'Only customer relations can assign new work' using errcode='42501';end if;
  allowed:=array['title','kind','related_id','task_type','assigned_to','due_date','due_time','priority','notes','status','result','version'];
  if p-allowed<>'{}'::jsonb then raise exception 'Unsupported task fields' using errcode='22023';end if;
  if target is not null then
   select * into task from public.crm_tasks where id=target for update;
   if not public.snacky_crm_allowed('task',target,true) then raise exception 'This task is not assigned to you' using errcode='42501';end if;
   if p->>'version' is distinct from task.updated_at::text then raise exception 'Task changed. Reload before saving' using errcode='40001';end if;
   if not staff and p-array['status','result','version']<>'{}'::jsonb then raise exception 'Operators can update only their own field result and completion status' using errcode='42501';end if;
   if task.status='completed' then raise exception 'Completed work remains in history. Create a new follow-up instead';end if;
  end if;
  if target is null then
   kind:=p->>'kind';related:=nullif(p->>'related_id','')::uuid;
   if related is not null and not public.snacky_crm_allowed(kind,related,true) then raise exception 'Related record is not assigned to you' using errcode='42501';end if;
   if related is null and coalesce(kind,'')<>'' then raise exception 'Select the related record';end if;
   assignee:=coalesce(nullif(p->>'assigned_to','')::uuid,me);
   if not exists(select 1 from public.team_members t where t.id=assignee and t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm','operator') or t.roles::text[]&&array['owner','admin','supervisor','crm','operator'])) then raise exception 'Choose an active staff member';end if;
   if exists(select 1 from public.team_members t where t.id=assignee and t.role::text='operator' and not t.roles::text[]&&array['owner','admin','supervisor','crm']) and (kind<>'issue' or p->>'task_type'<>'field_action') then raise exception 'Operators can be assigned issue field actions, not unrelated CRM work';end if;
   insert into public.crm_tasks(title,lead_id,location_id,issue_id,contact_id,obligation_id,task_type,assigned_to,due_date,due_time,priority,notes,created_by,updated_by,is_practice)
   values(trim(p->>'title'),case when kind='lead' then related end,case when kind='location' then related end,case when kind='issue' then related end,case when kind='contact' then related end,case when kind='obligation' then related end,coalesce(p->>'task_type','follow_up'),assignee,(p->>'due_date')::date,nullif(p->>'due_time','')::time,coalesce(p->>'priority','normal'),p->>'notes',me,me,
    case when kind='lead' then (select is_practice from public.location_pipeline_leads where id=related) when kind='issue' then (select is_practice from public.issues where id=related) when kind='obligation' then (select is_practice from public.location_admin_obligations where id=related) else false end) returning id into target;
  else
   assignee:=coalesce(nullif(p->>'assigned_to','')::uuid,task.assigned_to);
   if assignee<>task.assigned_to and not staff then raise exception 'Reassignment requires customer relations access';end if;
   if not exists(select 1 from public.team_members where id=assignee and active and active_status='active') then raise exception 'Assignee is inactive';end if;
   update public.crm_tasks set title=coalesce(nullif(trim(p->>'title'),''),title),assigned_to=assignee,due_date=coalesce(nullif(p->>'due_date','')::date,due_date),due_time=case when p?'due_time' then nullif(p->>'due_time','')::time else due_time end,priority=coalesce(p->>'priority',priority),notes=case when p?'notes' then p->>'notes' else notes end,
    status=coalesce(p->>'status',status),result=case when p?'result' then p->>'result' else result end,completed_at=case when p->>'status'='completed' then now() end,completed_by=case when p->>'status'='completed' then me end,updated_by=me,updated_at=now() where id=target;
  end if;
  kind:='task';

 elsif p_action='contact.save' then
  if not staff then raise exception 'Customer relations access required' using errcode='42501';end if;
  allowed:=array['name','position','organization','phone','whatsapp','email','preferred_channel','notes','kind','related_id','version'];
  if p-allowed<>'{}'::jsonb then raise exception 'Unsupported contact fields';end if;
  if target is null then
   perform pg_advisory_xact_lock(hashtext('crm-contact'),hashtext(coalesce(public.snacky_crm_phone_key(p->>'phone'),lower(p->>'email'),p->>'name')));
   select * into contact from public.crm_contacts where archived_at is null and ((phone_key=public.snacky_crm_phone_key(p->>'phone') and phone_key is not null) or (email_key=lower(trim(p->>'email')) and email_key is not null)) order by created_at limit 1;
   if contact.id is not null then target:=contact.id;else
    insert into public.crm_contacts(name,position,organization,phone,whatsapp,email,preferred_channel,notes,created_by,updated_by) values(trim(p->>'name'),p->>'position',p->>'organization',p->>'phone',p->>'whatsapp',p->>'email',coalesce(nullif(p->>'preferred_channel',''),'phone'),p->>'notes',me,me) returning id into target;
   end if;
  else
   select * into contact from public.crm_contacts where id=target for update;
   if contact.id is null then raise exception 'Contact not found';end if;
   if p->>'version' is distinct from contact.updated_at::text then raise exception 'Contact changed. Reload before saving' using errcode='40001';end if;
   select * into contact from jsonb_populate_record(contact,p-array['kind','related_id','version']);
   update public.crm_contacts set name=contact.name,position=contact.position,organization=contact.organization,phone=contact.phone,whatsapp=contact.whatsapp,email=contact.email,preferred_channel=contact.preferred_channel,notes=contact.notes,updated_by=me,updated_at=now() where id=target;
  end if;
  related:=nullif(p->>'related_id','')::uuid;
  if related is not null then
   kind:=p->>'kind';if kind not in ('lead','location','issue') or not public.snacky_crm_allowed(kind,related,true) then raise exception 'Cannot link to this record' using errcode='42501';end if;
   insert into public.crm_contact_links(contact_id,lead_id,location_id,issue_id,created_by) values(target,case when kind='lead' then related end,case when kind='location' then related end,case when kind='issue' then related end,me) on conflict do nothing;
   perform public.snacky_crm_emit(kind,related,'contact_linked','Contact linked',null,jsonb_build_object('contact_id',target));
  end if;
  kind:='contact';

 elsif p_action='location.save' then
  if not public.snacky_crm_allowed('location',target,true) then raise exception 'Location relationship is not assigned to you' using errcode='42501';end if;
  if p-array['assigned_to','next_action','next_action_date','next_action_time','notes','agreement_type','payment_frequency','version']<>'{}'::jsonb then raise exception 'Only relationship fields may be edited here';end if;
  if (p?'assigned_to' or p?'agreement_type' or p?'payment_frequency') and not manager then raise exception 'Management controls commercial terms and relationship assignment';end if;
  select to_jsonb(r) into previous from public.location_relationships r where location_id=target for update;
  if previous is not null and p->>'version' is distinct from (previous->>'updated_at')::timestamptz::text then raise exception 'Location relationship changed. Reload before saving' using errcode='40001';end if;
  insert into public.location_relationships(location_id,assigned_to,next_action,next_action_date,next_action_time,notes,agreement_type,payment_frequency,created_by,updated_by)
  values(target,coalesce(nullif(p->>'assigned_to','')::uuid,(previous->>'assigned_to')::uuid,me),coalesce(p->>'next_action',previous->>'next_action'),coalesce(nullif(p->>'next_action_date','')::date,(previous->>'next_action_date')::date),nullif(p->>'next_action_time','')::time,coalesce(p->>'notes',previous->>'notes'),coalesce(p->>'agreement_type',previous->>'agreement_type','other'),coalesce(p->>'payment_frequency',previous->>'payment_frequency','monthly'),me,me)
  on conflict(location_id) do update set assigned_to=excluded.assigned_to,next_action=excluded.next_action,next_action_date=case when p?'next_action_date' then nullif(p->>'next_action_date','')::date else location_relationships.next_action_date end,next_action_time=excluded.next_action_time,notes=excluded.notes,agreement_type=excluded.agreement_type,payment_frequency=excluded.payment_frequency,updated_by=me,updated_at=now();
  kind:='location';

 elsif p_action='lead.convert' then
  if not public.snacky_crm_allowed('lead',target,true) then raise exception 'Lead conversion is not permitted' using errcode='42501';end if;
  select * into lead from public.location_pipeline_leads where id=target for update;
  if lead.is_practice then raise exception 'Practice leads cannot create real operating locations';end if;
  if lead.is_archived or lead.status not in ('accepted','machine_placed') then raise exception 'Accept the lead before conversion';end if;
  if lead.converted_location_id is not null then new_location:=lead.converted_location_id;else
   new_location:=nullif(p->>'existing_location_id','')::uuid;
   if new_location is null then
    perform pg_advisory_xact_lock(hashtext('crm-location'),hashtext(lower(trim(lead.place_name))));
    if exists(select 1 from public.locations where lower(trim(name))=lower(trim(lead.place_name))) then raise exception 'A location with this name exists. Link it instead of creating a duplicate';end if;
    insert into public.locations(name,location_type,address,contact_name,contact_phone,rent_amount,status,notes,metadata)
    values(lead.place_name,lead.place_type,concat_ws(', ',lead.address_text,lead.area,lead.city),lead.contact_person_name,coalesce(lead.contact_phone,lead.contact_whatsapp),null,'active',lead.notes,jsonb_build_object('source_location_lead_id',lead.id,'lead_source',lead.source,'google_maps_url',lead.google_maps_url)) returning id into new_location;
   elsif not exists(select 1 from public.locations where id=new_location) then raise exception 'Existing location not found';end if;
   update public.location_pipeline_leads set converted_location_id=new_location,converted_at=now(),converted_by_user_id=me,updated_at=now(),updated_by_member_id=me where id=target;
   insert into public.location_relationships(location_id,assigned_to,notes,created_by,updated_by) values(new_location,lead.assigned_to_user_id,lead.notes,me,me) on conflict(location_id) do nothing;
   insert into public.crm_contact_links(contact_id,location_id,created_by) select contact_id,new_location,me from public.crm_contact_links where lead_id=target on conflict do nothing;
   perform public.snacky_crm_emit('location',new_location,'lead_converted','Accepted lead linked; its original contacts, documents and activity remain available',null,jsonb_build_object('lead_id',target));
  end if;
  answer:=jsonb_build_object('kind','location','id',new_location,'lead_id',target);kind:='lead';

 elsif p_action='note.add' then
  kind:=p->>'kind';if not public.snacky_crm_allowed(kind,target,true) then raise exception 'Cannot add activity to this record' using errcode='42501';end if;
  if nullif(trim(p->>'summary'),'') is null then raise exception 'Write the interaction result';end if;
  method:=coalesce(p->>'activity_type','note');if method not in ('call','whatsapp','email','meeting','visit','proposal','note','agreement','other') then raise exception 'Invalid activity type';end if;
  if kind='lead' then
   insert into public.location_pipeline_activities(lead_id,activity_type,summary,created_by_user_id) values(target,case when method='agreement' then 'other' else method end,trim(p->>'summary'),me);
   update public.location_pipeline_leads set last_activity_at=now(),last_contact_date=case when method in ('call','whatsapp','email','visit','meeting') then day else last_contact_date end,updated_at=now(),updated_by_member_id=me where id=target;
  end if;
  if kind='location' and method in ('call','whatsapp','email','visit','meeting') then update public.location_relationships set last_contact_at=now(),updated_at=now(),updated_by=me where location_id=target;end if;
  if kind='issue' then update public.issues set updated_at=now(),updated_by=me where id=target;end if;
  perform public.snacky_crm_emit(kind,target,method,trim(p->>'summary'));

 elsif p_action='obligation.create' then
  if not manager then raise exception 'Management creates rent and administrative obligations' using errcode='42501';end if;
  related:=(p->>'location_id')::uuid;assignee:=(p->>'assigned_to')::uuid;
  if not exists(select 1 from public.team_members where id=assignee and active and active_status='active') then raise exception 'Choose an active responsible employee';end if;
  insert into public.location_admin_obligations(location_id,title,amount_lyd,due_date,frequency,assigned_to,notes,is_practice,created_by,updated_by)
  values(related,trim(p->>'title'),(p->>'amount_lyd')::numeric,(p->>'due_date')::date,coalesce(p->>'frequency','monthly'),assignee,p->>'notes',coalesce((p->>'is_practice')::boolean,false),me,me) returning id into target;kind:='obligation';

 elsif p_action in ('obligation.paid','obligation.verify','obligation.next') then
  if not public.snacky_crm_allowed('obligation',target,true) then raise exception 'This obligation is not assigned to you' using errcode='42501';end if;
  select * into obligation from public.location_admin_obligations where id=target for update;
  if p_action='obligation.paid' then
   if obligation.status<>'open' then raise exception 'This obligation is already paid or closed';end if;
   if (p->>'payment_date')::date>day or nullif(p->>'payment_date','') is null then raise exception 'Enter the actual payment date';end if;
   if not exists(select 1 from public.crm_documents where obligation_id=target) then raise exception 'Upload the payment receipt before reporting it paid';end if;
   update public.location_admin_obligations set status='paid',payment_date=(p->>'payment_date')::date,paid_by=me,payment_method=p->>'payment_method',updated_by=me,updated_at=now() where id=target;
  elsif p_action='obligation.verify' then
   if not public.snacky_current_profile_has_any_role(array['owner','admin']) or obligation.is_practice then raise exception 'Only owner/admin can verify a real Finance payment' using errcode='42501';end if;
   related:=(p->>'finance_transaction_id')::uuid;
   if obligation.status<>'paid' or not exists(select 1 from public.financial_transactions f where f.id=related and f.direction='money_out' and f.transaction_effect='expense' and f.currency='LYD' and f.amount=obligation.amount_lyd and f.related_location_id=obligation.location_id and f.transaction_date=obligation.payment_date and f.transaction_status='active' and not coalesce(f.is_void,false) and f.voided_at is null and not coalesce(f.needs_review,true) and f.review_status in ('confirmed','reviewed')) then raise exception 'Choose a verified Finance expense matching location, amount and paid date';end if;
   update public.location_admin_obligations set finance_transaction_id=related,finance_verified_at=now(),finance_verified_by=me,updated_by=me,updated_at=now() where id=target;
  else
   if not manager or obligation.frequency='once' then raise exception 'Only management can generate the next recurring obligation';end if;
   insert into public.location_admin_obligations(location_id,title,amount_lyd,due_date,frequency,assigned_to,notes,is_practice,created_by,updated_by)
   values(obligation.location_id,obligation.title,obligation.amount_lyd,(obligation.due_date+case obligation.frequency when 'monthly' then interval '1 month' when 'quarterly' then interval '3 months' else interval '1 year' end)::date,obligation.frequency,obligation.assigned_to,obligation.notes,obligation.is_practice,me,me)
   on conflict(location_id,title,due_date) do update set title=excluded.title returning id into target;
  end if;
  kind:='obligation';

 elsif p_action='document.register' then
  kind:=p->>'kind';if not public.snacky_crm_allowed(kind,target,true) then raise exception 'Attachment access denied' using errcode='42501';end if;
  document_path:=p->>'object_path';
  if split_part(document_path,'/',1)<>auth.uid()::text or split_part(document_path,'/',2)<>kind or split_part(document_path,'/',3)<>target::text or not exists(select 1 from storage.objects where bucket_id='crm-documents' and name=document_path) then raise exception 'Uploaded file could not be verified';end if;
  insert into public.crm_documents(lead_id,location_id,issue_id,contact_id,obligation_id,task_id,object_path,original_name,mime_type,uploaded_by)
  values(case when kind='lead' then target end,case when kind='location' then target end,case when kind='issue' then target end,case when kind='contact' then target end,case when kind='obligation' then target end,case when kind='task' then target end,document_path,left(p->>'original_name',200),p->>'mime_type',me) on conflict(object_path) do nothing;
  perform public.snacky_crm_emit(kind,target,'document_uploaded','Document uploaded: '||left(p->>'original_name',200));

 elsif p_action='bonus.save' then
  if not public.snacky_current_profile_has_any_role(array['owner','admin']) then raise exception 'Bonus approval is management-only' using errcode='42501';end if;
  insert into public.crm_lead_bonus(lead_id,eligible,amount_lyd,status,notes,updated_by) values(target,coalesce((p->>'eligible')::boolean,false),nullif(p->>'amount_lyd','')::numeric,coalesce(p->>'status','pending'),p->>'notes',me)
  on conflict(lead_id) do update set eligible=excluded.eligible,amount_lyd=excluded.amount_lyd,status=excluded.status,notes=excluded.notes,updated_by=me,updated_at=now();kind:='lead';

 elsif p_action='record.archive' then
  kind:=p->>'kind';if not manager or not public.snacky_crm_allowed(kind,target) then raise exception 'Management must archive or restore records' using errcode='42501';end if;
  if nullif(trim(p->>'reason'),'') is null then raise exception 'An archive/restore reason is required';end if;
  if kind='lead' then update public.location_pipeline_leads set is_archived=not coalesce((p->>'restore')::boolean,false),archived_at=case when coalesce((p->>'restore')::boolean,false) then null else now() end,archived_by_user_id=me,updated_at=now(),updated_by_member_id=me where id=target;
  elsif kind='issue' then update public.issues set archived_at=case when coalesce((p->>'restore')::boolean,false) then null else now() end,archive_reason=p->>'reason',updated_at=now(),updated_by=me where id=target;
  elsif kind='task' then update public.crm_tasks set archived_at=case when coalesce((p->>'restore')::boolean,false) then null else now() end,updated_at=now(),updated_by=me where id=target;
  elsif kind='contact' then update public.crm_contacts set archived_at=case when coalesce((p->>'restore')::boolean,false) then null else now() end,updated_at=now(),updated_by=me where id=target;
  elsif kind='obligation' then
   if coalesce((p->>'restore')::boolean,false) or not exists(select 1 from public.location_admin_obligations where id=target and status='open') then raise exception 'Only an open obligation can be cancelled; paid history cannot be reversed here';end if;
   update public.location_admin_obligations set status='cancelled',notes=concat_ws(E'\n',notes,p->>'reason'),updated_at=now(),updated_by=me where id=target and status='open';
  else raise exception 'Unsupported archive target';end if;
  perform public.snacky_crm_emit(kind,target,'archive_change',trim(p->>'reason'));
 else raise exception 'Unsupported relationship action' using errcode='22023';end if;

 answer:=coalesce(answer,jsonb_build_object('kind',kind,'id',target));
 insert into public.crm_command_receipts(id,actor_user_id,action,request,response) values(p_command_id,auth.uid(),p_action,req,answer);
 return answer;
end $$;
revoke all on function public.snacky_crm_command_v1(uuid,text,uuid,jsonb) from public,anon;
grant execute on function public.snacky_crm_command_v1(uuid,text,uuid,jsonb) to authenticated;
