-- Complete the customer-compensation production contract.
-- This migration is intentionally additive and safe to re-run.

do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'inventory_entity_type'
      and e.enumlabel = 'customer'
  ) then
    alter type public.inventory_entity_type add value 'customer';
  end if;
end $$;

do $$ begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'movement_reason'
      and e.enumlabel = 'customer_compensation'
  ) then
    alter type public.movement_reason add value 'customer_compensation';
  end if;
end $$;

do $$
begin
  if to_regclass('public.route_customer_compensations') is not null then
    alter table public.route_customer_compensations
      drop constraint if exists route_customer_compensations_claim_type_check;

    alter table public.route_customer_compensations
      add constraint route_customer_compensations_claim_type_check
      check (
        claim_type in (
          'paid_no_product',
          'product_jammed',
          'wrong_product',
          'dispensing_damage',
          'previous_unresolved_issue',
          'damaged_or_stuck',
          'other'
        )
      );
  end if;
end $$;

do $$
begin
  if to_regclass('public.route_customer_compensations') is not null then
    create index if not exists idx_route_customer_compensations_product_time
      on public.route_customer_compensations(product_id, compensated_at desc);

    create index if not exists idx_route_customer_compensations_review_time
      on public.route_customer_compensations(needs_review, compensated_at desc)
      where needs_review = true;
  end if;
end $$;
