alter table refill_order_lines
  add column if not exists slot_code text;

alter table route_stop_items
  add column if not exists slot_code text;

create index if not exists idx_vms_stock_machine_product_captured
  on vms_stock_snapshots(machine_id, product_id, captured_at desc);

create or replace view latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vss.machine_id,
    nullif(btrim(vss.slot_code), '') as slot_code,
    vss.product_id,
    nullif(btrim(vss.vms_product_id), '') as vms_product_id,
    nullif(btrim(vss.vms_product_name), '') as vms_product_name,
    vss.current_qty,
    vss.capacity,
    vss.captured_at,
    vss.created_at,
    nullif(btrim(vss.tray_status), '') as tray_status,
    coalesce(
      nullif(btrim(vss.slot_code), ''),
      vss.product_id::text,
      nullif(btrim(vss.vms_product_id), ''),
      nullif(btrim(vss.vms_product_name), ''),
      vss.id::text
    ) as stock_item_key
  from vms_stock_snapshots vss
  where vss.machine_id is not null
),
ranked as (
  select
    normalized.*,
    dense_rank() over (
      partition by machine_id, stock_item_key
      order by captured_at desc, import_batch_id desc nulls last
    ) as recency_rank
  from normalized
),
latest as (
  select *
  from ranked
  where recency_rank = 1
)
select
  (array_agg(id order by created_at desc, id desc))[1] as id,
  machine_id,
  max(slot_code) as slot_code,
  (array_agg(product_id order by (product_id is not null) desc, created_at desc, id desc))[1] as product_id,
  sum(current_qty)::integer as current_qty,
  nullif(sum(coalesce(capacity, 0)), 0)::integer as capacity,
  max(captured_at) as captured_at,
  (array_agg(vms_product_id order by (vms_product_id is not null) desc, created_at desc, id desc))[1] as vms_product_id,
  (array_agg(vms_product_name order by (vms_product_name is not null) desc, created_at desc, id desc))[1] as vms_product_name,
  nullif(string_agg(distinct tray_status, ', '), '') as tray_status,
  stock_item_key
from latest
group by machine_id, stock_item_key;

create or replace view refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from current_inventory_by_location
  where location_type = 'storage'
  group by product_id
),
vms_stock as (
  select
    latest_vms_stock_by_slot.*,
    lower(coalesce(tray_status, '')) as normalized_tray_status
  from latest_vms_stock_by_slot
  where product_id is not null
),
matched_slots as (
  select distinct on (v.id)
    v.id as vms_stock_snapshot_id,
    ms.id as machine_slot_id,
    ms.slot_code,
    ms.min_qty,
    ms.par_qty
  from vms_stock v
  left join machine_slots ms
    on ms.machine_id = v.machine_id
   and ms.product_id = v.product_id
   and ms.active = true
   and (
     (v.slot_code is not null and ms.slot_code = v.slot_code)
     or v.slot_code is null
   )
  order by
    v.id,
    case when v.slot_code is not null and ms.slot_code = v.slot_code then 0 else 1 end,
    ms.created_at desc nulls last
)
select
  m.id as machine_id,
  m.name as machine_name,
  m.machine_code,
  ms.machine_slot_id,
  coalesce(v.slot_code, ms.slot_code, 'VMS') as slot_code,
  p.id as product_id,
  p.name as product_name,
  v.current_qty,
  coalesce(ms.min_qty, 0)::integer as min_qty,
  coalesce(ms.par_qty, v.capacity, v.current_qty)::integer as par_qty,
  greatest(coalesce(ms.par_qty, v.capacity, v.current_qty) - v.current_qty, 0)::integer as suggested_qty,
  coalesce(ss.available_storage_qty, 0) as available_storage_qty,
  least(
    greatest(coalesce(ms.par_qty, v.capacity, v.current_qty) - v.current_qty, 0),
    coalesce(ss.available_storage_qty, 0)
  )::integer as final_qty_to_take,
  case
    when v.current_qty <= 0
      or v.normalized_tray_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
      or v.normalized_tray_status like '%out of stock%'
      or v.normalized_tray_status like '%sold out%'
    then 'critical'
    when ms.min_qty is not null and v.current_qty <= ms.min_qty then 'high'
    when v.current_qty < coalesce(ms.par_qty, v.capacity, v.current_qty) then 'medium'
    else 'none'
  end as priority,
  v.captured_at as latest_vms_at,
  md5(concat_ws('|', 'vms_stock', v.machine_id::text, v.stock_item_key)) as recommendation_key,
  v.id as vms_stock_snapshot_id,
  'vms_stock'::text as recommendation_source,
  v.capacity::integer as capacity,
  v.tray_status
from vms_stock v
join machines m on m.id = v.machine_id
join products p on p.id = v.product_id
left join matched_slots ms on ms.vms_stock_snapshot_id = v.id
left join storage_stock ss on ss.product_id = p.id
where m.status = 'active'
  and coalesce(ms.par_qty, v.capacity) is not null
  and greatest(coalesce(ms.par_qty, v.capacity, v.current_qty) - v.current_qty, 0) > 0;
