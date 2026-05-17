alter table products
  add column if not exists current_cost_price_lyd numeric(12,4) not null default 0,
  add column if not exists current_selling_price_lyd numeric(12,2) not null default 0,
  add column if not exists last_purchase_cost_lyd numeric(12,4),
  add column if not exists average_cost_lyd numeric(12,4),
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists cost_price_source text not null default 'initial_import',
  add column if not exists selling_price_source text not null default 'initial_import',
  add column if not exists price_updated_at timestamptz;

update products
set
  current_cost_price_lyd = case when current_cost_price_lyd = 0 then cost_price else current_cost_price_lyd end,
  current_selling_price_lyd = case when current_selling_price_lyd = 0 then selling_price else current_selling_price_lyd end,
  cost_price_source = coalesce(nullif(cost_price_source, ''), 'initial_import'),
  selling_price_source = coalesce(nullif(selling_price_source, ''), 'initial_import');

do $$ begin
  alter table products add constraint products_cost_price_source_check check (cost_price_source in ('initial_import', 'latest_purchase', 'manual', 'vms', 'average_cost'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table products add constraint products_selling_price_source_check check (selling_price_source in ('initial_import', 'latest_purchase', 'manual', 'vms', 'average_cost'));
exception when duplicate_object then null; end $$;
