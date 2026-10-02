-- Shared two-person CRM queue plus direct, idempotent machine-fault reporting.
begin;

create or replace function public.snacky_crm_team_owned_v1(p_kind text,p_id uuid)
returns boolean
language plpgsql stable security definer
set search_path to ''
as $function$
begin
  if p_id is null then return false; end if;
  if p_kind='lead' then
    return exists(select 1 from public.location_pipeline_leads l join public.team_members a on a.id=l.assigned_to_user_id
      where l.id=p_id and l.visibility='team' and a.active and a.active_status='active'
        and (a.role::text='crm' or a.roles::text[]&&array['crm']));
  elsif p_kind='issue' then
    return exists(select 1 from public.issues i where i.id=p_id and (
      exists(select 1 from public.team_members a where a.id=i.assigned_to and a.active and a.active_status='active' and (a.role::text='crm' or a.roles::text[]&&array['crm']))
      or exists(select 1 from public.team_members a where a.id=i.reported_by and a.active and a.active_status='active' and (a.role::text='crm' or a.roles::text[]&&array['crm']))));
  elsif p_kind='location' then
    return exists(select 1 from public.location_relationships r join public.team_members a on a.id=r.assigned_to
      where r.location_id=p_id and a.active and a.active_status='active' and (a.role::text='crm' or a.roles::text[]&&array['crm']));
  elsif p_kind='obligation' then
    return exists(select 1 from public.location_admin_obligations o join public.team_members a on a.id=o.assigned_to
      where o.id=p_id and a.active and a.active_status='active' and (a.role::text='crm' or a.roles::text[]&&array['crm']));
  elsif p_kind='task' then
    return exists(select 1 from public.crm_tasks t join public.team_members a on a.id=t.assigned_to
      where t.id=p_id and a.active and a.active_status='active' and (a.role::text='crm' or a.roles::text[]&&array['crm']));
  end if;
  return false;
end
$function$;
revoke all on function public.snacky_crm_team_owned_v1(text,uuid) from public,anon;
grant execute on function public.snacky_crm_team_owned_v1(text,uuid) to authenticated,service_role;

do $$
declare ddl text;
begin
 select pg_get_functiondef('public.snacky_crm_allowed(text,uuid,boolean)'::regprocedure) into ddl;
 if position('crmteam boolean:=' in ddl)=0 then
  ddl:=replace(ddl,'staff boolean:=public.snacky_crm_staff();','staff boolean:=public.snacky_crm_staff();crmteam boolean:=public.snacky_current_profile_has_any_role(array[''crm'']);');
 end if;
 ddl:=replace(ddl,'(crmteam and l.visibility=''team'')','(crmteam and public.snacky_crm_team_owned_v1(''lead'',l.id))');
 ddl:=replace(ddl,'case when p_write then l.assigned_to_user_id=me or','case when p_write then (crmteam and public.snacky_crm_team_owned_v1(''lead'',l.id)) or l.assigned_to_user_id=me or');
 ddl:=replace(ddl,'not p_write or crmteam or i.assigned_to=me','not p_write or (crmteam and public.snacky_crm_team_owned_v1(''issue'',i.id)) or i.assigned_to=me');
 ddl:=replace(ddl,'not p_write or i.assigned_to=me or','not p_write or (crmteam and public.snacky_crm_team_owned_v1(''issue'',i.id)) or i.assigned_to=me or');
 ddl:=replace(ddl,'not p_write or crmteam or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)','not p_write or (crmteam and public.snacky_crm_team_owned_v1(''location'',l.id)) or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)');
 ddl:=replace(ddl,'not p_write or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)','not p_write or (crmteam and public.snacky_crm_team_owned_v1(''location'',l.id)) or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)');
 ddl:=regexp_replace(ddl,'\(crmteam and exists\(select 1 from public\.team_members a where a\.id=o\.assigned_to.*?array\[''crm''\]\)\)\)','(crmteam and public.snacky_crm_team_owned_v1(''obligation'',o.id))','g');
 ddl:=replace(ddl,'staff and (o.assigned_to=me or','staff and ((crmteam and public.snacky_crm_team_owned_v1(''obligation'',o.id)) or o.assigned_to=me or');
 ddl:=regexp_replace(ddl,'\(crmteam and exists\(select 1 from public\.team_members a where a\.id=t\.assigned_to.*?array\[''crm''\]\)\)\)','(crmteam and public.snacky_crm_team_owned_v1(''task'',t.id))','g');
 ddl:=replace(ddl,'manager or t.assigned_to=me or (staff and','manager or t.assigned_to=me or (crmteam and public.snacky_crm_team_owned_v1(''task'',t.id)) or (staff and');
 execute ddl;
end $$;

do $$
declare ddl text;
begin
 select pg_get_functiondef('public.snacky_crm_workspace_v1(text,uuid,jsonb)'::regprocedure) into ddl;
 if position('crmteam boolean:=' in ddl)=0 then
  ddl:=replace(ddl,'staff boolean:=public.snacky_crm_staff();owner_admin boolean:=public.snacky_current_profile_has_any_role(array[''owner'',''admin'']);','staff boolean:=public.snacky_crm_staff();crmteam boolean:=public.snacky_current_profile_has_any_role(array[''crm'']);owner_admin boolean:=public.snacky_current_profile_has_any_role(array[''owner'',''admin'']);');
 end if;
 ddl:=replace(ddl,'(crmteam and exists(select 1 from public.team_members a where a.id=r.assigned_to and a.active and a.active_status=''active'' and (a.role::text=''crm'' or a.roles::text[]&&array[''crm''])))','(crmteam and public.snacky_crm_team_owned_v1(''obligation'',r.id))');
 ddl:=replace(ddl,'when staff and r.kind=''obligation'' then (
        r.assigned_to=me','when staff and r.kind=''obligation'' then (
        (crmteam and public.snacky_crm_team_owned_v1(''obligation'',r.id)) or r.assigned_to=me');
 ddl:=replace(ddl,'and (scope<>''mine'' or r.assigned_to=me or (crmteam and public.snacky_crm_allowed(r.kind,r.id)))','and (scope<>''mine'' or r.assigned_to=me or (crmteam and public.snacky_crm_team_owned_v1(r.kind,r.id)))');
 ddl:=replace(ddl,'and (scope<>''mine'' or r.assigned_to=me)','and (scope<>''mine'' or r.assigned_to=me or (crmteam and public.snacky_crm_team_owned_v1(r.kind,r.id)))');
 execute ddl;
end $$;

create or replace function public.snacky_report_machine_issue_v1(p_request_id uuid,p_machine_id uuid,p_description text,p_priority text default 'high')
returns jsonb
language plpgsql security definer
set search_path to ''
as $function$
declare
 v_actor uuid:=auth.uid();v_me uuid;v_request jsonb;v_saved public.crm_command_receipts%rowtype;
 v_machine public.machines%rowtype;v_issue public.issues%rowtype;v_task_id uuid;v_dispatch jsonb;v_response jsonb;
 v_priority text:=lower(trim(coalesce(p_priority,'high')));v_description text:=nullif(trim(coalesce(p_description,'')),'');
begin
 if v_actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']) then raise exception 'Customer relations access required.' using errcode='42501';end if;
 v_me:=public.snacky_current_team_member_id();if v_me is null then raise exception 'Active team member required.' using errcode='42501';end if;
 if p_request_id is null or p_machine_id is null then raise exception 'Request and machine are required.' using errcode='22023';end if;
 if v_description is null or length(v_description)<3 or length(v_description)>2000 then raise exception 'Describe the machine problem in 3 to 2000 characters.' using errcode='22023';end if;
 if v_priority not in ('normal','high','critical') then raise exception 'Choose Normal, High or Critical priority.' using errcode='22023';end if;
 v_request:=jsonb_build_object('machine_id',p_machine_id,'description',v_description,'priority',v_priority);
 perform pg_advisory_xact_lock(hashtextextended('snacky:crm-machine-report:'||p_request_id::text,0));
 select * into v_saved from public.crm_command_receipts where id=p_request_id for update;
 if found then
  if v_saved.actor_user_id is distinct from v_actor or v_saved.action is distinct from 'machine.report' or v_saved.request is distinct from v_request then raise exception 'Saved request does not match this machine report.' using errcode='23505';end if;
  return v_saved.response;
 end if;
 select * into v_machine from public.machines where id=p_machine_id and status::text<>'inactive' for share;
 if not found then raise exception 'Machine is not active or was not found.' using errcode='23503';end if;
 perform pg_advisory_xact_lock(hashtextextended('snacky:machine-issue:'||p_machine_id::text,0));
 select * into v_issue from public.issues i where i.machine_id=p_machine_id and i.issue_type='machine_unavailable' and i.status::text not in ('resolved','closed') and i.archived_at is null and coalesce(i.is_practice,false)=false order by i.created_at desc limit 1 for update;
 if not found then
  insert into public.issues(machine_id,location_id,reported_by,assigned_to,issue_type,priority,status,description,contact_channel,updated_by)
  values(v_machine.id,v_machine.location_id,v_me,v_me,'machine_unavailable',v_priority::public.issue_priority,'open',v_description,'other',v_me) returning * into v_issue;
 end if;
 select t.id into v_task_id from public.crm_tasks t where t.issue_id=v_issue.id and t.task_type='field_action' and t.archived_at is null and t.status<>'completed' order by t.created_at desc limit 1;
 if v_task_id is null then
  v_dispatch:=public.snacky_issue_field_queue_command_v1('create',v_issue.id,null,jsonb_build_object('priority',v_priority,'title','Inspect and fix machine issue','notes',v_description));
  v_task_id:=nullif(v_dispatch->>'task_id','')::uuid;
 end if;
 if v_task_id is null then raise exception 'Operator field task was not created.' using errcode='23514';end if;
 v_response:=jsonb_build_object('ok',true,'id',v_issue.id,'kind','issue','task_id',v_task_id,'machine_id',v_machine.id,'machine_name',coalesce(nullif(v_machine.name,''),v_machine.machine_code),'operator_notified',true);
 insert into public.crm_command_receipts(id,actor_user_id,action,request,response) values(p_request_id,v_actor,'machine.report',v_request,v_response);
 return v_response;
end
$function$;
revoke all on function public.snacky_report_machine_issue_v1(uuid,uuid,text,text) from public,anon;
grant execute on function public.snacky_report_machine_issue_v1(uuid,uuid,text,text) to authenticated,service_role;

update public.location_pipeline_leads set visibility='team',next_action_date=date '2026-10-01',next_follow_up_date=date '2026-10-01',updated_at=clock_timestamp()
where id in ('9cdbd65b-50f8-4d92-b2d7-8cd30ec2179c','63bb3e26-159e-429f-b06c-07831f16b22b','b54aebf7-3ec2-4cfc-ab9b-e49ee6c00dd7');
update public.crm_tasks set archived_at=coalesce(archived_at,clock_timestamp()),updated_at=clock_timestamp() where id='5b3798bb-74b1-4944-be4b-54837947b0f7';
update public.location_admin_obligations set assigned_to='bef7c60f-2040-451f-9ea0-a1799964360b',updated_at=clock_timestamp()
where id='28ebcdd2-e6b8-431d-acfd-9ac639cd6254' and status='open';

select pg_notify('pgrst','reload schema');
commit;
