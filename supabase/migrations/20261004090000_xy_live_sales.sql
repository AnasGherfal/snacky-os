-- True sales signals for smart route planning.
-- Uses finalized active VMS transaction batches only; stock-depletion remains a fallback.

create or replace function public.snacky_smart_route_sales_signals(
  p_days integer default 21
)
returns table (
  machine_id uuid,
  location_id uuid,
  location_type text,
  product_id uuid,
  units_sold bigint,
  transaction_count bigint,
  revenue_amount numeric,
  latest_sale_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select
    t.mapped_machine_id as machine_id,
    m.location_id,
    coalesce(ctx.location_type, l.location_type::text) as location_type,
    t.mapped_product_id as product_id,
    sum(greatest(1, floor(coalesce(t.quantity, 1))))::bigint as units_sold,
    count(*)::bigint as transaction_count,
    sum(greatest(0, coalesce(t.payment_amount, 0)))::numeric as revenue_amount,
    max(coalesce(t.payment_time, t.delivery_time, t.created_at)) as latest_sale_at
  from public.vms_transactions_raw t
  join public.vms_import_batches b on b.id = t.import_batch_id
  join public.machines m on m.id = t.mapped_machine_id
  left join public.locations l on l.id = m.location_id
  left join public.smart_route_machine_context ctx on ctx.machine_id = m.id
  where t.transaction_status = 'successful_sale'
    and t.mapped_machine_id is not null
    and t.mapped_product_id is not null
    and coalesce(t.payment_time, t.delivery_time, t.created_at)
      >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 21), 60)))
    and b.deleted_at is null
    and coalesce(b.is_active, false) = true
    and b.status in ('imported', 'imported_with_warnings', 'partially_imported')
  group by
    t.mapped_machine_id,
    m.location_id,
    coalesce(ctx.location_type, l.location_type::text),
    t.mapped_product_id;
$$;

revoke all on function public.snacky_smart_route_sales_signals(integer)
  from public, anon, authenticated;
grant execute on function public.snacky_smart_route_sales_signals(integer)
  to service_role;

comment on function public.snacky_smart_route_sales_signals(integer) is
  'Recent successful VMS transaction sales by machine/product for server-side smart route ranking.';

select pg_notify('pgrst', 'reload schema');
