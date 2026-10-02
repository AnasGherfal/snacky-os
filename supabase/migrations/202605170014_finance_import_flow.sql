alter table financial_transactions
  add column if not exists import_status text check (import_status in ('imported', 'needs_review', 'skipped')),
  add column if not exists source_file text,
  add column if not exists original_description text,
  add column if not exists import_notes text;

update financial_transactions
set
  import_status = coalesce(import_status, case when needs_review then 'needs_review' else 'imported' end),
  source_file = coalesce(source_file, 'docs/current-data/financial_transactions.csv'),
  original_description = coalesce(original_description, description)
where transaction_kind = 'spreadsheet_import';

create index if not exists idx_financial_transactions_import_status
  on financial_transactions(import_status, source_file, source_sheet, source_row);

create table if not exists finance_import_rows (
  id uuid primary key default gen_random_uuid(),
  source_file text not null,
  source_sheet text not null,
  source_row integer not null,
  import_status text not null check (import_status in ('imported', 'needs_review', 'skipped')),
  transaction_date date,
  raw_date text,
  amount numeric(12,2),
  signed_amount numeric(12,2),
  raw_amount text,
  direction text check (direction in ('money_in', 'money_out')),
  raw_direction text,
  category text,
  raw_category text,
  original_description text,
  review_reason text,
  financial_transaction_id uuid references financial_transactions(id) on delete set null,
  raw_record jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_file, source_sheet, source_row)
);

create index if not exists idx_finance_import_rows_status
  on finance_import_rows(import_status, source_file, source_sheet, source_row);
