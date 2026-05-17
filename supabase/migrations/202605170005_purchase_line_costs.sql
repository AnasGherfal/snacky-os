alter table purchase_order_lines
  add column if not exists unit_cost_lyd numeric(12,4) not null default 0,
  add column if not exists line_total_lyd numeric(12,2) not null default 0;

update purchase_order_lines
set
  unit_cost_lyd = coalesce(nullif(unit_cost_lyd, 0), unit_cost, 0),
  line_total_lyd = coalesce(nullif(line_total_lyd, 0), line_total, 0)
where unit_cost_lyd = 0 or line_total_lyd = 0;

alter table inventory_movements
  add column if not exists related_purchase_line_id uuid references purchase_order_lines(id) on delete set null,
  add column if not exists unit_cost_lyd numeric(12,4),
  add column if not exists line_total_lyd numeric(12,2);

drop index if exists idx_inventory_movements_purchase_product_received;

create unique index if not exists idx_inventory_movements_purchase_line_received
  on inventory_movements(related_purchase_line_id)
  where reason = 'purchase_received' and related_purchase_line_id is not null;

create index if not exists idx_inventory_movements_related_purchase on inventory_movements(related_purchase_id);
