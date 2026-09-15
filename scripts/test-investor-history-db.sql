\set ON_ERROR_STOP on
-- Isolated fixture database only. No production identities or source figures.
select current_database() = 'investor_tests' as is_isolated_database \gset
\if :is_isolated_database
\else
  \echo 'Refusing historical fixtures outside investor_tests'
  \quit 2
\endif
\ir test-investor-ledger.sql
\ir ../supabase/migrations/20260915180000_investor_historical_months.sql
\ir ../supabase/migrations/20260915181000_investor_history_payment_confirmation.sql
begin;
insert into auth.users values
 ('11111111-1111-4111-8111-111111111111'),
 ('22222222-2222-4222-8222-222222222222'),
 ('33333333-3333-4333-8333-333333333333');
insert into public.team_members(id,auth_user_id,role,roles,can_add_products) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner',array['owner']::public.team_role[],true),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','22222222-2222-4222-8222-222222222222','investor',array['investor']::public.team_role[],false),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','33333333-3333-4333-8333-333333333333','investor',array['investor']::public.team_role[],false);
insert into public.profiles(id,team_member_id,role,roles,can_add_products)
 select auth_user_id,id,role,roles,can_add_products from public.team_members;

insert into public.investor_historical_months(
 investor_user_id,month_start,profit_lyd,cogs_refill_cost_lyd,other_opex_lyd,previous_month_lyd,
 net_profit_lyd,exchange_rate_lyd_per_usd,net_profit_usd,investor_share_percent,investor_share_usd,
 source_label,source_cells,import_batch_key)
values
 ('22222222-2222-4222-8222-222222222222','2022-01-01',1000,null,-1500,null,-500,5,-100,30,-30,'Synthetic source','{"COGS / Refill Cost (LYD)":"","Investor Share 30% (USD)":"-$30.00"}','fixture'),
 ('22222222-2222-4222-8222-222222222222','2022-02-01',1200,null,-500,-500,200,5,40,30,12,'Synthetic source','{"previous month":"-500.00 LYD"}','fixture'),
 ('33333333-3333-4333-8333-333333333333','2022-01-01',2000,null,-1000,null,1000,5,200,30,60,'Other synthetic investor','{}','fixture');

do $$
declare a uuid; blocked boolean; before_sources jsonb;
begin
 if (select count(*) from public.investor_historical_months)<>3 then raise exception 'Source rows missing'; end if;
 if exists(select 1 from public.investor_historical_months where confirmed_paid_usd is not null or confirmed_payable_usd is not null) then raise exception 'Import guessed payment status'; end if;
 select jsonb_agg(jsonb_build_object('id',id,'cells',source_cells) order by id) into before_sources from public.investor_historical_months;
 blocked:=false;
 begin update public.investor_historical_months set confirmed_paid_usd=0 where investor_user_id='22222222-2222-4222-8222-222222222222';
 exception when check_violation then blocked:=true; end;
 if not blocked then raise exception 'Incomplete payment confirmation accepted'; end if;
 update public.investor_historical_months set confirmed_payable_usd=case month_start when date '2022-01-01' then 0 else 12 end,
   confirmed_paid_usd=0,payment_confirmed_at=now(),payment_confirmation_note='Synthetic owner: nothing paid'
 where investor_user_id='22222222-2222-4222-8222-222222222222';
 if (select sum(confirmed_payable_usd-confirmed_paid_usd) from public.investor_historical_months where investor_user_id='22222222-2222-4222-8222-222222222222')<>12 then raise exception 'Loss was deducted a second time'; end if;
 if (select sum(confirmed_paid_usd) from public.investor_historical_months where investor_user_id='22222222-2222-4222-8222-222222222222')<>0 then raise exception 'Confirmation fabricated a payment'; end if;
 if before_sources is distinct from (select jsonb_agg(jsonb_build_object('id',id,'cells',source_cells) order by id) from public.investor_historical_months) then raise exception 'Payment confirmation changed original source cells'; end if;
 blocked:=false;
 begin update public.investor_historical_months set confirmed_paid_usd=13 where month_start='2022-02-01';
 exception when check_violation then blocked:=true; end;
 if not blocked then raise exception 'Paid amount above confirmed due accepted'; end if;
 blocked:=false;
 begin update public.investor_historical_months set confirmed_payable_usd=-30 where investor_user_id='22222222-2222-4222-8222-222222222222' and month_start='2022-01-01';
 exception when check_violation then blocked:=true; end;
 if not blocked then raise exception 'Negative investor debt invented'; end if;
 if not exists(select 1 from public.investor_historical_months where investor_share_usd=-30 and cogs_refill_cost_lyd is null and previous_month_lyd is null and source_cells->>'COGS / Refill Cost (LYD)'='') then raise exception 'Negative source or blank cells were lost'; end if;
 if not exists(select 1 from public.investor_historical_months where month_start='2022-02-01' and previous_month_lyd=-500 and investor_share_usd=12) then raise exception 'Carried loss was recalculated'; end if;
 if exists(select 1 from public.investor_agreements) or exists(select 1 from public.investor_payments) or exists(select 1 from public.investor_contributions) or exists(select 1 from public.financial_transactions) then raise exception 'Historical import or confirmation created money or an agreement'; end if;
 if has_table_privilege('authenticated','public.investor_historical_months','INSERT') or has_table_privilege('authenticated','public.investor_historical_months','UPDATE') or has_table_privilege('authenticated','public.investor_historical_months','DELETE') then raise exception 'Source records are not read-only'; end if;
 insert into public.investor_agreements(investor_user_id,investor_name,profit_share_percent,start_date,status,profit_basis_confirmed)
 values('22222222-2222-4222-8222-222222222222','Synthetic investor',30,'2022-01-01','active',true) returning id into a;
 blocked:=false;
 begin
  insert into public.investor_monthly_statements(agreement_id,month_start,calculation_status) values(a,'2022-01-01','draft');
 exception when check_violation then blocked:=true;
 end;
 if not blocked then raise exception 'Automatic month duplicated source history'; end if;
 insert into public.investor_monthly_statements(agreement_id,month_start,calculation_status) values(a,'2022-03-01','draft');
 blocked:=false;
 begin
  insert into public.investor_historical_months(investor_user_id,month_start,profit_lyd,other_opex_lyd,net_profit_lyd,exchange_rate_lyd_per_usd,net_profit_usd,investor_share_percent,investor_share_usd,source_label,source_cells,import_batch_key)
  values('22222222-2222-4222-8222-222222222222','2022-03-01',800,-100,700,5,140,30,42,'Synthetic source','{}','fixture');
 exception when check_violation then blocked:=true;
 end;
 if not blocked then raise exception 'Source history duplicated an existing statement'; end if;
 insert into public.investor_historical_months(investor_user_id,month_start,profit_lyd,other_opex_lyd,net_profit_lyd,exchange_rate_lyd_per_usd,net_profit_usd,investor_share_percent,investor_share_usd,source_label,source_cells,import_batch_key)
 values('22222222-2222-4222-8222-222222222222','2022-01-01',1000,-1500,-500,5,-100,30,-30,'Synthetic source','{}','fixture')
 on conflict(investor_user_id,month_start) do nothing;
 if (select count(*) from public.investor_historical_months)<>3 then raise exception 'Import retry duplicated records'; end if;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$begin
 if (select count(*) from public.investor_historical_months)<>3 then raise exception 'Owner cannot read historical months'; end if;
end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
do $$begin
 if (select count(*) from public.investor_historical_months)<>2 then raise exception 'Investor history scoping failed'; end if;
 if exists(select 1 from public.investor_historical_months where investor_user_id<>auth.uid()) then raise exception 'Another investor source history leaked'; end if;
 if (select sum(confirmed_payable_usd-confirmed_paid_usd) from public.investor_historical_months)<>12 then raise exception 'Investor cannot read own confirmed unpaid amount'; end if;
end $$;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $$begin
 if (select count(*) from public.investor_historical_months)<>1 then raise exception 'Second investor privacy failed'; end if;
 if exists(select 1 from public.investor_historical_months where payment_confirmed_at is not null) then raise exception 'Another investor confirmation leaked'; end if;
end $$;
reset role;
update public.profiles set active_status='inactive' where id='33333333-3333-4333-8333-333333333333';
set local role authenticated;
do $$begin
 if exists(select 1 from public.investor_historical_months) then raise exception 'Inactive investor can read source figures'; end if;
end $$;
reset role;
select 'PASS: preserved source cells, loss carry, explicit zero-paid confirmation, no money movements, duplicate-month protection and own-investor privacy' as verification;
rollback;
