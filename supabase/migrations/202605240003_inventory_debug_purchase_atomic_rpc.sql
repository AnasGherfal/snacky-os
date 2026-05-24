create or replace function public.snacky_create_purchase_with_lines(
  p_supplier_id uuid,
  p_order_date date,
  p_receipt_number text,
  p_payment_method text,
  p_payment_status text,
  p_receipt_url text,
  p_receipt_file_name text,
  p_receipt_content_type text,
  p_receipt_storage_path text,
  p_notes text,
  p_calculated_total_lyd numeric,
  p_manual_total_lyd numeric,
  p_total_adjustment_lyd numeric,
  p_total_source text,
  p_total_amount numeric,
  p_created_by uuid,
  p_submit_action text,
  p_lines jsonb
)
returns table (
  id uuid,
  receipt_number text,
  status text,
  total_amount numeric,
  payment_status text,
  movement_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase_id uuid;
  v_storage_id uuid;
  v_status text := 'draft';
  v_movement_count integer := 0;
begin
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']) then
    raise exception 'Permission denied for purchase save' using errcode = '42501';
  end if;

  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Purchase must include at least one line item' using errcode = '22023';
  end if;

  insert into public.purchase_orders (
    supplier_id,
    status,
    order_date,
    receipt_number,
    payment_method,
    payment_status,
    receipt_url,
    receipt_file_name,
    receipt_content_type,
    receipt_storage_path,
    notes,
    calculated_total_lyd,
    manual_total_lyd,
    total_adjustment_lyd,
    total_source,
    total_amount,
    created_by
  )
  values (
    p_supplier_id,
    'draft',
    coalesce(p_order_date, current_date),
    nullif(trim(coalesce(p_receipt_number, '')), ''),
    coalesce(nullif(trim(coalesce(p_payment_method, '')), ''), 'cash'),
    coalesce(nullif(trim(coalesce(p_payment_status, '')), ''), 'paid'),
    nullif(trim(coalesce(p_receipt_url, '')), ''),
    nullif(trim(coalesce(p_receipt_file_name, '')), ''),
    nullif(trim(coalesce(p_receipt_content_type, '')), ''),
    nullif(trim(coalesce(p_receipt_storage_path, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    coalesce(p_calculated_total_lyd, 0),
    p_manual_total_lyd,
    p_total_adjustment_lyd,
    coalesce(nullif(trim(coalesce(p_total_source, '')), ''), 'calculated'),
    coalesce(p_total_amount, 0),
    p_created_by
  )
  returning purchase_orders.id into v_purchase_id;

  insert into public.purchase_order_lines (
    purchase_order_id,
    product_id,
    line_position,
    boxes_qty,
    units_per_box,
    loose_units_qty,
    total_units,
    ordered_qty,
    received_qty,
    unit_cost,
    unit_cost_lyd,
    line_total,
    line_total_lyd
  )
  select
    v_purchase_id,
    line.product_id,
    coalesce(line.line_position, 0),
    greatest(coalesce(line.boxes_qty, 0), 0),
    greatest(coalesce(line.units_per_box, 1), 1),
    greatest(coalesce(line.loose_units_qty, 0), 0),
    greatest(coalesce(line.total_units, 0), 0),
    greatest(coalesce(line.total_units, 0), 0),
    case when p_submit_action = 'received' then greatest(coalesce(line.total_units, 0), 0) else 0 end,
    greatest(coalesce(line.unit_cost, line.unit_cost_lyd, 0), 0),
    greatest(coalesce(line.unit_cost_lyd, line.unit_cost, 0), 0),
    greatest(coalesce(line.line_total, line.line_total_lyd, 0), 0),
    greatest(coalesce(line.line_total_lyd, line.line_total, 0), 0)
  from jsonb_to_recordset(p_lines) as line(
    product_id uuid,
    line_position integer,
    boxes_qty integer,
    units_per_box integer,
    loose_units_qty integer,
    total_units integer,
    unit_cost numeric,
    unit_cost_lyd numeric,
    line_total numeric,
    line_total_lyd numeric
  )
  where line.product_id is not null
    and greatest(coalesce(line.total_units, 0), 0) > 0;

  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = v_purchase_id) then
    raise exception 'Purchase must include at least one valid line item' using errcode = '22023';
  end if;

  if p_submit_action = 'received' then
    select sl.id
    into v_storage_id
    from public.storage_locations sl
    where sl.active = true
      and sl.location_type::text = 'main_storage'
    order by sl.name
    limit 1;

    if v_storage_id is null then
      select sl.id
      into v_storage_id
      from public.storage_locations sl
      where sl.active = true
        and sl.location_type::text in ('vehicle', 'temporary', 'other')
      order by sl.name
      limit 1;
    end if;

    if v_storage_id is null then
      raise exception 'No active storage location found' using errcode = '23514';
    end if;

    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_purchase_id,
      related_purchase_line_id,
      unit_cost_lyd,
      line_total_lyd,
      created_by,
      notes
    )
    select
      pol.product_id,
      pol.total_units,
      'supplier',
      p_supplier_id,
      'storage',
      v_storage_id,
      'purchase_received',
      v_purchase_id,
      pol.id,
      coalesce(pol.unit_cost_lyd, pol.unit_cost, 0),
      coalesce(pol.line_total_lyd, pol.line_total, 0),
      p_created_by,
      'Purchase received'
    from public.purchase_order_lines pol
    where pol.purchase_order_id = v_purchase_id
      and pol.total_units > 0;

    get diagnostics v_movement_count = row_count;

    with latest_line as (
      select distinct on (pol.product_id)
        pol.product_id,
        coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) as latest_cost
      from public.purchase_order_lines pol
      where pol.purchase_order_id = v_purchase_id
      order by pol.product_id, pol.line_position desc, pol.id desc
    )
    update public.products p
    set
      cost_price = latest_line.latest_cost,
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      cost_price_source = 'latest_purchase',
      price_updated_at = now(),
      updated_at = now()
    from latest_line
    where p.id = latest_line.product_id;

    update public.purchase_orders po
    set
      status = 'received',
      received_at = now(),
      received_date = current_date,
      received_by = p_created_by,
      updated_at = now()
    where po.id = v_purchase_id;

    v_status := 'received';
  end if;

  return query
  select
    po.id,
    po.receipt_number,
    po.status,
    po.total_amount,
    po.payment_status,
    v_movement_count
  from public.purchase_orders po
  where po.id = v_purchase_id;
end;
$$;

grant execute on function public.snacky_create_purchase_with_lines(
  uuid,
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  numeric,
  numeric,
  numeric,
  text,
  numeric,
  uuid,
  text,
  jsonb
) to authenticated;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'drop policy if exists "snacky_products_select_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_insert_by_effective_role" on public.products';
    execute 'drop policy if exists "snacky_products_update_by_effective_role" on public.products';

    execute $sql$
      create policy "snacky_products_select_by_effective_role"
      on public.products for select
      to authenticated
      using (
        public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance'])
        or public.snacky_operator_can_read_product(id)
      )
    $sql$;

    execute $sql$
      create policy "snacky_products_insert_by_effective_role"
      on public.products for insert
      to authenticated
      with check (
        public.snacky_current_profile_can_add_products()
        or public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing'])
      )
    $sql$;

    execute $sql$
      create policy "snacky_products_update_by_effective_role"
      on public.products for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'warehouse', 'purchasing']))
    $sql$;
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'drop policy if exists "snacky_inventory_movements_insert_by_effective_role" on public.inventory_movements';

    execute $sql$
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
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_storage', 'stock_count_adjustment', 'manual_correction', 'damaged', 'expired', 'theft_or_missing', 'product_substitution'])
          and from_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
          and to_entity_type::text = any(array['storage', 'operator_bag', 'waste', 'adjustment'])
        )
        or (
          related_route_id is not null
          and public.snacky_operator_can_access_route(related_route_id)
          and reason::text = any(array['storage_to_operator_bag', 'operator_bag_to_machine', 'operator_bag_to_storage', 'manual_correction', 'damaged', 'expired', 'product_substitution'])
        )
      )
    $sql$;
  end if;
end $$;

grant select on table public.products to authenticated;
grant select on table public.inventory_movements to authenticated;
grant select on table public.route_stock_lines to authenticated;
grant select on table public.current_inventory_by_location to authenticated;
grant select on table public.storage_locations to authenticated;
grant select on table public.suppliers to authenticated;
grant select on table public.purchase_orders to authenticated;
grant select on table public.purchase_order_lines to authenticated;

select pg_notify('pgrst', 'reload schema');
