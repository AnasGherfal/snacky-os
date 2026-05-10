-- Snacky OS realistic starter seed from docs/*.md and sample CSVs.

-- Core team and storage
insert into team_members (id, full_name, phone, role)
values
  ('00000000-0000-0000-0000-000000000501', 'Snacky Owner', '+218-91-000-0001', 'owner'),
  ('00000000-0000-0000-0000-000000000502', 'Snacky Admin', '+218-91-000-0002', 'admin'),
  ('00000000-0000-0000-0000-000000000503', 'Snacky Operator 01', '+218-91-000-0003', 'operator')
on conflict do nothing;

insert into storage_locations (id, name, address)
values
  ('00000000-0000-0000-0000-000000000201', 'Main Storage - Tripoli', 'Tripoli, Libya')
on conflict do nothing;

-- Suppliers from REAL_PRODUCTS starter
insert into suppliers (id, name, contact_name, phone, payment_terms, notes)
values
  ('00000000-0000-0000-0000-000000000301', 'Supplier TBD - Drinks', 'TBD', 'TBD', 'Cash / TBD', 'Replace with real drinks wholesaler.'),
  ('00000000-0000-0000-0000-000000000302', 'Supplier TBD - Snacks', 'TBD', 'TBD', 'Cash / TBD', 'Replace with real snacks wholesaler.'),
  ('00000000-0000-0000-0000-000000000303', 'Supplier TBD - Chocolate', 'TBD', 'TBD', 'Cash / TBD', 'Replace with real chocolate wholesaler.')
on conflict do nothing;

-- Locations from REAL_MACHINES
insert into locations (id, name, location_type, rent_amount, status, notes)
values
  ('00000000-0000-0000-0000-000000000101', 'Hospital Active Location', 'hospital', 900, 'active', 'Replace with real hospital name and contact.'),
  ('00000000-0000-0000-0000-000000000102', 'Mall Active Location 01', 'mall', 900, 'active', 'Possible relocation candidate if underperforming.'),
  ('00000000-0000-0000-0000-000000000103', 'Mall Active Location 02', 'mall', 700, 'active', 'Replace with real mall name.'),
  ('00000000-0000-0000-0000-000000000104', 'Mixed Active Location', 'mixed', 350, 'active', 'Replace with exact location.'),
  ('00000000-0000-0000-0000-000000000105', 'School Target Location 01', 'school', 650, 'pipeline', 'Fixed rent target 500–700 LYD.'),
  ('00000000-0000-0000-0000-000000000106', 'School Target Location 02', 'school', 650, 'pipeline', 'Fixed rent target 500–700 LYD.'),
  ('00000000-0000-0000-0000-000000000107', 'Hospital or University Target Location', 'other', 700, 'pipeline', 'Replace when signed.'),
  ('00000000-0000-0000-0000-000000000108', 'Future High-Traffic Location', 'other', 650, 'pipeline', 'Placeholder growth location.')
on conflict do nothing;

-- Machines from REAL_MACHINES
insert into machines (id, machine_code, vms_machine_id, name, machine_type, location_id, status, rent_amount, target_nsm, target_uptime_percent, notes)
values
  ('00000000-0000-0000-0000-000000000601', 'SNK-001', 'VMS_MACHINE_ID_TBD_001', 'Hospital Machine 01', 'lift', '00000000-0000-0000-0000-000000000101', 'active', 900, 2800, 98, 'Good candidate for professional branding.'),
  ('00000000-0000-0000-0000-000000000602', 'SNK-002', 'VMS_MACHINE_ID_TBD_002', 'Mall Machine 01', 'non_lift', '00000000-0000-0000-0000-000000000102', 'active', 900, 2800, 98, 'Possible relocation candidate.'),
  ('00000000-0000-0000-0000-000000000603', 'SNK-003', 'VMS_MACHINE_ID_TBD_003', 'Mall Machine 02', 'lift', '00000000-0000-0000-0000-000000000103', 'active', 700, 2800, 98, 'Active machine.'),
  ('00000000-0000-0000-0000-000000000604', 'SNK-004', 'VMS_MACHINE_ID_TBD_004', 'Mixed Location Machine 01', 'non_lift', '00000000-0000-0000-0000-000000000104', 'active', 350, 2800, 98, 'Active machine.'),
  ('00000000-0000-0000-0000-000000000605', 'SNK-005', 'VMS_MACHINE_ID_TBD_005', 'School Machine 01', 'lift', '00000000-0000-0000-0000-000000000105', 'incoming', 650, 2800, 98, 'Incoming machine.'),
  ('00000000-0000-0000-0000-000000000606', 'SNK-006', 'VMS_MACHINE_ID_TBD_006', 'School Machine 02', 'lift', '00000000-0000-0000-0000-000000000106', 'incoming', 650, 2800, 98, 'Incoming machine.'),
  ('00000000-0000-0000-0000-000000000607', 'SNK-007', 'VMS_MACHINE_ID_TBD_007', 'Hospital/University Machine 02', 'lift', '00000000-0000-0000-0000-000000000107', 'incoming', 700, 2800, 98, 'Incoming machine.'),
  ('00000000-0000-0000-0000-000000000608', 'SNK-008', 'VMS_MACHINE_ID_TBD_008', 'Growth Machine 01', 'lift', '00000000-0000-0000-0000-000000000108', 'standby', 650, 2800, 98, 'Growth placeholder.')
on conflict do nothing;

-- Products from REAL_PRODUCTS starter
insert into products (sku, barcode, name, category, brand, supplier_id, cost_price, selling_price, case_quantity, expiry_sensitive, active)
values
('WATER-500','BARCODE_TBD_WATER_500','Water 500ml','drink','Local/TBD','00000000-0000-0000-0000-000000000301',0.80,2.00,24,true,true),
('PEPSI-330','BARCODE_TBD_PEPSI_330','Pepsi 330ml','drink','Pepsi','00000000-0000-0000-0000-000000000301',1.50,3.00,24,true,true),
('COLA-330','BARCODE_TBD_COLA_330','Cola 330ml','drink','Coca-Cola/TBD','00000000-0000-0000-0000-000000000301',1.50,3.00,24,true,true),
('ORANGE-330','BARCODE_TBD_ORANGE_330','Orange Soda 330ml','drink','Fanta/Mirinda/TBD','00000000-0000-0000-0000-000000000301',1.50,3.00,24,true,true),
('JUICE-BOX','BARCODE_TBD_JUICE_BOX','Juice Box','drink','TBD','00000000-0000-0000-0000-000000000301',1.20,2.50,24,true,true),
('ENERGY-DRINK','BARCODE_TBD_ENERGY','Energy Drink','drink','TBD','00000000-0000-0000-0000-000000000301',3.50,6.00,24,true,true),
('CHIPS-HOT','BARCODE_TBD_CHIPS_HOT','Hot Chips','snack','TBD','00000000-0000-0000-0000-000000000302',1.20,3.00,24,true,true),
('CHIPS-SALT','BARCODE_TBD_CHIPS_SALT','Salted Chips','snack','TBD','00000000-0000-0000-0000-000000000302',1.20,3.00,24,true,true),
('CHIPS-CHEESE','BARCODE_TBD_CHIPS_CHEESE','Cheese Chips','snack','TBD','00000000-0000-0000-0000-000000000302',1.20,3.00,24,true,true),
('BISCUIT','BARCODE_TBD_BISCUIT','Biscuit Pack','snack','TBD','00000000-0000-0000-0000-000000000302',1.00,2.50,24,true,true),
('CROISSANT','BARCODE_TBD_CROISSANT','Croissant','snack','TBD','00000000-0000-0000-0000-000000000302',1.50,3.50,24,true,true),
('CHOC-BAR','BARCODE_TBD_CHOC_BAR','Chocolate Bar','chocolate','TBD','00000000-0000-0000-0000-000000000303',2.00,4.00,24,true,true),
('SNICKERS','BARCODE_TBD_SNICKERS','Snickers','chocolate','Snickers','00000000-0000-0000-0000-000000000303',2.50,5.00,24,true,true),
('KITKAT','BARCODE_TBD_KITKAT','KitKat','chocolate','KitKat','00000000-0000-0000-0000-000000000303',2.30,5.00,24,true,true),
('GUM-MINT','BARCODE_TBD_GUM_MINT','Gum / Mints','small_item','TBD','00000000-0000-0000-0000-000000000303',1.00,2.50,24,true,true)
on conflict (sku) do nothing;

-- Machine slots seeded from starter planograms for active machines SNK-001..SNK-004
insert into machine_slots (machine_id, slot_code, product_id, capacity, min_qty, par_qty)
select m.id, v.slot_code, p.id, v.capacity, v.min_qty, v.par_qty
from (values
('SNK-001','A1','WATER-500',12,3,12),('SNK-001','A2','WATER-500',12,3,12),('SNK-001','A3','PEPSI-330',10,3,10),('SNK-001','A4','COLA-330',10,3,10),
('SNK-001','B1','JUICE-BOX',10,3,10),('SNK-001','B2','ORANGE-330',10,3,10),('SNK-001','B3','BISCUIT',10,3,10),('SNK-001','B4','CROISSANT',8,2,8),
('SNK-001','C1','CHOC-BAR',8,2,8),('SNK-001','C2','SNICKERS',8,2,8),('SNK-001','C3','KITKAT',8,2,8),('SNK-001','C4','GUM-MINT',10,3,10),
('SNK-002','A1','WATER-500',12,3,12),('SNK-002','A2','PEPSI-330',10,3,10),('SNK-002','A3','COLA-330',10,3,10),('SNK-002','A4','ENERGY-DRINK',8,2,8),
('SNK-002','B1','CHIPS-HOT',10,3,10),('SNK-002','B2','CHIPS-SALT',10,3,10),('SNK-002','B3','CHIPS-CHEESE',10,3,10),('SNK-002','B4','BISCUIT',10,3,10),
('SNK-002','C1','CHOC-BAR',8,2,8),('SNK-002','C2','SNICKERS',8,2,8),('SNK-002','C3','KITKAT',8,2,8),('SNK-002','C4','GUM-MINT',10,3,10),
('SNK-003','A1','WATER-500',12,3,12),('SNK-003','A2','PEPSI-330',10,3,10),('SNK-003','A3','ORANGE-330',10,3,10),('SNK-003','A4','ENERGY-DRINK',8,2,8),
('SNK-003','B1','CHIPS-HOT',10,3,10),('SNK-003','B2','CHIPS-SALT',10,3,10),('SNK-003','B3','BISCUIT',10,3,10),('SNK-003','B4','CROISSANT',8,2,8),
('SNK-003','C1','CHOC-BAR',8,2,8),('SNK-003','C2','SNICKERS',8,2,8),('SNK-003','C3','KITKAT',8,2,8),('SNK-003','C4','GUM-MINT',10,3,10),
('SNK-004','A1','WATER-500',12,3,12),('SNK-004','A2','PEPSI-330',10,3,10),('SNK-004','A3','COLA-330',10,3,10),('SNK-004','A4','JUICE-BOX',10,3,10),
('SNK-004','B1','CHIPS-HOT',10,3,10),('SNK-004','B2','CHIPS-SALT',10,3,10),('SNK-004','B3','BISCUIT',10,3,10),('SNK-004','B4','CROISSANT',8,2,8),
('SNK-004','C1','CHOC-BAR',8,2,8),('SNK-004','C2','SNICKERS',8,2,8),('SNK-004','C3','KITKAT',8,2,8),('SNK-004','C4','GUM-MINT',10,3,10)
) as v(machine_code, slot_code, sku, capacity, min_qty, par_qty)
join machines m on m.machine_code = v.machine_code
join products p on p.sku = v.sku
on conflict do nothing;

-- VMS product mapping starter
insert into vms_product_mappings (vms_product_id, vms_product_name, product_id, match_status)
select v.vms_product_id, v.vms_product_name, p.id, v.match_status
from (values
('VMS_WATER_500','Water 500ml','WATER-500','confirmed'),
('VMS_PEPSI_330','Pepsi Can 330ml','PEPSI-330','confirmed'),
('VMS_COLA_330','Cola 330ml','COLA-330','needs_review'),
('VMS_ORANGE_330','Orange Soda 330ml','ORANGE-330','needs_review'),
('VMS_JUICE_BOX','Juice Box','JUICE-BOX','confirmed'),
('VMS_ENERGY_DRINK','Energy Drink','ENERGY-DRINK','confirmed'),
('VMS_CHIPS_HOT','Hot Chips','CHIPS-HOT','confirmed'),
('VMS_CHIPS_SALT','Salted Chips','CHIPS-SALT','confirmed'),
('VMS_CHIPS_CHEESE','Cheese Chips','CHIPS-CHEESE','confirmed'),
('VMS_BISCUIT','Biscuit Pack','BISCUIT','confirmed'),
('VMS_CROISSANT','Croissant','CROISSANT','confirmed'),
('VMS_CHOC_BAR','Chocolate Bar','CHOC-BAR','confirmed'),
('VMS_SNICKERS','Snickers','SNICKERS','confirmed'),
('VMS_KITKAT','KitKat','KITKAT','confirmed'),
('VMS_GUM_MINT','Gum / Mints','GUM-MINT','confirmed')
) as v(vms_product_id, vms_product_name, sku, match_status)
join products p on p.sku = v.sku
on conflict do nothing;

-- Baseline inventory in storage (ledger-based)
insert into inventory_movements (product_id, quantity, from_entity_type, to_entity_type, to_entity_id, reason, created_by, notes)
select p.id, 120, 'supplier', 'storage', '00000000-0000-0000-0000-000000000201', 'purchase_received', '00000000-0000-0000-0000-000000000501', 'Initial seed stock'
from products p
where p.active = true;

-- Sample VMS imports from CSV docs
insert into vms_import_batches (id, source_type, file_name, imported_by, row_count, notes)
values
  ('00000000-0000-0000-0000-000000000701', 'csv', 'SAMPLE_VMS_STOCK_REPORT.csv', '00000000-0000-0000-0000-000000000502', 11, 'Loaded from docs sample stock report'),
  ('00000000-0000-0000-0000-000000000702', 'csv', 'SAMPLE_VMS_SALES_REPORT.csv', '00000000-0000-0000-0000-000000000502', 7, 'Loaded from docs sample sales report')
on conflict do nothing;

insert into vms_stock_snapshots (import_batch_id, machine_id, vms_machine_id, slot_code, vms_product_id, vms_product_name, product_id, current_qty, capacity, captured_at)
select '00000000-0000-0000-0000-000000000701', m.id, v.machine_id, v.slot_code, v.vms_product_id, v.vms_product_name, p.id, v.current_qty, v.capacity, v.captured_at::timestamptz
from (values
('VMS_MACHINE_ID_TBD_001','A1','VMS_WATER_500','Water 500ml',2,12,'2026-05-09'),
('VMS_MACHINE_ID_TBD_001','A2','VMS_WATER_500','Water 500ml',6,12,'2026-05-09'),
('VMS_MACHINE_ID_TBD_001','A3','VMS_PEPSI_330','Pepsi Can 330ml',1,10,'2026-05-09'),
('VMS_MACHINE_ID_TBD_001','B3','VMS_BISCUIT','Biscuit Pack',0,10,'2026-05-09'),
('VMS_MACHINE_ID_TBD_002','A1','VMS_WATER_500','Water 500ml',5,12,'2026-05-09'),
('VMS_MACHINE_ID_TBD_002','B1','VMS_CHIPS_HOT','Hot Chips',0,10,'2026-05-09'),
('VMS_MACHINE_ID_TBD_002','C2','VMS_SNICKERS','Snickers',3,8,'2026-05-09'),
('VMS_MACHINE_ID_TBD_003','A4','VMS_ENERGY_DRINK','Energy Drink',2,8,'2026-05-09'),
('VMS_MACHINE_ID_TBD_004','B2','VMS_CHIPS_SALT','Salted Chips',1,10,'2026-05-09'),
('VMS_MACHINE_ID_TBD_005','A1','VMS_WATER_500','Water 500ml',0,12,'2026-05-09'),
('VMS_MACHINE_ID_TBD_005','B1','VMS_CHIPS_HOT','Hot Chips',2,10,'2026-05-09')
) as v(machine_id, slot_code, vms_product_id, vms_product_name, current_qty, capacity, captured_at)
join machines m on m.vms_machine_id = v.machine_id
left join products p on p.sku = (select pm.sku from (values
('VMS_WATER_500','WATER-500'),('VMS_PEPSI_330','PEPSI-330'),('VMS_BISCUIT','BISCUIT'),('VMS_CHIPS_HOT','CHIPS-HOT'),('VMS_SNICKERS','SNICKERS'),('VMS_ENERGY_DRINK','ENERGY-DRINK'),('VMS_CHIPS_SALT','CHIPS-SALT')
) as pm(vms_product_id, sku) where pm.vms_product_id = v.vms_product_id);

insert into vms_sales_snapshots (import_batch_id, machine_id, product_id, sold_qty, sales_amount, cash_sales_amount, card_sales_amount, period_start, period_end)
select '00000000-0000-0000-0000-000000000702', m.id, p.id, v.sold_qty, v.total_sales_lyd, v.cash_sales_lyd, v.card_sales_lyd, v.date::timestamptz, (v.date::date + interval '1 day' - interval '1 second')::timestamptz
from (values
('VMS_MACHINE_ID_TBD_001','VMS_WATER_500',24,48,30,18,'2026-05-09'),
('VMS_MACHINE_ID_TBD_001','VMS_PEPSI_330',12,36,26,10,'2026-05-09'),
('VMS_MACHINE_ID_TBD_002','VMS_CHIPS_HOT',18,54,42,12,'2026-05-09'),
('VMS_MACHINE_ID_TBD_002','VMS_SNICKERS',8,40,30,10,'2026-05-09'),
('VMS_MACHINE_ID_TBD_003','VMS_ENERGY_DRINK',6,36,24,12,'2026-05-09'),
('VMS_MACHINE_ID_TBD_004','VMS_CHIPS_SALT',10,30,24,6,'2026-05-09'),
('VMS_MACHINE_ID_TBD_005','VMS_WATER_500',30,60,50,10,'2026-05-09')
) as v(machine_id, vms_product_id, sold_qty, total_sales_lyd, cash_sales_lyd, card_sales_lyd, date)
join machines m on m.vms_machine_id = v.machine_id
join products p on p.sku = (select pm.sku from (values
('VMS_WATER_500','WATER-500'),('VMS_PEPSI_330','PEPSI-330'),('VMS_CHIPS_HOT','CHIPS-HOT'),('VMS_SNICKERS','SNICKERS'),('VMS_ENERGY_DRINK','ENERGY-DRINK'),('VMS_CHIPS_SALT','CHIPS-SALT')
) as pm(vms_product_id, sku) where pm.vms_product_id = v.vms_product_id);
