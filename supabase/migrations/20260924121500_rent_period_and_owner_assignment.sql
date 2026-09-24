-- Make the rent/service period explicit on every location payment obligation,
-- and let owner/admin reassign current obligations without rewriting history.

alter table public.location_admin_obligations
  add column if not exists rent_period_start_month date,
  add column if not exists rent_period_end_month date;

update public.location_admin_obligations
set
  rent_period_start_month = coalesce(
    rent_period_start_month,
    date_trunc('month', due_date)::date
  ),
  rent_period_end_month = coalesce(
    rent_period_end_month,
    (
      date_trunc('month', due_date)
      + case frequency
          when 'quarterly' then interval '2 months'
          when 'yearly' then interval '11 months'
          else interval '0 months'
        end
    )::date
  )
where due_date is not null
  and (rent_period_start_month is null or rent_period_end_month is null);

alter table public.location_admin_obligations
  drop constraint if exists location_admin_obligations_rent_period_valid;

alter table public.location_admin_obligations
  add constraint location_admin_obligations_rent_period_valid
  check (
    (rent_period_start_month is null and rent_period_end_month is null)
    or (
      rent_period_start_month is not null
      and rent_period_end_month is not null
      and extract(day from rent_period_start_month)=1
      and extract(day from rent_period_end_month)=1
      and rent_period_end_month >= rent_period_start_month
    )
  );

create or replace function public.snacky_fill_obligation_rent_period_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $period$
declare
  base_month date;
begin
  if new.due_date is null then
    return new;
  end if;

  base_month := date_trunc('month', new.due_date)::date;

  if new.rent_period_start_month is null then
    new.rent_period_start_month := base_month;
  end if;

  if new.rent_period_end_month is null then
    new.rent_period_end_month :=
      (
        date_trunc('month', new.rent_period_start_month)
        + case new.frequency
            when 'quarterly' then interval '2 months'
            when 'yearly' then interval '11 months'
            else interval '0 months'
          end
      )::date;
  end if;

  return new;
end;
$period$;

drop trigger if exists location_admin_obligations_fill_rent_period_v1 on public.location_admin_obligations;
create trigger location_admin_obligations_fill_rent_period_v1
before insert or update of due_date,frequency,rent_period_start_month,rent_period_end_month
on public.location_admin_obligations
for each row execute function public.snacky_fill_obligation_rent_period_v1();

revoke all on function public.snacky_fill_obligation_rent_period_v1() from public, anon, authenticated;

create or replace function public.snacky_obligation_admin_update_v1(
  p_obligation_id uuid,
  p_assigned_to uuid,
  p_period_start_month date,
  p_period_end_month date,
  p_version timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $admin_update$
declare
  me uuid := public.snacky_current_team_member_id();
  old_row public.location_admin_obligations%rowtype;
  changed_assignment boolean := false;
  changed_period boolean := false;
begin
  if me is null or not public.snacky_current_profile_has_any_role(array['owner','admin']) then
    raise exception 'Only owner/admin can change rent responsibility or period'
      using errcode='42501';
  end if;

  select * into old_row
  from public.location_admin_obligations
  where id=p_obligation_id
  for update;

  if not found then
    raise exception 'Location payment not found' using errcode='22023';
  end if;

  if old_row.updated_at is distinct from p_version then
    raise exception 'Location payment changed. Reload before saving' using errcode='40001';
  end if;

  if old_row.is_historical then
    raise exception 'Historical payment ownership is preserved as recorded'
      using errcode='42501';
  end if;

  if old_row.status='cancelled' then
    raise exception 'Cancelled location payments cannot be reassigned'
      using errcode='22023';
  end if;

  if not exists(
    select 1 from public.team_members
    where id=p_assigned_to and active and active_status='active'
  ) then
    raise exception 'Choose an active responsible employee'
      using errcode='22023';
  end if;

  if p_period_start_month is null or p_period_end_month is null
     or extract(day from p_period_start_month)<>1
     or extract(day from p_period_end_month)<>1
     or p_period_end_month<p_period_start_month then
    raise exception 'Choose a valid rent month or month range'
      using errcode='22023';
  end if;

  changed_assignment := old_row.assigned_to is distinct from p_assigned_to;
  changed_period :=
    old_row.rent_period_start_month is distinct from p_period_start_month
    or old_row.rent_period_end_month is distinct from p_period_end_month;

  update public.location_admin_obligations
  set assigned_to=p_assigned_to,
      rent_period_start_month=p_period_start_month,
      rent_period_end_month=p_period_end_month,
      updated_by=me,
      updated_at=now()
  where id=p_obligation_id;

  if changed_assignment then
    perform public.snacky_crm_emit(
      'obligation',
      p_obligation_id,
      'assignment_changed',
      'Location payment responsible employee changed',
      to_jsonb(old_row),
      jsonb_build_object('assigned_to',p_assigned_to)
    );
  end if;

  if changed_period then
    perform public.snacky_crm_emit(
      'obligation',
      p_obligation_id,
      'period_changed',
      'Rent/payment period changed',
      jsonb_build_object(
        'rent_period_start_month',old_row.rent_period_start_month,
        'rent_period_end_month',old_row.rent_period_end_month
      ),
      jsonb_build_object(
        'rent_period_start_month',p_period_start_month,
        'rent_period_end_month',p_period_end_month
      )
    );
  end if;

  return jsonb_build_object('kind','obligation','id',p_obligation_id);
end;
$admin_update$;

revoke all on function public.snacky_obligation_admin_update_v1(uuid,uuid,date,date,timestamptz) from public, anon;
grant execute on function public.snacky_obligation_admin_update_v1(uuid,uuid,date,date,timestamptz) to authenticated;

comment on column public.location_admin_obligations.rent_period_start_month is
'First month covered by this rent/location payment obligation; stored as the first day of that month.';
comment on column public.location_admin_obligations.rent_period_end_month is
'Last month covered by this rent/location payment obligation; stored as the first day of that month.';
