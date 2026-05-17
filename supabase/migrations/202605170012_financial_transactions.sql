create table if not exists financial_transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_date date not null,
  direction text not null check (direction in ('money_in', 'money_out')),
  transaction_kind text not null default 'manual' check (transaction_kind in ('spreadsheet_import', 'manual_money_in', 'manual_money_out', 'product_purchase', 'cash_collection')),
  transaction_type text,
  location text,
  description text,
  amount numeric(12,2) not null check (amount >= 0),
  signed_amount numeric(12,2) not null,
  bucket text,
  bucket_override text,
  final_bucket text,
  review_status text not null default 'confirmed' check (review_status in ('confirmed', 'needs_review', 'reviewed')),
  needs_review boolean not null default false,
  source_sheet text,
  source_row integer,
  related_purchase_id uuid references purchase_orders(id) on delete set null,
  related_cash_collection_id uuid references cash_collections(id) on delete set null,
  created_by uuid references team_members(id) on delete set null,
  reviewed_by uuid references team_members(id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint financial_signed_direction check (
    (direction = 'money_in' and signed_amount >= 0)
    or (direction = 'money_out' and signed_amount <= 0)
  )
);

create unique index if not exists idx_financial_transactions_source
  on financial_transactions(source_sheet, source_row)
  where source_sheet is not null and source_row is not null;

create unique index if not exists idx_financial_transactions_purchase
  on financial_transactions(related_purchase_id)
  where related_purchase_id is not null and transaction_kind = 'product_purchase';

create unique index if not exists idx_financial_transactions_cash_collection
  on financial_transactions(related_cash_collection_id)
  where related_cash_collection_id is not null and transaction_kind = 'cash_collection';

create index if not exists idx_financial_transactions_date
  on financial_transactions(transaction_date desc);

create index if not exists idx_financial_transactions_review
  on financial_transactions(needs_review, review_status, transaction_date desc);

create index if not exists idx_financial_transactions_kind
  on financial_transactions(transaction_kind, transaction_date desc);
