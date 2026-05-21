do $$
declare
  has_payment_date boolean;
  has_paid_at boolean;
  purchase_transaction_date_expr text;
begin
  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_orders'
      and column_name = 'payment_date'
  )
  into has_payment_date;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'purchase_orders'
      and column_name = 'paid_at'
  )
  into has_paid_at;

  purchase_transaction_date_expr := case
    when has_payment_date and has_paid_at then 'coalesce(po.payment_date::date, po.paid_at::date, po.order_date)'
    when has_payment_date then 'coalesce(po.payment_date::date, po.order_date)'
    when has_paid_at then 'coalesce(po.paid_at::date, po.order_date)'
    else 'po.order_date'
  end;

  execute format($sql$
    update financial_transactions ft
    set transaction_date = %1$s,
        updated_at = now()
    from purchase_orders po
    where ft.related_purchase_id = po.id
      and ft.transaction_kind = 'product_purchase'
      and ft.related_purchase_id is not null
      and %1$s is not null
      and ft.transaction_date is distinct from %1$s
  $sql$, purchase_transaction_date_expr);
end $$;
