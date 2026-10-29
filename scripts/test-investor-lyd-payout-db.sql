\set ON_ERROR_STOP on
-- Isolated CI PostgreSQL fixture. This file must not be run on a live Snacky database.
create role anon nologin;
create role authenticated nologin;
create schema auth;
grant usage on schema auth,public to authenticated;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant execute on function auth.uid() to authenticated;
create table public.profiles(id uuid primary key,role text,active_status text);
create table public.team_members(id uuid primary key,auth_user_id uuid);
create function public.snacky_current_team_member_id() returns uuid language sql stable security definer as
 $$select id from public.team_members where auth_user_id=auth.uid() limit 1$$;
create function public.snacky_current_profile_has_any_role(allowed text[]) returns boolean language sql stable security definer as
 $$select exists(select 1 from public.profiles where id=auth.uid() and active_status='active' and role=any(allowed))$$;
create function public.snacky_is_owner_admin() returns boolean language sql stable security definer as
 $$select public.snacky_current_profile_has_any_role(array['owner','admin'])$$;
create table public.investor_agreements(
 id uuid primary key,investor_user_id uuid,investor_name text,investment_amount_lyd numeric,
 profit_share_percent numeric,profit_basis text,start_date date,end_date date,payout_cap_lyd numeric,
 payout_cap_usd numeric,status text
);
create function public.snacky_can_view_investor_agreement(a uuid) returns boolean language sql stable security definer as
 $$select exists(select 1 from public.investor_agreements where id=a and investor_user_id=auth.uid())$$;
create table public.investor_monthly_statements(
 id uuid primary key default gen_random_uuid(),agreement_id uuid,month_start date,calculation_status text,
 investor_share_due_lyd numeric,investor_share_due_usd numeric,operating_profit_lyd numeric,
 distribution_basis_lyd numeric,loss_carried_in_lyd numeric default 0,loss_carried_out_lyd numeric default 0
);
create table public.investor_historical_months(
 id uuid primary key default gen_random_uuid(),investor_user_id uuid,month_start date,
 payment_confirmed_at timestamptz,confirmed_payable_usd numeric,confirmed_paid_usd numeric,
 exchange_rate_lyd_per_usd numeric
);
create table public.investor_usd_payouts(
 id uuid primary key default gen_random_uuid(),agreement_id uuid,month_start date,
 amount_usd numeric,lyd_equivalent numeric
);
create table public.investor_payments(id uuid default gen_random_uuid(),agreement_id uuid,
 statement_id uuid,finance_posting_status text);
create table public.financial_transactions(
 id uuid primary key default gen_random_uuid(),transaction_date date,transaction_datetime timestamptz,
 direction text,transaction_kind text,transaction_type text,description text,notes text,
 amount numeric,signed_amount numeric,currency text,account_id text,account_key text,
 exchange_rate_usd_to_lyd numeric,transaction_effect text,category text,bucket text,final_bucket text,
 payment_method text,source_type text,source_id uuid,transaction_status text,import_status text,
 review_status text,needs_review boolean,is_void boolean,created_by uuid
);
create function public.snacky_record_investor_usd_payout_v1(uuid,date,numeric,date,numeric,text,text,text,text,uuid)
 returns jsonb language sql as $$select '{}'::jsonb$$;
revoke all on function public.snacky_record_investor_usd_payout_v1(uuid,date,numeric,date,numeric,text,text,text,text,uuid) from public,anon;
\ir ../supabase/migrations/20261029190000_investor_lyd_settlement_batches.sql

begin;
insert into public.profiles values
 ('11111111-1111-4111-8111-111111111111','owner','active'),
 ('22222222-2222-4222-8222-222222222222','investor','active');
insert into public.team_members values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111');
insert into public.investor_agreements(id,investor_user_id,investor_name,profit_share_percent,
 profit_basis,start_date,payout_cap_usd,status)
 values ('aaaaaaaa-aaaa-4aaa-8aaa-111111111111','22222222-2222-4222-8222-222222222222',
 'Synthetic investor',30,'operating_profit','2026-01-01',500,'active');
insert into public.investor_historical_months(investor_user_id,month_start,payment_confirmed_at,
 confirmed_payable_usd,confirmed_paid_usd,exchange_rate_lyd_per_usd)
 values ('22222222-2222-4222-8222-222222222222','2026-01-01',now(),200,0,7.5);
insert into public.investor_monthly_statements(agreement_id,month_start,calculation_status,
 investor_share_due_lyd,operating_profit_lyd,distribution_basis_lyd)
 values
 ('aaaaaaaa-aaaa-4aaa-8aaa-111111111111','2026-02-01','finalized',1000,3333.33,3333.33),
 ('aaaaaaaa-aaaa-4aaa-8aaa-111111111111','2026-03-01','finalized',2000,6666.67,6666.67),
 ('aaaaaaaa-aaaa-4aaa-8aaa-111111111111','2026-04-01','draft',250,833.33,833.33);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare first jsonb; replay jsonb; second jsonb; blocked boolean; n integer;
  a uuid:='aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
begin
 if (select count(*) from public.investor_lyd_payout_batches)<>0 then raise exception 'Test started with a payout'; end if;
 first:=public.snacky_record_investor_lyd_payout_batch_v1(a,
 '[{"month_start":"2026-02-01","amount_lyd":1000},{"month_start":"2026-03-01","amount_lyd":2000}]',
 '2026-05-01',10,'snacky_lyd','bank_transfer','TEST-RECEIPT-1','','33333333-3333-4333-8333-333333333333');
 if (first->>'amount_lyd')::numeric<>3000 or (first->>'credited_usd')::numeric<>300 then
   raise exception 'LYD multi-month payment or USD credit incorrect';
 end if;
 replay:=public.snacky_record_investor_lyd_payout_batch_v1(a,
 '[{"month_start":"2026-03-01","amount_lyd":2000},{"month_start":"2026-02-01","amount_lyd":1000}]',
 '2026-05-01',10,'snacky_lyd','bank_transfer','TEST-RECEIPT-1','','33333333-3333-4333-8333-333333333333');
 if replay->>'id'<>first->>'id' then raise exception 'Idempotent retry created another payout';end if;
 if (select count(*) from public.investor_lyd_payout_allocations)<>2
 or (select count(*) from public.financial_transactions)<>1
 or not exists(select 1 from public.financial_transactions
  where currency='LYD' and amount=3000 and signed_amount=-3000
  and created_by='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then
   raise exception 'A multi-month payment must write one LYD Finance cash-out';
 end if;
 blocked:=false;begin
  perform public.snacky_record_investor_lyd_payout_batch_v1(a,
  '[{"month_start":"2026-02-01","amount_lyd":999}]',
  '2026-05-01',10,'snacky_lyd','bank_transfer','TEST-RECEIPT-1','','33333333-3333-4333-8333-333333333333');
 exception when others then blocked:=true;end;
 if not blocked then raise exception 'Idempotency reused with changed payload';end if;
 blocked:=false;begin
  perform public.snacky_record_investor_lyd_payout_batch_v1(a,
  '[{"month_start":"2026-04-01","amount_lyd":250}]',
  '2026-05-01',10,'snacky_lyd','bank_transfer','TEST-RECEIPT-2','','44444444-4444-4444-8444-444444444444');
 exception when others then blocked:=true;end;
 if not blocked then raise exception 'Paid a draft month';end if;
 second:=public.snacky_record_investor_lyd_payout_batch_v1(a,
  '[{"month_start":"2026-01-01","amount_lyd":1000}]',
  '2026-05-20',5,'snacky_lyd','cash','TEST-RECEIPT-2','','55555555-5555-4555-8555-555555555555');
 if (second->>'credited_usd')::numeric<>200 then raise exception 'Payment-day FX was not used';end if;
 if (select count(*) from public.financial_transactions)<>2 then raise exception 'Unexpected duplicate Finance posting';end if;
 if (select confirmed_paid_usd from public.investor_historical_months limit 1)<>0 then
  raise exception 'Original historical source was rewritten';
 end if;
 blocked:=false;begin
  perform public.snacky_record_investor_lyd_payout_batch_v1(a,
  '[{"month_start":"2026-01-01","amount_lyd":500}]',
  '2026-05-22',10,'snacky_lyd','cash','TEST-RECEIPT-3','','66666666-6666-4666-8666-666666666666');
 exception when others then blocked:=true;end;
 if not blocked then raise exception 'Allowed payment above USD goal';end if;
 blocked:=false;begin
  update public.investor_lyd_payout_batches set amount_lyd=1 where id=(first->>'id')::uuid;
 exception when others then blocked:=true;end;
 if not blocked then raise exception 'Posted payout mutation allowed';end if;
 blocked:=false;begin
  insert into public.investor_payments(agreement_id) values(a);
 exception when others then blocked:=true;end;
 if not blocked then raise exception 'Legacy payout bypass accepted';end if;
 raise notice 'PASS: LYD multi-month payout, payment-day FX, goal accumulation, no initial payout, no duplicate posting, no draft payment, cap, immutability';
end $$;
-- The investor has SELECT only; they may not post money or read another investor.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
set local role authenticated;
do $$
declare blocked boolean:=false;
begin
 if (select count(*) from public.investor_lyd_payout_batches)<>2 then raise exception 'Investor cannot read own payouts';end if;
 if has_table_privilege('authenticated','public.investor_lyd_payout_batches','INSERT')
  or has_table_privilege('authenticated','public.investor_lyd_payout_allocations','INSERT') then
   raise exception 'Investor has direct insert privilege';
 end if;
 begin
  perform public.snacky_record_investor_lyd_payout_batch_v1(
  'aaaaaaaa-aaaa-4aaa-8aaa-111111111111',
  '[{"month_start":"2026-01-01","amount_lyd":1}]',
  '2026-05-01',10,'snacky_lyd','cash','UNAUTHORIZED','','77777777-7777-4777-8777-777777777777');
 exception when others then blocked:=true;end;
 if not blocked then raise exception 'Investor could pay themselves';end if;
 raise notice 'PASS: investor can view own ledger and cannot write payouts';
end $$;
rollback;
