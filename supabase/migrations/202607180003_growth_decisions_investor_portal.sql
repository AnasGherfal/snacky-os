begin;

alter type public.team_role add value if not exists 'investor';

create table if not exists public.growth_decision_settings (
  singleton boolean primary key default true check (singleton = true),
  machine_cost_lyd numeric(14,2) not null default 22000 check (machine_cost_lyd >= 0),
  minimum_cash_reserve_lyd numeric(14,2) not null default 15000 check (minimum_cash_reserve_lyd >= 0),
  restock_reserve_lyd numeric(14,2) not null default 10000 check (restock_reserve_lyd >= 0),
  minimum_monthly_operating_profit_lyd numeric(14,2) not null default 6000,
  target_payback_months numeric(8,2) not null default 18 check (target_payback_months > 0),
  minimum_history_months integer not null default 3 check (minimum_history_months between 1 and 24),
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.growth_decision_settings(singleton)
values (true)
on conflict (singleton) do nothing;

create table if not exists public.investor_agreements (
  id uuid primary key default gen_random_uuid(),
  investor_user_id uuid references auth.users(id) on delete set null,
  investor_name text not null,
  investment_amount_lyd numeric(14,2) not null default 0 check (investment_amount_lyd >= 0),
  profit_share_percent numeric(7,4) not null default 30 check (profit_share_percent >= 0 and profit_share_percent <= 100),
  profit_basis text not null default 'operating_profit' check (profit_basis in ('operating_profit')),
  start_date date not null,
  end_date date,
  payout_cap_lyd numeric(14,2) check (payout_cap_lyd is null or payout_cap_lyd >= 0),
  status text not null default 'active' check (status in ('draft', 'active', 'completed', 'cancelled')),
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date)
);

create table if not exists public.investor_monthly_statements (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.investor_agreements(id) on delete cascade,
  month_start date not null check (extract(day from month_start) = 1),
  revenue_lyd numeric(14,2) not null default 0,
  cogs_lyd numeric(14,2) not null default 0,
  gross_profit_lyd numeric(14,2) not null default 0,
  operating_expenses_lyd numeric(14,2) not null default 0,
  operating_profit_lyd numeric(14,2) not null default 0,
  share_percent numeric(7,4) not null default 30 check (share_percent >= 0 and share_percent <= 100),
  investor_share_due_lyd numeric(14,2) not null default 0 check (investor_share_due_lyd >= 0),
  calculation_status text not null default 'draft' check (calculation_status in ('draft', 'finalized')),
  data_source_note text,
  notes text,
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz not null default now(),
  finalized_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(agreement_id, month_start)
);

create table if not exists public.investor_payments (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references public.investor_agreements(id) on delete cascade,
  statement_id uuid references public.investor_monthly_statements(id) on delete set null,
  payment_date date not null default current_date,
  amount_lyd numeric(14,2) not null check (amount_lyd > 0),
  payment_reference text,
  notes text,
  finance_transaction_id uuid,
  finance_posting_status text not null default 'pending' check (finance_posting_status in ('pending', 'posted', 'needs_review')),
  finance_posting_error text,
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists investor_agreements_user_status_idx
  on public.investor_agreements(investor_user_id, status, start_date desc);
create index if not exists investor_statements_agreement_month_idx
  on public.investor_monthly_statements(agreement_id, month_start desc);
create index if not exists investor_payments_agreement_date_idx
  on public.investor_payments(agreement_id, payment_date desc);
create index if not exists investor_payments_statement_idx
  on public.investor_payments(statement_id);
create index if not exists investor_payments_finance_status_idx
  on public.investor_payments(finance_posting_status, payment_date desc);

create or replace function public.snacky_is_owner_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and (
        coalesce(p.role::text, '') in ('owner', 'admin')
        or coalesce(to_jsonb(p) -> 'roles', '[]'::jsonb) ?| array['owner', 'admin']
      )
  );
$$;

create or replace function public.snacky_can_view_investor_agreement(p_agreement_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.snacky_is_owner_admin()
    or exists (
      select 1
      from public.investor_agreements agreement
      where agreement.id = p_agreement_id
        and agreement.investor_user_id = auth.uid()
    );
$$;

alter table public.growth_decision_settings enable row level security;
alter table public.investor_agreements enable row level security;
alter table public.investor_monthly_statements enable row level security;
alter table public.investor_payments enable row level security;

drop policy if exists growth_settings_owner_admin on public.growth_decision_settings;
create policy growth_settings_owner_admin
  on public.growth_decision_settings
  for all
  to authenticated
  using (public.snacky_is_owner_admin())
  with check (public.snacky_is_owner_admin());

drop policy if exists investor_agreements_owner_admin_manage on public.investor_agreements;
create policy investor_agreements_owner_admin_manage
  on public.investor_agreements
  for all
  to authenticated
  using (public.snacky_is_owner_admin())
  with check (public.snacky_is_owner_admin());

drop policy if exists investor_agreements_investor_read on public.investor_agreements;
create policy investor_agreements_investor_read
  on public.investor_agreements
  for select
  to authenticated
  using (investor_user_id = auth.uid());

drop policy if exists investor_statements_owner_admin_manage on public.investor_monthly_statements;
create policy investor_statements_owner_admin_manage
  on public.investor_monthly_statements
  for all
  to authenticated
  using (public.snacky_is_owner_admin())
  with check (public.snacky_is_owner_admin());

drop policy if exists investor_statements_investor_read on public.investor_monthly_statements;
create policy investor_statements_investor_read
  on public.investor_monthly_statements
  for select
  to authenticated
  using (public.snacky_can_view_investor_agreement(agreement_id));

drop policy if exists investor_payments_owner_admin_manage on public.investor_payments;
create policy investor_payments_owner_admin_manage
  on public.investor_payments
  for all
  to authenticated
  using (public.snacky_is_owner_admin())
  with check (public.snacky_is_owner_admin());

drop policy if exists investor_payments_investor_read on public.investor_payments;
create policy investor_payments_investor_read
  on public.investor_payments
  for select
  to authenticated
  using (public.snacky_can_view_investor_agreement(agreement_id));

grant select, insert, update on public.growth_decision_settings to authenticated;
grant select, insert, update on public.investor_agreements to authenticated;
grant select, insert, update on public.investor_monthly_statements to authenticated;
grant select, insert, update on public.investor_payments to authenticated;
grant execute on function public.snacky_is_owner_admin() to authenticated;
grant execute on function public.snacky_can_view_investor_agreement(uuid) to authenticated;
grant all on public.growth_decision_settings to service_role;
grant all on public.investor_agreements to service_role;
grant all on public.investor_monthly_statements to service_role;
grant all on public.investor_payments to service_role;

select pg_notify('pgrst', 'reload schema');

commit;
