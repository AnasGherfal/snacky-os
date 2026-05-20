alter table purchase_orders
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references team_members(id) on delete set null,
  add column if not exists void_reason text;

alter table purchase_orders
  drop constraint if exists purchase_orders_status_check;

alter table purchase_orders
  add constraint purchase_orders_status_check check (status in ('draft', 'received', 'cancelled', 'voided'));

alter table inventory_movements
  add column if not exists reversed_movement_id uuid references inventory_movements(id) on delete set null,
  add column if not exists correction_reason text;

create index if not exists idx_inventory_movements_reversed_movement
  on inventory_movements(reversed_movement_id);

alter table routes
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references team_members(id) on delete set null,
  add column if not exists cancellation_reason text;

create index if not exists idx_routes_cancelled_at
  on routes(cancelled_at desc)
  where cancelled_at is not null;
