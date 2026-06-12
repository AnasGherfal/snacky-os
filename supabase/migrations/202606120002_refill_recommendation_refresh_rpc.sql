create or replace function public.refresh_refill_recommendations_from_latest_stock_snapshot()
returns table(
  refreshed_at timestamptz,
  latest_import_batch_id uuid,
  latest_file_name text,
  latest_report_type text,
  latest_status text,
  snapshot_rows integer,
  mapped_product_rows integer,
  mapped_machine_rows integer,
  recommendation_rows integer,
  zero_storage_recommendation_rows integer,
  warning text
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  latest_batch record;
begin
  select
    vib.id,
    coalesce(vib.original_file_name, vib.file_name) as file_name,
    vib.report_type,
    vib.status
  into latest_batch
  from public.vms_import_batches vib
  where vib.report_type in ('stock', 'machine_stock_snapshot')
    and vib.status in ('imported', 'imported_with_warnings')
    and coalesce(vib.is_active, false) = true
    and vib.deleted_at is null
  order by coalesce(vib.imported_at, vib.created_at) desc, vib.created_at desc
  limit 1;

  if latest_batch.id is null then
    return query
    select
      now(),
      null::uuid,
      null::text,
      null::text,
      null::text,
      0,
      0,
      0,
      0,
      0,
      'No active imported machine stock snapshot batch was found.'::text;
    return;
  end if;

  return query
  with snapshot_totals as (
    select
      count(*)::integer as total,
      count(vmss.product_id)::integer as mapped_products,
      count(vmss.machine_id)::integer as mapped_machines
    from public.vms_machine_stock_snapshots vmss
    where vmss.import_batch_id = latest_batch.id
      and coalesce(vmss.import_row_status, 'imported') = 'imported'
  ),
  recommendation_totals as (
    select
      count(*)::integer as total,
      count(*) filter (where coalesce(rr.available_storage_qty, 0) <= 0)::integer as zero_storage
    from public.refill_recommendations rr
    where rr.import_batch_id = latest_batch.id
  )
  select
    now(),
    latest_batch.id::uuid,
    latest_batch.file_name::text,
    latest_batch.report_type::text,
    latest_batch.status::text,
    snapshot_totals.total,
    snapshot_totals.mapped_products,
    snapshot_totals.mapped_machines,
    recommendation_totals.total,
    recommendation_totals.zero_storage,
    case
      when snapshot_totals.total = 0 then 'Latest active stock snapshot batch has no imported machine-stock rows.'
      when snapshot_totals.mapped_products = 0 or snapshot_totals.mapped_machines = 0 then 'Machine stock rows are missing product_id or machine_id mappings.'
      when recommendation_totals.total = 0 then 'Snapshot rows exist, but refill_recommendations currently returns no rows for the latest active stock import.'
      when recommendation_totals.zero_storage = recommendation_totals.total then 'Recommendations exist, but storage is empty so every default final take is 0.'
      else null
    end as warning
  from snapshot_totals
  cross join recommendation_totals;
end;
$$;

revoke all on function public.refresh_refill_recommendations_from_latest_stock_snapshot() from public;
grant execute on function public.refresh_refill_recommendations_from_latest_stock_snapshot() to authenticated, service_role;
