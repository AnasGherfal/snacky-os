-- Owner-reported cash+bank split for Snacky business LYD.
-- Historical counts: NOT revenue, deposits, payment events, or an implicit debt-free attestation.
-- Do not mutate finance_opening_balances or financial_transactions to force a match.
create table if not exists public.owner_cash_bank_counts (
  id uuid primary key default gen_random_uuid(),
  client_submission_id uuid not null unique default gen_random_uuid(),
  as_of_date date not null,
  cash_on_hand_lyd numeric(14,2) not null check (cash_on_hand_lyd between 0 and 1000000000),
  bank_lyd numeric(14,2) not null check (bank_lyd between 0 and 1000000000),
  reported_by_team_member_id uuid not null references public.team_members(id) on delete restrict,
  recorded_by_user_id uuid references auth.users(id) on delete set null,
  entry_source text not null default 'owner_app'
    check (entry_source in ('owner_app','owner_chat_connected_db')),
  notes text check (notes is null or length(notes)<=1000),
  created_at timestamptz not null default now()
);
create index if not exists owner_cash_bank_counts_latest_idx
  on public.owner_cash_bank_counts (created_at desc);
alter table public.owner_cash_bank_counts enable row level security;
revoke all on table public.owner_cash_bank_counts from public, anon, authenticated;
grant select, insert on table public.owner_cash_bank_counts to authenticated;
drop policy if exists owner_cash_bank_counts_read on public.owner_cash_bank_counts;
create policy owner_cash_bank_counts_read on public.owner_cash_bank_counts
  for select to authenticated
  using ((select public.snacky_current_profile_has_any_role(array['owner'])));
drop policy if exists owner_cash_bank_counts_create on public.owner_cash_bank_counts;
create policy owner_cash_bank_counts_create on public.owner_cash_bank_counts
  for insert to authenticated
  with check (
    recorded_by_user_id=(select auth.uid())
    and (select public.snacky_current_profile_has_any_role(array['owner']))
    and entry_source='owner_app'
  );
comment on table public.owner_cash_bank_counts is
 'Immutable owner-reported Snacky bank and physical cash counts. These are not ledger transactions, profit, confirmed bank statements or proof that debts and custody are zero.';
select pg_notify('pgrst','reload schema');