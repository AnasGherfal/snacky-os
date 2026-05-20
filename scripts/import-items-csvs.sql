\set ON_ERROR_STOP on

set datestyle = 'ISO, MDY';
set timezone = 'UTC';

begin;

create or replace function pg_temp.clean_text(value text)
returns text
language sql
immutable
as $$
  select nullif(nullif(btrim(coalesce(value, '')), ''), 'TO_CONFIRM')
$$;

create or replace function pg_temp.num_or_null(value text)
returns numeric
language sql
immutable
as $$
  select case
    when pg_temp.clean_text(value) ~ '^-?[0-9]+(\.[0-9]+)?$' then pg_temp.clean_text(value)::numeric
    else null
  end
$$;

create or replace function pg_temp.legacy_uuid(kind text, legacy_id text)
returns uuid
language sql
immutable
as $$
  select case
    when pg_temp.clean_text(legacy_id) is null then null
    else md5(kind || ':' || pg_temp.clean_text(legacy_id))::uuid
  end
$$;

create or replace function pg_temp.ts_or_null(value text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  if pg_temp.clean_text(value) is null then
    return null;
  end if;

  return pg_temp.clean_text(value)::timestamptz;
exception when others then
  return null;
end;
$$;

create temp table import_report (
  sort_order integer generated always as identity,
  metric text not null,
  value integer not null
) on commit preserve rows;

create temp table raw_purchases (
  row_no integer generated always as identity,
  purchase_id text,
  datetime text,
  operator_email text,
  supplier text,
  receipt_total text,
  calculated_total text,
  receipt_photo text,
  notes text
) on commit drop;

create temp table raw_purchase_lines (
  row_no integer generated always as identity,
  line_id text,
  purchase_id text,
  item_id text,
  qty_pieces text,
  unit_cost text,
  boxes_qty text,
  received_units text,
  pack_size_used text
) on commit drop;

create temp table raw_inventory_current (
  row_no integer generated always as identity,
  inventory_id text,
  item_id text,
  datetime text,
  amount text,
  source_purchase_id text,
  location_id text,
  reason text,
  operator_email text,
  machine_id text,
  related_refill_id text
) on commit drop;

create temp table raw_inventory_old (
  row_no integer generated always as identity,
  inventory_id text,
  item_id text,
  datetime text,
  amount text,
  source_purchase_id text,
  from_location_id text,
  to_location_id text,
  reason text,
  operator_email text,
  machine_id text,
  related_refill_id text
) on commit drop;

\copy raw_purchases(purchase_id, datetime, operator_email, supplier, receipt_total, calculated_total, receipt_photo, notes) from '/tmp/items_purchases.csv' with (format csv, header true)
\copy raw_purchase_lines(line_id, purchase_id, item_id, qty_pieces, unit_cost, boxes_qty, received_units, pack_size_used) from '/tmp/items_purchase_lines.csv' with (format csv, header true)
\copy raw_inventory_current(inventory_id, item_id, datetime, amount, source_purchase_id, location_id, reason, operator_email, machine_id, related_refill_id) from '/tmp/items_inventory.csv' with (format csv, header true)
\copy raw_inventory_old(inventory_id, item_id, datetime, amount, source_purchase_id, from_location_id, to_location_id, reason, operator_email, machine_id, related_refill_id) from '/tmp/items_inventory_old.csv' with (format csv, header true)

insert into import_report(metric, value)
select 'raw purchase rows', count(*) from raw_purchases
union all select 'raw purchase line rows', count(*) from raw_purchase_lines
union all select 'raw current inventory rows', count(*) from raw_inventory_current
union all select 'raw old inventory rows', count(*) from raw_inventory_old;

insert into team_members (id, full_name, email, role, active)
select
  pg_temp.legacy_uuid('team_member_email', email),
  split_part(email, '@', 1),
  email,
  'operator',
  true
from (
  select distinct lower(pg_temp.clean_text(operator_email)) as email from raw_purchases
  union
  select distinct lower(pg_temp.clean_text(operator_email)) as email from raw_inventory_current
  union
  select distinct lower(pg_temp.clean_text(operator_email)) as email from raw_inventory_old
) emails
where email is not null
  and not exists (
    select 1
    from team_members tm
    where lower(tm.email) = emails.email
  )
on conflict (id) do nothing;

insert into import_report(metric, value)
select 'team members available for import emails', count(distinct lower(email))
from team_members
where email in (
  select pg_temp.clean_text(operator_email) from raw_purchases
  union
  select pg_temp.clean_text(operator_email) from raw_inventory_current
  union
  select pg_temp.clean_text(operator_email) from raw_inventory_old
);

insert into suppliers (id, name, notes)
select
  pg_temp.legacy_uuid('supplier_name', supplier_name),
  supplier_name,
  'Imported from Items - Purchases.csv'
from (
  select distinct pg_temp.clean_text(supplier) as supplier_name
  from raw_purchases
) suppliers_in_file
where supplier_name is not null
on conflict (id) do update
set
  name = excluded.name,
  notes = coalesce(suppliers.notes, excluded.notes);

insert into import_report(metric, value)
select 'suppliers imported from purchases', count(*)
from (
  select distinct pg_temp.clean_text(supplier) as supplier_name
  from raw_purchases
  where pg_temp.clean_text(supplier) is not null
) supplier_count;

insert into products (
  sku,
  name,
  category,
  cost_price,
  selling_price,
  current_cost_price_lyd,
  current_selling_price_lyd,
  cost_price_source,
  selling_price_source,
  import_source,
  active
)
select
  item_id,
  'Imported item ' || item_id,
  'unknown',
  0,
  0,
  0,
  0,
  'initial_import',
  'initial_import',
  'items_csv',
  true
from (
  select distinct pg_temp.clean_text(item_id) as item_id
  from raw_purchase_lines
  union
  select distinct pg_temp.clean_text(item_id) as item_id
  from raw_inventory_current
  union
  select distinct pg_temp.clean_text(item_id) as item_id
  from raw_inventory_old
) item_ids
where item_id is not null
  and not exists (
    select 1
    from products p
    where p.sku = item_ids.item_id
  )
on conflict (sku) do nothing;

insert into import_report(metric, value)
select 'placeholder products available for missing CSV item IDs', count(*)
from products
where import_source = 'items_csv'
  and name like 'Imported item %';

create temp table prepared_purchase_lines as
with parsed as (
  select
    r.*,
    pg_temp.legacy_uuid('purchase_line', r.line_id) as id,
    pg_temp.legacy_uuid('purchase', r.purchase_id) as purchase_order_id,
    p.id as product_id,
    p.case_quantity,
    pg_temp.num_or_null(r.qty_pieces) as qty_pieces_num,
    pg_temp.num_or_null(r.received_units) as received_units_num,
    pg_temp.num_or_null(r.boxes_qty) as boxes_qty_num,
    pg_temp.num_or_null(r.pack_size_used) as pack_size_used_num,
    pg_temp.num_or_null(r.unit_cost) as unit_cost_num
  from raw_purchase_lines r
  left join products p on p.sku = pg_temp.clean_text(r.item_id)
),
quantities as (
  select
    parsed.*,
    greatest(
      0,
      round(coalesce(received_units_num, qty_pieces_num, boxes_qty_num * nullif(pack_size_used_num, 0), 0))::integer
    ) as total_units_calc,
    greatest(0, round(coalesce(boxes_qty_num, 0))::integer) as boxes_qty_calc
  from parsed
),
units as (
  select
    quantities.*,
    greatest(
      1,
      round(coalesce(
        nullif(pack_size_used_num, 0),
        case
          when boxes_qty_calc > 0 and total_units_calc > 0 then total_units_calc::numeric / boxes_qty_calc
          else null
        end,
        case_quantity,
        1
      ))::integer
    ) as units_per_box_calc
  from quantities
)
select
  id,
  purchase_order_id,
  product_id,
  row_number() over (partition by purchase_order_id order by row_no) - 1 as line_position,
  boxes_qty_calc as boxes_qty,
  units_per_box_calc as units_per_box,
  case
    when boxes_qty_calc > 0 then greatest(0, total_units_calc - (boxes_qty_calc * units_per_box_calc))
    else total_units_calc
  end as loose_units_qty,
  total_units_calc as total_units,
  round(coalesce(unit_cost_num, 0), 4) as unit_cost_lyd,
  round(coalesce(unit_cost_num, 0), 2) as unit_cost,
  round(total_units_calc * coalesce(unit_cost_num, 0), 2) as line_total_lyd,
  round(total_units_calc * coalesce(unit_cost_num, 0), 2) as line_total,
  line_id,
  purchase_id,
  item_id
from units
where id is not null
  and purchase_order_id is not null
  and product_id is not null
  and total_units_calc > 0;

insert into import_report(metric, value)
select 'purchase lines skipped: missing product or quantity', count(*)
from raw_purchase_lines r
left join prepared_purchase_lines p on p.line_id = r.line_id
where pg_temp.clean_text(r.line_id) is not null
  and p.id is null;

insert into purchase_orders (
  id,
  supplier_id,
  status,
  order_date,
  received_date,
  notes,
  created_at,
  receipt_number,
  payment_method,
  receipt_url,
  total_amount,
  created_by,
  received_by,
  received_at,
  updated_at,
  manual_total_lyd,
  calculated_total_lyd,
  total_adjustment_lyd,
  total_source,
  payment_status
)
with line_totals as (
  select purchase_id, round(sum(line_total_lyd), 2) as line_total
  from prepared_purchase_lines
  group by purchase_id
),
prepared as (
  select
    pg_temp.legacy_uuid('purchase', p.purchase_id) as id,
    pg_temp.legacy_uuid('supplier_name', p.supplier) as supplier_id,
    coalesce(pg_temp.ts_or_null(p.datetime), now()) as purchase_ts,
    pg_temp.clean_text(p.purchase_id) as legacy_purchase_id,
    pg_temp.clean_text(p.receipt_photo) as receipt_photo,
    pg_temp.clean_text(p.notes) as source_notes,
    pg_temp.num_or_null(p.receipt_total) as receipt_total_lyd,
    coalesce(pg_temp.num_or_null(p.calculated_total), lt.line_total, 0) as calculated_total_lyd,
    coalesce(pg_temp.num_or_null(p.receipt_total), pg_temp.num_or_null(p.calculated_total), lt.line_total, 0) as total_amount_lyd,
    tm.id as team_member_id
  from raw_purchases p
  left join line_totals lt on lt.purchase_id = p.purchase_id
  left join team_members tm on lower(tm.email) = lower(pg_temp.clean_text(p.operator_email))
  where pg_temp.clean_text(p.purchase_id) is not null
)
select
  id,
  supplier_id,
  'received',
  purchase_ts::date,
  purchase_ts::date,
  concat_ws(
    ' | ',
    source_notes,
    'Imported from Items - Purchases.csv',
    'legacy_purchase_id=' || legacy_purchase_id
  ),
  purchase_ts,
  legacy_purchase_id,
  'cash',
  receipt_photo,
  round(total_amount_lyd, 2),
  team_member_id,
  team_member_id,
  purchase_ts,
  now(),
  case when receipt_total_lyd is null then null else round(receipt_total_lyd, 2) end,
  round(calculated_total_lyd, 2),
  case when receipt_total_lyd is null then null else round(receipt_total_lyd - calculated_total_lyd, 2) end,
  case when receipt_total_lyd is null then 'calculated' else 'manual' end,
  'paid'
from prepared
where id is not null
on conflict (id) do update
set
  supplier_id = excluded.supplier_id,
  status = excluded.status,
  order_date = excluded.order_date,
  received_date = excluded.received_date,
  notes = excluded.notes,
  receipt_number = excluded.receipt_number,
  payment_method = excluded.payment_method,
  receipt_url = excluded.receipt_url,
  total_amount = excluded.total_amount,
  created_by = excluded.created_by,
  received_by = excluded.received_by,
  received_at = excluded.received_at,
  updated_at = now(),
  manual_total_lyd = excluded.manual_total_lyd,
  calculated_total_lyd = excluded.calculated_total_lyd,
  total_adjustment_lyd = excluded.total_adjustment_lyd,
  total_source = excluded.total_source,
  payment_status = excluded.payment_status;

insert into import_report(metric, value)
select 'purchase orders imported', count(*)
from raw_purchases
where pg_temp.clean_text(purchase_id) is not null;

insert into purchase_orders (
  id,
  supplier_id,
  status,
  order_date,
  received_date,
  notes,
  created_at,
  receipt_number,
  payment_method,
  receipt_url,
  total_amount,
  created_by,
  received_by,
  received_at,
  updated_at,
  manual_total_lyd,
  calculated_total_lyd,
  total_adjustment_lyd,
  total_source,
  payment_status
)
with line_totals as (
  select
    purchase_id,
    purchase_order_id,
    round(sum(line_total_lyd), 2) as line_total
  from prepared_purchase_lines
  group by purchase_id, purchase_order_id
),
inventory_dates as (
  select legacy_source_purchase_id, min(movement_ts) as movement_ts
  from (
    select
      pg_temp.clean_text(source_purchase_id) as legacy_source_purchase_id,
      pg_temp.ts_or_null(datetime) as movement_ts
    from raw_inventory_current
    where pg_temp.clean_text(source_purchase_id) is not null

    union all

    select
      pg_temp.clean_text(source_purchase_id) as legacy_source_purchase_id,
      pg_temp.ts_or_null(datetime) as movement_ts
    from raw_inventory_old
    where pg_temp.clean_text(source_purchase_id) is not null
  ) dated_movements
  where movement_ts is not null
  group by legacy_source_purchase_id
),
source_bounds as (
  select max(pg_temp.ts_or_null(datetime)) as latest_purchase_ts
  from raw_purchases
  where pg_temp.clean_text(purchase_id) is not null
),
missing as (
  select
    lt.purchase_id,
    lt.purchase_order_id,
    lt.line_total,
    least(
      coalesce(idt.movement_ts, source_bounds.latest_purchase_ts, now()),
      coalesce(source_bounds.latest_purchase_ts, idt.movement_ts, now())
    ) as purchase_ts
  from line_totals lt
  cross join source_bounds
  left join inventory_dates idt on idt.legacy_source_purchase_id = lt.purchase_id
  where not exists (
    select 1
    from raw_purchases rp
    where pg_temp.clean_text(rp.purchase_id) = lt.purchase_id
  )
)
select
  purchase_order_id,
  null,
  'received',
  purchase_ts::date,
  purchase_ts::date,
  'Imported placeholder from Items - PurchaseLines.csv because this purchase ID was missing from Items - Purchases.csv | legacy_purchase_id=' || purchase_id,
  purchase_ts,
  purchase_id,
  'cash',
  null,
  line_total,
  null,
  null,
  purchase_ts,
  now(),
  null,
  line_total,
  null,
  'calculated',
  'paid'
from missing
on conflict (id) do update
set
  status = excluded.status,
  order_date = excluded.order_date,
  received_date = excluded.received_date,
  notes = excluded.notes,
  receipt_number = excluded.receipt_number,
  payment_method = excluded.payment_method,
  receipt_url = excluded.receipt_url,
  total_amount = excluded.total_amount,
  received_at = excluded.received_at,
  updated_at = now(),
  manual_total_lyd = excluded.manual_total_lyd,
  calculated_total_lyd = excluded.calculated_total_lyd,
  total_adjustment_lyd = excluded.total_adjustment_lyd,
  total_source = excluded.total_source,
  payment_status = excluded.payment_status
where purchase_orders.notes like 'Imported placeholder from Items - PurchaseLines.csv%';

insert into import_report(metric, value)
select 'placeholder purchase orders imported from lines', count(*)
from (
  select distinct ppl.purchase_id
  from prepared_purchase_lines ppl
  where not exists (
    select 1
    from raw_purchases rp
    where pg_temp.clean_text(rp.purchase_id) = ppl.purchase_id
  )
) missing_purchase_headers;

insert into purchase_order_lines (
  id,
  purchase_order_id,
  product_id,
  ordered_qty,
  received_qty,
  unit_cost,
  boxes_qty,
  units_per_box,
  loose_units_qty,
  total_units,
  line_total,
  created_at,
  unit_cost_lyd,
  line_total_lyd,
  line_position
)
select
  ppl.id,
  ppl.purchase_order_id,
  ppl.product_id,
  ppl.total_units,
  ppl.total_units,
  ppl.unit_cost,
  ppl.boxes_qty,
  ppl.units_per_box,
  ppl.loose_units_qty,
  ppl.total_units,
  ppl.line_total,
  coalesce(po.created_at, now()),
  ppl.unit_cost_lyd,
  ppl.line_total_lyd,
  ppl.line_position
from prepared_purchase_lines ppl
join purchase_orders po on po.id = ppl.purchase_order_id
on conflict (id) do update
set
  purchase_order_id = excluded.purchase_order_id,
  product_id = excluded.product_id,
  ordered_qty = excluded.ordered_qty,
  received_qty = excluded.received_qty,
  unit_cost = excluded.unit_cost,
  boxes_qty = excluded.boxes_qty,
  units_per_box = excluded.units_per_box,
  loose_units_qty = excluded.loose_units_qty,
  total_units = excluded.total_units,
  line_total = excluded.line_total,
  unit_cost_lyd = excluded.unit_cost_lyd,
  line_total_lyd = excluded.line_total_lyd,
  line_position = excluded.line_position;

insert into import_report(metric, value)
select 'purchase lines imported', count(*)
from purchase_order_lines pol
join prepared_purchase_lines ppl on ppl.id = pol.id;

create temp table prepared_inventory_movements as
with raw_inventory as (
  select
    'Items - Inventory.csv' as source_file,
    row_no,
    inventory_id,
    item_id,
    datetime,
    amount,
    source_purchase_id,
    null::text as from_location_id,
    location_id as to_location_id,
    reason as raw_reason,
    operator_email,
    machine_id,
    related_refill_id
  from raw_inventory_current

  union all

  select
    'Items - Inventory_Old.csv' as source_file,
    row_no,
    inventory_id,
    item_id,
    datetime,
    amount,
    source_purchase_id,
    from_location_id,
    to_location_id,
    reason as raw_reason,
    operator_email,
    machine_id,
    related_refill_id
  from raw_inventory_old
),
main_storage as (
  select id
  from storage_locations
  where name = 'MAIN'
  order by created_at
  limit 1
),
parsed as (
  select
    r.*,
    pg_temp.legacy_uuid('inventory_movement', r.inventory_id) as id,
    pg_temp.clean_text(r.inventory_id) as legacy_inventory_id,
    pg_temp.clean_text(r.item_id) as sku,
    pg_temp.clean_text(r.source_purchase_id) as legacy_source_purchase_id,
    pg_temp.clean_text(r.raw_reason) as source_reason,
    pg_temp.clean_text(r.related_refill_id) as legacy_related_refill_id,
    pg_temp.num_or_null(r.amount) as signed_amount,
    coalesce(pg_temp.ts_or_null(r.datetime), now()) as movement_ts,
    p.id as product_id,
    tm.id as team_member_id,
    po.id as related_purchase_id,
    po.supplier_id as related_supplier_id,
    m.id as related_machine_id,
    ms.id as main_storage_id
  from raw_inventory r
  cross join main_storage ms
  left join products p on p.sku = pg_temp.clean_text(r.item_id)
  left join team_members tm on lower(tm.email) = lower(pg_temp.clean_text(r.operator_email))
  left join purchase_orders po on po.id = pg_temp.legacy_uuid('purchase', r.source_purchase_id)
  left join machines m on m.vms_machine_id = pg_temp.clean_text(r.machine_id)
    or m.machine_code = pg_temp.clean_text(r.machine_id)
),
classified as (
  select
    parsed.*,
    abs(round(signed_amount))::integer as quantity,
    case
      when source_reason = 'PickForRoute' then 'storage_to_operator_bag'::movement_reason
      when source_reason = 'MoveToBackstock' then 'machine_to_storage'::movement_reason
      when signed_amount > 0 and (legacy_source_purchase_id is not null or source_reason = 'Purchase') then 'purchase_received'::movement_reason
      else 'stock_count_adjustment'::movement_reason
    end as reason,
    case
      when source_reason = 'PickForRoute' then 'storage'::inventory_entity_type
      when source_reason = 'MoveToBackstock' then 'machine'::inventory_entity_type
      when signed_amount < 0 then 'storage'::inventory_entity_type
      when signed_amount > 0 and (legacy_source_purchase_id is not null or source_reason = 'Purchase') then 'supplier'::inventory_entity_type
      else 'adjustment'::inventory_entity_type
    end as from_entity_type,
    case
      when source_reason = 'PickForRoute' then 'operator_bag'::inventory_entity_type
      when source_reason = 'MoveToBackstock' then 'storage'::inventory_entity_type
      when signed_amount < 0 then 'adjustment'::inventory_entity_type
      else 'storage'::inventory_entity_type
    end as to_entity_type
  from parsed
  where id is not null
    and product_id is not null
    and signed_amount is not null
    and round(signed_amount) <> 0
),
costs as (
  select
    c.*,
    exact_line.id as exact_purchase_line_id,
    coalesce(exact_line.unit_cost_lyd, guessed_line.unit_cost_lyd) as unit_cost_lyd,
    coalesce(exact_line.line_total_lyd, round(c.quantity * guessed_line.unit_cost_lyd, 2)) as line_total_lyd
  from classified c
  left join purchase_order_lines exact_line on exact_line.id = pg_temp.legacy_uuid('purchase_line', c.legacy_inventory_id)
  left join lateral (
    select pol.unit_cost_lyd
    from purchase_order_lines pol
    where pol.purchase_order_id = c.related_purchase_id
      and pol.product_id = c.product_id
      and pol.unit_cost_lyd > 0
    order by abs(pol.total_units - c.quantity), pol.id
    limit 1
  ) guessed_line on true
)
select
  id,
  source_file,
  legacy_inventory_id,
  sku,
  product_id,
  quantity,
  from_entity_type,
  case
    when from_entity_type = 'storage' then main_storage_id
    when from_entity_type = 'operator_bag' then team_member_id
    when from_entity_type = 'machine' then related_machine_id
    when from_entity_type = 'supplier' then related_supplier_id
    else null
  end as from_entity_id,
  to_entity_type,
  case
    when to_entity_type = 'storage' then main_storage_id
    when to_entity_type = 'operator_bag' then team_member_id
    when to_entity_type = 'machine' then related_machine_id
    else null
  end as to_entity_id,
  reason,
  related_purchase_id,
  case when reason = 'purchase_received' then exact_purchase_line_id else null end as related_purchase_line_id,
  related_machine_id,
  team_member_id as created_by,
  unit_cost_lyd,
  line_total_lyd,
  concat_ws(
    ' | ',
    'Imported from ' || source_file,
    'legacy_inventory_id=' || legacy_inventory_id,
    case when legacy_source_purchase_id is not null then 'source_purchase_id=' || legacy_source_purchase_id end,
    case when source_reason is not null then 'source_reason=' || source_reason end,
    case when legacy_related_refill_id is not null then 'related_refill_id=' || legacy_related_refill_id end
  ) as notes,
  movement_ts as created_at
from costs;

insert into import_report(metric, value)
select 'inventory rows skipped: missing product, zero, or bad amount', count(*)
from (
  select inventory_id, item_id, amount from raw_inventory_current
  union all
  select inventory_id, item_id, amount from raw_inventory_old
) raw_rows
left join prepared_inventory_movements pim
  on pim.legacy_inventory_id = pg_temp.clean_text(raw_rows.inventory_id)
where pg_temp.clean_text(raw_rows.inventory_id) is not null
  and pim.id is null;

update inventory_movements im
set
  related_purchase_id = coalesce(im.related_purchase_id, pim.related_purchase_id),
  related_purchase_line_id = coalesce(im.related_purchase_line_id, pim.related_purchase_line_id),
  related_machine_id = coalesce(im.related_machine_id, pim.related_machine_id),
  unit_cost_lyd = coalesce(im.unit_cost_lyd, pim.unit_cost_lyd),
  line_total_lyd = coalesce(im.line_total_lyd, pim.line_total_lyd),
  notes = case
    when im.notes like '%legacy_inventory_id=' || pim.legacy_inventory_id || '%' then im.notes
    else concat_ws(' | ', im.notes, 'linked by import legacy_inventory_id=' || pim.legacy_inventory_id)
  end
from prepared_inventory_movements pim
where im.notes like '%source inventory_id=' || pim.legacy_inventory_id || '%';

insert into import_report(metric, value)
select 'existing seeded inventory movements linked', count(*)
from inventory_movements im
join prepared_inventory_movements pim
  on im.notes like '%source inventory_id=' || pim.legacy_inventory_id || '%';

insert into inventory_movements (
  id,
  product_id,
  quantity,
  from_entity_type,
  from_entity_id,
  to_entity_type,
  to_entity_id,
  reason,
  related_purchase_id,
  related_purchase_line_id,
  related_machine_id,
  created_by,
  unit_cost_lyd,
  line_total_lyd,
  notes,
  created_at
)
select
  pim.id,
  pim.product_id,
  pim.quantity,
  pim.from_entity_type,
  pim.from_entity_id,
  pim.to_entity_type,
  pim.to_entity_id,
  pim.reason,
  pim.related_purchase_id,
  pim.related_purchase_line_id,
  pim.related_machine_id,
  pim.created_by,
  pim.unit_cost_lyd,
  pim.line_total_lyd,
  pim.notes,
  pim.created_at
from prepared_inventory_movements pim
where not exists (
  select 1
  from inventory_movements im
  where im.id = pim.id
     or im.notes like '%source inventory_id=' || pim.legacy_inventory_id || '%'
     or im.notes like '%legacy_inventory_id=' || pim.legacy_inventory_id || '%'
)
on conflict (id) do update
set
  product_id = excluded.product_id,
  quantity = excluded.quantity,
  from_entity_type = excluded.from_entity_type,
  from_entity_id = excluded.from_entity_id,
  to_entity_type = excluded.to_entity_type,
  to_entity_id = excluded.to_entity_id,
  reason = excluded.reason,
  related_purchase_id = excluded.related_purchase_id,
  related_purchase_line_id = excluded.related_purchase_line_id,
  related_machine_id = excluded.related_machine_id,
  created_by = excluded.created_by,
  unit_cost_lyd = excluded.unit_cost_lyd,
  line_total_lyd = excluded.line_total_lyd,
  notes = excluded.notes,
  created_at = excluded.created_at;

insert into import_report(metric, value)
select 'inventory movements prepared from CSVs', count(*) from prepared_inventory_movements;

insert into import_report(metric, value)
select 'inventory movements now linked to purchases', count(*)
from inventory_movements
where related_purchase_id is not null;

with latest_cost as (
  select distinct on (pol.product_id)
    pol.product_id,
    pol.unit_cost_lyd,
    po.received_at
  from purchase_order_lines pol
  join purchase_orders po on po.id = pol.purchase_order_id
  where pol.unit_cost_lyd > 0
  order by pol.product_id, po.received_at desc nulls last, pol.line_position desc, pol.id
)
update products p
set
  cost_price = round(latest_cost.unit_cost_lyd, 2),
  current_cost_price_lyd = latest_cost.unit_cost_lyd,
  last_purchase_cost_lyd = latest_cost.unit_cost_lyd,
  cost_price_source = 'latest_purchase',
  price_updated_at = now(),
  updated_at = now()
from latest_cost
where p.id = latest_cost.product_id;

insert into import_report(metric, value)
select 'products updated with latest purchase cost', count(*)
from products
where cost_price_source = 'latest_purchase';

commit;

select metric, value
from import_report
order by sort_order;
