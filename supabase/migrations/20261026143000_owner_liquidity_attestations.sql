-- Owner-attested liquidity is a separate, append-only planning record.
-- Do NOT use it to generate income/expense, finance balances or repayments.
-- Production data is intentionally not seeded with values from chat.

create table if not exists public.owner_liquidity_attestations (
  id uuid primary key default gen_random_uuid(),
  client_submission_id uuid not null unique,
  as_of_date date not null,
  cash_on_hand_lyd numeric(14,2) not null check (cash_on_hand_lyd between 0 and 1000000000),
  bank_lyd numeric(14,2) not null check (bank_lyd between 0 and 1000000000),
  custody_lyd numeric(14,2) not null check (custody_lyd between 0 and 1000000000),
  immediate_debt_lyd numeric(14,2) not null check (immediate_debt_lyd between 0 and 1000000000),
  short_term_debt_lyd numeric(14,2) not null check (short_term_debt_lyd between 0 and 1000000000),
  immediate_debt_due_date date,
  short_term_debt_due_date date,
  custody_details text check (custody_details is null or length(custody_details) <= 1000),
  debt_details text check (debt_details is null or length(debt_details) <= 1000),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists owner_liquidity_attestations_latest_idx
  on public.owner_liquidity_attestations(created_at desc);

alter table public.owner_liquidity_attestations enable row level security;
revoke all on table public.owner_liquidity_attestations from public, anon, authenticated;
grant select, insert on table public.owner_liquidity_attestations to authenticated;

drop policy if exists owner_liquidity_attestations_read on public.owner_liquidity_attestations;
create policy owner_liquidity_attestations_read on public.owner_liquidity_attestations
  for select to authenticated
  using ((select public.snacky_current_profile_has_any_role(array['owner'])));

drop policy if exists owner_liquidity_attestations_create on public.owner_liquidity_attestations;
create policy owner_liquidity_attestations_create on public.owner_liquidity_attestations
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and (select public.snacky_current_profile_has_any_role(array['owner']))
  );

comment on table public.owner_liquidity_attestations is
  'Immutable owner-reported cash, bank, custodian holdings and liabilities. Not a posted finance ledger entry, revenue, repayment or automatic debt transaction.';

select pg_notify('pgrst','reload schema');
