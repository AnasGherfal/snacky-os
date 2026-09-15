-- Keep entitlements and actual money records independent and auditable.
create unique index if not exists investor_one_active_agreement_per_login on public.investor_agreements(investor_user_id) where status='active' and investor_user_id is not null;

create or replace function public.snacky_guard_investor_agreement_v1()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_due numeric;v_last date;
begin
 if tg_op='DELETE' then
  if exists(select 1 from public.investor_monthly_statements where agreement_id=old.id) or exists(select 1 from public.investor_payments where agreement_id=old.id) or exists(select 1 from public.investor_contributions where agreement_id=old.id) then raise exception 'Investor history exists. Complete or cancel the agreement instead of deleting it'; end if;
  return old;
 end if;
 select sum(investor_share_due_lyd),max(month_start) into v_due,v_last from public.investor_monthly_statements where agreement_id=old.id and calculation_status='finalized';
 if v_last is not null then
  if new.investor_user_id is distinct from old.investor_user_id or new.profit_share_percent is distinct from old.profit_share_percent or new.profit_basis is distinct from old.profit_basis or new.start_date is distinct from old.start_date or not new.profit_basis_confirmed then raise exception 'Finalized months exist: investor, percentage, profit basis and first month are locked'; end if;
  if new.end_date is not null and new.end_date<(v_last+interval '1 month - 1 day')::date then raise exception 'End date cannot exclude a finalized month'; end if;
  if new.payout_cap_lyd is not null and new.payout_cap_lyd<v_due then raise exception 'Payout cap cannot be less than finalized entitlement'; end if;
 end if;
 return new;
end $$;
revoke all on function public.snacky_guard_investor_agreement_v1() from public,anon,authenticated;
drop trigger if exists snacky_guard_investor_agreement_v1 on public.investor_agreements;
create trigger snacky_guard_investor_agreement_v1 before update or delete on public.investor_agreements for each row execute function public.snacky_guard_investor_agreement_v1();

-- Writes to actual investor money only through authorized atomic command RPCs.
revoke insert,update,delete on public.investor_payments from authenticated;

-- Prevent a generic Finance edit/void from breaking an immutable capital/payout receipt.
create or replace function public.snacky_guard_investor_finance_v1()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if exists(select 1 from public.investor_contributions c where c.finance_transaction_id=old.id) or exists(select 1 from public.investor_payments p where p.finance_transaction_id=old.id) then
  if tg_op='DELETE' then raise exception 'This Finance entry belongs to investor history. Use an explicit investor correction, not deletion'; end if;
  if new.amount is distinct from old.amount or new.signed_amount is distinct from old.signed_amount or new.currency is distinct from old.currency or new.account_id is distinct from old.account_id or new.transaction_status is distinct from old.transaction_status or new.is_void is distinct from old.is_void or new.voided_at is distinct from old.voided_at or new.transaction_date is distinct from old.transaction_date or new.transaction_effect is distinct from old.transaction_effect or new.source_type is distinct from old.source_type or new.source_id is distinct from old.source_id then raise exception 'Investor-linked money cannot be rewritten through a generic Finance edit'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.snacky_guard_investor_finance_v1() from public,anon,authenticated;
drop trigger if exists snacky_guard_investor_finance_v1 on public.financial_transactions;
create trigger snacky_guard_investor_finance_v1 before update or delete on public.financial_transactions for each row execute function public.snacky_guard_investor_finance_v1();
