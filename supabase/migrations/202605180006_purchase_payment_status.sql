alter table purchase_orders
  add column if not exists payment_status text not null default 'paid';

update purchase_orders
set payment_status = 'paid'
where payment_status is null
  or payment_status not in ('paid', 'unpaid', 'partial');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'purchase_orders_payment_status_check'
  ) then
    alter table purchase_orders
      add constraint purchase_orders_payment_status_check
      check (payment_status in ('paid', 'unpaid', 'partial'));
  end if;
end $$;

create index if not exists idx_purchase_orders_payment_status
  on purchase_orders(payment_status, order_date desc);
