alter table financial_transactions
  add column if not exists transaction_status text not null default 'active' check (transaction_status in ('active', 'voided', 'archived')),
  add column if not exists payment_method text,
  add column if not exists notes text,
  add column if not exists related_route_id uuid references routes(id) on delete set null,
  add column if not exists related_machine_id uuid references machines(id) on delete set null,
  add column if not exists related_location_id uuid references locations(id) on delete set null,
  add column if not exists receipt_url text,
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references team_members(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references team_members(id) on delete set null,
  add column if not exists status_reason text;

update financial_transactions
set transaction_status = 'active'
where transaction_status is null;

create index if not exists idx_financial_transactions_status_date
  on financial_transactions(transaction_status, transaction_date desc);

create index if not exists idx_financial_transactions_related_refs
  on financial_transactions(related_purchase_id, related_route_id, related_machine_id, related_location_id);
