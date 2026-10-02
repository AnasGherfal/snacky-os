alter table purchase_orders
  add column if not exists payment_account_id text not null default 'snacky_lyd';

update purchase_orders
set payment_account_id = coalesce(nullif(trim(payment_account_id), ''), 'snacky_lyd')
where payment_account_id is null
   or trim(payment_account_id) = '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_orders_payment_account_id_check'
  ) then
    alter table purchase_orders
      add constraint purchase_orders_payment_account_id_check
      check (payment_account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd'));
  end if;
end $$;

alter table financial_transactions
  add column if not exists linked_purchase_id uuid references purchase_orders(id) on delete set null,
  add column if not exists source_type text,
  add column if not exists source_id uuid;

update financial_transactions
set
  linked_purchase_id = coalesce(linked_purchase_id, related_purchase_id),
  source_type = coalesce(source_type, case when related_purchase_id is not null then 'purchase' else source_type end),
  source_id = coalesce(source_id, related_purchase_id)
where transaction_kind = 'product_purchase'
  and related_purchase_id is not null;

create unique index if not exists idx_financial_transactions_linked_purchase
  on financial_transactions(linked_purchase_id)
  where linked_purchase_id is not null and transaction_kind = 'product_purchase';

create unique index if not exists idx_financial_transactions_source_type_id
  on financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;
