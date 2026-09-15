\set ON_ERROR_STOP on
-- Isolated GitHub Actions database only. No production connection, identities,
-- credentials or customer data are used. Session helpers are test doubles;
-- the migrations, command bodies, numeric storage and balance view are real.
select current_database() = 'snacky_fx_test' as is_test_database \gset
\if :is_test_database
\else
  \echo 'Refusing to run fixtures outside snacky_fx_test'
  \quit 2
\endif
begin;
create role authenticated nologin;
create role anon nologin;
create type public.issue_priority as enum ('low','normal','high','critical');
create type public.issue_status as enum ('open','assigned','in_progress','resolved','closed');
create table public.machines(id uuid primary key default gen_random_uuid(),name text);
create table public.issues(id uuid primary key default gen_random_uuid(),machine_id uuid references public.machines(id),reported_by uuid,assigned_to uuid,issue_type text not null,priority public.issue_priority not null default 'normal',status public.issue_status not null default 'open',description text,photo_url text,created_at timestamptz not null default now(),resolved_at timestamptz,sla_due_at timestamptz);
create table public.finance_opening_balances(id uuid primary key default gen_random_uuid(),balance_date date,account_id text,currency text,opening_balance numeric);
create table public.financial_transactions(
  id uuid primary key default gen_random_uuid(),transaction_date date not null,transaction_datetime timestamptz,direction text not null,transaction_kind text not null,transaction_type text,
  amount numeric(12,2) not null check(amount>=0),signed_amount numeric(12,2) not null,currency text not null,account_id text,account_key text,transaction_effect text,
  source_account_id text,destination_account_id text,exchange_rate_usd_to_lyd numeric(12,6),category text,bucket text,final_bucket text,description text,notes text,
  transaction_status text not null default 'active',import_status text,review_status text,needs_review boolean not null default false,is_void boolean not null default false,
  source_type text,source_id uuid,created_by uuid,metadata jsonb not null default '{}',source_file text,source_sheet text,source_row integer,voided_at timestamptz,void_reason text
);
create function public.snacky_current_team_member_id() returns uuid language sql stable as $$ select case when coalesce(current_setting('snacky_test.role',true),'')<>'' then '22222222-2222-4222-8222-222222222222'::uuid else null end $$;
create function public.snacky_current_profile_has_any_role(allowed_roles text[]) returns boolean language sql stable as $$ select coalesce(current_setting('snacky_test.role',true),'')=any(allowed_roles) $$;
create view public.finance_account_balance_impacts with(security_invoker=true) as
select ft.id as financial_transaction_id,ft.transaction_date,ft.source_account_id as account_id,'LYD'::text as currency,-abs(ft.amount) as amount_delta,ft.transaction_effect,ft.final_bucket,ft.source_file,ft.source_sheet,ft.source_row from public.financial_transactions ft
union all
select ft.id,ft.transaction_date,ft.destination_account_id,'USD'::text,abs(ft.amount) as amount_delta,ft.transaction_effect,ft.final_bucket,ft.source_file,ft.source_sheet,ft.source_row from public.financial_transactions ft;
alter table public.financial_transactions enable row level security;
create policy fixture_finance_read on public.financial_transactions for select to authenticated using(public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','finance']));
create policy fixture_finance_update on public.financial_transactions for update to authenticated using(public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','finance']));
grant usage on schema public to authenticated,anon;
grant select,update on public.financial_transactions to authenticated;
grant select on public.finance_opening_balances,public.finance_account_balance_impacts to authenticated;
\ir ../supabase/migrations/20260915160000_explicit_currency_exchange.sql
\ir ../supabase/migrations/20260915160100_customer_issue_entry.sql
\ir ../supabase/migrations/20260915160200_explicit_currency_exchange_balance_projection.sql
select set_config('snacky_test.role','owner',true);
set local role authenticated;
do $$
declare
  fx_id uuid:=gen_random_uuid(); issue_id uuid:=gen_random_uuid();
  result jsonb; impacts jsonb;
  day date:=(now() at time zone 'Africa/Tripoli')::date;
begin
  result:=public.snacky_record_currency_exchange_v1(fx_id,day,'snacky_lyd','snacky_usd',9000,1000,'Test fixture');
  if result->>'id'<>fx_id::text then raise exception 'Incorrect exchange receipt'; end if;
  result:=public.snacky_record_currency_exchange_v1(fx_id,day,'snacky_lyd','snacky_usd',9000,1000,'Test fixture');
  if (result->>'already_applied')::boolean is not true or (select count(*) from public.financial_transactions where id=fx_id)<>1 then raise exception 'Replay duplicated exchange'; end if;
  select jsonb_object_agg(account_id,amount_delta) into impacts from public.finance_account_balance_impacts where financial_transaction_id=fx_id;
  if impacts is distinct from '{"snacky_lyd":-9000,"snacky_usd":1000}'::jsonb then raise exception 'Incorrect native currency impacts: %',impacts; end if;
  if not exists(select 1 from public.financial_transactions where id=fx_id and transaction_effect='transfer' and exchange_rate_usd_to_lyd=9) then raise exception 'Exchange was not stored as a rate-bearing transfer'; end if;
  begin
    perform public.snacky_record_currency_exchange_v1(fx_id,day,'snacky_lyd','snacky_usd',9000,999,'Test fixture');
    raise exception 'Changed request payload accepted';
  exception when unique_violation then null; end;
  begin
    perform public.snacky_record_currency_exchange_v1(gen_random_uuid(),day,'snacky_lyd','snacky_usd',9000,0,null);
    raise exception 'Zero received amount accepted';
  exception when invalid_parameter_value then null; end;
  begin
    update public.financial_transactions set amount=9001 where id=fx_id;
    raise exception 'Independent source edit accepted';
  exception when check_violation then null; end;
  update public.financial_transactions set transaction_status='voided',is_void=true,voided_at=now(),void_reason='Test fixture' where id=fx_id;
  if exists(select 1 from public.finance_account_balance_impacts where financial_transaction_id=fx_id) then raise exception 'Void did not remove both account impacts'; end if;
  result:=public.snacky_create_customer_issue_v1(issue_id,null,'product_stuck','normal','Fixture customer','0910000000','whatsapp','Test fixture');
  if result->>'status'<>'open' then raise exception 'New issue is not open'; end if;
  result:=public.snacky_create_customer_issue_v1(issue_id,null,'product_stuck','normal','Fixture customer','0910000000','whatsapp','Test fixture');
  if (result->>'already_applied')::boolean is not true or (select count(*) from public.issues where id=issue_id and machine_id is null and photo_url is null and customer_phone='0910000000')<>1 then raise exception 'Photo-free issue creation/replay failed'; end if;
  perform set_config('snacky_test.role','crm',true);
  if not exists(select 1 from public.issues where id=issue_id) then raise exception 'Support cannot read issue'; end if;
  begin
    perform public.snacky_record_currency_exchange_v1(gen_random_uuid(),day,'snacky_lyd','snacky_usd',9,1,null);
    raise exception 'CRM can record money';
  exception when insufficient_privilege then null; end;
  perform set_config('snacky_test.role','operator',true);
  begin
    perform public.snacky_create_customer_issue_v1(gen_random_uuid(),null,'other','normal',null,null,'phone','Test fixture');
    raise exception 'Operator can use global support command';
  exception when insufficient_privilege then null; end;
  perform set_config('snacky_test.role','viewer',true);
  if exists(select 1 from public.issues where id=issue_id) then raise exception 'Unrelated role can read customer contacts'; end if;
end $$;
select 'PASS: native LYD/USD projections, durable replay, mismatched-payload guard, amount guards, two-sided void, no-photo support issues and role privacy' as verification;
rollback;
