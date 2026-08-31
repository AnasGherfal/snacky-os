-- Real supplier-purchase settlement ledger.
-- Payment status becomes derived from append-only payment rows instead of a manual label.

create table public.purchase_payments (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete restrict,
  amount_lyd numeric(14,2) not null check(amount_lyd>0),
  paid_at timestamptz not null,
  payment_method text not null,
  account_id text not null default 'snacky_lyd',
  currency text not null default 'LYD' check(currency in ('LYD','USD')),
  reference text,
  note text,
  finance_transaction_id uuid references public.financial_transactions(id) on delete restrict,
  client_submission_id text not null unique,
  recorded_by uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references public.team_members(id) on delete set null,
  void_reason text
);
create index purchase_payments_purchase_date_idx
  on public.purchase_payments(purchase_order_id,paid_at desc) where voided_at is null;
create unique index purchase_payments_finance_transaction_uidx
  on public.purchase_payments(finance_transaction_id) where finance_transaction_id is not null;

create or replace view public.purchase_payment_summary
with(security_invoker=true) as
select
  po.id purchase_order_id,
  abs(coalesce(po.manual_total_lyd,nullif(po.total_amount,0),nullif(po.calculated_total_lyd,0),0))::numeric(14,2) total_amount_lyd,
  coalesce(sum(pp.amount_lyd) filter(where pp.voided_at is null),0)::numeric(14,2) paid_amount_lyd,
  greatest(
    abs(coalesce(po.manual_total_lyd,nullif(po.total_amount,0),nullif(po.calculated_total_lyd,0),0))
      -coalesce(sum(pp.amount_lyd) filter(where pp.voided_at is null),0),0
  )::numeric(14,2) remaining_amount_lyd,
  case
    when po.status in ('cancelled','voided') or po.payment_status='voided' then 'voided'
    when coalesce(sum(pp.amount_lyd) filter(where pp.voided_at is null),0)
      >=abs(coalesce(po.manual_total_lyd,nullif(po.total_amount,0),nullif(po.calculated_total_lyd,0),0))
      and abs(coalesce(po.manual_total_lyd,nullif(po.total_amount,0),nullif(po.calculated_total_lyd,0),0))>0 then 'paid'
    when coalesce(sum(pp.amount_lyd) filter(where pp.voided_at is null),0)>0 then 'partially_paid'
    else 'unpaid'
  end payment_status,
  max(pp.paid_at) filter(where pp.voided_at is null) last_paid_at,
  count(pp.id) filter(where pp.voided_at is null)::integer payment_count
from public.purchase_orders po
left join public.purchase_payments pp on pp.purchase_order_id=po.id
group by po.id;

-- Each historical paid purchase already has exactly one matching active finance row.
insert into public.purchase_payments(
  purchase_order_id,amount_lyd,paid_at,payment_method,account_id,currency,reference,note,
  finance_transaction_id,client_submission_id,recorded_by
)
select
  po.id,
  abs(coalesce(po.manual_total_lyd,nullif(po.total_amount,0),nullif(po.calculated_total_lyd,0),0))::numeric(14,2),
  coalesce(po.received_at,(po.order_date::timestamp at time zone 'Africa/Tripoli')),
  coalesce(nullif(trim(po.payment_method),''),'cash'),
  coalesce(nullif(trim(po.payment_account_id),''),'snacky_lyd'),
  coalesce(nullif(trim(po.currency),''),'LYD'),
  nullif(trim(po.receipt_number),''),
  'Historical paid purchase backfill',
  ft.id,
  'legacy-purchase-payment:'||po.id::text,
  coalesce(po.received_by,po.created_by)
from public.purchase_orders po
join lateral(
  select x.id
  from public.financial_transactions x
  where (x.linked_purchase_id=po.id or (x.source_type='purchase' and x.source_id=po.id))
    and coalesce(x.transaction_status,'active')='active' and coalesce(x.is_void,false)=false
  order by x.created_at,x.id limit 1
) ft on true
where po.payment_status='paid'
  and po.status not in ('cancelled','voided')
  and abs(coalesce(po.manual_total_lyd,nullif(po.total_amount,0),nullif(po.calculated_total_lyd,0),0))>0
on conflict(client_submission_id) do nothing;

-- Aggregate purchase-to-finance sync is replaced by one finance row per actual payment.
create or replace function public.finance_purchase_should_sync(p_purchase public.purchase_orders)
returns boolean language sql stable as $$ select false $$;

create or replace function public.sync_purchase_to_financial_transaction(p_purchase_id uuid)
returns uuid language sql stable security definer set search_path=public,auth as $$
  select pp.finance_transaction_id
  from public.purchase_payments pp
  where pp.purchase_order_id=p_purchase_id and pp.voided_at is null
  order by pp.paid_at desc,pp.id desc limit 1
$$;

create or replace function public.record_purchase_payment(
  p_purchase_order_id uuid,p_amount numeric,p_paid_at timestamptz,p_payment_method text,
  p_account_id text,p_reference text,p_note text,p_client_submission_id text
) returns public.purchase_payments
language plpgsql security definer set search_path=public,auth as $$
declare
  a uuid:=public.snacky_current_team_member_id();
  po public.purchase_orders%rowtype;
  row public.purchase_payments;
  v_total numeric; v_paid numeric; v_remaining numeric;
  v_supplier text; v_finance_id uuid; v_status text;
begin
  if a is null then raise exception 'Not authenticated' using errcode='28000'; end if;
  if not public.snacky_current_profile_has_any_role(array['owner','admin','finance']) then
    raise exception 'Only owner, admin, or finance can record supplier payments' using errcode='42501';
  end if;
  select * into row from public.purchase_payments where client_submission_id=p_client_submission_id;
  if found then return row; end if;

  select * into po from public.purchase_orders where id=p_purchase_order_id for update;
  if not found then raise exception 'Purchase not found' using errcode='P0002'; end if;
  if po.status<>'received' or po.payment_status='voided' then
    raise exception 'Only a received, non-void purchase can be paid' using errcode='23514';
  end if;

  v_total:=abs(coalesce(po.manual_total_lyd,nullif(po.total_amount,0),nullif(po.calculated_total_lyd,0),0));
  select coalesce(sum(amount_lyd),0) into v_paid
  from public.purchase_payments where purchase_order_id=po.id and voided_at is null;
  v_remaining:=greatest(v_total-v_paid,0);
  if p_amount is null or p_amount<=0 or p_amount>v_remaining then
    raise exception 'Payment exceeds the remaining supplier balance' using errcode='23514';
  end if;
  if coalesce(nullif(trim(p_account_id),''),'snacky_lyd') not in ('snacky_lyd','owner_lyd') then
    raise exception 'Supplier payments currently support LYD accounts only; record FX conversion separately before enabling USD'
      using errcode='23514';
  end if;

  insert into public.purchase_payments(
    purchase_order_id,amount_lyd,paid_at,payment_method,account_id,currency,reference,note,
    client_submission_id,recorded_by
  ) values(
    po.id,p_amount,p_paid_at,coalesce(nullif(trim(p_payment_method),''),po.payment_method),
    coalesce(nullif(trim(p_account_id),''),'snacky_lyd'),
    'LYD',
    nullif(trim(coalesce(p_reference,'')),''),nullif(trim(coalesce(p_note,'')),''),
    p_client_submission_id,a
  ) returning * into row;

  select nullif(trim(name),'') into v_supplier from public.suppliers where id=po.supplier_id;

  insert into public.financial_transactions(
    transaction_date,transaction_datetime,direction,transaction_kind,transaction_type,category,
    description,notes,amount,signed_amount,currency,account_id,account_key,transaction_effect,
    bucket,final_bucket,payment_method,receipt_url,import_status,transaction_status,
    review_status,needs_review,is_void,counterparty_text,paid_to_text,payee_text,
    source_type,source_id,created_by,updated_at
  ) values(
    (p_paid_at at time zone 'Africa/Tripoli')::date,p_paid_at,'money_out','product_purchase',
    'Products Restocking','Products Restocking',
    concat_ws(' - ','Supplier payment to '||coalesce(v_supplier,'supplier'),
      case when nullif(trim(po.receipt_number),'') is not null then 'Receipt '||po.receipt_number end),
    concat_ws(' / ',nullif(trim(coalesce(p_note,'')),''),
      'Purchase payment '||row.id::text),
    p_amount,-abs(p_amount),row.currency,row.account_id,row.account_id,'expense',
    'Inventory','Products Restocking',row.payment_method,po.receipt_url,'confirmed','active',
    'confirmed',false,false,v_supplier,v_supplier,v_supplier,
    'purchase_payment',row.id,a,now()
  ) returning id into v_finance_id;

  update public.purchase_payments set finance_transaction_id=v_finance_id where id=row.id
  returning * into row;

  v_status:=case when v_paid+p_amount>=v_total then 'paid' else 'partially_paid' end;
  update public.purchase_orders
  set payment_status=v_status,payment_method=row.payment_method,payment_account_id=row.account_id,updated_at=now()
  where id=po.id;

  return row;
end $$;

create or replace function public.void_purchase_payment_rows()
returns trigger language plpgsql security definer set search_path=public,auth as $$
begin
  if (new.status in ('cancelled','voided') or new.payment_status='voided')
    and not (old.status in ('cancelled','voided') or old.payment_status='voided') then
    update public.purchase_payments
    set voided_at=coalesce(voided_at,now()),voided_by=coalesce(new.voided_by,public.snacky_current_team_member_id()),
        void_reason=coalesce(void_reason,new.void_reason,'Source purchase was voided')
    where purchase_order_id=new.id and voided_at is null;
    update public.financial_transactions ft
    set transaction_status='voided',is_void=true,voided_at=coalesce(ft.voided_at,now()),
        voided_by=coalesce(new.voided_by,public.snacky_current_team_member_id()),
        void_reason=coalesce(ft.void_reason,new.void_reason,'Source purchase was voided'),updated_at=now()
    where ft.id in(select pp.finance_transaction_id from public.purchase_payments pp
      where pp.purchase_order_id=new.id and pp.finance_transaction_id is not null);
  end if;
  return new;
end $$;

drop trigger if exists trg_void_purchase_payment_rows on public.purchase_orders;
create trigger trg_void_purchase_payment_rows
after update of status,payment_status on public.purchase_orders
for each row execute function public.void_purchase_payment_rows();

alter table public.purchase_payments enable row level security;
create policy purchase_payments_read on public.purchase_payments for select to authenticated
using(public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing','finance']));

revoke all on public.purchase_payments from public,anon;
revoke insert,update,delete on public.purchase_payments from authenticated;
grant select on public.purchase_payments to authenticated;
revoke all on public.purchase_payment_summary from public,anon;
grant select on public.purchase_payment_summary to authenticated;

revoke all on function public.record_purchase_payment(uuid,numeric,timestamptz,text,text,text,text,text) from public,anon;
grant execute on function public.record_purchase_payment(uuid,numeric,timestamptz,text,text,text,text,text) to authenticated;
revoke all on function public.void_purchase_payment_rows() from public,anon,authenticated;
revoke all on function public.sync_purchase_to_financial_transaction(uuid) from public,anon;
grant execute on function public.sync_purchase_to_financial_transaction(uuid) to authenticated;

do $$
declare v_count integer; v_total numeric;
begin
  select count(*),coalesce(sum(amount_lyd),0) into v_count,v_total
  from public.purchase_payments where client_submission_id like 'legacy-purchase-payment:%' and voided_at is null;
  if v_count<>(select count(*) from public.purchase_orders where payment_status='paid' and status not in ('cancelled','voided')) then
    raise exception 'Historical supplier-payment backfill count mismatch';
  end if;
  if v_total<>(select coalesce(sum(abs(coalesce(manual_total_lyd,nullif(total_amount,0),nullif(calculated_total_lyd,0),0))),0)
    from public.purchase_orders where payment_status='paid' and status not in ('cancelled','voided')) then
    raise exception 'Historical supplier-payment backfill total mismatch';
  end if;
end $$;

notify pgrst,'reload schema';
