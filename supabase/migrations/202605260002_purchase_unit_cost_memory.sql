alter table public.products
  add column if not exists last_purchase_date date,
  add column if not exists last_supplier_id uuid,
  add column if not exists last_purchase_line_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_last_supplier_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_last_supplier_id_fkey
      foreign key (last_supplier_id) references public.suppliers(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_last_purchase_line_id_fkey'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_last_purchase_line_id_fkey
      foreign key (last_purchase_line_id) references public.purchase_order_lines(id) on delete set null;
  end if;
end $$;

create index if not exists idx_products_last_supplier_id
  on public.products(last_supplier_id);

create index if not exists idx_products_last_purchase_line_id
  on public.products(last_purchase_line_id);

with latest_received_cost as (
  select distinct on (pol.product_id)
    pol.product_id,
    pol.id as purchase_line_id,
    round(coalesce(pol.unit_cost_lyd, pol.unit_cost, 0)::numeric, 4) as latest_cost,
    coalesce(po.received_date, po.order_date, pol.created_at::date) as purchase_date,
    po.supplier_id
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) > 0
    and po.status = 'received'
  order by
    pol.product_id,
    coalesce(po.received_at, po.received_date::timestamptz, po.order_date::timestamptz, pol.created_at) desc,
    coalesce(pol.line_position, 0) desc,
    pol.id desc
)
update public.products p
set
  cost_price = round(latest_received_cost.latest_cost, 2),
  current_cost_price_lyd = latest_received_cost.latest_cost,
  last_purchase_cost_lyd = latest_received_cost.latest_cost,
  last_purchase_date = latest_received_cost.purchase_date,
  last_supplier_id = latest_received_cost.supplier_id,
  last_purchase_line_id = latest_received_cost.purchase_line_id,
  cost_price_source = 'latest_purchase',
  price_updated_at = coalesce(p.price_updated_at, now()),
  updated_at = now()
from latest_received_cost
where p.id = latest_received_cost.product_id;

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
  v_submit_action text;
  v_payment_status text;
  v_total_source text;
  v_total_amount numeric;
  v_created_by uuid;
  v_actor_team_member_id uuid;
  v_movement_count integer := 0;
begin
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']) then
    raise exception 'Permission denied for purchase save' using errcode = '42501';
  end if;

  select coalesce(p.team_member_id, tm.id)
  into v_actor_team_member_id
  from public.profiles p
  left join public.team_members tm
    on tm.id = p.team_member_id
    or tm.auth_user_id = p.id
  where p.id = auth.uid()
    and p.active_status = 'active'
  limit 1;

  if p_created_by is not null
    and v_actor_team_member_id is not null
    and p_created_by <> v_actor_team_member_id
    and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  then
    raise exception 'Permission denied for purchase actor' using errcode = '42501';
  end if;

  v_created_by := coalesce(v_actor_team_member_id, p_created_by);
  v_submit_action := case
    when lower(trim(coalesce(p_submit_action, ''))) in ('received', 'receive', 'submitted', 'submit') then 'received'
    else 'draft'
  end;
  v_payment_status := lower(trim(coalesce(p_payment_status, 'paid')));
  if v_payment_status = 'partial' then
    v_payment_status := 'partially_paid';
  end if;
  if v_payment_status not in ('paid', 'unpaid', 'partially_paid', 'voided') then
    v_payment_status := 'paid';
  end if;
  v_total_source := case
    when lower(trim(coalesce(p_total_source, ''))) = 'manual' then 'manual'
    else 'calculated'
  end;
  v_total_amount := greatest(coalesce(p_total_amount, p_manual_total_lyd, p_calculated_total_lyd, 0), 0);

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
    v_payment_status,
    nullif(trim(coalesce(p_receipt_url, '')), ''),
    nullif(trim(coalesce(p_receipt_file_name, '')), ''),
    nullif(trim(coalesce(p_receipt_content_type, '')), ''),
    nullif(trim(coalesce(p_receipt_storage_path, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    greatest(coalesce(p_calculated_total_lyd, 0), 0),
    p_manual_total_lyd,
    p_total_adjustment_lyd,
    v_total_source,
    v_total_amount,
    v_created_by
  )
  returning purchase_orders.id into v_purchase_id;

  with parsed_lines as (
    select
      line.product_id,
      greatest(coalesce(line.line_position, 0), 0) as line_position,
      floor(greatest(coalesce(line.boxes_qty, line.box_qty, line.box_quantity, 0), 0))::integer as boxes_qty,
      floor(greatest(coalesce(line.units_per_box, line.pieces_per_box, 1), 1))::integer as units_per_box,
      floor(greatest(coalesce(line.loose_units_qty, line.loose_units, 0), 0))::integer as loose_units_qty,
      line.total_units as explicit_total_units,
      line.received_units,
      line.quantity,
      line.ordered_qty,
      greatest(coalesce(line.unit_cost, line.unit_cost_lyd, 0), 0) as raw_unit_cost,
      greatest(coalesce(line.line_total, line.line_total_lyd, 0), 0) as raw_line_total
    from jsonb_to_recordset(p_lines) as line(
      product_id uuid,
      line_position integer,
      boxes_qty numeric,
      box_qty numeric,
      box_quantity numeric,
      units_per_box numeric,
      pieces_per_box numeric,
      loose_units_qty numeric,
      loose_units numeric,
      total_units numeric,
      received_units numeric,
      quantity numeric,
      ordered_qty numeric,
      unit_cost numeric,
      unit_cost_lyd numeric,
      line_total numeric,
      line_total_lyd numeric,
      notes text
    )
  ),
  normalized_lines as (
    select
      parsed_lines.product_id,
      parsed_lines.line_position,
      parsed_lines.boxes_qty,
      parsed_lines.units_per_box,
      parsed_lines.loose_units_qty,
      floor(
        greatest(
          coalesce(
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as total_units,
      floor(
        greatest(
          coalesce(
            parsed_lines.ordered_qty,
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as ordered_qty,
      parsed_lines.raw_unit_cost,
      parsed_lines.raw_line_total
    from parsed_lines
  ),
  priced_lines as (
    select
      normalized_lines.product_id,
      normalized_lines.line_position,
      normalized_lines.boxes_qty,
      normalized_lines.units_per_box,
      normalized_lines.loose_units_qty,
      normalized_lines.total_units,
      greatest(normalized_lines.ordered_qty, normalized_lines.total_units) as ordered_qty,
      case
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.raw_unit_cost
        when normalized_lines.raw_line_total > 0 and normalized_lines.total_units > 0 then normalized_lines.raw_line_total / normalized_lines.total_units
        else 0
      end as unit_cost,
      case
        when normalized_lines.raw_line_total > 0 then normalized_lines.raw_line_total
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.total_units * normalized_lines.raw_unit_cost
        else 0
      end as line_total
    from normalized_lines
  )
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
    priced_lines.product_id,
    priced_lines.line_position,
    priced_lines.boxes_qty,
    priced_lines.units_per_box,
    priced_lines.loose_units_qty,
    priced_lines.total_units,
    priced_lines.ordered_qty,
    case when v_submit_action = 'received' then priced_lines.total_units else 0 end,
    priced_lines.unit_cost,
    priced_lines.unit_cost,
    priced_lines.line_total,
    priced_lines.line_total
  from priced_lines
  where priced_lines.product_id is not null
    and priced_lines.total_units > 0;

  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = v_purchase_id) then
    raise exception 'Purchase must include at least one valid line item' using errcode = '22023';
  end if;

  if v_submit_action = 'received' then
    select sl.id
    into v_storage_id
    from public.storage_locations sl
    where sl.active = true
      and sl.location_type = 'main_storage'
    order by sl.name
    limit 1;

    if v_storage_id is null then
      select sl.id
      into v_storage_id
      from public.storage_locations sl
      where sl.active = true
        and sl.location_type in ('vehicle', 'temporary', 'other')
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
      v_created_by,
      'Purchase received'
    from public.purchase_order_lines pol
    where pol.purchase_order_id = v_purchase_id
      and pol.total_units > 0;

    get diagnostics v_movement_count = row_count;

    if v_movement_count = 0 then
      raise exception 'Purchase receipt created no inventory movements' using errcode = '23514';
    end if;

    with latest_line as (
      select distinct on (pol.product_id)
        pol.product_id,
        pol.id as purchase_line_id,
        round(coalesce(pol.unit_cost_lyd, pol.unit_cost, 0)::numeric, 4) as latest_cost
      from public.purchase_order_lines pol
      where pol.purchase_order_id = v_purchase_id
        and coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) > 0
      order by pol.product_id, pol.line_position desc, pol.id desc
    )
    update public.products p
    set
      cost_price = round(latest_line.latest_cost, 2),
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      last_purchase_date = coalesce(p_order_date, current_date),
      last_supplier_id = p_supplier_id,
      last_purchase_line_id = latest_line.purchase_line_id,
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
      received_by = v_created_by,
      updated_at = now()
    where po.id = v_purchase_id;
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

revoke all on function public.snacky_create_purchase_with_lines(
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
) from public;

revoke execute on function public.snacky_create_purchase_with_lines(
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
) from anon;

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

select pg_notify('pgrst', 'reload schema');
