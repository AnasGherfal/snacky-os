-- Seed Snacky OS from cleaned CSV-derived data.
-- Deterministic and rerunnable via `npx supabase db reset`.

begin;

-- Core storage
insert into storage_locations (id, name, address)
values ('00000000-0000-0000-0000-000000000201', 'MAIN', 'TO_CONFIRM')
on conflict (id) do update set name = excluded.name, address = excluded.address;

-- Minimal suppliers used by imported products
insert into suppliers (id, name, contact_name, phone, payment_terms, notes)
values
  ('00000000-0000-0000-0000-000000000301', 'TO_CONFIRM Supplier A', 'TO_CONFIRM', 'TO_CONFIRM', 'TO_CONFIRM', 'Seeded from CSV products'),
  ('00000000-0000-0000-0000-000000000302', 'TO_CONFIRM Supplier B', 'TO_CONFIRM', 'TO_CONFIRM', 'TO_CONFIRM', 'Seeded from CSV products')
on conflict do nothing;

create temporary table _machines_csv (
  machine_id text,
  machine_name text,
  location text,
  logo text,
  contact text,
  notes text,
  backstock_location_id text,
  shelf_location_id text
) on commit drop;
copy _machines_csv from '/workspace/snacky-os/docs/current-data/machines.csv' with (format csv, header true);

create temporary table _products_csv (
  product_id text, sku text, name text, description text, image text,
  selling_price text, purchase_price text, min_stock text, importance text,
  product_group text, barcode text, units_per_box text, sku_generated text
) on commit drop;
copy _products_csv from '/workspace/snacky-os/docs/current-data/products.csv' with (format csv, header true);

create temporary table _operators_csv (
  operator_email text, operator_name text, phone text,
  bag_location_id text, active text, is_admin text
) on commit drop;
copy _operators_csv from '/workspace/snacky-os/docs/current-data/operators.csv' with (format csv, header true);

create temporary table _storage_inventory_csv (
  inventory_id text, item_id text, datetime text, amount text, source_purchase_id text,
  location_id text, reason text, operator_email text, machine_id text, related_refill_id text
) on commit drop;
copy _storage_inventory_csv from '/workspace/snacky-os/docs/current-data/storage_inventory.csv' with (format csv, header true);

create temporary table _vms_mappings_csv (
  vms_product_number text, vms_product_name text, appsheet_item_id text,
  appsheet_item_name text, clean_name text, name_key text
) on commit drop;
copy _vms_mappings_csv from '/workspace/snacky-os/docs/current-data/vms_product_mappings.csv' with (format csv, header true);

create temporary table _planograms_csv (
  machine_id text, machine_name text, point_name text, vms_product_number text,
  vms_product_name text, inventory_capacity text, inventory_quantity text,
  fill_percent_product text, slot_code text, par_level text, min_level text
) on commit drop;
copy _planograms_csv from '/workspace/snacky-os/docs/current-data/machine_planograms.csv' with (format csv, header true);

-- Locations derived from machine locations.
insert into locations (id, name, location_type, address, contact_name, status, notes)
select
  ('00000000-0000-0000-0000-' || lpad(row_number() over(order by coalesce(nullif(location,''),'TO_CONFIRM'))::text, 12, '0'))::uuid,
  coalesce(nullif(location,''), 'TO_CONFIRM') as name,
  'other'::location_type,
  coalesce(nullif(location,''), 'TO_CONFIRM') as address,
  'TO_CONFIRM',
  'active',
  'Seeded from docs/current-data/machines.csv'
from (select distinct location from _machines_csv) q
on conflict do nothing;

-- Machines mapped 1:1 to CSV.
insert into machines (machine_code, vms_machine_id, name, machine_type, location_id, status, notes)
select
  'SNK-' || machine_id,
  machine_id,
  machine_name,
  'lift',
  l.id,
  'active',
  coalesce(nullif(m.notes,''), 'Seeded from machines.csv')
from _machines_csv m
left join locations l on l.name = coalesce(nullif(m.location,''), 'TO_CONFIRM')
on conflict (machine_code) do update set
  vms_machine_id = excluded.vms_machine_id,
  name = excluded.name,
  location_id = excluded.location_id,
  notes = excluded.notes;

-- Operators -> team_members
insert into team_members (full_name, phone, email, role, active)
select
  operator_name,
  phone,
  operator_email,
  case when is_admin = '1' then 'admin' else 'operator' end::team_role,
  active = '1'
from _operators_csv
on conflict do nothing;

-- Products mapped from real CSV.
insert into products (sku, barcode, name, category, brand, supplier_id, cost_price, selling_price, case_quantity, expiry_sensitive, active)
select
  p.sku,
  nullif(p.barcode,'TO_CONFIRM'),
  p.name,
  lower(coalesce(nullif(p.product_group,''), 'snack')),
  'TO_CONFIRM',
  case when row_number() over(order by p.sku)::int % 2 = 0 then '00000000-0000-0000-0000-000000000301'::uuid else '00000000-0000-0000-0000-000000000302'::uuid end,
  coalesce(nullif(p.purchase_price,'TO_CONFIRM')::numeric, 0),
  coalesce(nullif(p.selling_price,'TO_CONFIRM')::numeric, 0),
  coalesce(nullif(p.units_per_box,'TO_CONFIRM')::int, 1),
  true,
  true
from _products_csv p
on conflict (sku) do update set
  name = excluded.name,
  selling_price = excluded.selling_price,
  cost_price = excluded.cost_price,
  case_quantity = excluded.case_quantity,
  category = excluded.category;

-- VMS mappings
insert into vms_product_mappings (vms_product_id, vms_product_name, product_id, match_status)
select
  nullif(m.vms_product_number, 'TO_CONFIRM'),
  coalesce(nullif(m.vms_product_name,''), m.appsheet_item_name),
  p.id,
  case when m.vms_product_number = 'TO_CONFIRM' then 'needs_review' else 'confirmed' end
from _vms_mappings_csv m
join products p on p.sku = m.appsheet_item_id
on conflict (vms_product_id, vms_product_name) do update set
  product_id = excluded.product_id,
  match_status = excluded.match_status;

-- Machine slots from planograms where slot/par/min are available.
insert into machine_slots (machine_id, slot_code, product_id, capacity, min_qty, par_qty)
select
  mm.id,
  pl.slot_code,
  pr.id,
  greatest(1, coalesce(nullif(pl.inventory_capacity,'TO_CONFIRM')::int, 1)),
  greatest(0, coalesce(nullif(pl.min_level,'TO_CONFIRM')::int, 1)),
  greatest(1, coalesce(nullif(pl.par_level,'TO_CONFIRM')::int, coalesce(nullif(pl.inventory_capacity,'TO_CONFIRM')::int, 1)))
from _planograms_csv pl
join machines mm on mm.vms_machine_id = pl.machine_id
join vms_product_mappings vpm on vpm.vms_product_id = nullif(pl.vms_product_number, 'TO_CONFIRM') and vpm.vms_product_name = pl.vms_product_name
join products pr on pr.id = vpm.product_id
where pl.slot_code <> 'TO_CONFIRM'
on conflict (machine_id, slot_code) do update set
  product_id = excluded.product_id,
  capacity = excluded.capacity,
  min_qty = excluded.min_qty,
  par_qty = excluded.par_qty;

-- Opening balances using ledger movements only (supplier -> storage).
insert into inventory_movements (product_id, quantity, from_entity_type, to_entity_type, to_entity_id, reason, created_by, notes, created_at)
select
  p.id,
  abs(round(si.amount::numeric))::int,
  'supplier',
  'storage',
  '00000000-0000-0000-0000-000000000201'::uuid,
  'purchase_received',
  tm.id,
  coalesce(nullif(si.reason,''), 'Seeded opening balance') || ' | source inventory_id=' || si.inventory_id,
  si.datetime::timestamptz
from _storage_inventory_csv si
join products p on p.sku = si.item_id
left join team_members tm on tm.email = si.operator_email
where si.amount::numeric > 0;

commit;
