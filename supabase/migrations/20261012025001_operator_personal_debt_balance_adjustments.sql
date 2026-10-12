-- Financial-only corrections. No products, physical quantities or stock movements.
create table public.operator_personal_debt_adjustments (
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references public.team_members(id),
 period_id uuid not null references public.operator_money_periods(id),
 kind text not null check(kind in ('opening_balance','waiver','correction','repayment')),
 amount_lyd numeric(12,2) not null check(amount_lyd <> 0 and amount_lyd <> 'NaN'::numeric),
 effective_date date not null,
 note text not null check(length(trim(note)) >= 5),
 reference text not null unique,
 payment_id uuid unique references public.operator_debt_payments(id),
 recorded_by uuid not null references public.team_members(id),
 created_at timestamptz not null default now(),
 check((kind='opening_balance' and amount_lyd>0 and payment_id is null)
    or (kind='waiver' and amount_lyd<0 and payment_id is null)
    or (kind='correction' and payment_id is null)
    or (kind='repayment' and amount_lyd<0 and payment_id is not null))
);
create index operator_personal_debt_adjustments_person_period on public.operator_personal_debt_adjustments(person_id,period_id);
alter table public.operator_personal_debt_adjustments enable row level security;
revoke all on public.operator_personal_debt_adjustments from public,anon,authenticated,service_role;
grant select on public.operator_personal_debt_adjustments to authenticated;
grant select,insert on public.operator_personal_debt_adjustments to service_role;
create policy operator_personal_debt_adjustments_read on public.operator_personal_debt_adjustments for select to authenticated using (public.snacky_operator_money_can_view(person_id));
create policy crm_raw_record_boundary on public.operator_personal_debt_adjustments as restrictive for all to authenticated using ((select not public.snacky_crm_is_limited())) with check ((select not public.snacky_crm_is_limited()));
comment on table public.operator_personal_debt_adjustments is 'Append-only financial balance corrections and waivers. Never product purchases, inventory movements, sales, payroll runs or cash receipts. Repayment rows allocate the balance portion of an existing debt payment.';
create function public.snacky_validate_personal_debt_adjustment() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $fn$
declare v_period public.operator_money_periods; v_payment public.operator_debt_payments;
begin
 if TG_OP <> 'INSERT' then raise exception 'Personal balance adjustments are append-only'; end if;
 select * into v_period from public.operator_money_periods where id=new.period_id for update;
 if not found or v_period.person_id<>new.person_id then raise exception 'Adjustment must belong to its money period'; end if;
 if v_period.settled_at is not null then raise exception 'Cannot adjust a settled money period'; end if;
 if new.payment_id is not null then
  select * into v_payment from public.operator_debt_payments where id=new.payment_id;
  if not found or v_payment.person_id<>new.person_id or v_payment.period_id<>new.period_id or -new.amount_lyd>v_payment.amount_lyd then raise exception 'Adjustment repayment does not match its payment'; end if;
 end if;
 return new;
end $fn$;
revoke all on function public.snacky_validate_personal_debt_adjustment() from public,anon,authenticated;
create trigger personal_debt_adjustment_guard before insert or update or delete on public.operator_personal_debt_adjustments for each row execute function public.snacky_validate_personal_debt_adjustment();

create or replace view public.operator_money_period_summary with(security_invoker=true) as
with purchases as (
 select period_id,count(*) as purchase_count,coalesce(sum(total_lyd),0)::numeric(12,2) as personal_purchases_lyd from public.operator_personal_purchases group by period_id
), debt_paid as (
 select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) as debt_paid_lyd from (
  select period_id,amount_lyd from public.operator_debt_payment_allocations
  union all select period_id,-amount_lyd from public.operator_personal_debt_adjustments where kind='repayment'
 ) d group by period_id
), adjustments as (
 select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) as adjustment_lyd from public.operator_personal_debt_adjustments where kind<>'repayment' group by period_id
), advances as (
 select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) as advanced_lyd from public.operator_advances group by period_id
), expenses as (
 select period_id,coalesce(sum(amount_lyd) filter(where status='approved'),0)::numeric(12,2) as approved_expenses_lyd,
 coalesce(sum(amount_lyd) filter(where status='approved' and advance_id is not null),0)::numeric(12,2) as advance_expenses_lyd,
 coalesce(sum(amount_lyd) filter(where status='approved' and advance_id is null),0)::numeric(12,2) as self_funded_expenses_lyd,
 count(*) filter(where status='submitted')::integer as pending_expense_count from public.operator_expenses group by period_id
), returns as (
 select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) as returned_money_lyd from public.operator_advance_returns group by period_id
), reimbursements as (
 select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) as reimbursed_lyd from public.operator_expense_reimbursement_allocations group by period_id
)
select p.id as period_id,p.person_id,tm.full_name,p.label,p.period_start,p.period_end,p.lifecycle_status,p.closed_at,p.closed_by,p.close_note,p.closing_snapshot,p.settled_at,p.settled_by,p.settlement_note,
 coalesce(pu.purchase_count,0)::integer as purchase_count,
 coalesce(pu.personal_purchases_lyd,0)::numeric(12,2) as personal_purchases_lyd,
 coalesce(dp.debt_paid_lyd,0)::numeric(12,2) as debt_paid_lyd,
 greatest(coalesce(pu.personal_purchases_lyd,0)+coalesce(aj.adjustment_lyd,0)-coalesce(dp.debt_paid_lyd,0),0)::numeric(12,2) as personal_debt_remaining_lyd,
 coalesce(ad.advanced_lyd,0)::numeric(12,2) as advanced_lyd,
 coalesce(ex.approved_expenses_lyd,0)::numeric(12,2) as approved_expenses_lyd,
 coalesce(ex.advance_expenses_lyd,0)::numeric(12,2) as advance_expenses_lyd,
 coalesce(ex.self_funded_expenses_lyd,0)::numeric(12,2) as self_funded_expenses_lyd,
 coalesce(rt.returned_money_lyd,0)::numeric(12,2) as returned_money_lyd,
 coalesce(rb.reimbursed_lyd,0)::numeric(12,2) as reimbursed_lyd,
 greatest(coalesce(ad.advanced_lyd,0)-coalesce(ex.advance_expenses_lyd,0)-coalesce(rt.returned_money_lyd,0),0)::numeric(12,2) as advance_due_to_snacky_lyd,
 greatest(coalesce(ex.self_funded_expenses_lyd,0)+greatest(coalesce(ex.advance_expenses_lyd,0)+coalesce(rt.returned_money_lyd,0)-coalesce(ad.advanced_lyd,0),0)-coalesce(rb.reimbursed_lyd,0),0)::numeric(12,2) as reimbursement_due_to_operator_lyd,
 coalesce(ex.pending_expense_count,0) as pending_expense_count,
 case when coalesce(ex.pending_expense_count,0)>0 then 'needs_review'
 when p.settled_at is not null then 'settled'
 when p.lifecycle_status='open' then 'open'
 when greatest(coalesce(pu.personal_purchases_lyd,0)+coalesce(aj.adjustment_lyd,0)-coalesce(dp.debt_paid_lyd,0),0)=0
 and greatest(coalesce(ad.advanced_lyd,0)-coalesce(ex.advance_expenses_lyd,0)-coalesce(rt.returned_money_lyd,0),0)=0
 and greatest(coalesce(ex.self_funded_expenses_lyd,0)+greatest(coalesce(ex.advance_expenses_lyd,0)+coalesce(rt.returned_money_lyd,0)-coalesce(ad.advanced_lyd,0),0)-coalesce(rb.reimbursed_lyd,0),0)=0 then 'ready_to_settle'
 when coalesce(dp.debt_paid_lyd,0)>0 or coalesce(rt.returned_money_lyd,0)>0 or coalesce(rb.reimbursed_lyd,0)>0 then 'partially_settled'
 else 'unsettled' end as settlement_state,
 coalesce(aj.adjustment_lyd,0)::numeric(12,2) as personal_debt_adjustments_lyd
from public.operator_money_periods p join public.team_members tm on tm.id=p.person_id
left join purchases pu on pu.period_id=p.id left join debt_paid dp on dp.period_id=p.id
left join adjustments aj on aj.period_id=p.id left join advances ad on ad.period_id=p.id
left join expenses ex on ex.period_id=p.id left join returns rt on rt.period_id=p.id left join reimbursements rb on rb.period_id=p.id;

create or replace function public.record_operator_debt_payment_for_period(p_person_id uuid,p_period_id uuid,p_amount numeric,p_paid_at timestamptz,p_payment_method text,p_note text,p_client_submission_id text)
returns public.operator_debt_payments language plpgsql security definer set search_path=public,auth as $fn$
declare
 a uuid:=public.snacky_current_team_member_id(); v_period public.operator_money_periods%rowtype;
 v_due numeric; v_left numeric; v_apply numeric; v_purchase record; v_balance numeric; row public.operator_debt_payments;
begin
 if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
 if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can record payment' using errcode='42501'; end if;
 select * into row from public.operator_debt_payments where client_submission_id=p_client_submission_id;
 if found then
  if row.person_id<>p_person_id or row.period_id<>p_period_id or row.amount_lyd<>p_amount then raise exception 'Payment key already belongs to a different request'; end if;
  return row;
 end if;
 select * into v_period from public.operator_money_periods where id=p_period_id and person_id=p_person_id for update;
 if not found then raise exception 'Money period not found' using errcode='P0002'; end if;
 if v_period.settled_at is not null then raise exception 'Money period is already settled' using errcode='23514'; end if;
 select personal_debt_remaining_lyd into v_due from public.operator_money_period_summary where period_id=p_period_id;
 if p_amount is null or p_amount<=0 or p_amount>greatest(coalesce(v_due,0),0) then raise exception 'Payment exceeds remaining period debt' using errcode='23514'; end if;
 insert into public.operator_debt_payments(person_id,period_id,amount_lyd,paid_at,payment_method,note,client_submission_id,recorded_by)
 values(p_person_id,p_period_id,p_amount,p_paid_at,p_payment_method,nullif(trim(coalesce(p_note,'')),''),p_client_submission_id,a) returning * into row;
 v_left:=p_amount;
 for v_purchase in
 select p.id,greatest(p.total_lyd-coalesce((select sum(x.amount_lyd) from public.operator_debt_payment_allocations x where x.purchase_id=p.id),0),0) as remaining
 from public.operator_personal_purchases p where p.period_id=p_period_id order by p.purchased_at,p.id for update of p
 loop
  exit when v_left<=0;
  if v_purchase.remaining>0 then
   v_apply:=least(v_left,v_purchase.remaining);
   insert into public.operator_debt_payment_allocations(person_id,period_id,payment_id,purchase_id,amount_lyd) values(p_person_id,p_period_id,row.id,v_purchase.id,v_apply);
   v_left:=v_left-v_apply;
  end if;
 end loop;
 if v_left>0 then
  select coalesce(sum(amount_lyd),0) into v_balance from public.operator_personal_debt_adjustments where period_id=p_period_id and person_id=p_person_id;
  if v_left>greatest(v_balance,0) then raise exception 'Could not allocate the full debt payment'; end if;
  insert into public.operator_personal_debt_adjustments(person_id,period_id,kind,amount_lyd,effective_date,note,reference,payment_id,recorded_by)
  values(p_person_id,p_period_id,'repayment',-v_left,v_period.period_end,'Repayment allocated to historical personal balance; see linked debt payment.','balance-repayment:'||p_client_submission_id,row.id,a);
  v_left:=0;
 end if;
 return row;
end $fn$;
revoke all on function public.record_operator_debt_payment_for_period(uuid,uuid,numeric,timestamptz,text,text,text) from public,anon;
grant execute on function public.record_operator_debt_payment_for_period(uuid,uuid,numeric,timestamptz,text,text,text) to authenticated,service_role;
notify pgrst,'reload schema';
