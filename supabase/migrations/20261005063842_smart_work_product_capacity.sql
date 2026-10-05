-- Part 3A: no staffing, routes, stock, snapshots or existing rule values changed.
alter table public.smart_route_slot_product_rules
  add column if not exists verified_capacity integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.smart_route_slot_product_rules'::regclass and conname='smart_route_slot_verified_capacity_check') then
    alter table public.smart_route_slot_product_rules
      add constraint smart_route_slot_verified_capacity_check
      check (verified_capacity is null or verified_capacity between 1 and 1000);
  end if;
end $$;
comment on column public.smart_route_slot_product_rules.verified_capacity is
  'Owner-confirmed capacity for this exact product/lane combination. NULL means no confirmed replacement capacity, never inferred from category or previous product.';
