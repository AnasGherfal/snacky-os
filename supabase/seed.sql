-- Demo seed data for local testing. Replace with real Snacky data.

insert into locations (id, name, location_type, address, rent_amount, status)
values
  ('00000000-0000-0000-0000-000000000101', 'Demo Hospital', 'hospital', 'Tripoli', 900, 'active'),
  ('00000000-0000-0000-0000-000000000102', 'Demo School', 'school', 'Tripoli', 600, 'active')
on conflict do nothing;

insert into storage_locations (id, name, address)
values ('00000000-0000-0000-0000-000000000201', 'Main Storage', 'Tripoli')
on conflict do nothing;

insert into suppliers (id, name, phone)
values ('00000000-0000-0000-0000-000000000301', 'Demo Supplier', '+218')
on conflict do nothing;

insert into products (id, sku, name, category, brand, supplier_id, cost_price, selling_price, case_quantity)
values
  ('00000000-0000-0000-0000-000000000401', 'WATER-500', 'Water 500ml', 'drink', 'Generic', '00000000-0000-0000-0000-000000000301', 0.80, 2.00, 24),
  ('00000000-0000-0000-0000-000000000402', 'PEPSI-330', 'Pepsi 330ml', 'drink', 'Pepsi', '00000000-0000-0000-0000-000000000301', 1.50, 3.00, 24),
  ('00000000-0000-0000-0000-000000000403', 'CHIPS-HOT', 'Hot Chips', 'snack', 'Demo Brand', '00000000-0000-0000-0000-000000000301', 1.20, 3.00, 24)
on conflict do nothing;

insert into team_members (id, full_name, phone, role)
values
  ('00000000-0000-0000-0000-000000000501', 'Owner', '+218', 'owner'),
  ('00000000-0000-0000-0000-000000000502', 'Demo Operator', '+218', 'operator')
on conflict do nothing;

insert into machines (id, machine_code, vms_machine_id, name, machine_type, location_id, status, rent_amount)
values
  ('00000000-0000-0000-0000-000000000601', 'SNK-001', 'VMS-001', 'Hospital Machine 01', 'lift', '00000000-0000-0000-0000-000000000101', 'active', 900),
  ('00000000-0000-0000-0000-000000000602', 'SNK-002', 'VMS-002', 'School Machine 01', 'lift', '00000000-0000-0000-0000-000000000102', 'active', 600)
on conflict do nothing;

insert into machine_slots (machine_id, slot_code, product_id, capacity, min_qty, par_qty)
values
  ('00000000-0000-0000-0000-000000000601', 'A1', '00000000-0000-0000-0000-000000000401', 12, 3, 12),
  ('00000000-0000-0000-0000-000000000601', 'A2', '00000000-0000-0000-0000-000000000402', 10, 3, 10),
  ('00000000-0000-0000-0000-000000000602', 'A1', '00000000-0000-0000-0000-000000000401', 12, 3, 12),
  ('00000000-0000-0000-0000-000000000602', 'A2', '00000000-0000-0000-0000-000000000403', 10, 3, 10)
on conflict do nothing;

-- Receive initial storage inventory from supplier.
insert into inventory_movements (product_id, quantity, from_entity_type, to_entity_type, to_entity_id, reason, created_by)
values
  ('00000000-0000-0000-0000-000000000401', 100, 'supplier', 'storage', '00000000-0000-0000-0000-000000000201', 'purchase_received', '00000000-0000-0000-0000-000000000501'),
  ('00000000-0000-0000-0000-000000000402', 80, 'supplier', 'storage', '00000000-0000-0000-0000-000000000201', 'purchase_received', '00000000-0000-0000-0000-000000000501'),
  ('00000000-0000-0000-0000-000000000403', 60, 'supplier', 'storage', '00000000-0000-0000-0000-000000000201', 'purchase_received', '00000000-0000-0000-0000-000000000501');

-- Latest VMS stock snapshots. These create refill recommendations.
insert into vms_import_batches (id, source_type, file_name, imported_by, row_count)
values ('00000000-0000-0000-0000-000000000701', 'csv', 'demo-vms-stock.csv', '00000000-0000-0000-0000-000000000501', 4)
on conflict do nothing;

insert into vms_stock_snapshots (import_batch_id, machine_id, vms_machine_id, slot_code, vms_product_name, product_id, current_qty, capacity, captured_at)
values
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000601', 'VMS-001', 'A1', 'Water 500ml', '00000000-0000-0000-0000-000000000401', 2, 12, now()),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000601', 'VMS-001', 'A2', 'Pepsi 330ml', '00000000-0000-0000-0000-000000000402', 8, 10, now()),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000602', 'VMS-002', 'A1', 'Water 500ml', '00000000-0000-0000-0000-000000000401', 0, 12, now()),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000602', 'VMS-002', 'A2', 'Hot Chips', '00000000-0000-0000-0000-000000000403', 4, 10, now());
