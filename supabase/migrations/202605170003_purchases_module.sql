alter table purchase_orders
  add column if not exists receipt_number text,
  add column if not exists payment_method text not null default 'cash',
  add column if not exists receipt_url text,
  add column if not exists total_amount numeric(12,2) not null default 0,
  add column if not exists created_by uuid references team_members(id) on delete set null,
  add column if not exists received_by uuid references team_members(id) on delete set null,
  add column if not exists received_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

alter table purchase_order_lines
  add column if not exists boxes_qty integer not null default 0,
  add column if not exists units_per_box integer not null default 1,
  add column if not exists loose_units_qty integer not null default 0,
  add column if not exists total_units integer not null default 0,
  add column if not exists line_total numeric(12,2) not null default 0,
  add column if not exists created_at timestamptz not null default now();

update purchase_order_lines
set
  total_units = greatest(total_units, ordered_qty, received_qty, 0),
  line_total = greatest(line_total, coalesce(nullif(total_units, 0), ordered_qty, received_qty, 0) * unit_cost, 0)
where total_units = 0 or line_total = 0;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_boxes_nonnegative check (boxes_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_units_per_box_positive check (units_per_box > 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_loose_units_nonnegative check (loose_units_qty >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_total_units_nonnegative check (total_units >= 0);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table purchase_order_lines add constraint purchase_lines_line_total_nonnegative check (line_total >= 0);
exception when duplicate_object then null; end $$;

alter table inventory_movements
  add column if not exists related_purchase_id uuid references purchase_orders(id) on delete set null;

create unique index if not exists idx_inventory_movements_purchase_product_received
  on inventory_movements(related_purchase_id, product_id)
  where reason = 'purchase_received' and related_purchase_id is not null;

create index if not exists idx_purchase_orders_status_date on purchase_orders(status, order_date desc);
create index if not exists idx_purchase_order_lines_purchase on purchase_order_lines(purchase_order_id);
