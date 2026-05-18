create table if not exists finance_settings (
  id text primary key default 'default',
  opening_balance numeric(12,2),
  opening_balance_date date,
  default_currency text not null default 'LYD',
  updated_by uuid references team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_settings_singleton check (id = 'default'),
  constraint finance_settings_currency_not_blank check (length(trim(default_currency)) between 2 and 8)
);

create index if not exists idx_finance_settings_updated_at
  on finance_settings(updated_at desc);
