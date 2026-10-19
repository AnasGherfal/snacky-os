-- The employee who owns CRM follow-up is not necessarily the operator who
-- was assigned the repair. Keep permissions/audit ownership unchanged and
-- expose a separate authoritative field-assignment projection for the UI.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.snacky_issue_assignment_summary_v1(p_issue_ids uuid[])
returns table (
 issue_id uuid,
 field_task_id uuid,
 operator_id uuid,
 operator_name text,
 dispatch_state text
)
language plpgsql
stable security definer
set search_path to ''
as $summary$
begin
 if auth.uid() is null or public.snacky_current_team_member_id() is null
   or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then
  raise exception 'Active staff access required' using errcode='42501';
 end if;
 if coalesce(cardinality(p_issue_ids),0)>200 then
  raise exception 'Too many issues requested' using errcode='22023';
 end if;
 return query
 select i.id,field.id,field.assigned_to,member.full_name,field.dispatch_state
 from public.issues i
 left join lateral (
  select t.id,t.assigned_to,t.dispatch_state
  from public.crm_tasks t
  where t.issue_id=i.id and t.task_type='field_action' and t.archived_at is null
    and (public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm'])
      or t.assigned_to=public.snacky_current_team_member_id())
  order by t.created_at desc,t.id desc
  limit 1
 ) field on true
 left join public.team_members member on member.id=field.assigned_to
 where i.id=any(coalesce(p_issue_ids,'{}'::uuid[]))
   and public.snacky_crm_allowed('issue',i.id,false);
end
$summary$;
revoke all on function public.snacky_issue_assignment_summary_v1(uuid[]) from public,anon;
grant execute on function public.snacky_issue_assignment_summary_v1(uuid[]) to authenticated;

-- Patch only the list ordering and employee filter, preserving the complete
-- existing authorization, field-work exclusions, history and pagination.
do $ordering$
declare
 definition text;
 old_fragment text;
 new_fragment text;
begin
 definition:=pg_get_functiondef('public.snacky_crm_workspace_v1(text,uuid,jsonb)'::regprocedure);
 if position('issue-newest-first-v1' in definition)=0 then
  old_fragment:='order by overdue desc nulls last,due_date nulls last,updated_at desc,id limit 40 offset skip';
  new_fragment:='order by /* issue-newest-first-v1 */ case when p_section=''issue'' then created_at end desc nulls last,case when p_section=''issue'' then id end desc,case when p_section<>''issue'' then overdue end desc nulls last,case when p_section<>''issue'' then due_date end nulls last,updated_at desc,id limit 40 offset skip';
  if position(old_fragment in definition)=0 then raise exception 'Inner workspace ordering changed; review migration';end if;
  definition:=replace(definition,old_fragment,new_fragment);
  old_fragment:='order by x.overdue desc nulls last,x.due_date nulls last,x.updated_at desc';
  new_fragment:='order by case when p_section=''issue'' then x.created_at end desc nulls last,case when p_section=''issue'' then x.id end desc,case when p_section<>''issue'' then x.overdue end desc nulls last,case when p_section<>''issue'' then x.due_date end nulls last,x.updated_at desc,x.id';
  if position(old_fragment in definition)=0 then raise exception 'Outer workspace ordering changed; review migration';end if;
  definition:=replace(definition,old_fragment,new_fragment);
  -- The issue employee filter follows the current repair assignee when there
  -- is field work, rather than misleadingly treating the reporter as operator.
  old_fragment:='and (nullif(p_filters->>''assigned_to'','''') is null or r.assigned_to=(p_filters->>''assigned_to'')::uuid)';
  new_fragment:='and (nullif(p_filters->>''assigned_to'','''') is null or case when r.kind=''issue'' and exists(select 1 from public.crm_tasks f where f.issue_id=r.id and f.task_type=''field_action'' and f.archived_at is null) then (select f.assigned_to from public.crm_tasks f where f.issue_id=r.id and f.task_type=''field_action'' and f.archived_at is null order by f.created_at desc,f.id desc limit 1) else r.assigned_to end=(p_filters->>''assigned_to'')::uuid)';
  if position(old_fragment in definition)=0 then raise exception 'Workspace employee filter changed; review migration';end if;
  definition:=replace(definition,old_fragment,new_fragment);
  execute definition;
 end if;
end
$ordering$;
select pg_notify('pgrst','reload schema');
commit;
