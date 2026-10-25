create or replace function public.snacky_restock_refill_summary_v1()
returns table (
  product_id uuid,
  recommended_refill_qty bigint,
  machine_names text[]
)
language sql
stable
security invoker
set search_path = ''
as $fn$
  select
    r.product_id,
    sum(greatest(coalesce(r.final_qty_to_take,0),coalesce(r.suggested_qty,0)))::bigint as recommended_refill_qty,
    array_agg(distinct r.machine_name order by r.machine_name)
      filter (where r.machine_name is not null and btrim(r.machine_name)<>'') as machine_names
  from public.refill_recommendations r
  where r.product_id is not null
    and greatest(coalesce(r.final_qty_to_take,0),coalesce(r.suggested_qty,0)) > 0
  group by r.product_id;
$fn$;

revoke all on function public.snacky_restock_refill_summary_v1() from public, anon;
grant execute on function public.snacky_restock_refill_summary_v1() to authenticated, service_role;

select pg_notify('pgrst','reload schema');
