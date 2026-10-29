-- Investor earnings and actual settlement are denominated in LYD.
-- A payment-day exchange rate only credits the agreed USD payout ceiling.
-- Additive: legacy USD payout records and historical source cells are untouched.

create table if not exists public.investor_lyd_payout_batches (
 id uuid primary key default gen_random_uuid(),
 agreement_id uuid not null references public.investor_agreements(id) on delete restrict,
 payout_date date not null,
 amount_lyd numeric(16,2) not null check (amount_lyd > 0),
 lyd_per_usd numeric(16,6) not null check (lyd_per_usd > 0 and lyd_per_usd < 100000),
 credited_usd numeric(16,2) not null check (credited_usd > 0),
 payment_account text not null check (payment_account in ('snacky_lyd','owner_lyd')),
 payment_method text not null check (payment_method in ('cash','bank_transfer','other')),
 payment_reference text not null,
 notes text,
 finance_transaction_id uuid not null unique references public.financial_transactions(id) on delete restrict,
 client_submission_id uuid not null unique,
 request_payload jsonb not null,
 recorded_by uuid not null,
 created_at timestamptz not null default now()
);
create index if not exists investor_lyd_payout_batches_agreement_date_idx
 on public.investor_lyd_payout_batches(agreement_id,payout_date,id);

create table if not exists public.investor_lyd_payout_allocations (
 id uuid primary key default gen_random_uuid(),
 payout_id uuid not null references public.investor_lyd_payout_batches(id) on delete restrict,
 agreement_id uuid not null references public.investor_agreements(id) on delete restrict,
 month_start date not null check (month_start=date_trunc('month',month_start)::date),
 amount_lyd numeric(16,2) not null check (amount_lyd > 0),
 unique(payout_id,month_start)
);
create index if not exists investor_lyd_allocations_agreement_month_idx
 on public.investor_lyd_payout_allocations(agreement_id,month_start);

alter table public.investor_lyd_payout_batches enable row level security;
alter table public.investor_lyd_payout_allocations enable row level security;
revoke all on public.investor_lyd_payout_batches, public.investor_lyd_payout_allocations from public,anon,authenticated;
grant select on public.investor_lyd_payout_batches,public.investor_lyd_payout_allocations to authenticated;

create policy investor_lyd_batches_read on public.investor_lyd_payout_batches
 for select to authenticated using (public.snacky_is_owner_admin() or public.snacky_can_view_investor_agreement(agreement_id));
create policy investor_lyd_allocations_read on public.investor_lyd_payout_allocations
 for select to authenticated using (public.snacky_is_owner_admin() or public.snacky_can_view_investor_agreement(agreement_id));

-- Replace only the USD cap's monthly finalization guard. Keep finalization review
-- and historic month duplication protections; do NOT convert or cap monthly LYD.
create or replace function public.snacky_investor_usd_cap_and_loss_guard_2026()
returns trigger language plpgsql security definer set search_path to ''
as $function$
declare
 a public.investor_agreements%rowtype;
 prev_stmt public.investor_monthly_statements%rowtype;
 expected_lyd numeric;
 past_due numeric;
begin
 if new.calculation_status <> 'finalized' or old.calculation_status='finalized' then return new; end if;
 select * into a from public.investor_agreements where id=new.agreement_id for update;
 if a.id is null then raise exception 'Investor agreement missing' using errcode='23514'; end if;
 if a.payout_cap_usd is null then return new; end if;
 if exists(select 1 from public.investor_historical_months h
    where h.investor_user_id=a.investor_user_id and h.month_start=new.month_start) then
    raise exception 'Historical investor month already exists' using errcode='23505';
 end if;
 if exists(select 1 from public.investor_historical_months h
    where h.investor_user_id=a.investor_user_id and h.month_start<new.month_start and h.month_start>=a.start_date
    and (h.payment_confirmed_at is null or h.confirmed_payable_usd is null)) then
    raise exception 'Verify prior historical investor shares first' using errcode='23514';
 end if;
 if exists(select 1 from public.investor_monthly_statements s
    where s.agreement_id=a.id and s.month_start<new.month_start and s.calculation_status<>'finalized') then
    raise exception 'Finalize prior draft investor months first' using errcode='23514';
 end if;
 select * into prev_stmt from public.investor_monthly_statements s
 where s.agreement_id=a.id and s.month_start=(new.month_start-interval '1 month')::date
 and s.calculation_status='finalized';
 if found and abs(new.loss_carried_in_lyd-prev_stmt.loss_carried_out_lyd)>0.01 then
    raise exception 'Carried loss does not reconcile' using errcode='23514';
 end if;
 if new.loss_carried_out_lyd>0.001
 or abs(new.loss_carried_out_lyd-least(0,new.operating_profit_lyd+new.loss_carried_in_lyd))>0.011 then
    raise exception 'Loss carry forward does not reconcile' using errcode='23514';
 end if;
 expected_lyd:=round(greatest(0,new.distribution_basis_lyd)*a.profit_share_percent/100,2);
 select coalesce(sum(s.investor_share_due_lyd),0) into past_due
 from public.investor_monthly_statements s where s.agreement_id=a.id
 and s.month_start<new.month_start and s.calculation_status='finalized';
 if a.payout_cap_lyd is not null then
    expected_lyd:=least(expected_lyd,greatest(0,a.payout_cap_lyd-past_due));
 end if;
 if new.investor_share_due_lyd is null or abs(new.investor_share_due_lyd-expected_lyd)>0.011 then
    raise exception 'Finalized LYD share does not reconcile with agreed percentage' using errcode='23514';
 end if;
 -- The USD cap is reached by actual paid LYD at the payment-day rate,
 -- not by monthly estimated conversions.
 return new;
end
$function$;
revoke all on function public.snacky_investor_usd_cap_and_loss_guard_2026() from public,anon,authenticated;

create or replace function public.snacky_record_investor_lyd_payout_batch_v1(
 p_agreement_id uuid, p_allocations jsonb, p_payout_date date,
 p_lyd_per_usd numeric, p_account_id text, p_method text,
 p_reference text, p_notes text, p_command_id uuid)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
 a public.investor_agreements%rowtype;
 h public.investor_historical_months%rowtype;
 s public.investor_monthly_statements%rowtype;
 old_record public.investor_lyd_payout_batches%rowtype;
 v_team uuid:=public.snacky_current_team_member_id();
 v_today date:=(now() at time zone 'Africa/Tripoli')::date;
 item jsonb;
 v_allocations jsonb:='[]'::jsonb;
 v_payload jsonb;
 v_month date;
 v_month_raw text;
 v_amount numeric;
 v_due numeric;
 v_paid numeric;
 v_total numeric:=0;
 v_usd numeric;
 v_prior_usd numeric;
 v_finance uuid;
 v_batch uuid;
 v_seen date[]:=array[]::date[];
begin
 if auth.uid() is null or v_team is null
    or not public.snacky_current_profile_has_any_role(array['owner','admin']) then
    raise exception 'Only active owner/admin can record investor cash payments' using errcode='42501';
 end if;
 if p_agreement_id is null or p_command_id is null
    or p_payout_date is null or p_payout_date>v_today or p_payout_date<'2026-01-01'
    or p_lyd_per_usd is null or p_lyd_per_usd<=0 or p_lyd_per_usd>=100000
    or p_account_id not in ('snacky_lyd','owner_lyd')
    or p_method not in ('cash','bank_transfer','other')
    or length(btrim(coalesce(p_reference,'')))<3 or length(p_reference)>200
    or length(coalesce(p_notes,''))>2000
    or p_allocations is null or jsonb_typeof(p_allocations)<>'array'
    or jsonb_array_length(p_allocations) not between 1 and 24 then
    raise exception 'Enter real LYD payment date, payment-day rate, reference and 1-24 months'
      using errcode='22023';
 end if;
 for item in select value from jsonb_array_elements(p_allocations) loop
    v_month_raw:=item->>'month_start';
    if v_month_raw is null or v_month_raw !~ '^\d{4}-(0[1-9]|1[0-2])-01$'
      or (item->>'amount_lyd') is null then
      raise exception 'Select valid months and LYD amounts' using errcode='22023';
    end if;
    v_month:=v_month_raw::date;
    v_amount:=(item->>'amount_lyd')::numeric;
    if v_amount<=0 or v_amount>=1000000000 or v_amount<>round(v_amount,2)
      or v_month=any(v_seen) then
      raise exception 'Duplicate month or invalid LYD amount' using errcode='22023';
    end if;
    v_seen:=array_append(v_seen,v_month);
    v_total:=v_total+v_amount;
    v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('month_start',v_month_raw,'amount_lyd',v_amount));
 end loop;
 -- Canonical order for duplicate submit checks; one cash payment has one total.
 select coalesce(jsonb_agg(value order by value->>'month_start'),'[]'::jsonb)
 into v_allocations from jsonb_array_elements(v_allocations) value;
 v_usd:=round(v_total/p_lyd_per_usd,2);
 if v_usd<=0 then raise exception 'Payment is too small to credit the contractual USD goal' using errcode='22023'; end if;
 v_payload:=jsonb_build_object('agreement',p_agreement_id,'allocations',v_allocations,'date',p_payout_date,
  'rate',p_lyd_per_usd,'account',p_account_id,'method',p_method,'reference',p_reference,'notes',coalesce(p_notes,''));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('investor-lyd-payout:'||p_command_id::text,0));
 select * into old_record from public.investor_lyd_payout_batches where client_submission_id=p_command_id;
 if found then
   if old_record.request_payload is distinct from v_payload then
      raise exception 'Saved payment request differs from previously posted payment' using errcode='23505';
   end if;
   return pg_catalog.to_jsonb(old_record);
 end if;
 select * into a from public.investor_agreements where id=p_agreement_id for update;
 if a.id is null or a.investor_user_id is null or a.payout_cap_usd is null or a.status='cancelled' then
   raise exception 'Active or completed USD-ceiling investment agreement required' using errcode='23514';
 end if;
 -- Prior LYD payments without an audited conversion cannot be silently turned into USD credits.
 if exists(select 1 from public.investor_payments p join public.investor_monthly_statements s on s.id=p.statement_id
   where s.agreement_id=a.id and p.finance_posting_status='posted') then
   raise exception 'Reconcile legacy LYD distributions before a new capped batch' using errcode='23514';
 end if;
 foreach v_month in array v_seen loop
   if v_month<a.start_date or (a.end_date is not null and v_month>a.end_date)
     or v_month>date_trunc('month',v_today)::date then
     raise exception 'Payment month is outside this investment agreement' using errcode='23514';
   end if;
   select (elem->>'amount_lyd')::numeric into v_amount from jsonb_array_elements(v_allocations) elem
     where elem->>'month_start'=v_month::text;
   select * into h from public.investor_historical_months
     where investor_user_id=a.investor_user_id and month_start=v_month for update;
   if found then
     if h.payment_confirmed_at is null or h.confirmed_payable_usd is null or h.confirmed_paid_usd is null then
       raise exception 'Historical month is not confirmed' using errcode='23514';
     end if;
     v_due:=round(h.confirmed_payable_usd*h.exchange_rate_lyd_per_usd,2);
     v_paid:=round(h.confirmed_paid_usd*h.exchange_rate_lyd_per_usd,2);
   else
     select * into s from public.investor_monthly_statements
       where agreement_id=a.id and month_start=v_month for update;
     if s.id is null or s.calculation_status<>'finalized' then
       raise exception 'Only finalized LYD monthly shares may be paid' using errcode='23514';
     end if;
     v_due:=s.investor_share_due_lyd;
     select coalesce(sum(lyd_equivalent),0) into v_paid
       from public.investor_usd_payouts
       where agreement_id=a.id and month_start=v_month;
   end if;
   select v_paid+coalesce(sum(x.amount_lyd),0) into v_paid
     from public.investor_lyd_payout_allocations x
     where x.agreement_id=a.id and x.month_start=v_month;
   if v_due<=0 or v_paid+v_amount>v_due+0.005 then
     raise exception 'Payment exceeds verified unpaid LYD entitlement in %',v_month using errcode='23514';
   end if;
 end loop;
 select coalesce(sum(confirmed_paid_usd),0) into v_prior_usd
 from public.investor_historical_months
 where investor_user_id=a.investor_user_id and month_start>=a.start_date
   and (a.end_date is null or month_start<=a.end_date)
   and payment_confirmed_at is not null;
 select v_prior_usd+coalesce(sum(p.amount_usd),0) into v_prior_usd
 from public.investor_usd_payouts p where p.agreement_id=a.id
 and not exists(select 1 from public.investor_historical_months h
  where h.investor_user_id=a.investor_user_id and h.month_start=p.month_start);
 select v_prior_usd+coalesce(sum(credited_usd),0) into v_prior_usd
 from public.investor_lyd_payout_batches where agreement_id=a.id;
 if v_prior_usd+v_usd>a.payout_cap_usd+0.005 then
   raise exception 'Payment would exceed remaining agreed USD payout ceiling' using errcode='23514';
 end if;
 insert into public.financial_transactions(transaction_date,transaction_datetime,direction,transaction_kind,transaction_type,
  description,notes,amount,signed_amount,currency,account_id,account_key,exchange_rate_usd_to_lyd,transaction_effect,
  category,bucket,final_bucket,payment_method,source_type,transaction_status,import_status,review_status,needs_review,is_void,created_by)
 values (p_payout_date,p_payout_date::timestamp at time zone 'Africa/Tripoli','money_out','manual_money_out','Investor Profit Distribution',
   'Investor LYD profit payout: '||a.investor_name,
   nullif(p_notes,''),v_total,-v_total,'LYD',p_account_id,p_account_id,p_lyd_per_usd,'expense',
   'Investor Profit Share','Investor Profit Share','Investor Profit Share',p_method,'investor_payment',
   'active','confirmed','confirmed',false,false,v_team)
 returning id into v_finance;
 insert into public.investor_lyd_payout_batches(agreement_id,payout_date,amount_lyd,lyd_per_usd,credited_usd,
    payment_account,payment_method,payment_reference,notes,finance_transaction_id,client_submission_id,request_payload,recorded_by)
 values(p_agreement_id,p_payout_date,v_total,p_lyd_per_usd,v_usd,p_account_id,p_method,p_reference,
   nullif(p_notes,''),v_finance,p_command_id,v_payload,auth.uid())
 returning id into v_batch;
 insert into public.investor_lyd_payout_allocations(payout_id,agreement_id,month_start,amount_lyd)
 select v_batch,p_agreement_id,(x->>'month_start')::date,(x->>'amount_lyd')::numeric
 from jsonb_array_elements(v_allocations) x;
 update public.financial_transactions set source_id=v_batch where id=v_finance;
 return jsonb_build_object('id',v_batch,'agreement_id',p_agreement_id,'client_submission_id',p_command_id,
 'amount_lyd',v_total,'credited_usd',v_usd,'finance_transaction_id',v_finance);
end
$function$;
revoke all on function public.snacky_record_investor_lyd_payout_batch_v1(uuid,jsonb,date,numeric,text,text,text,text,uuid) from public,anon;
grant execute on function public.snacky_record_investor_lyd_payout_batch_v1(uuid,jsonb,date,numeric,text,text,text,text,uuid) to authenticated;
