-- Add auditable monthly periods to the existing append-only operator-money ledger.
-- Closing a period locks new entries; settlement remains a separate verified state.

create table public.operator_money_periods (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.team_members(id) on delete restrict,
  label text not null,
  period_start date not null,
  period_end date not null,
  lifecycle_status text not null default 'open' check (lifecycle_status in ('open','closed')),
  closed_at timestamptz,
  closed_by uuid references public.team_members(id) on delete set null,
  close_note text,
  closing_snapshot jsonb,
  settled_at timestamptz,
  settled_by uuid references public.team_members(id) on delete set null,
  settlement_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint operator_money_period_dates_valid check (period_end >= period_start),
  constraint operator_money_period_person_dates_unique unique (person_id,period_start,period_end)
);

create unique index operator_money_periods_one_open_per_person_idx
  on public.operator_money_periods(person_id) where lifecycle_status='open';
create index operator_money_periods_person_start_idx
  on public.operator_money_periods(person_id,period_start desc);

alter table public.operator_personal_purchases add column period_id uuid references public.operator_money_periods(id) on delete restrict;
alter table public.operator_debt_payments add column period_id uuid references public.operator_money_periods(id) on delete restrict;
alter table public.operator_advances add column period_id uuid references public.operator_money_periods(id) on delete restrict;
alter table public.operator_expenses add column period_id uuid references public.operator_money_periods(id) on delete restrict;
alter table public.operator_advance_returns add column period_id uuid references public.operator_money_periods(id) on delete restrict;

create index operator_personal_purchases_period_date_idx on public.operator_personal_purchases(period_id,purchased_at desc);
create index operator_debt_payments_period_date_idx on public.operator_debt_payments(period_id,paid_at desc);
create index operator_advances_period_date_idx on public.operator_advances(period_id,given_at desc);
create index operator_expenses_period_date_idx on public.operator_expenses(period_id,spent_at desc);
create index operator_advance_returns_period_date_idx on public.operator_advance_returns(period_id,returned_at desc);

with event_months as (
  select person_id,date_trunc('month',purchased_at at time zone 'Africa/Tripoli')::date month_start from public.operator_personal_purchases
  union select person_id,date_trunc('month',paid_at at time zone 'Africa/Tripoli')::date from public.operator_debt_payments
  union select person_id,date_trunc('month',given_at at time zone 'Africa/Tripoli')::date from public.operator_advances
  union select person_id,date_trunc('month',spent_at at time zone 'Africa/Tripoli')::date from public.operator_expenses
  union select person_id,date_trunc('month',returned_at at time zone 'Africa/Tripoli')::date from public.operator_advance_returns
)
insert into public.operator_money_periods(person_id,label,period_start,period_end,lifecycle_status,closed_at,close_note)
select person_id,to_char(month_start,'FMMonth YYYY'),month_start,
  (month_start+interval '1 month - 1 day')::date,
  case when month_start=date_trunc('month',now() at time zone 'Africa/Tripoli')::date then 'open' else 'closed' end,
  case when month_start=date_trunc('month',now() at time zone 'Africa/Tripoli')::date then null
       else ((month_start+interval '1 month')::timestamp at time zone 'Africa/Tripoli') end,
  case when month_start=date_trunc('month',now() at time zone 'Africa/Tripoli')::date then null
       else 'Archived during period backfill' end
from event_months
on conflict(person_id,period_start,period_end) do nothing;

insert into public.operator_money_periods(person_id,label,period_start,period_end)
select tm.id,
  to_char(date_trunc('month',now() at time zone 'Africa/Tripoli')::date,'FMMonth YYYY'),
  date_trunc('month',now() at time zone 'Africa/Tripoli')::date,
  (date_trunc('month',now() at time zone 'Africa/Tripoli')::date+interval '1 month - 1 day')::date
from public.team_members tm
where tm.active=true
  and not exists(select 1 from public.operator_money_periods p where p.person_id=tm.id and p.lifecycle_status='open')
on conflict(person_id,period_start,period_end) do nothing;

update public.operator_personal_purchases e set period_id=p.id
from public.operator_money_periods p
where p.person_id=e.person_id and (e.purchased_at at time zone 'Africa/Tripoli')::date between p.period_start and p.period_end;
update public.operator_debt_payments e set period_id=p.id
from public.operator_money_periods p
where p.person_id=e.person_id and (e.paid_at at time zone 'Africa/Tripoli')::date between p.period_start and p.period_end;
update public.operator_advances e set period_id=p.id
from public.operator_money_periods p
where p.person_id=e.person_id and (e.given_at at time zone 'Africa/Tripoli')::date between p.period_start and p.period_end;
update public.operator_expenses e set period_id=p.id
from public.operator_money_periods p
where p.person_id=e.person_id and (e.spent_at at time zone 'Africa/Tripoli')::date between p.period_start and p.period_end;
update public.operator_advance_returns e set period_id=p.id
from public.operator_money_periods p
where p.person_id=e.person_id and (e.returned_at at time zone 'Africa/Tripoli')::date between p.period_start and p.period_end;

do $$
begin
  if exists(
    select 1 from public.operator_personal_purchases where period_id is null
    union all select 1 from public.operator_debt_payments where period_id is null
    union all select 1 from public.operator_advances where period_id is null
    union all select 1 from public.operator_expenses where period_id is null
    union all select 1 from public.operator_advance_returns where period_id is null
  ) then raise exception 'Operator-money period backfill left unassigned rows'; end if;
end $$;

alter table public.operator_personal_purchases alter column period_id set not null;
alter table public.operator_debt_payments alter column period_id set not null;
alter table public.operator_advances alter column period_id set not null;
alter table public.operator_expenses alter column period_id set not null;
alter table public.operator_advance_returns alter column period_id set not null;

create table public.operator_debt_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.team_members(id) on delete restrict,
  period_id uuid not null references public.operator_money_periods(id) on delete restrict,
  payment_id uuid not null references public.operator_debt_payments(id) on delete restrict,
  purchase_id uuid not null references public.operator_personal_purchases(id) on delete restrict,
  amount_lyd numeric(12,2) not null check(amount_lyd>0),
  created_at timestamptz not null default now(),
  unique(payment_id,purchase_id)
);
create index operator_debt_allocations_payment_idx on public.operator_debt_payment_allocations(payment_id);
create index operator_debt_allocations_purchase_idx on public.operator_debt_payment_allocations(purchase_id);
create index operator_debt_allocations_period_idx on public.operator_debt_payment_allocations(period_id);

create table public.operator_expense_reimbursements (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.team_members(id) on delete restrict,
  period_id uuid not null references public.operator_money_periods(id) on delete restrict,
  amount_lyd numeric(12,2) not null check(amount_lyd>0),
  paid_at timestamptz not null,
  payment_method text not null,
  note text,
  client_submission_id text not null unique,
  recorded_by uuid not null references public.team_members(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index operator_expense_reimbursements_period_date_idx
  on public.operator_expense_reimbursements(period_id,paid_at desc);

create table public.operator_money_period_events (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.operator_money_periods(id) on delete restrict,
  person_id uuid not null references public.team_members(id) on delete restrict,
  action text not null check(action in ('closed','settled','reopened')),
  note text,
  snapshot jsonb,
  acted_by uuid not null references public.team_members(id) on delete restrict,
  acted_at timestamptz not null default now()
);
create index operator_money_period_events_period_date_idx
  on public.operator_money_period_events(period_id,acted_at desc);

create table public.operator_personal_purchase_corrections (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.operator_personal_purchases(id) on delete restrict,
  person_id uuid not null references public.team_members(id) on delete restrict,
  period_id uuid not null references public.operator_money_periods(id) on delete restrict,
  old_unit_price_lyd numeric(12,2) not null,
  new_unit_price_lyd numeric(12,2) not null,
  reason text not null,
  correction_key text not null unique,
  corrected_by uuid references public.team_members(id) on delete set null,
  corrected_at timestamptz not null default now()
);
create index operator_purchase_corrections_purchase_idx
  on public.operator_personal_purchase_corrections(purchase_id,corrected_at desc);

create or replace view public.operator_personal_purchase_status
with(security_invoker=true) as
select p.id,p.person_id,p.period_id,p.product_id,pr.name product_name,p.storage_location_id,
  p.quantity,p.unit_price_lyd,p.total_lyd,p.note,p.inventory_movement_id,p.client_submission_id,
  p.created_by,p.purchased_at,p.created_at,
  coalesce(a.paid_amount_lyd,0)::numeric(12,2) paid_amount_lyd,
  greatest(p.total_lyd-coalesce(a.paid_amount_lyd,0),0)::numeric(12,2) remaining_amount_lyd,
  case when coalesce(a.paid_amount_lyd,0)>=p.total_lyd then 'paid'
       when coalesce(a.paid_amount_lyd,0)>0 then 'partially_paid' else 'unpaid' end payment_status,
  c.old_unit_price_lyd corrected_from_unit_price_lyd,c.reason correction_reason
from public.operator_personal_purchases p
join public.products pr on pr.id=p.product_id
left join lateral(
  select sum(x.amount_lyd) paid_amount_lyd
  from public.operator_debt_payment_allocations x where x.purchase_id=p.id
) a on true
left join lateral(
  select x.old_unit_price_lyd,x.reason
  from public.operator_personal_purchase_corrections x where x.purchase_id=p.id
  order by x.corrected_at desc,x.id desc limit 1
) c on true;

create or replace view public.operator_money_period_summary
with(security_invoker=true) as
with purchases as (
  select period_id,count(*) purchase_count,coalesce(sum(total_lyd),0)::numeric(12,2) personal_purchases_lyd
  from public.operator_personal_purchases group by period_id
), debt_paid as (
  select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) debt_paid_lyd
  from public.operator_debt_payment_allocations group by period_id
), advances as (
  select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) advanced_lyd
  from public.operator_advances group by period_id
), expenses as (
  select period_id,
    coalesce(sum(amount_lyd) filter(where status='approved'),0)::numeric(12,2) approved_expenses_lyd,
    coalesce(sum(amount_lyd) filter(where status='approved' and advance_id is not null),0)::numeric(12,2) advance_expenses_lyd,
    coalesce(sum(amount_lyd) filter(where status='approved' and advance_id is null),0)::numeric(12,2) self_funded_expenses_lyd,
    count(*) filter(where status='submitted')::integer pending_expense_count
  from public.operator_expenses group by period_id
), returns as (
  select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) returned_money_lyd
  from public.operator_advance_returns group by period_id
), reimbursements as (
  select period_id,coalesce(sum(amount_lyd),0)::numeric(12,2) reimbursed_lyd
  from public.operator_expense_reimbursements group by period_id
)
select p.id period_id,p.person_id,tm.full_name,p.label,p.period_start,p.period_end,
  p.lifecycle_status,p.closed_at,p.closed_by,p.close_note,p.closing_snapshot,
  p.settled_at,p.settled_by,p.settlement_note,
  coalesce(pu.purchase_count,0)::integer purchase_count,
  coalesce(pu.personal_purchases_lyd,0)::numeric(12,2) personal_purchases_lyd,
  coalesce(dp.debt_paid_lyd,0)::numeric(12,2) debt_paid_lyd,
  greatest(coalesce(pu.personal_purchases_lyd,0)-coalesce(dp.debt_paid_lyd,0),0)::numeric(12,2) personal_debt_remaining_lyd,
  coalesce(ad.advanced_lyd,0)::numeric(12,2) advanced_lyd,
  coalesce(ex.approved_expenses_lyd,0)::numeric(12,2) approved_expenses_lyd,
  coalesce(ex.advance_expenses_lyd,0)::numeric(12,2) advance_expenses_lyd,
  coalesce(ex.self_funded_expenses_lyd,0)::numeric(12,2) self_funded_expenses_lyd,
  coalesce(rt.returned_money_lyd,0)::numeric(12,2) returned_money_lyd,
  coalesce(rb.reimbursed_lyd,0)::numeric(12,2) reimbursed_lyd,
  greatest(coalesce(ad.advanced_lyd,0)-coalesce(ex.advance_expenses_lyd,0)-coalesce(rt.returned_money_lyd,0),0)::numeric(12,2) advance_due_to_snacky_lyd,
  greatest(coalesce(ex.self_funded_expenses_lyd,0)
    +greatest(coalesce(ex.advance_expenses_lyd,0)+coalesce(rt.returned_money_lyd,0)-coalesce(ad.advanced_lyd,0),0)
    -coalesce(rb.reimbursed_lyd,0),0)::numeric(12,2) reimbursement_due_to_operator_lyd,
  coalesce(ex.pending_expense_count,0)::integer pending_expense_count,
  case when coalesce(ex.pending_expense_count,0)>0 then 'needs_review'
       when p.settled_at is not null then 'settled'
       when p.lifecycle_status='open' then 'open'
       when greatest(coalesce(pu.personal_purchases_lyd,0)-coalesce(dp.debt_paid_lyd,0),0)=0
        and greatest(coalesce(ad.advanced_lyd,0)-coalesce(ex.advance_expenses_lyd,0)-coalesce(rt.returned_money_lyd,0),0)=0
        and greatest(coalesce(ex.self_funded_expenses_lyd,0)
          +greatest(coalesce(ex.advance_expenses_lyd,0)+coalesce(rt.returned_money_lyd,0)-coalesce(ad.advanced_lyd,0),0)
          -coalesce(rb.reimbursed_lyd,0),0)=0 then 'ready_to_settle'
       when coalesce(dp.debt_paid_lyd,0)>0 or coalesce(rt.returned_money_lyd,0)>0 or coalesce(rb.reimbursed_lyd,0)>0
         then 'partially_settled' else 'unsettled' end settlement_state
from public.operator_money_periods p
join public.team_members tm on tm.id=p.person_id
left join purchases pu on pu.period_id=p.id
left join debt_paid dp on dp.period_id=p.id
left join advances ad on ad.period_id=p.id
left join expenses ex on ex.period_id=p.id
left join returns rt on rt.period_id=p.id
left join reimbursements rb on rb.period_id=p.id;

create or replace view public.operator_money_balances
with(security_invoker=true) as
select tm.id person_id,tm.full_name,
  coalesce(sum(s.personal_purchases_lyd),0)::numeric(12,2) personal_purchases_lyd,
  coalesce(sum(s.debt_paid_lyd),0)::numeric(12,2) debt_paid_lyd,
  coalesce(sum(s.personal_debt_remaining_lyd),0)::numeric(12,2) personal_debt_remaining_lyd,
  coalesce(sum(s.advanced_lyd),0)::numeric(12,2) advanced_lyd,
  coalesce(sum(s.approved_expenses_lyd),0)::numeric(12,2) approved_expenses_lyd,
  coalesce(sum(s.returned_money_lyd),0)::numeric(12,2) returned_money_lyd,
  coalesce(sum(s.advance_due_to_snacky_lyd),0)::numeric(12,2) unaccounted_advance_lyd,
  coalesce(sum(s.reimbursed_lyd),0)::numeric(12,2) reimbursed_lyd,
  coalesce(sum(s.reimbursement_due_to_operator_lyd),0)::numeric(12,2) operator_reimbursement_due_lyd
from public.team_members tm
left join public.operator_money_period_summary s on s.person_id=tm.id
group by tm.id,tm.full_name;

create or replace function public.snacky_operator_money_period_for_timestamp(
  p_person_id uuid,p_at timestamptz,p_require_open boolean default true
) returns uuid language plpgsql security definer set search_path=public,auth as $$
declare
  v_date date := (coalesce(p_at,now()) at time zone 'Africa/Tripoli')::date;
  v_month_start date := date_trunc('month',coalesce(p_at,now()) at time zone 'Africa/Tripoli')::date;
  v_period public.operator_money_periods%rowtype;
begin
  select * into v_period from public.operator_money_periods
  where person_id=p_person_id and v_date between period_start and period_end
  order by period_start desc limit 1 for update;
  if not found then
    update public.operator_money_periods
    set lifecycle_status='closed',closed_at=coalesce(closed_at,now()),
        close_note=coalesce(close_note,'Automatically closed when the next month started'),updated_at=now()
    where person_id=p_person_id and lifecycle_status='open' and period_end<v_date;
    insert into public.operator_money_periods(person_id,label,period_start,period_end)
    values(p_person_id,to_char(v_month_start,'FMMonth YYYY'),v_month_start,(v_month_start+interval '1 month - 1 day')::date)
    on conflict(person_id,period_start,period_end) do update set updated_at=public.operator_money_periods.updated_at
    returning * into v_period;
  end if;
  if p_require_open and v_period.lifecycle_status<>'open' then
    raise exception 'This operator money period is closed' using errcode='23514';
  end if;
  return v_period.id;
end $$;

create or replace function public.create_operator_personal_purchase(
  p_person_id uuid,p_product_id uuid,p_storage_location_id uuid,p_quantity integer,
  p_unit_price_lyd numeric,p_note text,p_client_submission_id text
) returns public.operator_personal_purchases language plpgsql security definer set search_path=public,auth as $$
declare
  a uuid:=public.snacky_current_team_member_id(); m boolean:=public.snacky_operator_money_is_manager();
  q integer; reserved integer; price numeric; v_period_id uuid;
  row public.operator_personal_purchases; movement uuid;
begin
  if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not m and a<>p_person_id then raise exception 'Operators can only buy for themselves' using errcode='42501'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Quantity must be positive' using errcode='23514'; end if;
  select * into row from public.operator_personal_purchases where client_submission_id=p_client_submission_id;
  if found then return row; end if;
  select coalesce(current_selling_price_lyd,selling_price,0) into price
  from public.products where id=p_product_id and active=true;
  if not found then raise exception 'Product not found'; end if;
  if price<=0 then raise exception 'Product selling price is missing or invalid' using errcode='23514'; end if;
  v_period_id:=public.snacky_operator_money_period_for_timestamp(p_person_id,now(),true);
  select coalesce(quantity_on_hand,0)::integer into q from public.current_inventory_by_location
  where location_type='storage' and location_id=p_storage_location_id and product_id=p_product_id;
  reserved:=public.operator_money_reserved_qty(p_product_id);
  if greatest(coalesce(q,0)-reserved,0)<p_quantity then
    raise exception 'Not enough genuinely available storage stock after route reservations' using errcode='23514';
  end if;
  insert into public.inventory_movements(
    product_id,quantity,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    reason,idempotency_key,source_type,created_by,notes
  ) values(
    p_product_id,p_quantity,'storage',p_storage_location_id,'operator_personal_purchase',p_person_id,
    'operator_personal_purchase',p_client_submission_id,'operator_personal_purchase',a,
    coalesce(p_note,'Operator personal purchase')
  ) returning id into movement;
  insert into public.operator_personal_purchases(
    person_id,period_id,product_id,storage_location_id,quantity,unit_price_lyd,note,
    inventory_movement_id,client_submission_id,created_by
  ) values(
    p_person_id,v_period_id,p_product_id,p_storage_location_id,p_quantity,price,
    nullif(trim(coalesce(p_note,'')),''),movement,p_client_submission_id,a
  ) returning * into row;
  return row;
end $$;

create or replace function public.create_operator_advance(
  p_person_id uuid,p_amount numeric,p_given_at timestamptz,p_purpose text,p_note text,p_client_submission_id text
) returns public.operator_advances language plpgsql security definer set search_path=public,auth as $$
declare a uuid:=public.snacky_current_team_member_id(); v_period_id uuid; row public.operator_advances;
begin
  if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can give money' using errcode='42501'; end if;
  select * into row from public.operator_advances where client_submission_id=p_client_submission_id;
  if found then return row; end if;
  if p_amount<=0 then raise exception 'Amount must be positive' using errcode='23514'; end if;
  v_period_id:=public.snacky_operator_money_period_for_timestamp(p_person_id,p_given_at,true);
  insert into public.operator_advances(person_id,period_id,amount_lyd,given_at,purpose,note,client_submission_id,issued_by)
  values(p_person_id,v_period_id,p_amount,p_given_at,p_purpose,nullif(trim(coalesce(p_note,'')),''),p_client_submission_id,a)
  returning * into row;
  return row;
end $$;

create or replace function public.submit_operator_expense(
  p_person_id uuid,p_advance_id uuid,p_amount numeric,p_expense_type text,p_supplier_payee text,
  p_spent_at timestamptz,p_receipt_url text,p_note text,p_client_submission_id text
) returns public.operator_expenses language plpgsql security definer set search_path=public,auth as $$
declare a uuid:=public.snacky_current_team_member_id(); v_period_id uuid; row public.operator_expenses;
begin
  if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not public.snacky_operator_money_is_manager() and a<>p_person_id then
    raise exception 'Operators can only submit their own expense' using errcode='42501';
  end if;
  select * into row from public.operator_expenses where client_submission_id=p_client_submission_id;
  if found then return row; end if;
  if p_amount<=0 then raise exception 'Amount must be positive' using errcode='23514'; end if;
  v_period_id:=public.snacky_operator_money_period_for_timestamp(p_person_id,p_spent_at,true);
  if p_advance_id is not null and not exists(
    select 1 from public.operator_advances x
    where x.id=p_advance_id and x.person_id=p_person_id and x.period_id=v_period_id
  ) then raise exception 'Advance does not belong to this person and period' using errcode='23514'; end if;
  insert into public.operator_expenses(
    person_id,period_id,advance_id,amount_lyd,expense_type,supplier_payee,spent_at,
    receipt_url,note,client_submission_id,submitted_by
  ) values(
    p_person_id,v_period_id,p_advance_id,p_amount,p_expense_type,p_supplier_payee,p_spent_at,
    nullif(trim(coalesce(p_receipt_url,'')),''),p_note,p_client_submission_id,a
  ) returning * into row;
  return row;
end $$;

create or replace function public.record_operator_debt_payment_for_period(
  p_person_id uuid,p_period_id uuid,p_amount numeric,p_paid_at timestamptz,
  p_payment_method text,p_note text,p_client_submission_id text
) returns public.operator_debt_payments language plpgsql security definer set search_path=public,auth as $$
declare
  a uuid:=public.snacky_current_team_member_id(); v_period public.operator_money_periods%rowtype;
  v_due numeric; v_left numeric; v_apply numeric; v_purchase record; row public.operator_debt_payments;
begin
  if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can record payment' using errcode='42501'; end if;
  select * into row from public.operator_debt_payments where client_submission_id=p_client_submission_id;
  if found then return row; end if;
  select * into v_period from public.operator_money_periods
  where id=p_period_id and person_id=p_person_id for update;
  if not found then raise exception 'Money period not found' using errcode='P0002'; end if;
  if v_period.settled_at is not null then raise exception 'Money period is already settled' using errcode='23514'; end if;
  select personal_debt_remaining_lyd into v_due
  from public.operator_money_period_summary where period_id=p_period_id;
  if p_amount<=0 or p_amount>greatest(coalesce(v_due,0),0) then
    raise exception 'Payment exceeds remaining period debt' using errcode='23514';
  end if;
  insert into public.operator_debt_payments(
    person_id,period_id,amount_lyd,paid_at,payment_method,note,client_submission_id,recorded_by
  ) values(
    p_person_id,p_period_id,p_amount,p_paid_at,p_payment_method,
    nullif(trim(coalesce(p_note,'')),''),p_client_submission_id,a
  ) returning * into row;
  v_left:=p_amount;
  for v_purchase in
    select p.id,greatest(p.total_lyd-coalesce((
      select sum(x.amount_lyd) from public.operator_debt_payment_allocations x where x.purchase_id=p.id
    ),0),0) remaining
    from public.operator_personal_purchases p where p.period_id=p_period_id
    order by p.purchased_at,p.id for update of p
  loop
    exit when v_left<=0;
    if v_purchase.remaining>0 then
      v_apply:=least(v_left,v_purchase.remaining);
      insert into public.operator_debt_payment_allocations(person_id,period_id,payment_id,purchase_id,amount_lyd)
      values(p_person_id,p_period_id,row.id,v_purchase.id,v_apply);
      v_left:=v_left-v_apply;
    end if;
  end loop;
  if v_left<>0 then raise exception 'Could not allocate the full debt payment'; end if;
  return row;
end $$;

create or replace function public.record_operator_debt_payment(
  p_person_id uuid,p_amount numeric,p_paid_at timestamptz,p_payment_method text,p_note text,p_client_submission_id text
) returns public.operator_debt_payments language plpgsql security definer set search_path=public,auth as $$
declare v_period_id uuid;
begin
  select period_id into v_period_id from public.operator_money_period_summary
  where person_id=p_person_id and personal_debt_remaining_lyd>0 and settled_at is null
  order by period_start,period_id limit 1;
  if v_period_id is null then raise exception 'No unsettled personal debt exists' using errcode='23514'; end if;
  return public.record_operator_debt_payment_for_period(
    p_person_id,v_period_id,p_amount,p_paid_at,p_payment_method,p_note,p_client_submission_id
  );
end $$;

create or replace function public.record_operator_advance_return_for_period(
  p_person_id uuid,p_period_id uuid,p_advance_id uuid,p_amount numeric,p_returned_at timestamptz,
  p_payment_method text,p_note text,p_client_submission_id text
) returns public.operator_advance_returns language plpgsql security definer set search_path=public,auth as $$
declare a uuid:=public.snacky_current_team_member_id(); v_due numeric; row public.operator_advance_returns;
begin
  if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can record returned money' using errcode='42501'; end if;
  select * into row from public.operator_advance_returns where client_submission_id=p_client_submission_id;
  if found then return row; end if;
  perform 1 from public.operator_money_periods
  where id=p_period_id and person_id=p_person_id and settled_at is null for update;
  if not found then raise exception 'Money period not found or already settled' using errcode='P0002'; end if;
  select advance_due_to_snacky_lyd into v_due from public.operator_money_period_summary where period_id=p_period_id;
  if p_amount<=0 or p_amount>greatest(coalesce(v_due,0),0) then
    raise exception 'Return exceeds unaccounted advance for this period' using errcode='23514';
  end if;
  if p_advance_id is not null and not exists(
    select 1 from public.operator_advances x where x.id=p_advance_id and x.period_id=p_period_id
  ) then raise exception 'Advance does not belong to this period' using errcode='23514'; end if;
  insert into public.operator_advance_returns(
    person_id,period_id,advance_id,amount_lyd,returned_at,payment_method,note,client_submission_id,recorded_by
  ) values(
    p_person_id,p_period_id,p_advance_id,p_amount,p_returned_at,p_payment_method,
    nullif(trim(coalesce(p_note,'')),''),p_client_submission_id,a
  ) returning * into row;
  return row;
end $$;

create or replace function public.record_operator_advance_return(
  p_person_id uuid,p_advance_id uuid,p_amount numeric,p_returned_at timestamptz,
  p_payment_method text,p_note text,p_client_submission_id text
) returns public.operator_advance_returns language plpgsql security definer set search_path=public,auth as $$
declare v_period_id uuid;
begin
  if p_advance_id is not null then
    select period_id into v_period_id from public.operator_advances
    where id=p_advance_id and person_id=p_person_id;
  end if;
  if v_period_id is null then
    select period_id into v_period_id from public.operator_money_period_summary
    where person_id=p_person_id and advance_due_to_snacky_lyd>0 and settled_at is null
    order by period_start,period_id limit 1;
  end if;
  if v_period_id is null then raise exception 'No unaccounted advance exists' using errcode='23514'; end if;
  return public.record_operator_advance_return_for_period(
    p_person_id,v_period_id,p_advance_id,p_amount,p_returned_at,p_payment_method,p_note,p_client_submission_id
  );
end $$;

create or replace function public.record_operator_expense_reimbursement(
  p_person_id uuid,p_period_id uuid,p_amount numeric,p_paid_at timestamptz,
  p_payment_method text,p_note text,p_client_submission_id text
) returns public.operator_expense_reimbursements language plpgsql security definer set search_path=public,auth as $$
declare a uuid:=public.snacky_current_team_member_id(); v_due numeric; row public.operator_expense_reimbursements;
begin
  if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can record reimbursement' using errcode='42501'; end if;
  select * into row from public.operator_expense_reimbursements where client_submission_id=p_client_submission_id;
  if found then return row; end if;
  perform 1 from public.operator_money_periods
  where id=p_period_id and person_id=p_person_id and settled_at is null for update;
  if not found then raise exception 'Money period not found or already settled' using errcode='P0002'; end if;
  select reimbursement_due_to_operator_lyd into v_due
  from public.operator_money_period_summary where period_id=p_period_id;
  if p_amount<=0 or p_amount>greatest(coalesce(v_due,0),0) then
    raise exception 'Reimbursement exceeds the amount Snacky owes for this period' using errcode='23514';
  end if;
  insert into public.operator_expense_reimbursements(
    person_id,period_id,amount_lyd,paid_at,payment_method,note,client_submission_id,recorded_by
  ) values(
    p_person_id,p_period_id,p_amount,p_paid_at,p_payment_method,
    nullif(trim(coalesce(p_note,'')),''),p_client_submission_id,a
  ) returning * into row;
  return row;
end $$;

create or replace function public.close_operator_money_period(p_period_id uuid,p_note text)
returns public.operator_money_periods language plpgsql security definer set search_path=public,auth as $$
declare a uuid:=public.snacky_current_team_member_id(); v_snapshot jsonb; row public.operator_money_periods;
begin
  if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can close a money period' using errcode='42501'; end if;
  select * into row from public.operator_money_periods where id=p_period_id for update;
  if not found then raise exception 'Money period not found' using errcode='P0002'; end if;
  if row.lifecycle_status<>'open' then raise exception 'Money period is already closed' using errcode='23514'; end if;
  if exists(select 1 from public.operator_expenses where period_id=p_period_id and status='submitted') then
    raise exception 'Review submitted expenses before closing this period' using errcode='23514';
  end if;
  select to_jsonb(s) into v_snapshot from public.operator_money_period_summary s where s.period_id=p_period_id;
  update public.operator_money_periods
  set lifecycle_status='closed',closed_at=now(),closed_by=a,
      close_note=nullif(trim(coalesce(p_note,'')),''),closing_snapshot=v_snapshot,updated_at=now()
  where id=p_period_id returning * into row;
  insert into public.operator_money_period_events(period_id,person_id,action,note,snapshot,acted_by)
  values(row.id,row.person_id,'closed',row.close_note,v_snapshot,a);
  return row;
end $$;

create or replace function public.settle_operator_money_period(p_period_id uuid,p_note text)
returns public.operator_money_periods language plpgsql security definer set search_path=public,auth as $$
declare a uuid:=public.snacky_current_team_member_id(); s record; row public.operator_money_periods;
begin
  if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can settle a money period' using errcode='42501'; end if;
  select * into row from public.operator_money_periods where id=p_period_id for update;
  if not found then raise exception 'Money period not found' using errcode='P0002'; end if;
  if row.lifecycle_status<>'closed' then raise exception 'Close the period before settling it' using errcode='23514'; end if;
  if row.settled_at is not null then return row; end if;
  select * into s from public.operator_money_period_summary where period_id=p_period_id;
  if s.pending_expense_count>0 or s.personal_debt_remaining_lyd>0
    or s.advance_due_to_snacky_lyd>0 or s.reimbursement_due_to_operator_lyd>0 then
    raise exception 'The period still has money or expense review outstanding' using errcode='23514';
  end if;
  update public.operator_money_periods
  set settled_at=now(),settled_by=a,settlement_note=nullif(trim(coalesce(p_note,'')),''),updated_at=now()
  where id=p_period_id returning * into row;
  insert into public.operator_money_period_events(period_id,person_id,action,note,snapshot,acted_by)
  values(row.id,row.person_id,'settled',row.settlement_note,to_jsonb(s),a);
  return row;
end $$;

create or replace function public.reopen_operator_money_period(p_period_id uuid,p_reason text)
returns public.operator_money_periods language plpgsql security definer set search_path=public,auth as $$
declare a uuid:=public.snacky_current_team_member_id(); row public.operator_money_periods;
begin
  if not public.snacky_operator_money_is_manager() then raise exception 'Only owner/admin can reopen a money period' using errcode='42501'; end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'A reopen reason is required' using errcode='23514'; end if;
  select * into row from public.operator_money_periods where id=p_period_id for update;
  if not found then raise exception 'Money period not found' using errcode='P0002'; end if;
  if row.lifecycle_status<>'closed' then raise exception 'Money period is already open' using errcode='23514'; end if;
  if exists(select 1 from public.operator_money_periods x
    where x.person_id=row.person_id and x.lifecycle_status='open' and x.id<>row.id) then
    raise exception 'Close the current open period before reopening this one' using errcode='23514';
  end if;
  update public.operator_money_periods
  set lifecycle_status='open',settled_at=null,settled_by=null,settlement_note=null,updated_at=now()
  where id=p_period_id returning * into row;
  insert into public.operator_money_period_events(period_id,person_id,action,note,acted_by)
  values(row.id,row.person_id,'reopened',trim(p_reason),a);
  return row;
end $$;

alter table public.operator_money_periods enable row level security;
alter table public.operator_debt_payment_allocations enable row level security;
alter table public.operator_expense_reimbursements enable row level security;
alter table public.operator_money_period_events enable row level security;
alter table public.operator_personal_purchase_corrections enable row level security;

create policy operator_money_periods_read on public.operator_money_periods for select to authenticated
  using(public.snacky_operator_money_can_view(person_id));
create policy operator_debt_payment_allocations_read on public.operator_debt_payment_allocations for select to authenticated
  using(public.snacky_operator_money_can_view(person_id));
create policy operator_expense_reimbursements_read on public.operator_expense_reimbursements for select to authenticated
  using(public.snacky_operator_money_can_view(person_id));
create policy operator_money_period_events_read on public.operator_money_period_events for select to authenticated
  using(public.snacky_operator_money_can_view(person_id));
create policy operator_personal_purchase_corrections_read on public.operator_personal_purchase_corrections for select to authenticated
  using(public.snacky_operator_money_can_view(person_id));

revoke all on public.operator_money_periods,public.operator_debt_payment_allocations,
  public.operator_expense_reimbursements,public.operator_money_period_events,
  public.operator_personal_purchase_corrections from public,anon;
revoke insert,update,delete on public.operator_money_periods,public.operator_debt_payment_allocations,
  public.operator_expense_reimbursements,public.operator_money_period_events,
  public.operator_personal_purchase_corrections from authenticated;
grant select on public.operator_money_periods,public.operator_debt_payment_allocations,
  public.operator_expense_reimbursements,public.operator_money_period_events,
  public.operator_personal_purchase_corrections to authenticated;

revoke all on public.operator_personal_purchases,public.operator_debt_payments,
  public.operator_advances,public.operator_expenses,public.operator_advance_returns from anon;
revoke insert,update,delete on public.operator_personal_purchases,public.operator_debt_payments,
  public.operator_advances,public.operator_expenses,public.operator_advance_returns from authenticated;
grant select on public.operator_personal_purchases,public.operator_debt_payments,
  public.operator_advances,public.operator_expenses,public.operator_advance_returns to authenticated;

revoke all on public.operator_personal_purchase_status,public.operator_money_period_summary,
  public.operator_money_balances from public,anon;
grant select on public.operator_personal_purchase_status,public.operator_money_period_summary,
  public.operator_money_balances to authenticated;

revoke all on function public.snacky_operator_money_period_for_timestamp(uuid,timestamptz,boolean) from public,anon,authenticated;
revoke all on function public.create_operator_personal_purchase(uuid,uuid,uuid,integer,numeric,text,text) from public,anon;
revoke all on function public.create_operator_advance(uuid,numeric,timestamptz,text,text,text) from public,anon;
revoke all on function public.submit_operator_expense(uuid,uuid,numeric,text,text,timestamptz,text,text,text) from public,anon;
revoke all on function public.record_operator_debt_payment_for_period(uuid,uuid,numeric,timestamptz,text,text,text) from public,anon;
revoke all on function public.record_operator_debt_payment(uuid,numeric,timestamptz,text,text,text) from public,anon;
revoke all on function public.record_operator_advance_return_for_period(uuid,uuid,uuid,numeric,timestamptz,text,text,text) from public,anon;
revoke all on function public.record_operator_advance_return(uuid,uuid,numeric,timestamptz,text,text,text) from public,anon;
revoke all on function public.record_operator_expense_reimbursement(uuid,uuid,numeric,timestamptz,text,text,text) from public,anon;
revoke all on function public.close_operator_money_period(uuid,text) from public,anon;
revoke all on function public.settle_operator_money_period(uuid,text) from public,anon;
revoke all on function public.reopen_operator_money_period(uuid,text) from public,anon;

grant execute on function public.create_operator_personal_purchase(uuid,uuid,uuid,integer,numeric,text,text) to authenticated;
grant execute on function public.create_operator_advance(uuid,numeric,timestamptz,text,text,text) to authenticated;
grant execute on function public.submit_operator_expense(uuid,uuid,numeric,text,text,timestamptz,text,text,text) to authenticated;
grant execute on function public.record_operator_debt_payment_for_period(uuid,uuid,numeric,timestamptz,text,text,text) to authenticated;
grant execute on function public.record_operator_debt_payment(uuid,numeric,timestamptz,text,text,text) to authenticated;
grant execute on function public.record_operator_advance_return_for_period(uuid,uuid,uuid,numeric,timestamptz,text,text,text) to authenticated;
grant execute on function public.record_operator_advance_return(uuid,uuid,numeric,timestamptz,text,text,text) to authenticated;
grant execute on function public.record_operator_expense_reimbursement(uuid,uuid,numeric,timestamptz,text,text,text) to authenticated;
grant execute on function public.close_operator_money_period(uuid,text) to authenticated;
grant execute on function public.settle_operator_money_period(uuid,text) to authenticated;
grant execute on function public.reopen_operator_money_period(uuid,text) to authenticated;

notify pgrst,'reload schema';
