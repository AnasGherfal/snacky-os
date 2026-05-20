alter table storage_locations
  add column if not exists location_type text not null default 'main_storage',
  add column if not exists related_operator_id uuid references team_members(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

update storage_locations
set location_type = 'main_storage'
where location_type is null
  or location_type = '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'storage_locations_location_type_check'
  ) then
    alter table storage_locations
      add constraint storage_locations_location_type_check
      check (location_type in ('main_storage', 'operator_bag', 'vehicle', 'damaged', 'expired', 'temporary', 'other'));
  end if;
end $$;

create index if not exists idx_storage_locations_location_type on storage_locations(location_type);
create index if not exists idx_storage_locations_related_operator on storage_locations(related_operator_id);
create index if not exists idx_storage_locations_active_type on storage_locations(active, location_type);

