-- Stage XY live sales in an inactive draft batch, then publish that batch
-- with DB-validated transaction/source completeness in ONE SQL transaction.
-- The existing chunked draft-row writes are intentionally NOT made atomic
-- by this migration; failed draft batches must remain ineligible for cash.
-- Never relink, reactivate or delete a historical import automatically.

create or replace function public.snacky_publish_xy_live_sales_batch_v1(
  p_batch_id uuid,
  p_metrics jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $function$
declare
  v_batch public.vms_import_batches%rowtype;
  v_fetched integer;
  v_inserted integer;
  v_duplicates integer;
  v_rejected integer;
  v_review integer;
  v_mapped integer;
  v_pages integer;
  v_rows bigint;
  v_invalid bigint;
  v_status text;
  v_errors jsonb;
begin
  if current_user <> 'service_role' then
    raise exception 'Only the Snacky server role can publish XY live sales'
      using errcode = '42501';
  end if;

  if p_batch_id is null or p_metrics is null
    or jsonb_typeof(p_metrics) <> 'object' then
    raise exception 'An identified draft batch and complete source metrics are required'
      using errcode = '22023';
  end if;

  if jsonb_typeof(p_metrics->'fetched_rows') <> 'number'
    or jsonb_typeof(p_metrics->'inserted_rows') <> 'number'
    or jsonb_typeof(p_metrics->'duplicate_rows') <> 'number'
    or jsonb_typeof(p_metrics->'rejected_unverified_rows') <> 'number'
    or jsonb_typeof(p_metrics->'rows_needing_review') <> 'number'
    or jsonb_typeof(p_metrics->'mapped_machine_rows') <> 'number'
    or jsonb_typeof(p_metrics->'pages_read') <> 'number'
    or p_metrics->>'pagination_complete' <> 'true'
    or jsonb_typeof(p_metrics->'errors') <> 'array'
    or jsonb_typeof(p_metrics->'parse_diagnostics') <> 'object' then
    raise exception 'Incomplete XY pagination or source metrics: refusing to publish'
      using errcode = '23514';
  end if;

  v_fetched := (p_metrics->>'fetched_rows')::integer;
  v_inserted := (p_metrics->>'inserted_rows')::integer;
  v_duplicates := (p_metrics->>'duplicate_rows')::integer;
  v_rejected := (p_metrics->>'rejected_unverified_rows')::integer;
  v_review := (p_metrics->>'rows_needing_review')::integer;
  v_mapped := (p_metrics->>'mapped_machine_rows')::integer;
  v_pages := (p_metrics->>'pages_read')::integer;
  v_errors := p_metrics->'errors';

  if least(v_fetched,v_inserted,v_duplicates,v_rejected,v_review,v_mapped,v_pages) < 0
    or v_pages = 0 or v_fetched <> v_inserted + v_duplicates
    or v_rejected <> 0 or v_review <> 0 or v_mapped <> v_fetched then
    raise exception 'XY source coverage is partial, ambiguous, or unmapped: refusing to publish'
      using errcode = '23514';
  end if;

  select * into v_batch
  from public.vms_import_batches
  where id = p_batch_id
  for update;

  if not found or v_batch.status <> 'draft'
    or coalesce(v_batch.is_active,false)
    or v_batch.deleted_at is not null
    or v_batch.source_type <> 'api'
    or v_batch.report_type <> 'vms_order_details_weekly'
    or v_batch.source_usage->>'source_type' <> 'xy_live_sales_api' then
    raise exception 'This is not an eligible unpublished XY live sales draft'
      using errcode = '23514';
  end if;

  select count(*),
    count(*) filter (where
      t.duplicate_hash !~ '^[0-9a-f]{64}$'
      or t.transaction_status = 'needs_review'
      or (t.transaction_status = 'successful_sale' and (
        t.mapped_machine_id is null
        or coalesce(t.payment_time,t.delivery_time) is null
        or t.payment_amount is null
        or t.payment_amount < 0
        or public.snacky_vms_normalize_payment_method(t.raw_row,t.normalized_row) not in ('cash','card')
      ))
    )
  into v_rows,v_invalid
  from public.vms_transactions_raw t
  where t.import_batch_id = p_batch_id;

  if v_rows <> v_inserted or v_invalid <> 0 then
    raise exception 'Staged transaction count or cash evidence failed database validation'
      using errcode = '23514';
  end if;

  -- A request with zero new rows is NOT an eligible cash transaction source.
  -- It still records a completed, empty/deduplicated import for audit.
  v_status := case
    when v_inserted = 0 then 'partially_imported'
    when jsonb_array_length(v_errors) > 0 then 'imported_with_warnings'
    else 'imported'
  end;

  update public.vms_import_batches
  set status = v_status,
      is_active = (v_inserted > 0),
      imported_at = now(),
      row_count = v_fetched,
      rows_found = v_fetched,
      rows_imported = v_inserted,
      rows_skipped = v_duplicates,
      rows_skipped_duplicate = v_duplicates,
      rows_needing_review = v_review,
      error_count = jsonb_array_length(v_errors),
      errors = v_errors,
      report_start_date = (p_metrics->>'report_start_date')::date,
      report_end_date = (p_metrics->>'report_end_date')::date,
      detected_min_datetime = nullif(p_metrics->>'detected_min_datetime','')::timestamptz,
      detected_max_datetime = nullif(p_metrics->>'detected_max_datetime','')::timestamptz,
      total_successful_sales = (p_metrics->>'total_successful_sales')::numeric,
      successful_rows_count = (p_metrics->>'successful_rows_count')::integer,
      failed_rows_count = (p_metrics->>'failed_rows_count')::integer,
      refunded_rows_count = (p_metrics->>'refunded_rows_count')::integer,
      latest_error = nullif(v_errors->>0,''),
      parse_diagnostics = p_metrics->'parse_diagnostics',
      updated_at = now()
  where id = p_batch_id
    and status = 'draft'
    and deleted_at is null;

  if not found then
    raise exception 'XY batch changed while publishing' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'batch_id',p_batch_id,
    'status',v_status,
    'published_rows',v_inserted,
    'duplicate_rows',v_duplicates,
    'eligible_for_cash',(v_inserted > 0),
    'pagination_complete',true
  );
end;
$function$;

revoke all on function public.snacky_publish_xy_live_sales_batch_v1(uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.snacky_publish_xy_live_sales_batch_v1(uuid,jsonb)
  to service_role;

comment on function public.snacky_publish_xy_live_sales_batch_v1(uuid,jsonb) is
  'Atomic publication of an already staged XY sales batch after validating counts, source, mapped successful sales and cash/card methods. Staging itself remains chunked; failed drafts never become eligible. Server-only.';

select pg_notify('pgrst','reload schema');
