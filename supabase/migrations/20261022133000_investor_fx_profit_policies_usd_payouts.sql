-- 2026-10-22 Snacky investor FX, profit policies and actual USD payout controls.
-- Idempotent schema replay only. Investor personal IDs and agreement balances are NOT seeded.
alter table public.investor_agreements add column if not exists investment_amount_usd numeric(16,2),add column if not exists payout_cap_usd numeric(16,2);
alter table public.investor_monthly_statements add column if not exists loss_carried_in_lyd numeric(16,2) not null default 0,add column if not exists loss_carried_out_lyd numeric(16,2) not null default 0,add column if not exists usd_rate_lyd_per_usd numeric(14,6),add column if not exists investor_share_due_usd numeric(16,2);
create table if not exists public.investor_cost_policies (
 id uuid primary key default gen_random_uuid(),agreement_id uuid not null references public.investor_agreements(id) on delete cascade,item_key text not null,item_type text not null check(item_type in ('rent','salary_adjustment','other')),label text not null,monthly_amount_lyd numeric(16,2) not null check(monthly_amount_lyd>=0),effective_from date not null,effective_through date,notes text,recorded_by uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(agreement_id,item_key,effective_from),check(effective_through is null or effective_through>=effective_from));
create index if not exists investor_cost_policies_period_idx on public.investor_cost_policies(agreement_id,effective_from,effective_through);
create table if not exists public.investor_monthly_fx_rates (
 agreement_id uuid not null references public.investor_agreements(id) on delete cascade,month_start date not null,lyd_per_usd numeric(16,6) not null check(lyd_per_usd>0 and lyd_per_usd<100000),rate_source text,updated_by uuid,updated_at timestamptz not null default now(),primary key(agreement_id,month_start),check(month_start=date_trunc('month',month_start)::date));
create table if not exists public.investor_usd_payouts (
 id uuid primary key default gen_random_uuid(),agreement_id uuid not null references public.investor_agreements(id) on delete restrict,month_start date not null,payout_date date not null,amount_usd numeric(16,2) not null check(amount_usd>0),exchange_rate_lyd_per_usd numeric(16,6) not null check(exchange_rate_lyd_per_usd>0),lyd_equivalent numeric(16,2) not null,payment_account text not null check(payment_account in ('snacky_usd','owner_usd')),payment_method text not null check(payment_method in ('cash','bank_transfer','other')),payment_reference text not null,notes text,finance_transaction_id uuid not null unique references public.financial_transactions(id),client_submission_id uuid not null unique,recorded_by uuid,created_at timestamptz not null default now(),check(month_start=date_trunc('month',month_start)::date));
alter table public.investor_cost_policies enable row level security;
alter table public.investor_monthly_fx_rates enable row level security;
alter table public.investor_usd_payouts enable row level security;
do $policy$
begin
 if not exists (select 1 from pg_policies where schemaname='public' and tablename='investor_cost_policies' and policyname='investor_cost_policies_owner_read') then
  create policy investor_cost_policies_owner_read on public.investor_cost_policies for select to authenticated using (public.snacky_is_owner_admin() or public.snacky_can_view_investor_agreement(agreement_id));
 end if;
 if not exists (select 1 from pg_policies where schemaname='public' and tablename='investor_cost_policies' and policyname='investor_cost_policies_owner_write') then
  create policy investor_cost_policies_owner_write on public.investor_cost_policies for all to authenticated using (public.snacky_is_owner_admin()) with check (public.snacky_is_owner_admin());
 end if;
 if not exists (select 1 from pg_policies where schemaname='public' and tablename='investor_monthly_fx_rates' and policyname='investor_monthly_fx_rates_read') then
  create policy investor_monthly_fx_rates_read on public.investor_monthly_fx_rates for select to authenticated using (public.snacky_is_owner_admin() or public.snacky_can_view_investor_agreement(agreement_id));
 end if;
 if not exists (select 1 from pg_policies where schemaname='public' and tablename='investor_monthly_fx_rates' and policyname='investor_monthly_fx_rates_owner_write') then
  create policy investor_monthly_fx_rates_owner_write on public.investor_monthly_fx_rates for all to authenticated using (public.snacky_is_owner_admin()) with check (public.snacky_is_owner_admin());
 end if;
 if not exists (select 1 from pg_policies where schemaname='public' and tablename='investor_usd_payouts' and policyname='investor_usd_payouts_read') then
  create policy investor_usd_payouts_read on public.investor_usd_payouts for select to authenticated using (public.snacky_is_owner_admin() or public.snacky_can_view_investor_agreement(agreement_id));
 end if;
end $policy$;
revoke all on public.investor_cost_policies,public.investor_monthly_fx_rates,public.investor_usd_payouts from anon;
grant select,insert,update,delete on public.investor_cost_policies,public.investor_monthly_fx_rates to authenticated;
grant select on public.investor_usd_payouts to authenticated;
alter policy investor_statements_investor_read on public.investor_monthly_statements using (public.snacky_can_view_investor_agreement(agreement_id));
CREATE OR REPLACE FUNCTION public.snacky_investor_usd_cap_and_loss_guard_2026()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.investor_agreements%rowtype; historic numeric :=0; previous_usd numeric:=0; already_profit numeric:=0; expected_usd numeric:=0; prev_month date; prev_stmt public.investor_monthly_statements%rowtype;
begin
 if new.calculation_status <> 'finalized' or old.calculation_status='finalized' then return new; end if;
 select * into a from public.investor_agreements where id=new.agreement_id for update;
 if a.id is null then raise exception 'Investor agreement missing' using errcode='23514'; end if;
 if a.payout_cap_usd is null then return new; end if;
 if new.usd_rate_lyd_per_usd is null or new.usd_rate_lyd_per_usd<=0 then
   raise exception 'Document monthly USD/LYD rate before finalizing a USD-capped investor statement' using errcode='23514';
 end if;
 if new.investor_share_due_usd is null then
   raise exception 'Calculate and document capped investor share in USD before finalizing' using errcode='23514';
 end if;
 if exists(select 1 from public.investor_historical_months h where h.investor_user_id=a.investor_user_id and h.month_start=new.month_start) then
   raise exception 'Historical investor month already exists; cannot double-count entitlement' using errcode='23505';
 end if;
 if exists(select 1 from public.investor_historical_months h where h.investor_user_id=a.investor_user_id and h.month_start<new.month_start and h.month_start>=a.start_date and (h.confirmed_payable_usd is null or h.payment_confirmed_at is null)) then
   raise exception 'Prior historical investor shares require verification first' using errcode='23514';
 end if;
 select coalesce(sum(h.confirmed_payable_usd),0) into historic from public.investor_historical_months h
 where h.investor_user_id=a.investor_user_id and h.month_start<new.month_start and h.month_start>=a.start_date and h.payment_confirmed_at is not null;
 select coalesce(sum(s.investor_share_due_usd),0) into previous_usd
 from public.investor_monthly_statements s
 where s.agreement_id=new.agreement_id and s.month_start<new.month_start and s.calculation_status='finalized';
 if exists(select 1 from public.investor_monthly_statements s where s.agreement_id=new.agreement_id and s.month_start<new.month_start and s.calculation_status<>'finalized') then
   raise exception 'Finalize prior draft investor months first' using errcode='23514';
 end if;
 prev_month := (new.month_start - interval '1 month')::date;
 select * into prev_stmt from public.investor_monthly_statements s
 where s.agreement_id=new.agreement_id and s.month_start=prev_month and s.calculation_status='finalized';
 if found and abs(new.loss_carried_in_lyd - prev_stmt.loss_carried_out_lyd)>0.01 then
    raise exception 'Loss carried from previous month does not reconcile' using errcode='23514';
 end if;
 if new.loss_carried_out_lyd > 0.001 or abs(new.loss_carried_out_lyd - least(0,new.operating_profit_lyd+new.loss_carried_in_lyd))>0.011 then
    raise exception 'Loss carry forward does not reconcile' using errcode='23514';
 end if;
 already_profit := greatest(0, new.operating_profit_lyd + new.loss_carried_in_lyd);
 expected_usd := least(round((already_profit*a.profit_share_percent/100)/new.usd_rate_lyd_per_usd,2), greatest(0,a.payout_cap_usd-historic-previous_usd));
 if expected_usd<0 or abs(new.investor_share_due_usd - expected_usd)>0.011 then
   raise exception 'USD monthly share or 150 percent cumulative cap does not reconcile' using errcode='23514';
 end if;
 if new.investor_share_due_lyd > round(new.investor_share_due_usd * new.usd_rate_lyd_per_usd,2)+0.02 then
   raise exception 'Local-currency distribution exceeds documented USD cap' using errcode='23514';
 end if;
 return new;
end $function$
;
drop trigger if exists snacky_investor_usd_cap_and_loss_guard on public.investor_monthly_statements;
create trigger snacky_investor_usd_cap_and_loss_guard before update of calculation_status on public.investor_monthly_statements for each row execute function public.snacky_investor_usd_cap_and_loss_guard_2026();
revoke all on function public.snacky_investor_usd_cap_and_loss_guard_2026() from public,anon,authenticated;
CREATE OR REPLACE FUNCTION public.snacky_record_investor_usd_payout_v1(p_agreement_id uuid, p_month_start date, p_amount_usd numeric, p_payout_date date, p_lyd_per_usd numeric, p_account_id text, p_method text, p_reference text, p_notes text, p_command_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 a public.investor_agreements%rowtype;
 h public.investor_historical_months%rowtype;
 s public.investor_monthly_statements%rowtype;
 r public.investor_usd_payouts%rowtype;
 v_eligible numeric;
 v_paid numeric;
 v_total_paid numeric;
 v_finance uuid;
 v_team uuid:=public.snacky_current_team_member_id();
 v_today date:=(now() at time zone 'Africa/Tripoli')::date;
 v_payload jsonb;
begin
 if auth.uid() is null or v_team is null or not public.snacky_current_profile_has_any_role(array['owner','admin'])
 then raise exception 'Only active owner/admin can record actual investor USD payouts' using errcode='42501'; end if;
 if p_command_id is null or p_agreement_id is null or p_month_start is null or p_month_start <> date_trunc('month',p_month_start)::date
 or p_amount_usd is null or p_amount_usd<=0 or p_amount_usd<>round(p_amount_usd,2) or p_lyd_per_usd is null or p_lyd_per_usd<=0
 or p_payout_date is null or p_payout_date>v_today or p_payout_date<'2026-01-01'
 or p_account_id not in ('snacky_usd','owner_usd') or p_method not in ('cash','bank_transfer','other')
 or length(btrim(coalesce(p_reference,'')))<3 or length(coalesce(p_reference,''))>200 or length(coalesce(p_notes,''))>2000
 then raise exception 'Valid past payment date, USD amount, actual exchange rate, USD paying account and payment reference required' using errcode='22023';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('investor-usd-payout:'||p_command_id::text,0));
 select * into r from public.investor_usd_payouts where client_submission_id=p_command_id;
 if found then
   if r.agreement_id<>p_agreement_id or r.month_start<>p_month_start or r.amount_usd<>p_amount_usd
      or r.exchange_rate_lyd_per_usd<>p_lyd_per_usd or r.payout_date<>p_payout_date
      or r.payment_account<>p_account_id or r.payment_method<>p_method or r.payment_reference<>p_reference
   then raise exception 'Saved payment request does not match previous receipt' using errcode='23505';end if;
   return pg_catalog.to_jsonb(r);
 end if;
 select * into a from public.investor_agreements where id=p_agreement_id for update;
 if a.id is null or a.investor_user_id is null or a.payout_cap_usd is null
 then raise exception 'USD-capped investor agreement required' using errcode='23514';end if;
 if p_month_start<a.start_date or (a.end_date is not null and p_month_start>a.end_date)
 then raise exception 'Month outside investment agreement' using errcode='23514';end if;
 select * into h from public.investor_historical_months
 where investor_user_id=a.investor_user_id and month_start=p_month_start for update;
 if found then
   if h.payment_confirmed_at is null or h.confirmed_payable_usd is null or h.confirmed_paid_usd is null then
     raise exception 'Historical entitlement and prior payments must be confirmed first' using errcode='23514';end if;
   v_eligible:=h.confirmed_payable_usd;
 else
   select * into s from public.investor_monthly_statements where agreement_id=a.id and month_start=p_month_start for update;
   if s.id is null or s.calculation_status<>'finalized' or s.investor_share_due_usd is null then
      raise exception 'Only a finalized monthly share can be marked paid' using errcode='23514';end if;
   v_eligible:=s.investor_share_due_usd;
 end if;
 select coalesce(sum(amount_usd),0) into v_paid from public.investor_usd_payouts where agreement_id=a.id and month_start=p_month_start;
 if h.id is not null then
    -- Historical paid value is updated by this function and includes these USD payouts.
    if h.confirmed_paid_usd+p_amount_usd>v_eligible+0.005 then raise exception 'Payment exceeds historic monthly USD share' using errcode='23514';end if;
 else
    if v_paid+p_amount_usd>v_eligible+0.005 then raise exception 'Payment exceeds finalized monthly USD share' using errcode='23514';end if;
 end if;
 select coalesce(sum(amount_usd),0) into v_total_paid from public.investor_usd_payouts where agreement_id=a.id;
 if v_total_paid+p_amount_usd>a.payout_cap_usd+0.005 then raise exception 'Payment exceeds investment USD payout cap' using errcode='23514';end if;
 insert into public.financial_transactions(transaction_date,transaction_datetime,direction,transaction_kind,transaction_type,
 description,notes,amount,signed_amount,currency,account_id,account_key,exchange_rate_usd_to_lyd,transaction_effect,
 category,bucket,final_bucket,payment_method,source_type,transaction_status,import_status,review_status,needs_review,is_void,created_by)
 values (p_payout_date,p_payout_date::timestamp at time zone 'Africa/Tripoli','money_out','manual_money_out','Investor Profit Distribution',
 'Investor USD profit payout: '||a.investor_name||' / '||to_char(p_month_start,'YYYY-MM'),
 nullif(p_notes,''),p_amount_usd,-p_amount_usd,'USD',p_account_id,p_account_id,p_lyd_per_usd,'expense',
 'Investor Profit Share','Investor Profit Share','Investor Profit Share',p_method,'investor_payment',
 'active','confirmed','confirmed',false,false,v_team)
 returning id into v_finance;
 insert into public.investor_usd_payouts(agreement_id,month_start,payout_date,amount_usd,exchange_rate_lyd_per_usd,lyd_equivalent,
 payment_account,payment_method,payment_reference,notes,finance_transaction_id,client_submission_id,recorded_by)
 values(a.id,p_month_start,p_payout_date,p_amount_usd,p_lyd_per_usd,round(p_amount_usd*p_lyd_per_usd,2),
 p_account_id,p_method,p_reference,nullif(p_notes,''),v_finance,p_command_id,auth.uid()) returning * into r;
 update public.financial_transactions set source_id=r.id where id=v_finance;
 if h.id is not null then
 update public.investor_historical_months set confirmed_paid_usd=confirmed_paid_usd+p_amount_usd,
 payment_confirmed_at=clock_timestamp(),
 payment_confirmation_note=concat(coalesce(payment_confirmation_note,''),' | Actual USD investor payout ',p_amount_usd,' dated ',p_payout_date,' finance ',v_finance)
 where id=h.id;
 end if;
 return pg_catalog.to_jsonb(r);
end $function$
;
revoke all on function public.snacky_record_investor_usd_payout_v1(uuid,date,numeric,date,numeric,text,text,text,text,uuid) from public,anon;
grant execute on function public.snacky_record_investor_usd_payout_v1(uuid,date,numeric,date,numeric,text,text,text,text,uuid) to authenticated;
