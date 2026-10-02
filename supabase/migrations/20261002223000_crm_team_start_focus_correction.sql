-- Correct CRM team start/focus semantics after the 1 Oct 2026 kickoff.
-- 1 Oct is the team start, not a follow-up deadline. All current rents remain shared CRM work.
begin;

update public.team_members
set crm_focus=null
where id in (
  'd6212c40-92c8-40dc-81af-8226b2e65613',
  '8e1f8e0c-613f-4c08-ab31-55bf94d4164b'
);

update public.location_pipeline_leads
set visibility='team',
    next_action_date=null,
    next_follow_up_date=null,
    updated_at=clock_timestamp()
where id in (
  '9cdbd65b-50f8-4d92-b2d7-8cd30ec2179c',
  '63bb3e26-159e-429f-b06c-07831f16b22b',
  'b54aebf7-3ec2-4cfc-ab9b-e49ee6c00dd7'
);

-- Ahed is only the canonical stored assignee. Active CRM users share these records.
update public.location_admin_obligations
set assigned_to='d6212c40-92c8-40dc-81af-8226b2e65613',
    updated_at=clock_timestamp()
where status='open'
  and coalesce(is_historical,false)=false
  and coalesce(is_practice,false)=false;

-- Shared review window from the actual CRM kickoff. This is not a follow-up deadline.
insert into crm_lead_private.focus(
  lead_id,starts_on,ends_on,removed_at,revision,updated_by,updated_at
)
select v.lead_id,v.starts_on,v.ends_on,null,1,'bef7c60f-2040-451f-9ea0-a1799964360b',clock_timestamp()
from (
  values
    ('9cdbd65b-50f8-4d92-b2d7-8cd30ec2179c'::uuid,date '2026-10-01',date '2026-10-15'),
    ('63bb3e26-159e-429f-b06c-07831f16b22b'::uuid,date '2026-10-01',date '2026-10-15'),
    ('b54aebf7-3ec2-4cfc-ab9b-e49ee6c00dd7'::uuid,date '2026-10-01',date '2026-10-15')
) as v(lead_id,starts_on,ends_on)
join public.location_pipeline_leads l on l.id=v.lead_id
where exists(
  select 1
  from public.team_members t
  where t.id='bef7c60f-2040-451f-9ea0-a1799964360b'
)
on conflict(lead_id) do update
set starts_on=excluded.starts_on,
    ends_on=excluded.ends_on,
    removed_at=null,
    revision=crm_lead_private.focus.revision+1,
    updated_by=excluded.updated_by,
    updated_at=clock_timestamp();

-- "Mine" for a CRM user means the shared active CRM-team focus, not only one UUID.
do $$
declare ddl text;
begin
  select pg_get_functiondef('crm_lead_private.workspace(jsonb)'::regprocedure) into ddl;
  if ddl is null then raise exception 'crm_lead_private.workspace not found'; end if;

  if position('crmteam boolean:=' in ddl)=0 then
    ddl:=replace(
      ddl,
      'me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();',
      'me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();crmteam boolean:=public.snacky_current_profile_has_any_role(array[''crm'']);'
    );
  end if;

  if position('and (scope<>''mine'' or r.assigned_to=me or (crmteam and public.snacky_crm_team_owned_v1(''lead'',r.id)))' in ddl)=0 then
    if position('and (scope<>''mine'' or r.assigned_to=me)' in ddl)=0 then
      raise exception 'Review crm_lead_private.workspace scope filter before applying shared CRM focus';
    end if;
    ddl:=replace(
      ddl,
      'and (scope<>''mine'' or r.assigned_to=me)',
      'and (scope<>''mine'' or r.assigned_to=me or (crmteam and public.snacky_crm_team_owned_v1(''lead'',r.id)))'
    );
  end if;

  execute ddl;
end $$;

select pg_notify('pgrst','reload schema');
commit;
