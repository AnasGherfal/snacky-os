alter table public.team_members
  add column if not exists crm_focus text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'team_members_crm_focus_check'
      and conrelid = 'public.team_members'::regclass
  ) then
    alter table public.team_members
      add constraint team_members_crm_focus_check
      check (crm_focus is null or crm_focus in ('office', 'field'));
  end if;
end $$;

comment on column public.team_members.crm_focus is
  'Non-authorization CRM work focus: office owns relationships/follow-up; field executes visits/field actions.';
