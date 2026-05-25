alter type route_stop_status add value if not exists 'picked';
alter type route_stop_status add value if not exists 'in_progress';
alter type route_stop_status add value if not exists 'canceled';

create table if not exists public.route_pickup_batches (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  operator_id uuid references public.team_members(id) on delete set null,
  status text not null default 'confirmed',
  selected_stop_ids uuid[] not null default '{}'::uuid[],
  product_summary jsonb not null default '[]'::jsonb,
  storage_deducted boolean not null default false,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_pickup_batches_status_check check (status in ('draft', 'confirmed', 'cancelled')),
  constraint route_pickup_batches_product_summary_array check (jsonb_typeof(product_summary) = 'array')
);

create table if not exists public.route_pickup_batch_stops (
  pickup_batch_id uuid not null references public.route_pickup_batches(id) on delete cascade,
  route_stop_id uuid not null references public.route_stops(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pickup_batch_id, route_stop_id)
);

alter table if exists public.route_pick_list_items
  add column if not exists pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

alter table if exists public.inventory_movements
  add column if not exists related_pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

create index if not exists idx_route_pickup_batches_route_id
  on public.route_pickup_batches(route_id);

create index if not exists idx_route_pickup_batches_operator_id
  on public.route_pickup_batches(operator_id);

create index if not exists idx_route_pickup_batch_stops_route_stop_id
  on public.route_pickup_batch_stops(route_stop_id);

create index if not exists idx_route_pick_list_items_pickup_batch_id
  on public.route_pick_list_items(pickup_batch_id);

create index if not exists idx_inventory_movements_pickup_batch_id
  on public.inventory_movements(related_pickup_batch_id);

do $$
begin
  if to_regclass('public.route_pickup_batches') is not null then
    execute 'alter table public.route_pickup_batches enable row level security';
    execute 'grant select, insert, update, delete on table public.route_pickup_batches to authenticated';

    execute 'drop policy if exists "snacky_route_pickup_batches_select_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_insert_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_update_by_route_access" on public.route_pickup_batches';
    execute 'drop policy if exists "snacky_route_pickup_batches_delete_by_route_access" on public.route_pickup_batches';

    execute $sql$
      create policy "snacky_route_pickup_batches_select_by_route_access"
      on public.route_pickup_batches for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_insert_by_route_access"
      on public.route_pickup_batches for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_update_by_route_access"
      on public.route_pickup_batches for update
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batches_delete_by_route_access"
      on public.route_pickup_batches for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_pickup_batch_stops') is not null then
    execute 'alter table public.route_pickup_batch_stops enable row level security';
    execute 'grant select, insert, update, delete on table public.route_pickup_batch_stops to authenticated';

    execute 'drop policy if exists "snacky_route_pickup_batch_stops_select_by_route_access" on public.route_pickup_batch_stops';
    execute 'drop policy if exists "snacky_route_pickup_batch_stops_insert_by_route_access" on public.route_pickup_batch_stops';
    execute 'drop policy if exists "snacky_route_pickup_batch_stops_delete_by_route_access" on public.route_pickup_batch_stops';

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_select_by_route_access"
      on public.route_pickup_batch_stops for select
      to authenticated
      using (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_insert_by_route_access"
      on public.route_pickup_batch_stops for insert
      to authenticated
      with check (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_pickup_batch_stops_delete_by_route_access"
      on public.route_pickup_batch_stops for delete
      to authenticated
      using (
        exists (
          select 1
          from public.route_pickup_batches b
          where b.id = pickup_batch_id
            and (
              public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
              or public.snacky_operator_can_access_route(b.route_id)
            )
        )
      )
    $sql$;
  end if;

  if to_regclass('public.route_stop_items') is not null then
    execute 'drop policy if exists "snacky_route_stop_items_insert_by_effective_role" on public.route_stop_items';
    execute 'drop policy if exists "snacky_route_stop_items_delete_by_effective_role" on public.route_stop_items';

    execute $sql$
      create policy "snacky_route_stop_items_insert_by_effective_role"
      on public.route_stop_items for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stop_items_delete_by_effective_role"
      on public.route_stop_items for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.route_stock_lines') is not null then
    execute 'drop policy if exists "snacky_route_stock_lines_insert_by_effective_role" on public.route_stock_lines';
    execute 'drop policy if exists "snacky_route_stock_lines_delete_by_effective_role" on public.route_stock_lines';

    execute $sql$
      create policy "snacky_route_stock_lines_insert_by_effective_role"
      on public.route_stock_lines for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_route_stock_lines_delete_by_effective_role"
      on public.route_stock_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;

  if to_regclass('public.refill_order_lines') is not null then
    execute 'drop policy if exists "snacky_refill_order_lines_insert_by_effective_role" on public.refill_order_lines';
    execute 'drop policy if exists "snacky_refill_order_lines_delete_by_effective_role" on public.refill_order_lines';

    execute $sql$
      create policy "snacky_refill_order_lines_insert_by_effective_role"
      on public.refill_order_lines for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
    $sql$;

    execute $sql$
      create policy "snacky_refill_order_lines_delete_by_effective_role"
      on public.refill_order_lines for delete
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or exists (
          select 1
          from public.refill_orders ro
          where ro.id = refill_order_id
            and public.snacky_operator_can_access_route(ro.route_id)
        )
      )
    $sql$;
  end if;

  if to_regclass('public.refill_orders') is not null then
    execute 'drop policy if exists "snacky_refill_orders_insert_by_effective_role" on public.refill_orders';

    execute $sql$
      create policy "snacky_refill_orders_insert_by_effective_role"
      on public.refill_orders for insert
      to authenticated
      with check (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
        or public.snacky_operator_can_access_route(route_id)
      )
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
