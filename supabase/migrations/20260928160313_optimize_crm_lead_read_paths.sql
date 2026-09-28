create index if not exists idx_location_pipeline_leads_converted_location
  on public.location_pipeline_leads (converted_location_id)
  where converted_location_id is not null;

create index if not exists idx_crm_contact_links_lead
  on public.crm_contact_links (lead_id)
  where lead_id is not null;

create index if not exists idx_crm_contact_links_location
  on public.crm_contact_links (location_id)
  where location_id is not null;

create index if not exists idx_crm_contact_links_issue
  on public.crm_contact_links (issue_id)
  where issue_id is not null;

create index if not exists idx_crm_documents_lead
  on public.crm_documents (lead_id)
  where lead_id is not null;

create index if not exists idx_crm_documents_location
  on public.crm_documents (location_id)
  where location_id is not null;

create index if not exists idx_crm_documents_issue
  on public.crm_documents (issue_id)
  where issue_id is not null;

create index if not exists idx_crm_documents_contact
  on public.crm_documents (contact_id)
  where contact_id is not null;

create index if not exists idx_crm_documents_obligation
  on public.crm_documents (obligation_id)
  where obligation_id is not null;

create index if not exists idx_crm_documents_task
  on public.crm_documents (task_id)
  where task_id is not null;

create index if not exists idx_crm_tasks_contact
  on public.crm_tasks (contact_id)
  where contact_id is not null;

create index if not exists idx_crm_tasks_obligation
  on public.crm_tasks (obligation_id)
  where obligation_id is not null;

create index if not exists idx_crm_activities_contact
  on public.crm_activities (contact_id, occurred_at desc)
  where contact_id is not null;

create index if not exists idx_crm_activities_obligation
  on public.crm_activities (obligation_id, occurred_at desc)
  where obligation_id is not null;

drop index if exists public.idx_location_pipeline_leads_assignee;

create or replace function crm_collab_private.labels_for_workspace(
  p_lead uuid,
  p_active boolean,
  p_manager boolean,
  p_actor uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', l.id,
        'name', l.name,
        'color', l.color,
        'owner_id', l.owner_id,
        'owner_name', p.full_name
      )
      order by l.name, l.id
    ),
    '[]'::jsonb
  )
  from crm_collab_private.lead_labels x
  join crm_collab_private.labels l on l.id = x.label_id
  join public.profiles p on p.id = l.owner_id
  where p_active
    and x.lead_id = p_lead
    and not l.archived
    and (p_manager or l.owner_id = p_actor);
$fn$;

revoke all on function crm_collab_private.labels_for_workspace(uuid,boolean,boolean,uuid)
  from public, anon, authenticated;

do $patch$
declare
  ddl text;
  old_auth text := 'where r.kind=''lead'' and public.snacky_crm_allowed(''lead'',r.id)';
  new_auth text := 'where r.kind=''lead'' and (manager or coalesce(r.data->>''visibility'','''')=''team'' or r.assigned_to=me or nullif(r.data->>''created_by_member_id'','''')::uuid=me)';
  old_decl text := 'me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();';
  new_decl text := 'me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();actor uuid:=auth.uid();collab_active boolean:=crm_collab_private.active();collab_manager boolean:=crm_collab_private.manager();';
  old_labels text := 'crm_collab_private.labels_for((value->>''id'')::uuid)';
  new_labels text := 'crm_collab_private.labels_for_workspace((value->>''id'')::uuid,collab_active,collab_manager,actor)';
begin
  select pg_get_functiondef('crm_lead_private.workspace(jsonb)'::regprocedure) into ddl;
  if ddl is null then raise exception 'crm_lead_private.workspace not found'; end if;

  if position(new_auth in ddl) = 0 then
    if position(old_auth in ddl) = 0 then raise exception 'lead desk authorization anchor not found'; end if;
    ddl := replace(ddl, old_auth, new_auth);
  end if;

  if position(new_decl in ddl) = 0 then
    if position(old_decl in ddl) = 0 then raise exception 'lead desk declaration anchor not found'; end if;
    ddl := replace(ddl, old_decl, new_decl);
  end if;

  if position(new_labels in ddl) = 0 then
    if position(old_labels in ddl) = 0 then raise exception 'lead desk label anchor not found'; end if;
    ddl := replace(ddl, old_labels, new_labels);
  end if;

  execute ddl;
end
$patch$;

do $patch$
declare
  ddl text;
  old_where text := 'where (manager or public.snacky_crm_allowed(r.kind,r.id))';
  new_where text := $sql$where (
    manager
    or case
      when staff and r.kind='lead' then (
        coalesce(r.data->>'visibility','')='team'
        or r.assigned_to=me
        or nullif(r.data->>'created_by_member_id','')::uuid=me
      )
      when staff and r.kind in ('issue','location','contact') then true
      when staff and r.kind='obligation' then (
        r.assigned_to=me
        or (
          coalesce((r.data->>'is_historical')::boolean,false)
          and exists (
            select 1
            from public.location_relationships lr
            where lr.location_id=r.location_id
              and lr.assigned_to=me
          )
        )
      )
      else public.snacky_crm_allowed(r.kind,r.id)
    end
  )$sql$;
  old_contacts text := 'from public.crm_contacts where archived_at is null and public.snacky_crm_allowed(''contact'',id)';
  new_contacts text := 'from public.crm_contacts where archived_at is null';
begin
  select pg_get_functiondef('public.snacky_crm_workspace_v1(text,uuid,jsonb)'::regprocedure) into ddl;
  if ddl is null then raise exception 'snacky_crm_workspace_v1 not found'; end if;

  if position(new_where in ddl) = 0 then
    if position(old_where in ddl) = 0 then raise exception 'CRM workspace authorization anchor not found'; end if;
    ddl := replace(ddl, old_where, new_where);
  end if;

  if position(new_contacts in ddl) = 0 then
    if position(old_contacts in ddl) = 0 then raise exception 'CRM contact options anchor not found'; end if;
    ddl := replace(ddl, old_contacts, new_contacts);
  end if;

  execute ddl;
end
$patch$;

select pg_notify('pgrst','reload schema');
