do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'movement_reason'
      and e.enumlabel = 'returned_from_machine'
  ) then
    alter type public.movement_reason add value 'returned_from_machine';
  end if;
end $$;

create table if not exists public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  adjustment_type text not null,
  product_id uuid references public.products(id) on delete set null,
  product_name text,
  machine_id uuid references public.machines(id) on delete set null,
  location_id uuid references public.locations(id) on delete set null,
  route_id uuid references public.routes(id) on delete set null,
  route_stop_id uuid references public.route_stops(id) on delete set null,
  operator_id uuid references public.team_members(id) on delete set null,
  quantity integer not null,
  unit_cost_lyd numeric(12,4),
  total_cost_lyd numeric(12,2),
  reason text,
  notes text,
  photo_url text,
  status text not null default 'confirmed',
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  inventory_movement_id uuid references public.inventory_movements(id) on delete set null,
  client_submission_id text,
  cancellation_reason text,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid references auth.users(id) on delete set null,
  constraint inventory_adjustments_type_check check (
    adjustment_type in (
      'damaged',
      'returned_from_machine',
      'expired',
      'lost',
      'found',
      'manual_correction'
    )
  ),
  constraint inventory_adjustments_quantity_positive check (quantity > 0),
  constraint inventory_adjustments_status_check check (
    status in ('confirmed', 'pending_storage_confirmation', 'cancelled')
  )
);

alter table public.inventory_adjustments
  add column if not exists inventory_movement_id uuid references public.inventory_movements(id) on delete set null,
  add column if not exists client_submission_id text,
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by_user_id uuid references auth.users(id) on delete set null;

create index if not exists idx_inventory_adjustments_route_created
  on public.inventory_adjustments(route_id, created_at desc);

create index if not exists idx_inventory_adjustments_stop_created
  on public.inventory_adjustments(route_stop_id, created_at desc);

create index if not exists idx_inventory_adjustments_type_created
  on public.inventory_adjustments(adjustment_type, created_at desc);

create index if not exists idx_inventory_adjustments_product_created
  on public.inventory_adjustments(product_id, created_at desc);

create unique index if not exists idx_inventory_adjustments_client_submission
  on public.inventory_adjustments(client_submission_id)
  where client_submission_id is not null;

alter table public.inventory_adjustments enable row level security;

grant select, insert, update on public.inventory_adjustments to authenticated;

drop policy if exists "snacky_inventory_adjustments_select_by_route_access" on public.inventory_adjustments;
create policy "snacky_inventory_adjustments_select_by_route_access"
on public.inventory_adjustments for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or (route_id is not null and public.snacky_operator_can_access_route(route_id))
);

drop policy if exists "snacky_inventory_adjustments_insert_by_route_access" on public.inventory_adjustments;
create policy "snacky_inventory_adjustments_insert_by_route_access"
on public.inventory_adjustments for insert
to authenticated
with check (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  or (
    route_id is not null
    and public.snacky_operator_can_access_route(route_id)
    and adjustment_type in ('damaged', 'returned_from_machine')
    and status in ('confirmed', 'pending_storage_confirmation')
  )
);

drop policy if exists "snacky_inventory_adjustments_update_by_manager" on public.inventory_adjustments;
create policy "snacky_inventory_adjustments_update_by_manager"
on public.inventory_adjustments for update
to authenticated
using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']));

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
      'returned_from_machine'
    ])
    and from_entity_type::text = any (array['storage', 'operator_bag', 'machine', 'waste', 'adjustment'])
    and to_entity_type::text = any (array['storage', 'operator_bag', 'machine', 'waste', 'adjustment'])
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
      'returned_from_machine'
    ])
  )
);

create or replace function public.create_route_inventory_adjustment(
  p_adjustment_id uuid,
  p_adjustment_type text,
  p_product_id uuid,
  p_machine_id uuid,
  p_route_id uuid,
  p_route_stop_id uuid,
  p_quantity integer,
  p_reason text,
  p_notes text default null,
  p_photo_url text default null,
  p_client_submission_id text default null
)
returns table (
  id uuid,
  adjustment_type text,
  product_id uuid,
  product_name text,
  machine_id uuid,
  location_id uuid,
  route_id uuid,
  route_stop_id uuid,
  operator_id uuid,
  quantity integer,
  unit_cost_lyd numeric,
  total_cost_lyd numeric,
  reason text,
  notes text,
  photo_url text,
  status text,
  inventory_movement_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_route record;
  v_stop record;
  v_product record;
  v_adjustment_id uuid := coalesce(p_adjustment_id, gen_random_uuid());
  v_client_submission_id text := nullif(trim(coalesce(p_client_submission_id, '')), '');
  v_unit_cost numeric(12,4);
  v_total_cost numeric(12,2);
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_photo_url text := nullif(trim(coalesce(p_photo_url, '')), '');
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid := public.snacky_current_team_member_id();
  v_is_manager boolean := public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
  v_existing record;
  v_available_bag_qty integer := 0;
  v_from_type public.inventory_entity_type;
  v_from_id uuid;
  v_to_type public.inventory_entity_type;
  v_to_id uuid;
  v_movement_reason text;
  v_movement_id uuid;
  v_idempotency_key text;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if p_adjustment_type not in ('damaged', 'returned_from_machine') then
    raise exception 'Unsupported inventory adjustment type.' using errcode = '22023';
  end if;

  if p_product_id is null then
    raise exception 'Product is required.' using errcode = '23502';
  end if;

  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'Quantity must be greater than 0.' using errcode = '23514';
  end if;

  if v_reason is null then
    raise exception 'Reason is required.' using errcode = '23502';
  end if;

  select ia.*
    into v_existing
  from public.inventory_adjustments ia
  where ia.id = v_adjustment_id
     or (v_client_submission_id is not null and ia.client_submission_id = v_client_submission_id)
  limit 1;

  if found then
    if v_existing.route_id is distinct from p_route_id
      or v_existing.route_stop_id is distinct from p_route_stop_id then
      raise exception 'Duplicate adjustment id belongs to another route stop.' using errcode = '23505';
    end if;

    return query
    select
      ia.id,
      ia.adjustment_type,
      ia.product_id,
      ia.product_name,
      ia.machine_id,
      ia.location_id,
      ia.route_id,
      ia.route_stop_id,
      ia.operator_id,
      ia.quantity,
      ia.unit_cost_lyd,
      ia.total_cost_lyd,
      ia.reason,
      ia.notes,
      ia.photo_url,
      ia.status,
      ia.inventory_movement_id,
      ia.created_at,
      ia.updated_at
    from public.inventory_adjustments ia
    where ia.id = v_existing.id;
    return;
  end if;

  select r.id, r.operator_id, r.status
    into v_route
  from public.routes r
  where r.id = p_route_id;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0002';
  end if;

  if not v_is_manager and not public.snacky_operator_can_access_route(p_route_id) then
    raise exception 'You are not authorized to adjust inventory for this route.' using errcode = '42501';
  end if;

  if not v_is_manager and v_route.status::text in ('completed', 'verified', 'payroll_pending', 'paid', 'disputed', 'reviewed', 'cancelled', 'canceled') then
    raise exception 'Operators cannot add inventory adjustments after route completion.' using errcode = '42501';
  end if;

  if v_route.status::text in ('cancelled', 'canceled') then
    raise exception 'Cancelled routes cannot receive inventory adjustments.' using errcode = '22023';
  end if;

  select rs.id, rs.route_id, rs.machine_id, m.location_id
    into v_stop
  from public.route_stops rs
  left join public.machines m on m.id = rs.machine_id
  where rs.id = p_route_stop_id;

  if not found then
    raise exception 'Route stop not found.' using errcode = 'P0002';
  end if;

  if v_stop.route_id is distinct from p_route_id then
    raise exception 'This stop does not belong to the selected route.' using errcode = '22023';
  end if;

  if p_machine_id is not null and v_stop.machine_id is distinct from p_machine_id then
    raise exception 'This machine does not match the selected stop.' using errcode = '22023';
  end if;

  select
    p.id,
    p.name,
    coalesce(
      nullif(p.average_cost_lyd, 0),
      nullif(p.last_purchase_cost_lyd, 0),
      nullif(p.current_cost_price_lyd, 0),
      nullif(p.cost_price, 0),
      0
    )::numeric(12,4) as unit_cost
    into v_product
  from public.products p
  where p.id = p_product_id;

  if not found then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;

  select coalesce(sum(
    case
      when im.to_entity_type::text = 'operator_bag' and im.from_entity_type::text <> 'operator_bag' then im.quantity
      when im.from_entity_type::text = 'operator_bag' and im.to_entity_type::text <> 'operator_bag' then -im.quantity
      else 0
    end
  ), 0)::integer
    into v_available_bag_qty
  from public.inventory_movements im
  where im.related_route_id = p_route_id
    and im.product_id = p_product_id;

  if p_adjustment_type = 'damaged' and p_quantity > greatest(v_available_bag_qty, 0) then
    raise exception 'Damaged quantity cannot exceed available operator bag stock.' using errcode = '23514';
  end if;

  v_unit_cost := coalesce(v_product.unit_cost, 0);
  v_total_cost := round((v_unit_cost * p_quantity)::numeric, 2);

  if p_adjustment_type = 'damaged' then
    v_from_type := 'operator_bag';
    v_from_id := v_route.operator_id;
    v_to_type := 'waste';
    v_to_id := null;
    v_movement_reason := 'damaged';
  else
    v_from_type := 'machine';
    v_from_id := v_stop.machine_id;
    v_to_type := 'operator_bag';
    v_to_id := v_route.operator_id;
    v_movement_reason := 'returned_from_machine';
  end if;

  v_idempotency_key := coalesce(v_client_submission_id, 'route-inventory-adjustment:' || v_adjustment_id::text);

  insert into public.inventory_adjustments (
    id,
    adjustment_type,
    product_id,
    product_name,
    machine_id,
    location_id,
    route_id,
    route_stop_id,
    operator_id,
    quantity,
    unit_cost_lyd,
    total_cost_lyd,
    reason,
    notes,
    photo_url,
    status,
    created_by_user_id,
    client_submission_id
  ) values (
    v_adjustment_id,
    p_adjustment_type,
    p_product_id,
    v_product.name,
    v_stop.machine_id,
    v_stop.location_id,
    p_route_id,
    p_route_stop_id,
    v_route.operator_id,
    p_quantity,
    v_unit_cost,
    v_total_cost,
    v_reason,
    v_notes,
    v_photo_url,
    'confirmed',
    v_actor_user_id,
    v_client_submission_id
  );

  select im.id
    into v_movement_id
  from public.inventory_movements im
  where im.idempotency_key = v_idempotency_key
  limit 1;

  if v_movement_id is null then
    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_route_id,
      related_route_stop_id,
      related_machine_id,
      unit_cost_lyd,
      line_total_lyd,
      source_type,
      source_id,
      idempotency_key,
      created_by,
      notes
    ) values (
      p_product_id,
      p_quantity,
      v_from_type,
      v_from_id,
      v_to_type,
      v_to_id,
      v_movement_reason::public.movement_reason,
      p_route_id,
      p_route_stop_id,
      v_stop.machine_id,
      v_unit_cost,
      v_total_cost,
      'inventory_adjustment',
      v_adjustment_id,
      v_idempotency_key,
      coalesce(v_route.operator_id, v_actor_team_member_id),
      concat(
        case when p_adjustment_type = 'damaged' then 'Damaged products' else 'Returned from machine' end,
        ': ',
        v_reason,
        case when v_notes is null then '' else ' - ' || v_notes end
      )
    )
    returning public.inventory_movements.id into v_movement_id;
  end if;

  update public.inventory_adjustments ia
  set inventory_movement_id = v_movement_id,
      updated_at = now()
  where ia.id = v_adjustment_id;

  return query
  select
    ia.id,
    ia.adjustment_type,
    ia.product_id,
    ia.product_name,
    ia.machine_id,
    ia.location_id,
    ia.route_id,
    ia.route_stop_id,
    ia.operator_id,
    ia.quantity,
    ia.unit_cost_lyd,
    ia.total_cost_lyd,
    ia.reason,
    ia.notes,
    ia.photo_url,
    ia.status,
    ia.inventory_movement_id,
    ia.created_at,
    ia.updated_at
  from public.inventory_adjustments ia
  where ia.id = v_adjustment_id;
end;
$$;

grant execute on function public.create_route_inventory_adjustment(
  uuid,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  integer,
  text,
  text,
  text,
  text
) to authenticated;

create or replace function public.cancel_inventory_adjustment(
  p_adjustment_id uuid,
  p_reason text default null
)
returns public.inventory_adjustments
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_adjustment public.inventory_adjustments%rowtype;
  v_movement public.inventory_movements%rowtype;
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid := public.snacky_current_team_member_id();
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_correction_id uuid;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only owner/admin can cancel inventory adjustments.' using errcode = '42501';
  end if;

  select *
    into v_adjustment
  from public.inventory_adjustments
  where id = p_adjustment_id
  for update;

  if not found then
    raise exception 'Inventory adjustment not found.' using errcode = 'P0002';
  end if;

  if v_adjustment.status = 'cancelled' then
    return v_adjustment;
  end if;

  if v_adjustment.inventory_movement_id is not null then
    select *
      into v_movement
    from public.inventory_movements
    where id = v_adjustment.inventory_movement_id;

    if found then
      select id
        into v_correction_id
      from public.inventory_movements
      where idempotency_key = 'inventory-adjustment-cancel:' || p_adjustment_id::text
      limit 1;

      if v_correction_id is null then
        insert into public.inventory_movements (
          product_id,
          quantity,
          from_entity_type,
          from_entity_id,
          to_entity_type,
          to_entity_id,
          reason,
          related_route_id,
          related_route_stop_id,
          related_machine_id,
          unit_cost_lyd,
          line_total_lyd,
          reversed_movement_id,
          correction_reason,
          source_type,
          source_id,
          idempotency_key,
          created_by,
          notes
        ) values (
          v_movement.product_id,
          v_movement.quantity,
          v_movement.to_entity_type,
          v_movement.to_entity_id,
          v_movement.from_entity_type,
          v_movement.from_entity_id,
          'manual_correction',
          v_movement.related_route_id,
          v_movement.related_route_stop_id,
          v_movement.related_machine_id,
          v_movement.unit_cost_lyd,
          case when v_movement.line_total_lyd is null then null else -abs(v_movement.line_total_lyd) end,
          v_movement.id,
          coalesce(v_reason, 'Cancelled inventory adjustment'),
          'inventory_adjustment_cancel',
          p_adjustment_id,
          'inventory-adjustment-cancel:' || p_adjustment_id::text,
          v_actor_team_member_id,
          concat('Cancelled inventory adjustment ', left(p_adjustment_id::text, 8), coalesce(': ' || v_reason, ''))
        )
        returning id into v_correction_id;
      end if;
    end if;
  end if;

  update public.inventory_adjustments
  set status = 'cancelled',
      cancellation_reason = v_reason,
      cancelled_at = now(),
      cancelled_by_user_id = v_actor_user_id,
      updated_at = now()
  where id = p_adjustment_id
  returning * into v_adjustment;

  return v_adjustment;
end;
$$;

grant execute on function public.cancel_inventory_adjustment(uuid, text) to authenticated;
