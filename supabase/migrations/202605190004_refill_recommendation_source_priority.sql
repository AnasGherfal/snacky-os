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
    ms.slot_code
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
),
vms_recommendations as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.machine_slot_id,
    coalesce(v.slot_code, ms.slot_code, 'VMS') as slot_code,
    p.id as product_id,
    p.name as product_name,
    v.current_qty,
    null::integer as min_qty,
    v.capacity::integer as par_qty,
    case
      when v.capacity is not null then greatest(v.capacity - v.current_qty, 0)::integer
      else null::integer
    end as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    case
      when v.capacity is not null then least(greatest(v.capacity - v.current_qty, 0), coalesce(ss.available_storage_qty, 0))::integer
      else null::integer
    end as final_qty_to_take,
    case
      when v.current_qty <= 0
        or (
          v.normalized_tray_status not like '%not empty%'
          and v.normalized_tray_status not like '%not out%'
          and (
            v.normalized_tray_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
            or v.normalized_tray_status like '%out of stock%'
            or v.normalized_tray_status like '%sold out%'
            or v.normalized_tray_status like '%empty%'
          )
        )
      then 'critical'
      when v.capacity is not null and v.current_qty < v.capacity then 'medium'
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
    and (
      (v.capacity is not null and greatest(v.capacity - v.current_qty, 0) > 0)
      or (
        v.capacity is null
        and (
          v.current_qty <= 0
          or (
            v.normalized_tray_status not like '%not empty%'
            and v.normalized_tray_status not like '%not out%'
            and (
              v.normalized_tray_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
              or v.normalized_tray_status like '%out of stock%'
              or v.normalized_tray_status like '%sold out%'
              or v.normalized_tray_status like '%empty%'
            )
          )
        )
      )
    )
),
planogram_fallback as (
  select
    m.id as machine_id,
    m.name as machine_name,
    m.machine_code,
    ms.id as machine_slot_id,
    ms.slot_code,
    p.id as product_id,
    p.name as product_name,
    0::integer as current_qty,
    ms.min_qty,
    ms.par_qty,
    ms.par_qty::integer as suggested_qty,
    coalesce(ss.available_storage_qty, 0) as available_storage_qty,
    least(ms.par_qty, coalesce(ss.available_storage_qty, 0))::integer as final_qty_to_take,
    'critical'::text as priority,
    null::timestamptz as latest_vms_at,
    md5(concat_ws('|', 'manual_planogram', ms.id::text)) as recommendation_key,
    null::uuid as vms_stock_snapshot_id,
    'manual_planogram_fallback'::text as recommendation_source,
    ms.capacity::integer as capacity,
    null::text as tray_status
  from machine_slots ms
  join machines m on m.id = ms.machine_id
  join products p on p.id = ms.product_id
  left join storage_stock ss on ss.product_id = p.id
  where ms.active = true
    and m.status = 'active'
    and not exists (
      select 1
      from latest_vms_stock_by_slot v
      where v.machine_id = ms.machine_id
    )
    and ms.par_qty > 0
)
select * from vms_recommendations
union all
select * from planogram_fallback;
