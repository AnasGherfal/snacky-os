alter table vms_import_batches
  add column if not exists file_type text,
  add column if not exists sheet_name text,
  add column if not exists report_type text,
  add column if not exists rows_imported integer default 0,
  add column if not exists rows_skipped integer default 0,
  add column if not exists errors jsonb not null default '[]'::jsonb,
  add column if not exists unknown_machines jsonb not null default '[]'::jsonb,
  add column if not exists unmapped_products jsonb not null default '[]'::jsonb,
  add column if not exists column_mapping jsonb not null default '{}'::jsonb;

create table if not exists vms_import_previews (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_type text not null,
  report_type text not null,
  sheets jsonb not null default '[]'::jsonb,
  uploaded_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_vms_import_previews_created_at
  on vms_import_previews(created_at desc);

alter table machines
  add column if not exists vms_online_status text,
  add column if not exists vms_temperature_c numeric(8,2),
  add column if not exists vms_cash_balance_lyd numeric(12,2),
  add column if not exists vms_empty_trays integer,
  add column if not exists last_vms_status_at timestamptz;

alter table vms_stock_snapshots
  add column if not exists temperature_c numeric(8,2),
  add column if not exists cash_balance_lyd numeric(12,2),
  add column if not exists tray_status text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table vms_sales_snapshots
  add column if not exists cost_amount numeric(12,2),
  add column if not exists profit_amount numeric(12,2),
  add column if not exists metadata jsonb not null default '{}'::jsonb;
