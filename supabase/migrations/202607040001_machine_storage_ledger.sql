do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'inventory_entity_type'
      and e.enumlabel = 'machine_storage'
  ) then
    alter type public.inventory_entity_type add value 'machine_storage';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'movement_reason'
      and e.enumlabel = 'extra_stock_left_at_machine'
  ) then
    alter type public.movement_reason add value 'extra_stock_left_at_machine';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'movement_reason'
      and e.enumlabel = 'other'
  ) then
    alter type public.movement_reason add value 'other';
  end if;
end $$;

alter table if exists public.inventory_movements
  add column if not exists related_route_stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists movement_type text;

create index if not exists idx_inventory_movements_movement_type
  on public.inventory_movements(movement_type)
  where movement_type is not null;

create table if not exists public.machine_storage_stock (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.machines(id) on delete cascade,
  location_id uuid references public.locations(id) on delete set null,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  quantity integer not null default 0,
  notes text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint machine_storage_stock_quantity_nonnegative check (quantity >= 0)
);

alter table public.machine_storage_stock
  add column if not exists location_id uuid references public.locations(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists product_name text,
  add column if not exists quantity integer not null default 0,
  add column if not exists notes text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists idx_machine_storage_stock_machine_product
  on public.machine_storage_stock(machine_id, product_id)
  where product_id is not null;

create index if not exists idx_machine_storage_stock_machine_updated
  on public.machine_storage_stock(machine_id, updated_at desc);

create index if not exists idx_machine_storage_stock_product_updated
  on public.machine_storage_stock(product_id, updated_at desc)
  where product_id is not null;

alter table public.machine_storage_stock enable row level security;

grant select on table public.machine_storage_stock to authenticated;

drop policy if exists "snacky_machine_storage_stock_select_by_roles" on public.machine_storage_stock;
create policy "snacky_machine_storage_stock_select_by_roles"
on public.machine_storage_stock for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'operator'])
);

create or replace function public.sync_machine_storage_stock_from_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_delta integer := 0;
  v_machine_id uuid;
  v_location_id uuid;
  v_product_name text;
begin
  if new.product_id is null then
    return new;
  end if;

  if coalesce(new.quantity, 0) <= 0 then
    return new;
  end if;

  if coalesce(new.to_entity_type::text, '') = 'machine_storage' then
    v_delta := coalesce(new.quantity, 0);
    v_machine_id := coalesce(new.related_machine_id, new.to_entity_id);
  elsif coalesce(new.from_entity_type::text, '') = 'machine_storage' then
    v_delta := -coalesce(new.quantity, 0);
    v_machine_id := coalesce(new.related_machine_id, new.from_entity_id);
  else
    return new;
  end if;

  if v_machine_id is null then
    return new;
  end if;

  select m.location_id
    into v_location_id
  from public.machines m
  where m.id = v_machine_id;

  select p.name
    into v_product_name
  from public.products p
  where p.id = new.product_id;

  if v_delta > 0 then
    insert into public.machine_storage_stock (
      machine_id,
      location_id,
      product_id,
      product_name,
      quantity,
      notes,
      updated_at
    )
    values (
      v_machine_id,
      v_location_id,
      new.product_id,
      v_product_name,
      v_delta,
      nullif(trim(coalesce(new.notes, '')), ''),
      now()
    )
    on conflict (machine_id, product_id) where product_id is not null
    do update set
      location_id = coalesce(excluded.location_id, public.machine_storage_stock.location_id),
      product_name = coalesce(excluded.product_name, public.machine_storage_stock.product_name),
      quantity = public.machine_storage_stock.quantity + excluded.quantity,
      notes = coalesce(excluded.notes, public.machine_storage_stock.notes),
      updated_at = now();
  else
    update public.machine_storage_stock
      set location_id = coalesce(v_location_id, location_id),
          product_name = coalesce(v_product_name, product_name),
          quantity = greatest(quantity + v_delta, 0),
          notes = coalesce(nullif(trim(coalesce(new.notes, '')), ''), notes),
          updated_at = now()
    where machine_id = v_machine_id
      and product_id = new.product_id;

    if not found then
      return new;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_machine_storage_stock_from_inventory_movement on public.inventory_movements;
create trigger trg_sync_machine_storage_stock_from_inventory_movement
after insert on public.inventory_movements
for each row
execute function public.sync_machine_storage_stock_from_inventory_movement();

drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements;
create policy "snacky_inventory_movements_insert_by_effective_role"
on public.inventory_movements for insert
to authenticated
with check (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  or (
    public.snacky_current_profile_has_any_role(array['warehouse', 'purchasing'])
    and reason::text = 'purchase_received'
    and from_entity_type::text = 'supplier'
    and to_entity_type::text = 'storage'
  )
  or (
    public.snacky_current_profile_has_any_role(array['warehouse'])
    and reason::text = any (array[
      'storage_to_operator_bag',
      'operator_bag_to_storage',
      'stock_count_adjustment',
      'manual_correction',
      'damaged',
      'expired',
      'theft_or_missing',
      'product_substitution',
      'returned_from_machine',
      'extra_stock_left_at_machine',
      'other'
    ])
    and from_entity_type::text = any (array['storage', 'operator_bag', 'machine', 'machine_storage', 'waste', 'adjustment'])
    and to_entity_type::text = any (array['storage', 'operator_bag', 'machine', 'machine_storage', 'waste', 'adjustment'])
  )
  or (
    related_route_id is not null
    and public.snacky_operator_can_access_route(related_route_id)
    and reason::text = any (array[
      'storage_to_operator_bag',
      'operator_bag_to_machine',
      'operator_bag_to_storage',
      'manual_correction',
      'damaged',
      'expired',
      'product_substitution',
      'returned_from_machine',
      'extra_stock_left_at_machine',
      'other'
    ])
  )
);

select pg_notify('pgrst', 'reload schema');
