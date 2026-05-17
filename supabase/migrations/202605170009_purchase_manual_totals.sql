alter table purchase_orders
  add column if not exists manual_total_lyd numeric(12,2),
  add column if not exists calculated_total_lyd numeric(12,2) not null default 0,
  add column if not exists total_adjustment_lyd numeric(12,2),
  add column if not exists total_source text not null default 'calculated';

update purchase_orders
set
  calculated_total_lyd = case when calculated_total_lyd = 0 then coalesce(total_amount, 0) else calculated_total_lyd end,
  total_source = case when manual_total_lyd is null then 'calculated' else 'manual' end,
  total_adjustment_lyd = case when manual_total_lyd is null then null else manual_total_lyd - calculated_total_lyd end;

do $$
begin
  alter table purchase_orders add constraint purchase_orders_total_source_check check (total_source in ('calculated', 'manual'));
exception
  when duplicate_object then null;
end $$;
