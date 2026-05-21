create table if not exists product_aliases (
  id uuid primary key default gen_random_uuid(),
  alias_name text not null,
  product_id uuid not null references products(id) on delete cascade,
  source text not null default 'receipt',
  confidence numeric,
  approved_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(alias_name, product_id)
);

create index if not exists idx_product_aliases_alias_name
  on product_aliases(lower(alias_name));

create index if not exists idx_product_aliases_product
  on product_aliases(product_id);

create table if not exists receipt_scan_results (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid references purchase_orders(id) on delete set null,
  file_url text,
  raw_text text,
  extracted_data jsonb not null default '{}'::jsonb,
  status text not null default 'completed',
  error_message text,
  created_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_receipt_scan_results_purchase
  on receipt_scan_results(purchase_id);

create index if not exists idx_receipt_scan_results_created_by
  on receipt_scan_results(created_by, created_at desc);

create index if not exists idx_receipt_scan_results_status
  on receipt_scan_results(status, created_at desc);

do $$
begin
  alter table receipt_scan_results
    add constraint receipt_scan_results_status_check
    check (status in ('completed', 'not_configured', 'failed'));
exception
  when duplicate_object then null;
end $$;
