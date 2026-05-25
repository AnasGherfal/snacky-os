alter type public.route_stop_status add value if not exists 'picked';
alter type public.route_stop_status add value if not exists 'in_progress';
alter type public.route_stop_status add value if not exists 'canceled';

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
  add column if not exists route_stop_id uuid references public.route_stops(id) on delete set null,
  add column if not exists route_stop_item_id uuid references public.route_stop_items(id) on delete set null,
  add column if not exists machine_id uuid references public.machines(id) on delete set null,
  add column if not exists pickup_batch_id uuid references public.route_pickup_batches(id) on delete set null;

alter table if exists public.inventory_movements
  add column if not exists related_pickup_batch_id uuid;

do $$
begin
  if to_regclass('public.route_pickup_batches') is not null
    and to_regclass('public.inventory_movements') is not null
    and not exists (
      select 1
      from pg_constraint
      where conname = 'inventory_movements_related_pickup_batch_id_fkey'
        and conrelid = 'public.inventory_movements'::regclass
    )
  then
    alter table public.inventory_movements
      add constraint inventory_movements_related_pickup_batch_id_fkey
      foreign key (related_pickup_batch_id)
      references public.route_pickup_batches(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_route_pick_list_items_route_stop_id
  on public.route_pick_list_items(route_stop_id);

create index if not exists idx_route_pick_list_items_route_stop_item_id
  on public.route_pick_list_items(route_stop_item_id);

create index if not exists idx_route_pick_list_items_machine_id
  on public.route_pick_list_items(machine_id);

create index if not exists idx_route_pick_list_items_pickup_batch_id
  on public.route_pick_list_items(pickup_batch_id);

create index if not exists idx_route_pickup_batches_route_id
  on public.route_pickup_batches(route_id);

create index if not exists idx_route_pickup_batches_operator_id
  on public.route_pickup_batches(operator_id);

create index if not exists idx_route_pickup_batch_stops_route_stop_id
  on public.route_pickup_batch_stops(route_stop_id);

create index if not exists idx_inventory_movements_pickup_batch_id
  on public.inventory_movements(related_pickup_batch_id);

create or replace function public.snacky_current_profile_has_any_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
        or public.snacky_profile_has_any_role(tm.roles, tm.role, allowed_roles)
      )
  );
$$;

create or replace function public.snacky_operator_can_access_route(target_route_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
      )
  );
$$;

grant execute on function public.snacky_current_profile_has_any_role(text[]) to authenticated;
grant execute on function public.snacky_operator_can_access_route(uuid) to authenticated;

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
end $$;

create or replace function public.confirm_route_pickup_batch(
  p_route_id uuid,
  p_expected_route_status public.route_status,
  p_next_route_status public.route_status,
  p_started_at timestamptz,
  p_replace_pick_list boolean default false,
  p_pickup_batch jsonb default null,
  p_batch_stop_ids uuid[] default '{}'::uuid[],
  p_new_stop_item_rows jsonb default '[]'::jsonb,
  p_inventory_movements jsonb default '[]'::jsonb,
  p_pick_list_rows jsonb default '[]'::jsonb,
  p_stock_line_rows jsonb default '[]'::jsonb,
  p_stop_item_picks jsonb default '[]'::jsonb,
  p_refill_line_picks jsonb default '[]'::jsonb,
  p_selected_stop_ids uuid[] default '{}'::uuid[],
  p_selected_machine_ids uuid[] default '{}'::uuid[]
)
returns table(pickup_batch_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_pickup_batch_id uuid;
  v_expected_stop_count integer;
  v_updated_stop_count integer;
begin
  if p_pickup_batch is not null and jsonb_typeof(p_pickup_batch) = 'object' then
    v_pickup_batch_id := coalesce((p_pickup_batch->>'id')::uuid, gen_random_uuid());

    insert into public.route_pickup_batches (
      id,
      route_id,
      operator_id,
      status,
      selected_stop_ids,
      product_summary,
      storage_deducted,
      confirmed_at
    )
    values (
      v_pickup_batch_id,
      p_route_id,
      nullif(p_pickup_batch->>'operator_id', '')::uuid,
      coalesce(nullif(p_pickup_batch->>'status', ''), 'confirmed'),
      coalesce(p_batch_stop_ids, '{}'::uuid[]),
      coalesce(p_pickup_batch->'product_summary', '[]'::jsonb),
      coalesce((p_pickup_batch->>'storage_deducted')::boolean, false),
      nullif(p_pickup_batch->>'confirmed_at', '')::timestamptz
    );

    if coalesce(array_length(p_batch_stop_ids, 1), 0) > 0 then
      insert into public.route_pickup_batch_stops (pickup_batch_id, route_stop_id)
      select v_pickup_batch_id, unnest(p_batch_stop_ids)
      on conflict do nothing;
    end if;
  end if;

  if jsonb_array_length(coalesce(p_new_stop_item_rows, '[]'::jsonb)) > 0 then
    insert into public.route_stop_items (
      id,
      route_id,
      route_stop_id,
      machine_id,
      product_id,
      machine_slot_id,
      slot_code,
      planned_quantity,
      picked_quantity,
      source,
      notes
    )
    select
      x.id,
      p_route_id,
      x.route_stop_id,
      x.machine_id,
      x.product_id,
      x.machine_slot_id,
      x.slot_code,
      x.planned_quantity,
      x.picked_quantity,
      x.source,
      x.notes
    from jsonb_to_recordset(p_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    );
  end if;

  if p_replace_pick_list then
    delete from public.route_pick_list_items
    where route_id = p_route_id;
  end if;

  if jsonb_array_length(coalesce(p_inventory_movements, '[]'::jsonb)) > 0 then
    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_route_id,
      related_pickup_batch_id,
      created_by,
      notes
    )
    select
      x.product_id,
      x.quantity,
      x.from_entity_type::public.inventory_entity_type,
      x.from_entity_id,
      x.to_entity_type::public.inventory_entity_type,
      x.to_entity_id,
      x.reason::public.movement_reason,
      p_route_id,
      x.related_pickup_batch_id,
      x.created_by,
      x.notes
    from jsonb_to_recordset(p_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    );
  end if;

  if jsonb_array_length(coalesce(p_pick_list_rows, '[]'::jsonb)) > 0 then
    insert into public.route_pick_list_items (
      route_id,
      route_stop_id,
      route_stop_item_id,
      machine_id,
      product_id,
      planned_qty,
      picked_qty,
      action_type,
      pickup_batch_id,
      reason,
      notes,
      needs_review,
      created_by
    )
    select
      p_route_id,
      x.route_stop_id,
      x.route_stop_item_id,
      x.machine_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      x.action_type,
      x.pickup_batch_id,
      x.reason,
      x.notes,
      x.needs_review,
      x.created_by
    from jsonb_to_recordset(p_pick_list_rows) as x(
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      reason text,
      notes text,
      needs_review boolean,
      created_by uuid
    );
  end if;

  if jsonb_array_length(coalesce(p_stock_line_rows, '[]'::jsonb)) > 0 then
    insert into public.route_stock_lines (
      route_id,
      product_id,
      planned_qty,
      picked_qty,
      updated_at
    )
    select
      p_route_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(p_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    on conflict (route_id, product_id)
    do update set
      planned_qty = excluded.planned_qty,
      picked_qty = excluded.picked_qty,
      updated_at = excluded.updated_at;
  end if;

  if jsonb_array_length(coalesce(p_stop_item_picks, '[]'::jsonb)) > 0 then
    update public.route_stop_items rsi
    set picked_quantity = x.picked_quantity,
        updated_at = now()
    from jsonb_to_recordset(p_stop_item_picks) as x(id uuid, picked_quantity integer)
    where rsi.id = x.id
      and rsi.route_id = p_route_id;
  end if;

  if jsonb_array_length(coalesce(p_refill_line_picks, '[]'::jsonb)) > 0 then
    update public.refill_order_lines rol
    set picked_qty = x.picked_qty
    from jsonb_to_recordset(p_refill_line_picks) as x(id uuid, picked_qty integer)
    where rol.id = x.id;
  end if;

  update public.routes
  set status = p_next_route_status,
      started_at = coalesce(started_at, p_started_at)
  where id = p_route_id
    and status = p_expected_route_status;

  if not found then
    raise exception 'Route % could not be updated because its status changed.', p_route_id
      using errcode = 'P0001';
  end if;

  v_expected_stop_count := coalesce(array_length(p_selected_stop_ids, 1), 0);
  if v_expected_stop_count > 0 then
    update public.route_stops
    set status = 'picked'::public.route_stop_status
    where route_id = p_route_id
      and id = any(p_selected_stop_ids)
      and status = 'pending'::public.route_stop_status;

    get diagnostics v_updated_stop_count = row_count;
    if v_updated_stop_count <> v_expected_stop_count then
      raise exception 'Only pending stops can be picked for route %.', p_route_id
        using errcode = 'P0001';
    end if;
  end if;

  update public.refill_orders
  set status = 'picked'::public.refill_status
  where route_id = p_route_id
    and status in ('assigned'::public.refill_status, 'in_progress'::public.refill_status, 'picked'::public.refill_status)
    and (
      coalesce(array_length(p_selected_machine_ids, 1), 0) = 0
      or machine_id = any(p_selected_machine_ids)
    );

  return query select v_pickup_batch_id;
end;
$$;

grant execute on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[]
) to authenticated;

select pg_notify('pgrst', 'reload schema');
