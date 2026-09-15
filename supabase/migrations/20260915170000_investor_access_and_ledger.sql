-- Additive investor workflow repair. No capital, profit, or payout amounts are seeded.
create or replace function public.snacky_sync_team_access_v1()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
begin
  if cardinality(new.roles)=1 and new.roles[1]::text='investor' then new.can_add_products:=false; end if;
  if new.auth_user_id is not null and exists(select 1 from public.profiles p where p.id=new.auth_user_id and p.team_member_id is not null and p.team_member_id<>new.id) then
    raise exception 'Login belongs to a different team member; access update stopped';
  end if;
  if tg_op='UPDATE' and (old.role::text in ('owner','admin') or old.roles::text[] && array['owner','admin'])
     and old.active and old.active_status='active'
     and (not new.active or new.active_status<>'active' or not (new.role::text in ('owner','admin') or new.roles::text[] && array['owner','admin'])) then
    perform pg_advisory_xact_lock(hashtext('snacky-last-administrator'));
    if not exists(select 1 from public.team_members t where t.id<>new.id and t.active and t.active_status='active' and (t.role::text in ('owner','admin') or t.roles::text[] && array['owner','admin'])) then
      raise exception 'Cannot remove the last active administrator';
    end if;
  end if;
  update public.profiles p set role=new.role,roles=new.roles,can_add_products=new.can_add_products,
    active_status=case when new.active then new.active_status else 'inactive' end,updated_at=now()
    where p.team_member_id=new.id or p.id=new.auth_user_id;
  return new;
end $$;
revoke all on function public.snacky_sync_team_access_v1() from public,anon,authenticated;
drop trigger if exists snacky_sync_team_access_v1 on public.team_members;
create trigger snacky_sync_team_access_v1 before update of role,roles,can_add_products,active,active_status,auth_user_id on public.team_members for each row execute function public.snacky_sync_team_access_v1();

alter table public.investor_agreements drop constraint if exists investor_agreements_profit_basis_check;
alter table public.investor_agreements add constraint investor_agreements_profit_basis_check check(profit_basis in ('operating_profit','operating_profit_after_capex'));
alter table public.investor_agreements add column if not exists profit_basis_confirmed boolean not null default false;
alter table public.investor_monthly_statements
  add column if not exists capital_purchases_lyd numeric(14,2),
  add column if not exists distribution_basis_lyd numeric(14,2),
  add column if not exists profit_basis text,
  add column if not exists expense_breakdown jsonb,
  add column if not exists source_complete boolean not null default false,
  add column if not exists review_checks jsonb;
alter table public.investor_payments add column if not exists client_submission_id uuid,
  add column if not exists request_payload jsonb;
create unique index if not exists investor_payments_command_unique on public.investor_payments(client_submission_id) where client_submission_id is not null;

create table if not exists public.investor_contributions(
 id uuid primary key default gen_random_uuid(),
 agreement_id uuid not null references public.investor_agreements(id) on delete restrict,
 received_date date not null,
 original_amount numeric(14,2) not null check(original_amount>0),
 currency text not null check(currency in ('LYD','USD')),
 exchange_rate_lyd numeric(14,6) not null check(exchange_rate_lyd>0),
 amount_lyd numeric(14,2) not null check(amount_lyd>0),
 finance_transaction_id uuid not null unique references public.financial_transactions(id) on delete restrict,
 client_submission_id uuid not null unique,
 request_payload jsonb not null,
 reference text,notes text,
 recorded_by uuid references auth.users(id) on delete set null,
 created_at timestamptz not null default now(),
 check(amount_lyd=round(original_amount*exchange_rate_lyd,2)),
 check(currency<>'LYD' or exchange_rate_lyd=1)
);
alter table public.investor_contributions enable row level security;
revoke all on public.investor_contributions from anon,authenticated;
grant select on public.investor_contributions to authenticated;
grant all on public.investor_contributions to service_role;
create policy investor_contributions_read on public.investor_contributions for select to authenticated using(
 public.snacky_current_profile_has_any_role(array['owner','admin']) or
 (public.snacky_current_profile_has_any_role(array['investor']) and exists(select 1 from public.investor_agreements a where a.id=agreement_id and a.investor_user_id=auth.uid()))
);

-- Finalized months are immutable; the application cannot silently rewrite an investor's entitlement.
create or replace function public.snacky_guard_investor_statement_v1()
returns trigger language plpgsql set search_path=public,pg_catalog as $$
begin
 if old.calculation_status='finalized' then raise exception 'Finalized investor statements cannot be changed or deleted'; end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
drop trigger if exists snacky_guard_investor_statement_v1 on public.investor_monthly_statements;
create trigger snacky_guard_investor_statement_v1 before update or delete on public.investor_monthly_statements for each row execute function public.snacky_guard_investor_statement_v1();

create or replace function public.snacky_finalize_investor_statement_v1(p_statement_id uuid,p_generated_at timestamptz,p_review_checks jsonb)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_catalog as $$
declare s public.investor_monthly_statements; a public.investor_agreements; v_agreement uuid; v_prior numeric;
begin
 if not public.snacky_current_profile_has_any_role(array['owner','admin']) then raise exception 'Only active owner/admin can finalize' using errcode='42501'; end if;
 select agreement_id into v_agreement from public.investor_monthly_statements where id=p_statement_id;
 select * into a from public.investor_agreements where id=v_agreement for update;
 select * into s from public.investor_monthly_statements where id=p_statement_id for update;
 if s.id is null then raise exception 'Statement not found'; end if;
 if s.calculation_status='finalized' then return to_jsonb(s); end if;
 if s.generated_at is distinct from p_generated_at then raise exception 'Draft changed. Reload and review it again'; end if;
 if not s.source_complete or not a.profit_basis_confirmed then raise exception 'Incomplete sources or unconfirmed profit basis'; end if;
 if s.month_start+interval '1 month' > (now() at time zone 'Africa/Tripoli')::date then raise exception 'Only a completed month can be finalized'; end if;
 if a.status<>'active' or s.month_start<a.start_date or (a.end_date is not null and (s.month_start+interval '1 month - 1 day')::date>a.end_date) then raise exception 'Month is outside the active agreement'; end if;
 if s.profit_basis is distinct from a.profit_basis or s.share_percent<>a.profit_share_percent then raise exception 'Agreement changed. Regenerate the draft'; end if;
 if coalesce(p_review_checks->>'sales','')<>'true' or coalesce(p_review_checks->>'rent_payroll','')<>'true' or coalesce(p_review_checks->>'expenses','')<>'true' or coalesce(p_review_checks->>'capital','')<>'true' then raise exception 'Review sales, rent/payroll, expenses and machine purchases before finalizing'; end if;
 select coalesce(sum(investor_share_due_lyd),0) into v_prior from public.investor_monthly_statements where agreement_id=a.id and calculation_status='finalized';
 if a.payout_cap_lyd is not null and v_prior+s.investor_share_due_lyd>a.payout_cap_lyd then raise exception 'Agreement payout cap changed. Regenerate this draft'; end if;
 update public.investor_monthly_statements set calculation_status='finalized',review_checks=p_review_checks,finalized_at=now(),updated_at=now() where id=s.id returning * into s;
 return to_jsonb(s);
end $$;
revoke all on function public.snacky_finalize_investor_statement_v1(uuid,timestamptz,jsonb) from public,anon;
grant execute on function public.snacky_finalize_investor_statement_v1(uuid,timestamptz,jsonb) to authenticated;

create or replace function public.snacky_record_investor_payment_v1(p_statement_id uuid,p_amount numeric,p_payment_date date,p_account_id text,p_method text,p_reference text,p_notes text,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_catalog as $$
declare s public.investor_monthly_statements; a public.investor_agreements; r public.investor_payments; v_actor uuid:=public.snacky_current_team_member_id(); v_agreement uuid; v_paid numeric; v_finance uuid; v_request jsonb;
begin
 if v_actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin']) then raise exception 'Only active owner/admin can record investor payouts' using errcode='42501'; end if;
 if p_command_id is null or p_amount is null or p_amount<=0 or p_amount>=10000000000 or p_amount<>round(p_amount,2) or p_payment_date is null or not isfinite(p_payment_date) or p_payment_date>(now() at time zone 'Africa/Tripoli')::date then raise exception 'Invalid payout amount, date or command'; end if;
 if p_account_id not in ('snacky_lyd','owner_lyd') or p_account_id is null or p_method not in ('cash','bank_transfer','card','other') or p_method is null then raise exception 'Choose a LYD account and payment method'; end if;
 v_request:=jsonb_build_object('statement',p_statement_id,'amount',p_amount,'date',p_payment_date,'account',p_account_id,'method',p_method,'reference',coalesce(p_reference,''),'notes',coalesce(p_notes,''),'actor',auth.uid());
 perform pg_advisory_xact_lock(hashtext('investor-money:'||p_command_id::text));
 select * into r from public.investor_payments where client_submission_id=p_command_id;
 if found then
  if r.request_payload is distinct from v_request then raise exception 'Payment request details changed; use the original request'; end if;
  return to_jsonb(r);
 end if;
 select agreement_id into v_agreement from public.investor_monthly_statements where id=p_statement_id;
 select * into a from public.investor_agreements where id=v_agreement for update;
 select * into s from public.investor_monthly_statements where id=p_statement_id for update;
 if s.id is null or s.calculation_status<>'finalized' then raise exception 'Only finalized monthly statements can be paid'; end if;
 if exists(select 1 from public.investor_payments where agreement_id=a.id and finance_posting_status<>'posted') then raise exception 'An older payout needs Finance review before another payout'; end if;
 select coalesce(sum(amount_lyd),0) into v_paid from public.investor_payments where statement_id=s.id;
 if p_amount>s.investor_share_due_lyd-v_paid then raise exception 'Payment exceeds the remaining monthly entitlement'; end if;
 insert into public.investor_payments(agreement_id,statement_id,payment_date,amount_lyd,payment_reference,notes,recorded_by,client_submission_id,request_payload,finance_posting_status)
 values(a.id,s.id,p_payment_date,p_amount,nullif(p_reference,''),nullif(p_notes,''),auth.uid(),p_command_id,v_request,'pending') returning * into r;
 insert into public.financial_transactions(transaction_date,transaction_datetime,direction,transaction_kind,transaction_type,description,notes,amount,signed_amount,currency,account_id,account_key,transaction_effect,category,bucket,final_bucket,payment_method,source_type,source_id,transaction_status,import_status,review_status,needs_review,is_void,created_by)
 values(p_payment_date,p_payment_date::timestamp at time zone 'Africa/Tripoli','money_out','manual_money_out','Investor Profit Share','Investor profit share: '||a.investor_name||' / '||to_char(s.month_start,'YYYY-MM'),nullif(p_notes,''),p_amount,-p_amount,'LYD',p_account_id,p_account_id,'expense','Investor Profit Share','Investor Profit Share','Investor Profit Share',p_method,'investor_payment',r.id,'active','confirmed','confirmed',false,false,v_actor) returning id into v_finance;
 update public.investor_payments set finance_transaction_id=v_finance,finance_posting_status='posted',finance_posting_error=null where id=r.id returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.snacky_record_investor_payment_v1(uuid,numeric,date,text,text,text,text,uuid) from public,anon;
grant execute on function public.snacky_record_investor_payment_v1(uuid,numeric,date,text,text,text,text,uuid) to authenticated;

create or replace function public.snacky_record_investor_contribution_v1(p_agreement_id uuid,p_amount numeric,p_currency text,p_rate numeric,p_received_date date,p_account_id text,p_reference text,p_notes text,p_existing_finance_id uuid,p_command_id uuid)
returns jsonb language plpgsql security definer set search_path=public,auth,pg_catalog as $$
declare a public.investor_agreements; r public.investor_contributions; f public.financial_transactions; v_actor uuid:=public.snacky_current_team_member_id(); v_finance uuid; v_id uuid:=gen_random_uuid(); v_request jsonb;
begin
 if v_actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin']) then raise exception 'Only active owner/admin can record investor capital' using errcode='42501'; end if;
 if p_command_id is null or p_amount is null or p_amount<=0 or p_amount>=10000000000 or p_amount<>round(p_amount,2) or p_rate is null or p_rate<=0 or p_rate>=1000000 or p_received_date is null or not isfinite(p_received_date) or p_received_date>(now() at time zone 'Africa/Tripoli')::date then raise exception 'Invalid capital amount, exchange rate, date or command'; end if;
 if p_currency not in ('LYD','USD') or p_currency is null or (p_currency='LYD' and p_rate<>1) or p_account_id is null or p_account_id not in ('snacky_lyd','snacky_usd','owner_lyd','owner_usd') or right(p_account_id,3)<>lower(p_currency) then raise exception 'Capital currency and receiving account must match'; end if;
 v_request:=jsonb_build_object('agreement',p_agreement_id,'amount',p_amount,'currency',p_currency,'rate',p_rate,'date',p_received_date,'account',p_account_id,'reference',coalesce(p_reference,''),'notes',coalesce(p_notes,''),'finance',p_existing_finance_id,'actor',auth.uid());
 perform pg_advisory_xact_lock(hashtext('investor-money:'||p_command_id::text));
 select * into r from public.investor_contributions where client_submission_id=p_command_id;
 if found then
  if r.request_payload is distinct from v_request then raise exception 'Capital request details changed; use the original request'; end if;
  return to_jsonb(r);
 end if;
 select * into a from public.investor_agreements where id=p_agreement_id for update;
 if a.id is null or a.status='cancelled' then raise exception 'Investor agreement not found or cancelled'; end if;
 if p_existing_finance_id is not null then
  select * into f from public.financial_transactions where id=p_existing_finance_id for update;
  if f.id is null or f.direction<>'money_in' or f.transaction_status<>'active' or coalesce(f.is_void,false) or f.voided_at is not null or f.needs_review or f.review_status not in ('confirmed','reviewed') or f.transaction_effect<>'income' or f.transaction_kind not in ('manual_money_in','spreadsheet_import') or f.source_type in ('cash_collection','purchase_payment','investor_payment') or f.amount<>p_amount or f.currency<>p_currency or f.account_id<>p_account_id or f.transaction_date<>p_received_date then raise exception 'The existing Finance receipt does not match a confirmed capital money-in'; end if;
  v_finance:=f.id;
 else
  insert into public.financial_transactions(transaction_date,transaction_datetime,direction,transaction_kind,transaction_type,description,notes,amount,signed_amount,currency,account_id,account_key,transaction_effect,category,bucket,final_bucket,payment_method,source_type,source_id,transaction_status,import_status,review_status,needs_review,is_void,created_by,exchange_rate_usd_to_lyd)
  values(p_received_date,p_received_date::timestamp at time zone 'Africa/Tripoli','money_in','manual_money_in','Investor Capital','Investor capital: '||a.investor_name,nullif(p_notes,''),p_amount,p_amount,p_currency,p_account_id,p_account_id,'income','Investor Capital','Investor Capital','Investor Capital','other','investor_contribution',v_id,'active','confirmed','confirmed',false,false,v_actor,case when p_currency='USD' then p_rate else null end) returning id into v_finance;
 end if;
 insert into public.investor_contributions(id,agreement_id,received_date,original_amount,currency,exchange_rate_lyd,amount_lyd,finance_transaction_id,client_submission_id,request_payload,reference,notes,recorded_by)
 values(v_id,a.id,p_received_date,p_amount,p_currency,p_rate,round(p_amount*p_rate,2),v_finance,p_command_id,v_request,nullif(p_reference,''),nullif(p_notes,''),auth.uid()) returning * into r;
 return to_jsonb(r);
end $$;
revoke all on function public.snacky_record_investor_contribution_v1(uuid,numeric,text,numeric,date,text,text,text,uuid,uuid) from public,anon;
grant execute on function public.snacky_record_investor_contribution_v1(uuid,numeric,text,numeric,date,text,text,text,uuid,uuid) to authenticated;
