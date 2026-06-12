-- Finance transaction ledger repair: purchases and cash collections must own one source-linked row.

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists account_key text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists category text,
  add column if not exists direction text,
  add column if not exists location text,
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists payment_method text,
  add column if not exists receipt_url text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists currency text default 'LYD',
  add column if not exists notes text,
  add column if not exists is_void boolean default false,
  add column if not exists void_reason text,
  add column if not exists transaction_status text default 'active';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_fkey'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_fkey
      foreign key (linked_purchase_id) references public.purchase_orders(id) on delete set null;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'financial_transactions_linked_cash_collection_id_fkey'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_cash_collection_id_fkey
      foreign key (linked_cash_collection_id) references public.cash_collections(id) on delete set null;
  end if;
exception
  when duplicate_object then null;
end $$;

update public.financial_transactions
set
  linked_purchase_id = coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end),
  related_purchase_id = coalesce(related_purchase_id, linked_purchase_id, case when source_type = 'purchase' then source_id end),
  source_type = 'purchase',
  source_id = coalesce(source_id, related_purchase_id, linked_purchase_id),
  direction = 'money_out',
  transaction_kind = 'product_purchase',
  transaction_type = 'Products Restocking',
  category = 'Products Restocking',
  final_bucket = coalesce(nullif(trim(final_bucket), ''), 'Products Restocking'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), 'snacky_lyd'),
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), 'active'),
  is_void = coalesce(is_void, false),
  updated_at = now()
where transaction_kind = 'product_purchase'
  and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null;

update public.financial_transactions
set
  linked_cash_collection_id = coalesce(linked_cash_collection_id, related_cash_collection_id, case when source_type = 'cash_collection' then source_id end),
  related_cash_collection_id = coalesce(related_cash_collection_id, linked_cash_collection_id, case when source_type = 'cash_collection' then source_id end),
  source_type = 'cash_collection',
  source_id = coalesce(source_id, related_cash_collection_id, linked_cash_collection_id),
  direction = 'money_in',
  transaction_kind = 'cash_collection',
  transaction_type = 'Revenue',
  category = 'Revenue',
  final_bucket = coalesce(nullif(trim(final_bucket), ''), 'Revenue'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), 'snacky_lyd'),
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), 'active'),
  is_void = coalesce(is_void, false),
  updated_at = now()
where transaction_kind = 'cash_collection'
  and coalesce(linked_cash_collection_id, related_cash_collection_id, case when source_type = 'cash_collection' then source_id end) is not null;

with linked as (
  select id, linked_purchase_id as source_id,
    row_number() over (partition by linked_purchase_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_purchase_id is not null
), duplicates as (
  select * from linked where rn > 1
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
    status_reason = coalesce(ft.status_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
    linked_purchase_id = null,
    source_type = case when ft.source_type = 'purchase' then null else ft.source_type end,
    source_id = case when ft.source_type = 'purchase' then null else ft.source_id end,
    updated_at = now()
from duplicates d
where ft.id = d.id;

with linked as (
  select id, linked_cash_collection_id as source_id,
    row_number() over (partition by linked_cash_collection_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where linked_cash_collection_id is not null
), duplicates as (
  select * from linked where rn > 1
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance transaction superseded by the linked transaction.'),
    status_reason = coalesce(ft.status_reason, 'Duplicate cash collection finance transaction superseded by the linked transaction.'),
    linked_cash_collection_id = null,
    source_type = case when ft.source_type = 'cash_collection' then null else ft.source_type end,
    source_id = case when ft.source_type = 'cash_collection' then null else ft.source_id end,
    updated_at = now()
from duplicates d
where ft.id = d.id;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_purchase_id_key' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions add constraint financial_transactions_linked_purchase_id_key unique (linked_purchase_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_cash_collection_id_key' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions add constraint financial_transactions_linked_cash_collection_id_key unique (linked_cash_collection_id);
  end if;
exception
  when duplicate_object then null;
end $$;

with linked as (
  select id, source_type, source_id,
    row_number() over (partition by source_type, source_id order by case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end, created_at, id) as rn
  from public.financial_transactions
  where source_type is not null and source_id is not null
), duplicates as (
  select * from linked where rn > 1
)
update public.financial_transactions ft
set transaction_status = 'voided',
    is_void = true,
    voided_at = coalesce(ft.voided_at, now()),
    void_reason = coalesce(ft.void_reason, 'Duplicate source finance transaction superseded by the linked transaction.'),
    status_reason = coalesce(ft.status_reason, 'Duplicate source finance transaction superseded by the linked transaction.'),
    source_type = null,
    source_id = null,
    linked_purchase_id = case when ft.source_type = 'purchase' then null else ft.linked_purchase_id end,
    linked_cash_collection_id = case when ft.source_type = 'cash_collection' then null else ft.linked_cash_collection_id end,
    updated_at = now()
from duplicates d
where ft.id = d.id;

create unique index if not exists idx_financial_transactions_source_type_source_id
  on public.financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;

insert into public.finance_categories (name, type, is_active)
values ('Products Restocking', 'expense', true), ('Revenue', 'income', true)
on conflict (name) do update set type = excluded.type, is_active = true;

drop function if exists public.backfill_missing_finance_transactions();

create or replace function public.backfill_missing_finance_transactions()
returns table (
  purchases_checked integer,
  purchase_transactions_created integer,
  cash_collections_checked integer,
  cash_collection_transactions_created integer,
  skipped_existing integer,
  errors jsonb
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_cash record;
  v_existing_id uuid;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_description text;
  v_purchases_checked integer := 0;
  v_purchase_created integer := 0;
  v_cash_checked integer := 0;
  v_cash_created integer := 0;
  v_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  for v_purchase in
    select po.*, s.name as supplier_name
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    where po.payment_status = 'paid'
      and coalesce(po.status, '') <> 'voided'
  loop
    v_purchases_checked := v_purchases_checked + 1;
    begin
      v_amount := abs(coalesce(v_purchase.manual_total_lyd, v_purchase.total_amount, v_purchase.calculated_total_lyd, 0));
      if v_amount <= 0 then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
      v_currency := case when v_account_key like '%usd' then 'USD' else 'LYD' end;
      v_description := concat_ws(' - ', 'Purchase from ' || coalesce(nullif(trim(v_purchase.supplier_name), ''), 'supplier'), case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || v_purchase.receipt_number end, nullif(trim(coalesce(v_purchase.notes, '')), ''));

      select ft.id into v_existing_id
      from public.financial_transactions ft
      where ft.linked_purchase_id = v_purchase.id
         or ft.related_purchase_id = v_purchase.id
         or (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
      order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end, ft.created_at, ft.id
      limit 1;

      if v_existing_id is not null then
        update public.financial_transactions
        set transaction_date = v_purchase.order_date,
            transaction_datetime = v_purchase.order_date::timestamptz,
            direction = 'money_out',
            transaction_kind = 'product_purchase',
            transaction_type = 'Products Restocking',
            category = 'Products Restocking',
            description = v_description,
            notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
            amount = v_amount,
            signed_amount = -abs(v_amount),
            currency = v_currency,
            account_id = v_account_key,
            account_key = v_account_key,
            transaction_effect = 'expense',
            source_account_id = null,
            destination_account_id = null,
            bucket = 'Inventory',
            final_bucket = 'Products Restocking',
            review_status = 'confirmed',
            needs_review = false,
            transaction_status = 'active',
            is_void = false,
            voided_at = null,
            void_reason = null,
            payment_method = v_purchase.payment_method,
            receipt_url = v_purchase.receipt_url,
            paid_to_text = nullif(trim(v_purchase.supplier_name), ''),
            payee_text = nullif(trim(v_purchase.supplier_name), ''),
            counterparty_text = nullif(trim(v_purchase.supplier_name), ''),
            linked_purchase_id = v_purchase.id,
            related_purchase_id = v_purchase.id,
            source_type = 'purchase',
            source_id = v_purchase.id,
            updated_at = now()
        where id = v_existing_id;
        v_skipped := v_skipped + 1;
      else
        insert into public.financial_transactions(transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category, description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect, source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review, transaction_status, is_void, payment_method, receipt_url, paid_to_text, payee_text, counterparty_text, linked_purchase_id, related_purchase_id, source_type, source_id, created_by, updated_at)
        values (v_purchase.order_date, v_purchase.order_date::timestamptz, 'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', v_description, coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description), v_amount, -abs(v_amount), v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking', 'confirmed', false, 'active', false, v_purchase.payment_method, v_purchase.receipt_url, nullif(trim(v_purchase.supplier_name), ''), nullif(trim(v_purchase.supplier_name), ''), nullif(trim(v_purchase.supplier_name), ''), v_purchase.id, v_purchase.id, 'purchase', v_purchase.id, v_purchase.created_by, now())
        on conflict (linked_purchase_id) do update set updated_at = now();
        v_purchase_created := v_purchase_created + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'purchase', 'source_id', v_purchase.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  for v_cash in
    select cc.*, m.name as machine_name, m.machine_code, l.name as location_name
    from public.cash_collections cc
    left join public.machines m on m.id = cc.machine_id
    left join public.locations l on l.id = m.location_id
    where coalesce(cc.actual_cash_collected, 0) > 0
      and coalesce(cc.review_status, '') <> 'voided'
  loop
    v_cash_checked := v_cash_checked + 1;
    begin
      v_amount := abs(coalesce(v_cash.actual_cash_collected, 0));
      v_description := 'Cash collection from ' || coalesce(nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), ''), nullif(trim(v_cash.location_name), ''), v_cash.id::text);
      if nullif(trim(coalesce(v_cash.cash_bag_id, '')), '') is not null then
        v_description := v_description || ' - Bag ' || v_cash.cash_bag_id;
      end if;

      select ft.id into v_existing_id
      from public.financial_transactions ft
      where ft.linked_cash_collection_id = v_cash.id
         or ft.related_cash_collection_id = v_cash.id
         or (ft.source_type = 'cash_collection' and ft.source_id = v_cash.id)
      order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end, ft.created_at, ft.id
      limit 1;

      if v_existing_id is not null then
        update public.financial_transactions
        set transaction_date = coalesce(v_cash.collected_at, v_cash.counted_at, now())::date,
            transaction_datetime = coalesce(v_cash.collected_at, v_cash.counted_at, now()),
            direction = 'money_in',
            transaction_kind = 'cash_collection',
            transaction_type = 'Revenue',
            category = 'Revenue',
            description = v_description,
            notes = v_description,
            amount = v_amount,
            signed_amount = abs(v_amount),
            currency = 'LYD',
            account_id = 'snacky_lyd',
            account_key = 'snacky_lyd',
            transaction_effect = 'income',
            source_account_id = null,
            destination_account_id = null,
            bucket = 'Revenue',
            final_bucket = 'Revenue',
            review_status = 'confirmed',
            needs_review = false,
            transaction_status = 'active',
            is_void = false,
            voided_at = null,
            void_reason = null,
            payment_method = 'cash',
            payer_text = 'Cash customers',
            counterparty_text = 'Cash customers',
            linked_cash_collection_id = v_cash.id,
            related_cash_collection_id = v_cash.id,
            related_route_id = v_cash.route_id,
            related_machine_id = v_cash.machine_id,
            location = coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), '')),
            source_type = 'cash_collection',
            source_id = v_cash.id,
            updated_at = now()
        where id = v_existing_id;
        v_skipped := v_skipped + 1;
      else
        insert into public.financial_transactions(transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category, description, notes, amount, signed_amount, currency, account_id, account_key, transaction_effect, source_account_id, destination_account_id, bucket, final_bucket, review_status, needs_review, transaction_status, is_void, payment_method, payer_text, counterparty_text, related_cash_collection_id, linked_cash_collection_id, related_route_id, related_machine_id, location, source_type, source_id, created_by, updated_at)
        values (coalesce(v_cash.collected_at, v_cash.counted_at, now())::date, coalesce(v_cash.collected_at, v_cash.counted_at, now()), 'money_in', 'cash_collection', 'Revenue', 'Revenue', v_description, v_description, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd', 'income', null, null, 'Revenue', 'Revenue', 'confirmed', false, 'active', false, 'cash', 'Cash customers', 'Cash customers', v_cash.id, v_cash.id, v_cash.route_id, v_cash.machine_id, coalesce(nullif(trim(v_cash.location_name), ''), nullif(trim(v_cash.machine_name), ''), nullif(trim(v_cash.machine_code), '')), 'cash_collection', v_cash.id, v_cash.operator_id, now())
        on conflict (linked_cash_collection_id) do update set updated_at = now();
        v_cash_created := v_cash_created + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'cash_collection', 'source_id', v_cash.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  return query select v_purchases_checked, v_purchase_created, v_cash_checked, v_cash_created, v_skipped, v_errors;
end;
$$;

revoke all on function public.backfill_missing_finance_transactions() from public;
grant execute on function public.backfill_missing_finance_transactions() to authenticated;

select pg_notify('pgrst', 'reload schema');
