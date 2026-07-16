begin;

-- Keep exactly one usable Monthly Product Profit source active per business month.
-- The winner is the batch with the latest report end date, then the latest import/upload.
create or replace function public.snacky_refresh_monthly_profit_batch_activation(
  p_business_month date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_business_month is null then
    return;
  end if;

  with row_stats as (
    select
      rows.import_batch_id,
      min(coalesce(rows.business_month, date_trunc('month', rows.report_start_date)::date)) as business_month,
      min(rows.report_start_date) as report_start_date,
      max(rows.report_end_date) as report_end_date,
      count(*)::integer as imported_row_count
    from public.vms_monthly_product_profit rows
    where rows.import_batch_id is not null
    group by rows.import_batch_id
  ),
  ranked as (
    select
      batches.id as import_batch_id,
      stats.business_month,
      stats.report_start_date,
      stats.report_end_date,
      stats.imported_row_count,
      row_number() over (
        partition by stats.business_month
        order by
          stats.report_end_date desc nulls last,
          coalesce(batches.imported_at, batches.uploaded_at, batches.updated_at) desc nulls last,
          batches.id desc
      ) as activation_rank
    from row_stats stats
    join public.vms_import_batches batches
      on batches.id = stats.import_batch_id
    where stats.business_month = p_business_month
      and batches.report_type = 'monthly_product_profit'
      and batches.status not in ('deleted', 'disabled')
  )
  update public.vms_import_batches batches
  set
    status = 'imported',
    is_active = ranked.activation_rank = 1,
    rows_found = greatest(coalesce(batches.rows_found, 0), ranked.imported_row_count),
    row_count = greatest(coalesce(batches.row_count, 0), ranked.imported_row_count),
    rows_imported = ranked.imported_row_count,
    report_start_date = coalesce(ranked.report_start_date, batches.report_start_date, ranked.business_month),
    report_end_date = coalesce(
      ranked.report_end_date,
      batches.report_end_date,
      (ranked.business_month + interval '1 month - 1 day')::date
    ),
    imported_at = case
      when ranked.activation_rank = 1 then coalesce(batches.imported_at, now())
      else batches.imported_at
    end,
    updated_at = now()
  from ranked
  where batches.id = ranked.import_batch_id;
end;
$$;

create or replace function public.snacky_activate_monthly_profit_batch_from_rows()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_business_month date;
begin
  for v_business_month in
    select distinct
      coalesce(new_rows.business_month, date_trunc('month', new_rows.report_start_date)::date)
    from new_rows
    where new_rows.import_batch_id is not null
      and coalesce(new_rows.business_month, date_trunc('month', new_rows.report_start_date)::date) is not null
  loop
    perform public.snacky_refresh_monthly_profit_batch_activation(v_business_month);
  end loop;

  return null;
end;
$$;

drop trigger if exists snacky_monthly_profit_batch_activate_after_insert
  on public.vms_monthly_product_profit;
create trigger snacky_monthly_profit_batch_activate_after_insert
after insert on public.vms_monthly_product_profit
referencing new table as new_rows
for each statement
execute function public.snacky_activate_monthly_profit_batch_from_rows();

drop trigger if exists snacky_monthly_profit_batch_activate_after_update
  on public.vms_monthly_product_profit;
create trigger snacky_monthly_profit_batch_activate_after_update
after update on public.vms_monthly_product_profit
referencing new table as new_rows
for each statement
execute function public.snacky_activate_monthly_profit_batch_from_rows();

-- Repair existing Monthly Product Profit rows immediately when this migration is applied.
do $$
declare
  v_business_month date;
begin
  for v_business_month in
    select distinct
      coalesce(rows.business_month, date_trunc('month', rows.report_start_date)::date)
    from public.vms_monthly_product_profit rows
    where rows.import_batch_id is not null
      and coalesce(rows.business_month, date_trunc('month', rows.report_start_date)::date) is not null
  loop
    perform public.snacky_refresh_monthly_profit_batch_activation(v_business_month);
  end loop;
end;
$$;

revoke all on function public.snacky_refresh_monthly_profit_batch_activation(date) from public;
revoke all on function public.snacky_activate_monthly_profit_batch_from_rows() from public;

grant execute on function public.snacky_refresh_monthly_profit_batch_activation(date) to service_role;

select pg_notify('pgrst', 'reload schema');

commit;
