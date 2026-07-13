drop view if exists refill_recommendations;
drop view if exists latest_vms_stock_by_slot;

create view latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vib.imported_at as batch_imported_at,
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
  left join vms_import_batches vib on vib.id = vss.import_batch_id
  where vss.machine_id is not null
),
ranked as (
  select
    normalized.*,
    dense_rank() over (
      partition by machine_id, stock_item_key
      order by captured_at desc, batch_imported_at desc nulls last, created_at desc
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
  stock_item_key,
  (array_agg(import_batch_id order by batch_imported_at desc nulls last, created_at desc, id desc))[1] as import_batch_id,
  max(batch_imported_at) as imported_at
from latest
group by machine_id, stock_item_key;

create view refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from current_inventory_by_location
  where location_type = 'storage'
  group by product_id
),
vms_stock as (
  select
    lvs.id,
    lvs.machine_id,
    lvs.slot_code,
    coalesce(lvs.product_id, mapped.product_id) as product_id,
    lvs.vms_product_id,
    lvs.vms_product_name,
    lvs.current_qty,
    lvs.capacity,
    lvs.captured_at,
    lvs.tray_status,
    lvs.stock_item_key,
    lvs.import_batch_id,
    lvs.imported_at,
    lower(coalesce(lvs.tray_status, '')) as normalized_status
  from latest_vms_stock_by_slot lvs
  left join lateral (
    select vpm.product_id
    from vms_product_mappings vpm
    where vpm.product_id is not null
      and vpm.match_status = 'confirmed'
      and (
        (
          lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
        or (
          lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        )
        or (
          lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        )
      )
    order by
      case
        when lvs.vms_product_id is not null
          and lvs.vms_product_name is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
          and lower(btrim(vpm.vms_product_name)) = lower(btrim(lvs.vms_product_name))
        then 0
        when lvs.vms_product_id is not null
          and lower(btrim(vpm.vms_product_id)) = lower(btrim(lvs.vms_product_id))
        then 1
        else 2
      end,
      vpm.updated_at desc
    limit 1
  ) mapped on true
  where coalesce(lvs.product_id, mapped.product_id) is not null
),
vms_scored as (
  select
    vms_stock.*,
    (
      current_qty <= 0
      or (
        normalized_status not like '%not empty%'
        and normalized_status not like '%not out%'
        and (
          normalized_status in ('empty', 'out', 'out_of_stock', 'sold_out', 'yes', 'true', '1')
          or normalized_status like '%out of stock%'
          or normalized_status like '%sold out%'
          or normalized_status like '%empty%'
        )
      )
    ) as out_of_stock
  from vms_stock
),
matched_slots as (
  select distinct on (v.id)
    v.id as vms_stock_snapshot_id,
    ms.id as machine_slot_id,
    ms.slot_code
  from vms_scored v
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
      when v.out_of_stock then 'critical'
      when v.capacity is not null and v.current_qty <= v.capacity * 0.25 then 'high'
      when v.capacity is not null and v.current_qty <= v.capacity * 0.50 then 'medium'
      else 'low'
    end as priority,
    v.captured_at as latest_vms_at,
    md5(concat_ws('|', 'vms_stock', v.machine_id::text, v.stock_item_key)) as recommendation_key,
    v.id as vms_stock_snapshot_id,
    'vms_stock'::text as recommendation_source,
    v.capacity::integer as capacity,
    v.tray_status,
    v.import_batch_id,
    v.imported_at
  from vms_scored v
  join machines m on m.id = v.machine_id
  join products p on p.id = v.product_id
  left join matched_slots ms on ms.vms_stock_snapshot_id = v.id
  left join storage_stock ss on ss.product_id = p.id
  where m.status = 'active'
    and (
      (v.capacity is not null and greatest(v.capacity - v.current_qty, 0) > 0)
      or v.out_of_stock
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
    null::text as tray_status,
    null::uuid as import_batch_id,
    null::timestamptz as imported_at
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
