\set ON_ERROR_STOP on
-- ISOLATED CI DATABASE ONLY. Never run this fixture against a Snacky project.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
grant usage on schema auth,public to authenticated,service_role;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create type public.team_role as enum('owner','admin','operator','investor');
create table public.team_members(id uuid primary key,auth_user_id uuid,role public.team_role,roles public.team_role[],can_add_products boolean,active boolean default true,active_status text default 'active',updated_at timestamptz default now());
create table public.profiles(id uuid primary key,team_member_id uuid,role public.team_role,roles public.team_role[],can_add_products boolean,active_status text default 'active',updated_at timestamptz default now());
create function public.snacky_current_team_member_id() returns uuid language sql stable security definer as $$select id from public.team_members where auth_user_id=auth.uid() limit 1$$;
create function public.snacky_current_profile_has_any_role(allowed text[]) returns boolean language sql stable security definer as $$select exists(select 1 from public.profiles where id=auth.uid() and active_status='active' and (role::text=any(allowed) or roles::text[]&&allowed))$$;
create table public.investor_agreements(id uuid primary key default gen_random_uuid(),investor_user_id uuid references auth.users,investor_name text not null,investment_amount_lyd numeric(14,2) default 0,profit_share_percent numeric not null,profit_basis text not null default 'operating_profit' constraint investor_agreements_profit_basis_check check(profit_basis='operating_profit'),start_date date,end_date date,payout_cap_lyd numeric,status text,notes text,created_by uuid references auth.users,created_at timestamptz default now(),updated_at timestamptz default now());
create table public.investor_monthly_statements(id uuid primary key default gen_random_uuid(),agreement_id uuid references public.investor_agreements on delete cascade,month_start date,revenue_lyd numeric,cogs_lyd numeric,gross_profit_lyd numeric,operating_expenses_lyd numeric,operating_profit_lyd numeric,share_percent numeric,investor_share_due_lyd numeric,calculation_status text,data_source_note text,generated_by uuid references auth.users,generated_at timestamptz default now(),finalized_at timestamptz,updated_at timestamptz default now(),unique(agreement_id,month_start));
create table public.financial_transactions(id uuid primary key default gen_random_uuid(),transaction_date date,transaction_datetime timestamptz,direction text,transaction_kind text check(transaction_kind in ('spreadsheet_import','manual_money_in','manual_money_out','product_purchase','cash_collection')),transaction_type text,description text,notes text,amount numeric(14,2),signed_amount numeric(14,2),currency text,account_id text,account_key text,transaction_effect text,category text,bucket text,final_bucket text,payment_method text,source_type text,source_id uuid,transaction_status text,import_status text,review_status text,needs_review boolean,is_void boolean,voided_at timestamptz,created_by uuid references public.team_members,exchange_rate_usd_to_lyd numeric);
create table public.investor_payments(id uuid primary key default gen_random_uuid(),agreement_id uuid references public.investor_agreements on delete cascade,statement_id uuid references public.investor_monthly_statements,payment_date date,amount_lyd numeric(14,2),payment_reference text,notes text,finance_transaction_id uuid,finance_posting_status text,finance_posting_error text,recorded_by uuid references auth.users,created_at timestamptz default now());
grant select,insert,update,delete on public.investor_payments to authenticated;
\ir ../supabase/migrations/20260915170000_investor_access_and_ledger.sql
\ir ../supabase/migrations/20260915170100_investor_history_guards.sql
begin;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.team_members(id,auth_user_id,role,roles,can_add_products) values('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner',array['owner']::public.team_role[],true),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','operator',array['operator','investor']::public.team_role[],true);
insert into public.profiles(id,team_member_id,role,roles,can_add_products) select auth_user_id,id,role,roles,can_add_products from public.team_members;
update public.team_members set role='investor',roles=array['investor']::public.team_role[] where id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
do $$
declare a uuid;s uuid;g timestamptz;capital jsonb;payout jsonb;replayed jsonb;n integer;blocked boolean;
begin
 if not exists(select 1 from public.profiles where id='22222222-2222-4222-8222-222222222222' and role='investor' and roles=array['investor']::public.team_role[] and not can_add_products) then raise exception 'Role synchronization failed'; end if;
 blocked:=false;begin update public.team_members set role='investor',roles=array['investor']::public.team_role[] where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';exception when others then blocked:=true;end;if not blocked then raise exception 'Last admin was removed';end if;
 insert into public.investor_agreements(investor_user_id,investor_name,profit_share_percent,start_date,status,profit_basis_confirmed) values('22222222-2222-4222-8222-222222222222','CI investor',30,'2020-01-01','active',true) returning id into a;
 capital:=public.snacky_record_investor_contribution_v1(a,1000,'USD',9,'2020-01-01','snacky_usd','test','',null,'33333333-3333-4333-8333-333333333333');
 if (capital->>'amount_lyd')::numeric<>9000 then raise exception 'USD capital valuation failed';end if;
 replayed:=public.snacky_record_investor_contribution_v1(a,1000,'USD',9,'2020-01-01','snacky_usd','test','',null,'33333333-3333-4333-8333-333333333333');
 if replayed->>'id'<>capital->>'id' then raise exception 'Capital retry duplicated';end if;
 insert into public.investor_monthly_statements(agreement_id,month_start,revenue_lyd,cogs_lyd,gross_profit_lyd,operating_expenses_lyd,operating_profit_lyd,share_percent,investor_share_due_lyd,calculation_status,source_complete,profit_basis,distribution_basis_lyd,capital_purchases_lyd) values(a,'2020-01-01',45000,24000,21000,6000,15000,30,4500,'draft',true,'operating_profit',15000,22350) returning id,generated_at into s,g;
 blocked:=false;begin perform public.snacky_finalize_investor_statement_v1(s,g,'{}');exception when others then blocked:=true;end;if not blocked then raise exception 'Unreviewed draft finalized';end if;
 perform public.snacky_finalize_investor_statement_v1(s,g,'{"sales":true,"rent_payroll":true,"expenses":true,"capital":true}');
 payout:=public.snacky_record_investor_payment_v1(s,2000,'2020-02-01','snacky_lyd','cash','test','','44444444-4444-4444-8444-444444444444');
 replayed:=public.snacky_record_investor_payment_v1(s,2000,'2020-02-01','snacky_lyd','cash','test','','44444444-4444-4444-8444-444444444444');
 if payout->>'id'<>replayed->>'id' then raise exception 'Payout retry duplicated';end if;
 if not exists(select 1 from public.financial_transactions where id=(payout->>'finance_transaction_id')::uuid and amount=2000 and signed_amount=-2000 and transaction_kind='manual_money_out' and created_by='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') then raise exception 'Finance payout/actor mismatch';end if;
 select count(*) into n from public.financial_transactions;
 if n<>2 then raise exception 'Expected exactly one capital cash-in and one payout cash-out, got %',n;end if;
 blocked:=false;begin perform public.snacky_record_investor_payment_v1(s,3000,'2020-02-01','snacky_lyd','cash','test','','55555555-5555-4555-8555-555555555555');exception when others then blocked:=true;end;if not blocked then raise exception 'Overpayment accepted';end if;
 blocked:=false;begin perform public.snacky_record_investor_payment_v1(s,1000,'2020-02-01','snacky_lyd','cash','test','','44444444-4444-4444-8444-444444444444');exception when others then blocked:=true;end;if not blocked then raise exception 'Different payload replay accepted';end if;
 blocked:=false;begin update public.investor_monthly_statements set operating_profit_lyd=1 where id=s;exception when others then blocked:=true;end;if not blocked then raise exception 'Finalized profit rewritten';end if;
 blocked:=false;begin update public.investor_agreements set profit_share_percent=40 where id=a;exception when others then blocked:=true;end;if not blocked then raise exception 'Finalized share agreement rewritten';end if;
 blocked:=false;begin update public.financial_transactions set amount=1 where id=(payout->>'finance_transaction_id')::uuid;exception when others then blocked:=true;end;if not blocked then raise exception 'Linked payout rewritten';end if;
 perform set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
 blocked:=false;begin perform public.snacky_record_investor_payment_v1(s,1,'2020-02-01','snacky_lyd','cash','','','66666666-6666-4666-8666-666666666666');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Investor allowed to pay self';end if;
 if has_table_privilege('authenticated','public.investor_payments','INSERT') then raise exception 'Direct payout insertion still permitted';end if;
 if has_table_privilege('authenticated','public.investor_contributions','INSERT') then raise exception 'Direct contribution insertion still permitted';end if;
 raise notice 'PASS: exact roles, capital receipt, USD valuation, safe retries, monthly review, partial payout, overpayment guard, actor FK, immutable histories, investor read-only authorization';
end $$;
rollback;
