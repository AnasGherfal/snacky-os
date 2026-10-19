-- Presentation and assignment only: existing issues, tasks, sales and stock stay intact.
begin;
set local lock_timeout='5s';

create or replace function public.snacky_issue_field_workspace_v1(p_issue_id uuid)
returns jsonb language plpgsql stable security definer set search_path to '' as $fn$
declare
 v_me uuid:=public.snacky_current_team_member_id();
 v_staff boolean:=public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']);
 v_issue public.issues%rowtype;
 v_tasks jsonb; v_ops jsonb; v_can_assign boolean;
begin
 if auth.uid() is null or v_me is null or not public.snacky_crm_allowed('issue',p_issue_id,false) then
  raise exception 'Issue access denied' using errcode='42501';
 end if;
 select * into strict v_issue from public.issues where id=p_issue_id;
 v_can_assign:=v_staff and v_issue.archived_at is null and v_issue.status::text not in ('resolved','closed') and (
  public.snacky_crm_allowed('issue',p_issue_id,true) or (
   v_issue.issue_type='machine_unavailable' and v_issue.contact_channel='other'
   and nullif(btrim(v_issue.customer_name),'') is null
   and nullif(btrim(v_issue.customer_phone),'') is null
   and nullif(btrim(v_issue.customer_whatsapp),'') is null
   and coalesce(v_issue.amount_involved_lyd,0)=0 and coalesce(v_issue.refund_amount_lyd,0)=0
  )
 );
 select coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object(
  'version',t.updated_at::text,'assigned_name',m.full_name,
  'can_act',t.assigned_to=v_me and t.archived_at is null and t.status<>'completed' and v_issue.status::text not in ('resolved','closed'),
  'proof_images',(select count(*) from public.crm_documents d where d.task_id=t.id and lower(coalesce(d.mime_type,'')) like 'image/%'),
  'documents',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.original_name,'mime_type',d.mime_type) order by d.created_at),'[]'::jsonb) from public.crm_documents d where d.task_id=t.id and public.snacky_crm_allowed('task',t.id,false))
 ) order by t.created_at desc),'[]'::jsonb) into v_tasks
 from public.crm_tasks t left join public.team_members m on m.id=t.assigned_to
 where t.issue_id=p_issue_id and t.task_type='field_action' and t.archived_at is null
 and (v_staff or t.assigned_to=v_me);
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',full_name) order by full_name),'[]'::jsonb) into v_ops
 from public.team_members t where v_can_assign and t.active and t.active_status='active'
 and (t.role::text='operator' or coalesce(t.roles::text[],'{}')&&array['operator']);
 return jsonb_build_object('ok',true,'issue_id',p_issue_id,'user_id',auth.uid(),'staff',v_staff,
  'can_assign',v_can_assign,'operators',v_ops,'tasks',v_tasks,'issue_status',v_issue.status,
  'priority',v_issue.priority,'machine_id',v_issue.machine_id,
  'machine_name',(select name from public.machines where id=v_issue.machine_id));
end $fn$;
revoke all on function public.snacky_issue_field_workspace_v1(uuid) from public,anon;
grant execute on function public.snacky_issue_field_workspace_v1(uuid) to authenticated;

-- Same existing field-assignment contract. Claim and direct assignment compete
-- for the same row; NOWAIT prevents deadlocks against a concurrent operator claim.
create or replace function public.snacky_issue_field_queue_command_v1(
 p_action text,p_issue_id uuid default null,p_task_id uuid default null,p_payload jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path to '' as $fn$
declare
 me uuid:=public.snacky_current_team_member_id();
 issue public.issues%rowtype; task public.crm_tasks%rowtype;
 v_operator_id uuid; v_priority text; v_title text; v_notes text;
 v_now timestamptz:=clock_timestamp(); v_due date:=(clock_timestamp() at time zone 'Africa/Tripoli')::date;
begin
 if auth.uid() is null or me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']) then
  raise exception 'Customer relations access required' using errcode='42501';
 end if;
 if p_action<>'create' then raise exception 'Only CRM field assignment is supported' using errcode='22023';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>12000 then
  raise exception 'Invalid assignment request' using errcode='22023';end if;
 if p_issue_id is null or not public.snacky_crm_allowed('issue',p_issue_id,false) then
  raise exception 'Issue unavailable' using errcode='42501';end if;
 select * into issue from public.issues where id=p_issue_id for update;
 if not found or issue.archived_at is not null or issue.status::text in ('resolved','closed') then
  raise exception 'Issue is not open' using errcode='23514';end if;
 if not public.snacky_crm_allowed('issue',p_issue_id,true) and not (
  issue.issue_type='machine_unavailable' and issue.contact_channel='other'
  and nullif(btrim(issue.customer_name),'') is null and nullif(btrim(issue.customer_phone),'') is null
  and nullif(btrim(issue.customer_whatsapp),'') is null
  and coalesce(issue.amount_involved_lyd,0)=0 and coalesce(issue.refund_amount_lyd,0)=0
 ) then raise exception 'This customer case belongs to another employee' using errcode='42501';end if;
 begin v_operator_id:=(p_payload->>'operator_id')::uuid;
 exception when invalid_text_representation then raise exception 'Choose a valid operator' using errcode='22023';end;
 if v_operator_id is null or not exists(select 1 from public.team_members t where t.id=v_operator_id and t.active and t.active_status='active' and (t.role::text='operator' or coalesce(t.roles::text[],'{}')&&array['operator'])) then
  raise exception 'Choose an active operator' using errcode='23514';end if;
 v_notes:=nullif(btrim(p_payload->>'notes'),'');
 v_title:=coalesce(nullif(btrim(p_payload->>'title'),''),'Inspect and fix machine issue');
 if length(coalesce(v_notes,''))>2000 or length(v_title)>240 then raise exception 'Instructions are too long' using errcode='22023';end if;
 v_priority:=case coalesce(nullif(p_payload->>'priority',''),issue.priority::text,'normal') when 'critical' then 'urgent' when 'urgent' then 'urgent' when 'high' then 'high' when 'low' then 'low' else 'normal' end;
 select * into task from public.crm_tasks t where t.issue_id=p_issue_id and t.task_type='field_action' and t.archived_at is null and t.status<>'completed' order by t.created_at desc limit 1 for update nowait;
 if found then
  if task.assigned_to=v_operator_id then
   return jsonb_build_object('ok',true,'action','create','task_id',task.id,'dispatch_state',task.dispatch_state,'assigned_to',task.assigned_to,'already_assigned',true);
  end if;
  if task.dispatch_state<>'available' or task.assigned_to is not null then
   raise exception 'Another operator already owns the active field work. Refresh the issue.' using errcode='40001';end if;
  -- Assign the existing queue row; never create a second repair task.
  update public.crm_tasks set assigned_to=v_operator_id,notes=coalesce(v_notes,notes),priority=v_priority,
   updated_at=v_now,updated_by=me where id=task.id returning * into task;
  update public.notifications set read_at=coalesce(read_at,v_now)
   where source_kind='task' and source_id=task.id and event_kind='available' and read_at is null;
 else
  insert into public.crm_tasks(title,issue_id,task_type,assigned_to,due_date,priority,notes,status,created_by,updated_by,is_practice)
   values(v_title,p_issue_id,'field_action',v_operator_id,v_due,v_priority,v_notes,'open',me,me,coalesce(issue.is_practice,false)) returning * into task;
 end if;
 update public.issues set status='assigned',is_waiting=true,waiting_on='operator',
  next_action='Operator field visit assigned by Customer Relations',next_action_date=v_due,updated_at=v_now,updated_by=me where id=p_issue_id;
 perform public.snacky_crm_emit('issue',p_issue_id,'field_assigned','Operator field visit assigned from issue',null,jsonb_build_object('task_id',task.id,'operator_id',v_operator_id));
 return jsonb_build_object('ok',true,'action','create','task_id',task.id,'dispatch_state',task.dispatch_state,'assigned_to',task.assigned_to);
end $fn$;

-- Follow-ups are calls/visits/admin reminders, not separate copies of repairs.
-- Filter before paging/counting. Detail RPC remains available for audit and old links.
do $patch$
declare s text; a text; b text;
begin
 select pg_get_functiondef('public.snacky_crm_workspace_v1(text,uuid,jsonb)'::regprocedure) into s;
 a:='(p_section in (''work'',''search'',''management'') or r.kind=p_section)';
 b:=a||E'\n   and (p_section<>''task'' or coalesce(r.data->>''task_type'','''')<>''field_action'')';
 if position(b in s)=0 then
  if (length(s)-length(replace(s,a,'')))/length(a)<>1 then raise exception 'CRM workspace changed; rebase the filter patch';end if;
  execute replace(s,a,b);
 end if;
 -- Read-only repair sales for CRM viewing an authorized parent issue; write
 -- authorization remains assigned operator + working task in the sale RPC.
 select pg_get_functiondef('public.snacky_repair_sale_workspace_v1(uuid)'::regprocedure) into s;
 a:='not public.snacky_crm_allowed(''task'',p_task_id,false)';
 b:='not (public.snacky_crm_allowed(''task'',p_task_id,false) or (public.snacky_current_profile_has_any_role(array[''owner'',''admin'',''supervisor'',''crm'']) and public.snacky_crm_allowed(''issue'',v_task.issue_id,false)))';
 if position(b in s)=0 then
  if (length(s)-length(replace(s,a,'')))/length(a)<>1 then raise exception 'Repair workspace changed; rebase the read patch';end if;
  execute replace(s,a,b);
 end if;
end $patch$;
select pg_notify('pgrst','reload schema');
commit;
