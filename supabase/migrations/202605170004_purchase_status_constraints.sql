update purchase_orders
set status = 'draft'
where status not in ('draft', 'received', 'cancelled');

do $$ begin
  alter table purchase_orders add constraint purchase_orders_status_check check (status in ('draft', 'received', 'cancelled'));
exception when duplicate_object then null; end $$;
