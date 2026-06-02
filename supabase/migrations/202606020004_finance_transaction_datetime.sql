alter table public.financial_transactions
  add column if not exists transaction_datetime timestamptz;

update public.financial_transactions
set transaction_datetime = transaction_date::timestamptz
where transaction_datetime is null
  and transaction_date is not null;

create index if not exists idx_financial_transactions_datetime
  on public.financial_transactions(transaction_datetime desc);
