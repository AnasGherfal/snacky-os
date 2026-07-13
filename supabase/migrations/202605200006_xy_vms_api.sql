create table if not exists vms_sync_runs (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'xy',
  sync_type text not null,
  status text not null default 'running',
  endpoint text,
  merchant_id_masked text,
  requested_by uuid references team_members(id) on delete set null,
  row_count integer not null default 0,
  rows_imported integer not null default 0,
  rows_updated integer not null default 0,
  rows_skipped integer not null default 0,
  error_count integer not null default 0,
  message text,
  request_summary jsonb not null default '{}'::jsonb,
  response_summary jsonb not null default '{}'::jsonb,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint vms_sync_runs_status_check check (status in ('running', 'completed', 'completed_with_warnings', 'failed'))
);

create index if not exists idx_vms_sync_runs_provider_type_created
  on vms_sync_runs(provider, sync_type, created_at desc);

create index if not exists idx_vms_sync_runs_status_created
  on vms_sync_runs(status, created_at desc);

create table if not exists vms_product_catalog_snapshots (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references vms_sync_runs(id) on delete set null,
  vms_product_id text,
  third_party_product_id text,
  product_id uuid references products(id) on delete set null,
  product_name text,
  barcode text,
  selling_price_lyd numeric(12,2),
  image_url text,
  detail_images jsonb not null default '[]'::jsonb,
  raw_data jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_vms_product_catalog_snapshots_product
  on vms_product_catalog_snapshots(vms_product_id, third_party_product_id, captured_at desc);

create index if not exists idx_vms_product_catalog_snapshots_sync_run
  on vms_product_catalog_snapshots(sync_run_id);

create table if not exists vms_machine_status_snapshots (
  id uuid primary key default gen_random_uuid(),
  sync_run_id uuid references vms_sync_runs(id) on delete set null,
  machine_id uuid references machines(id) on delete cascade,
  vms_machine_id text,
  network_status text,
  temperature_raw text,
  humidity_raw text,
  raw_data jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_vms_machine_status_snapshots_machine
  on vms_machine_status_snapshots(machine_id, captured_at desc);

create index if not exists idx_vms_machine_status_snapshots_sync_run
  on vms_machine_status_snapshots(sync_run_id);

alter table locations
  add column if not exists latitude numeric(12,8),
  add column if not exists longitude numeric(12,8),
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table machines
  add column if not exists vms_provider text,
  add column if not exists vms_category text,
  add column if not exists vms_type text,
  add column if not exists vms_location_name text,
  add column if not exists vms_longitude numeric(12,8),
  add column if not exists vms_latitude numeric(12,8),
  add column if not exists vms_temperature_raw text,
  add column if not exists vms_humidity_raw text,
  add column if not exists vms_raw_metadata jsonb not null default '{}'::jsonb,
  add column if not exists vms_last_synced_at timestamptz;

alter table vms_product_mappings
  add column if not exists vms_third_party_product_id text,
  add column if not exists vms_barcode text,
  add column if not exists vms_image_url text,
  add column if not exists vms_raw_metadata jsonb not null default '{}'::jsonb;

create index if not exists idx_vms_product_mappings_third_party
  on vms_product_mappings(vms_third_party_product_id);

create index if not exists idx_vms_product_mappings_barcode
  on vms_product_mappings(vms_barcode);

alter table vms_stock_snapshots
  add column if not exists sync_run_id uuid references vms_sync_runs(id) on delete set null,
  add column if not exists source_provider text,
  add column if not exists third_party_product_id text,
  add column if not exists locked_inventory_qty integer,
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists product_image_url text,
  add column if not exists production_date date,
  add column if not exists aisle_status text;

create index if not exists idx_vms_stock_snapshots_sync_run
  on vms_stock_snapshots(sync_run_id);

create index if not exists idx_vms_stock_snapshots_provider_captured
  on vms_stock_snapshots(source_provider, captured_at desc);

drop view if exists refill_recommendations;
drop view if exists latest_vms_stock_by_slot;

create view latest_vms_stock_by_slot as
with normalized as (
  select
    vss.id,
    vss.import_batch_id,
    vib.imported_at as batch_imported_at,
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
  from vms_stock_snapshots vss
  left join vms_import_batches vib on vib.id = vss.import_batch_id
  where vss.machine_id is not null
    and vss.import_row_status = 'imported'
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
  max(batch_imported_at) as imported_at,
  (array_agg(sync_run_id order by created_at desc, id desc))[1] as sync_run_id,
  (array_agg(source_provider order by created_at desc, id desc))[1] as source_provider
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
  );
