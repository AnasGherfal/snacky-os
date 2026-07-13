drop view if exists public.refill_recommendations;
drop view if exists public.latest_vms_stock_by_slot;

create view public.latest_vms_stock_by_slot as
with latest_batch as (
  select
    vib.id,
    vib.imported_at as batch_imported_at,
    vib.uploaded_at as batch_uploaded_at,
    coalesce(vib.original_file_name, vib.file_name, 'unknown file') as batch_file_name
  from public.vms_import_batches vib
  where vib.report_type in ('stock', 'machine_stock_snapshot')
    and vib.status in ('imported', 'imported_with_warnings', 'partially_imported')
    and vib.is_active = true
    and vib.deleted_at is null
  order by coalesce(vib.imported_at, vib.uploaded_at, vib.created_at) desc, vib.created_at desc, vib.id desc
  limit 1
),
normalized as (
  select
    vss.id,
    vss.import_batch_id,
    lb.batch_imported_at,
    lb.batch_uploaded_at,
    lb.batch_file_name,
    vss.sync_run_id,
    vss.source_provider,
    vss.machine_id,
    nullif(btrim(vss.slot_code), '') as slot_code,
    vss.product_id,
    nullif(btrim(vss.vms_product_id), '') as vms_product_id,
    nullif(btrim(vss.vms_product_name), '') as vms_product_name,
    vss.current_qty,
    vss.capacity,
    vss.captured_at,
    vss.created_at,
    nullif(btrim(coalesce(vss.aisle_status, vss.tray_status)), '') as tray_status,
    coalesce(
      nullif(btrim(vss.slot_code), ''),
      vss.product_id::text,
      nullif(btrim(vss.vms_product_id), ''),
      nullif(btrim(vss.vms_product_name), ''),
      vss.id::text
    ) as stock_item_key
  from public.vms_stock_snapshots vss
  join latest_batch lb on lb.id = vss.import_batch_id
  where vss.machine_id is not null
    and vss.import_row_status = 'imported'
),
ranked as (
  select
    normalized.*,
    dense_rank() over (
      partition by machine_id, stock_item_key
      order by captured_at desc, created_at desc, id desc
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
  max(batch_imported_at) as imported_at,
  max(batch_uploaded_at) as source_uploaded_at,
  (array_agg(batch_file_name order by batch_imported_at desc nulls last, created_at desc, id desc))[1] as source_file_name,
  (array_agg(sync_run_id order by created_at desc, id desc))[1] as sync_run_id,
  (array_agg(source_provider order by created_at desc, id desc))[1] as source_provider
from latest
group by machine_id, stock_item_key;

create view public.refill_recommendations as
with storage_stock as (
  select product_id, sum(quantity_on_hand)::integer as available_storage_qty
  from public.current_inventory_by_location
  where location_type = 'storage'
  group by product_id
),
vms_stock as (
  select
    latest_vms_stock_by_slot.id,
    latest_vms_stock_by_slot.machine_id,
    latest_vms_stock_by_slot.slot_code,
    latest_vms_stock_by_slot.product_id,
    latest_vms_stock_by_slot.current_qty,
    latest_vms_stock_by_slot.capacity,
    latest_vms_stock_by_slot.captured_at,
    latest_vms_stock_by_slot.vms_product_id,
    latest_vms_stock_by_slot.vms_product_name,
    latest_vms_stock_by_slot.tray_status,
    latest_vms_stock_by_slot.stock_item_key,
    latest_vms_stock_by_slot.import_batch_id,
    latest_vms_stock_by_slot.imported_at,
    latest_vms_stock_by_slot.source_uploaded_at,
    latest_vms_stock_by_slot.source_file_name,
    latest_vms_stock_by_slot.sync_run_id,
    latest_vms_stock_by_slot.source_provider,
    lower(coalesce(latest_vms_stock_by_slot.tray_status, '')) as normalized_tray_status
  from public.latest_vms_stock_by_slot
  where latest_vms_stock_by_slot.product_id is not null
),
matched_slots as (
  select distinct on (v.id)
    v.id as vms_stock_snapshot_id,
    ms.id as machine_slot_id,
    ms.slot_code,
    ms.min_qty,
    ms.par_qty
  from vms_stock v
  left join public.machine_slots ms
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
  v.imported_at,
  v.import_batch_id,
  v.source_file_name,
  v.source_uploaded_at,
  md5(concat_ws('|', 'vms_stock', v.machine_id::text, v.stock_item_key)) as recommendation_key,
  v.id as vms_stock_snapshot_id,
  'vms_stock'::text as recommendation_source,
  v.capacity,
  v.tray_status
from vms_stock v
join public.machines m on m.id = v.machine_id
join public.products p on p.id = v.product_id
left join matched_slots ms on ms.vms_stock_snapshot_id = v.id
left join storage_stock ss on ss.product_id = p.id
where m.status = 'active'
  and coalesce(ms.par_qty, v.capacity) is not null
  and greatest(coalesce(ms.par_qty, v.capacity, v.current_qty) - v.current_qty, 0) > 0;

grant select on public.latest_vms_stock_by_slot to anon, authenticated, service_role;
grant select on public.refill_recommendations to anon, authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
