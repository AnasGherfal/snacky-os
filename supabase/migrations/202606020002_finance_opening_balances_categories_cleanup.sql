create table if not exists public.finance_opening_balances (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  currency text not null,
  balance_date date not null,
  opening_balance numeric(12,2) not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_opening_balances_account_check check (account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')),
  constraint finance_opening_balances_currency_check check (currency in ('LYD', 'USD')),
  constraint finance_opening_balances_account_currency_check check (
    (account_id like '%_lyd' and currency = 'LYD')
    or (account_id like '%_usd' and currency = 'USD')
  ),
  unique(account_id, balance_date)
);

create index if not exists idx_finance_opening_balances_account_date
  on public.finance_opening_balances(account_id, balance_date desc);

create table if not exists public.finance_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null default 'both',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint finance_categories_type_check check (type in ('income', 'expense', 'transfer', 'both'))
);

alter table public.financial_transactions
  add column if not exists finance_category_id uuid references public.finance_categories(id) on delete set null,
  add column if not exists payer_text text,
  add column if not exists payee_text text,
  add column if not exists counterparty_text text;

alter table public.finance_settings
  add column if not exists reconciliation_cutoff_date date not null default '2026-05-15';

insert into public.finance_categories (name, type)
values
  ('Sales Revenue', 'income'),
  ('Ad Revenue', 'income'),
  ('Rent', 'expense'),
  ('Product Purchase', 'expense'),
  ('Salary / Employee Payment', 'expense'),
  ('Operator Payment', 'expense'),
  ('Delivery / Transport', 'expense'),
  ('Maintenance', 'expense'),
  ('Machine Purchase', 'expense'),
  ('Shipping', 'expense'),
  ('Customs', 'expense'),
  ('Marketing / Ads', 'expense'),
  ('Refund', 'both'),
  ('Charity', 'expense'),
  ('Owner Funding', 'transfer'),
  ('Owner Withdrawal', 'transfer'),
  ('Bank / Exchange', 'transfer'),
  ('Miscellaneous', 'both'),
  ('Other', 'both')
on conflict (name) do update
set type = excluded.type,
    is_active = true;

insert into public.finance_opening_balances (account_id, currency, balance_date, opening_balance, notes)
values
  ('owner_lyd', 'LYD', '2026-05-15', -24360.50, 'Owner / Anas reconciled opening balance as of 2026-05-15'),
  ('owner_usd', 'USD', '2026-05-15', -418.00, 'Owner / Anas reconciled opening balance as of 2026-05-15'),
  ('snacky_lyd', 'LYD', '2026-05-15', 9514.00, 'Snacky reconciled opening balance as of 2026-05-15'),
  ('snacky_usd', 'USD', '2026-05-15', 660.00, 'Snacky reconciled opening balance as of 2026-05-15')
on conflict (account_id, balance_date) do update
set currency = excluded.currency,
    opening_balance = excluded.opening_balance,
    notes = excluded.notes,
    updated_at = now();

insert into public.finance_settings (
  id,
  opening_balance,
  opening_balance_snacky_lyd,
  opening_balance_snacky_usd,
  opening_balance_owner_lyd,
  opening_balance_owner_usd,
  opening_balance_date,
  reconciliation_cutoff_date,
  default_currency
)
values (
  'default',
  9514.00,
  9514.00,
  660.00,
  -24360.50,
  -418.00,
  '2026-05-15',
  '2026-05-15',
  'LYD'
)
on conflict (id) do update
set opening_balance = excluded.opening_balance,
    opening_balance_snacky_lyd = excluded.opening_balance_snacky_lyd,
    opening_balance_snacky_usd = excluded.opening_balance_snacky_usd,
    opening_balance_owner_lyd = excluded.opening_balance_owner_lyd,
    opening_balance_owner_usd = excluded.opening_balance_owner_usd,
    opening_balance_date = excluded.opening_balance_date,
    reconciliation_cutoff_date = excluded.reconciliation_cutoff_date,
    updated_at = now();

create or replace view public.finance_account_balance_impacts as
select
  fob.id as financial_transaction_id,
  fob.balance_date as transaction_date,
  fob.account_id,
  fob.currency,
  fob.opening_balance as amount_delta,
  'opening_balance'::text as transaction_effect,
  'Opening Balance'::text as final_bucket,
  'finance_opening_balances'::text as source_file,
  null::text as source_sheet,
  null::integer as source_row
from public.finance_opening_balances fob
where fob.balance_date = '2026-05-15'

union all

select
  ft.id as financial_transaction_id,
  ft.transaction_date,
  ft.account_id as account_id,
  ft.currency,
  ft.signed_amount as amount_delta,
  ft.transaction_effect,
  ft.final_bucket,
  ft.source_file,
  ft.source_sheet,
  ft.source_row
from public.financial_transactions ft
where ft.transaction_status = 'active'
  and ft.transaction_date > '2026-05-15'
  and coalesce(ft.needs_review, false) = false
  and coalesce(ft.import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and ft.transaction_effect <> 'transfer'
  and ft.transaction_effect <> 'opening_balance'
  and ft.account_id is not null

union all

select
  ft.id,
  ft.transaction_date,
  ft.source_account_id,
  case when right(ft.source_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  -abs(ft.amount),
  ft.transaction_effect,
  ft.final_bucket,
  ft.source_file,
  ft.source_sheet,
  ft.source_row
from public.financial_transactions ft
where ft.transaction_status = 'active'
  and ft.transaction_date > '2026-05-15'
  and coalesce(ft.needs_review, false) = false
  and coalesce(ft.import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and ft.transaction_effect = 'transfer'
  and ft.source_account_id is not null

union all

select
  ft.id,
  ft.transaction_date,
  ft.destination_account_id,
  case when right(ft.destination_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  abs(ft.amount),
  ft.transaction_effect,
  ft.final_bucket,
  ft.source_file,
  ft.source_sheet,
  ft.source_row
from public.financial_transactions ft
where ft.transaction_status = 'active'
  and ft.transaction_date > '2026-05-15'
  and coalesce(ft.needs_review, false) = false
  and coalesce(ft.import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and ft.transaction_effect = 'transfer'
  and ft.destination_account_id is not null;

create or replace view public.finance_account_balances as
select
  account_id,
  currency,
  sum(amount_delta)::numeric(12,2) as balance
from public.finance_account_balance_impacts
group by account_id, currency;

grant select, insert, update on public.finance_opening_balances to authenticated;
grant select, insert, update on public.finance_categories to authenticated;
grant select on public.finance_account_balance_impacts to authenticated;
grant select on public.finance_account_balances to authenticated;
