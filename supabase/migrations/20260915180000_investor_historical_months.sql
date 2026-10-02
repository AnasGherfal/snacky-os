-- Historical source records, not sales, finalized entitlements or money commands.
-- Import personal financial data through an authorized data operation, never a code seed.
create table public.investor_historical_months (
  id uuid primary key default gen_random_uuid(),
  investor_user_id uuid not null references auth.users(id) on delete restrict,
  month_start date not null check (extract(day from month_start) = 1),
  profit_lyd numeric(14,2) not null,
  cogs_refill_cost_lyd numeric(14,2),
  other_opex_lyd numeric(14,2) not null,
  previous_month_lyd numeric(14,2),
  net_profit_lyd numeric(14,2) not null,
  exchange_rate_lyd_per_usd numeric(14,6) not null check (exchange_rate_lyd_per_usd > 0 and exchange_rate_lyd_per_usd < 1000000),
  net_profit_usd numeric(14,2) not null,
  investor_share_percent numeric(5,2) not null check (investor_share_percent between 0 and 100),
  investor_share_usd numeric(14,2) not null,
  source_label text not null check (length(trim(source_label)) > 0),
  source_cells jsonb not null check (jsonb_typeof(source_cells) = 'object'),
  source_note text,
  import_batch_key text not null check (length(trim(import_batch_key)) > 0),
  imported_at timestamptz not null default now(),
  unique (investor_user_id, month_start)
);
comment on table public.investor_historical_months is 'Owner-supplied source history. Signed amounts and unspecified cells are preserved. Not finalized entitlements, contributions, debt, payments, or Finance postings.';
comment on column public.investor_historical_months.profit_lyd is 'Source column Profit; never silently relabel as revenue or infer whether COGS was included.';
comment on column public.investor_historical_months.investor_share_usd is 'Signed source figure; a negative value does not create an investor repayment obligation.';
comment on column public.investor_historical_months.source_cells is 'Original column labels and cell text, including blanks and original rounding.';

alter table public.investor_historical_months enable row level security;
revoke all on public.investor_historical_months from public, anon, authenticated;
grant select on public.investor_historical_months to authenticated;
grant all on public.investor_historical_months to service_role;
create policy investor_historical_months_read on public.investor_historical_months
for select to authenticated using (
  public.snacky_current_profile_has_any_role(array['owner','admin'])
  or (investor_user_id = auth.uid() and public.snacky_current_profile_has_any_role(array['investor']))
);

-- One investor-month cannot simultaneously have supplied history and an automatic
-- statement. Otherwise a carried loss or entitlement could be counted twice.
-- Both insertion paths acquire the same transaction-scoped lock.
create or replace function public.snacky_guard_investor_history_overlap_v1()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_investor uuid; v_month date;
begin
  if tg_table_name = 'investor_historical_months' then
    v_investor := new.investor_user_id;
    v_month := new.month_start;
  else
    select investor_user_id into v_investor from public.investor_agreements where id = new.agreement_id;
    v_month := new.month_start;
  end if;
  if v_investor is null or v_month is null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('snacky-investor-source-month'), hashtext(v_investor::text || ':' || v_month::text));
  if tg_table_name = 'investor_historical_months' then
    if exists (
      select 1 from public.investor_monthly_statements s
      join public.investor_agreements a on a.id=s.agreement_id
      where a.investor_user_id=v_investor and s.month_start=v_month
    ) then
      raise exception 'A monthly statement already exists for this investor and month. Review it before importing historical figures.' using errcode='23514';
    end if;
  else
    if exists (select 1 from public.investor_historical_months h where h.investor_user_id=v_investor and h.month_start=v_month) then
      raise exception 'This month has imported investor history. Review Historical months instead of creating a second record.' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.snacky_guard_investor_history_overlap_v1() from public, anon, authenticated;
create trigger snacky_guard_historical_investor_month
before insert or update on public.investor_historical_months
for each row execute function public.snacky_guard_investor_history_overlap_v1();
create trigger snacky_guard_generated_investor_month
before insert or update on public.investor_monthly_statements
for each row execute function public.snacky_guard_investor_history_overlap_v1();
