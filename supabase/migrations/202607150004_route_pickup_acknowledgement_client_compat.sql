-- Hotfix for the two-stage pickup confirmation rollout.
--
-- The deployed operator page submits checked route-stop lines in
-- p_pick_list_rows, but older/current clients may omit the duplicate
-- p_acknowledged_pickup_line_ids argument. The strict wrapper introduced in
-- 202607150003 rejected that otherwise valid confirmation with a generic error.
--
-- Keep server-side enforcement: when the explicit acknowledgement array is
-- empty, derive it from the submitted checked pickup rows. Required route lines
-- must still match exactly, so unchecked or stale pickup lines remain blocked.

create or replace function public.confirm_route_pickup_batch(
  p_route_id uuid,
  p_expected_route_status public.route_status,
  p_next_route_status public.route_status,
  p_started_at timestamptz,
  p_replace_pick_list boolean default false,
  p_pickup_batch jsonb default null,
  p_batch_stop_ids uuid[] default '{}'::uuid[],
  p_new_stop_item_rows jsonb default '[]'::jsonb,
  p_inventory_movements jsonb default '[]'::jsonb,
  p_pick_list_rows jsonb default '[]'::jsonb,
  p_stock_line_rows jsonb default '[]'::jsonb,
  p_stop_item_picks jsonb default '[]'::jsonb,
  p_refill_line_picks jsonb default '[]'::jsonb,
  p_selected_stop_ids uuid[] default '{}'::uuid[],
  p_acknowledged_pickup_line_ids uuid[] default '{}'::uuid[],
  p_selected_machine_ids uuid[] default '{}'::uuid[]
)
returns table(
  pickup_batch_id uuid,
  route_status public.route_status,
  picked_stop_ids uuid[],
  pending_stop_count integer
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_pick_list_rows jsonb := coalesce(p_pick_list_rows, '[]'::jsonb);
  v_acknowledged_pickup_line_ids uuid[] := coalesce(p_acknowledged_pickup_line_ids, '{}'::uuid[]);
  v_checked_pickup_line_ids uuid[] := '{}'::uuid[];
  v_required_pickup_line_ids uuid[] := '{}'::uuid[];
  v_invalid_count integer := 0;
  v_pickup_batch_id uuid := nullif(coalesce(p_pickup_batch->>'id', ''), '')::uuid;
  v_pickup_batch jsonb := coalesce(p_pickup_batch, '{}'::jsonb);
  v_expected_product_summary jsonb := coalesce(v_pickup_batch->'product_summary', '[]'::jsonb);
  v_saved_summary_signatures text[] := '{}'::text[];
  v_confirm_summary_signatures text[] := '{}'::text[];
  v_saved_selected_stop_ids uuid[] := '{}'::uuid[];
  v_confirm_selected_stop_ids uuid[] := '{}'::uuid[];
  v_saved_batch record;
  v_result record;
begin
  if jsonb_typeof(v_pick_list_rows) <> 'array' then
    raise exception 'Pickup checklist payload is invalid.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct x.route_stop_item_id order by x.route_stop_item_id), '{}'::uuid[])
  into v_checked_pickup_line_ids
  from jsonb_to_recordset(v_pick_list_rows) as x(route_stop_item_id uuid, is_checked boolean)
  where x.route_stop_item_id is not null
    and coalesce(x.is_checked, false) = true;

  -- Client compatibility: the checked IDs are already part of the authoritative
  -- server payload. Use them only when the duplicate explicit array is absent.
  if coalesce(array_length(v_acknowledged_pickup_line_ids, 1), 0) = 0
     and coalesce(array_length(v_checked_pickup_line_ids, 1), 0) > 0 then
    v_acknowledged_pickup_line_ids := v_checked_pickup_line_ids;
  end if;

  select coalesce(array_agg(distinct rsi.id order by rsi.id), '{}'::uuid[])
  into v_required_pickup_line_ids
  from public.route_stop_items rsi
  join public.route_stops rs on rs.id = rsi.route_stop_id
  where rs.route_id = p_route_id
    and coalesce(rsi.planned_quantity, 0) > 0
    and (
      coalesce(array_length(p_selected_stop_ids, 1), 0) = 0
      or rsi.route_stop_id = any(p_selected_stop_ids)
    );

  if coalesce(array_length(v_checked_pickup_line_ids, 1), 0) <> coalesce(array_length(v_acknowledged_pickup_line_ids, 1), 0) then
    raise exception 'Pickup checklist acknowledgements do not match the submitted checked lines.' using errcode = 'P0001';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(v_checked_pickup_line_ids) as checked_id
  where not (checked_id = any(v_acknowledged_pickup_line_ids));
  if v_invalid_count > 0 then
    raise exception 'Pickup checklist acknowledgements do not match the submitted checked lines.' using errcode = 'P0001';
  end if;

  select count(*)
  into v_invalid_count
  from unnest(v_required_pickup_line_ids) as required_id
  where not (required_id = any(v_acknowledged_pickup_line_ids));
  if v_invalid_count > 0 then
    raise exception 'Every required pickup line must be checked before confirming pickup.' using errcode = 'P0001';
  end if;

  if v_pickup_batch_id is null then
    raise exception 'Pickup must be prepared before confirmation.' using errcode = 'P0001';
  end if;

  select
    b.id,
    b.route_id,
    b.status,
    b.selected_stop_ids,
    b.product_summary,
    b.prepared_at,
    b.confirmed_at,
    b.returned_to_assigned_at
  into v_saved_batch
  from public.route_pickup_batches b
  where b.id = v_pickup_batch_id
    and b.route_id = p_route_id
  for update;

  if not found then
    raise exception 'Prepared pickup batch was not found.' using errcode = 'P0001';
  end if;

  if v_saved_batch.returned_to_assigned_at is not null then
    raise exception 'Returned pickup batches cannot be confirmed.' using errcode = 'P0001';
  end if;

  if v_saved_batch.prepared_at is null then
    raise exception 'Pickup must be prepared before confirmation.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_expected_product_summary) <> 'array' then
    raise exception 'Prepared pickup summary is invalid.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct (coalesce(x.product_id, '') || ':' || coalesce(x.quantity, 0)::text) order by (coalesce(x.product_id, '') || ':' || coalesce(x.quantity, 0)::text)), '{}'::text[])
  into v_saved_summary_signatures
  from jsonb_to_recordset(coalesce(v_saved_batch.product_summary, '[]'::jsonb)) as x(product_id text, quantity integer);

  select coalesce(array_agg(distinct (coalesce(x.product_id, '') || ':' || coalesce(x.quantity, 0)::text) order by (coalesce(x.product_id, '') || ':' || coalesce(x.quantity, 0)::text)), '{}'::text[])
  into v_confirm_summary_signatures
  from jsonb_to_recordset(v_expected_product_summary) as x(product_id text, quantity integer);

  if v_saved_summary_signatures <> v_confirm_summary_signatures then
    raise exception 'Prepared pickup summary does not match the saved preparation snapshot.' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
  into v_saved_selected_stop_ids
  from unnest(coalesce(v_saved_batch.selected_stop_ids, '{}'::uuid[])) as x;

  select coalesce(array_agg(distinct x order by x), '{}'::uuid[])
  into v_confirm_selected_stop_ids
  from unnest(coalesce(p_selected_stop_ids, '{}'::uuid[])) as x;

  if v_saved_selected_stop_ids <> v_confirm_selected_stop_ids then
    raise exception 'Prepared pickup stops do not match the current confirmation payload.' using errcode = 'P0001';
  end if;

  select *
  into v_result
  from public.confirm_route_pickup_batch_core(
    p_route_id,
    p_expected_route_status,
    p_next_route_status,
    p_started_at,
    p_replace_pick_list,
    p_pickup_batch,
    p_batch_stop_ids,
    p_new_stop_item_rows,
    p_inventory_movements,
    p_pick_list_rows,
    p_stock_line_rows,
    p_stop_item_picks,
    p_refill_line_picks,
    p_selected_stop_ids,
    p_selected_machine_ids
  );

  update public.route_pickup_batches
  set
    status = 'confirmed',
    selected_stop_ids = coalesce(p_selected_stop_ids, selected_stop_ids),
    product_summary = coalesce(v_expected_product_summary, product_summary),
    storage_deducted = coalesce((p_pickup_batch->>'storage_deducted')::boolean, storage_deducted),
    confirmed_at = coalesce(nullif(p_pickup_batch->>'confirmed_at', '')::timestamptz, confirmed_at, now()),
    updated_at = now()
  where id = v_pickup_batch_id;

  pickup_batch_id := v_result.pickup_batch_id;
  route_status := v_result.route_status;
  picked_stop_ids := v_result.picked_stop_ids;
  pending_stop_count := v_result.pending_stop_count;
  return next;
end;
$$;

revoke all on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[],
  uuid[]
) from public;

grant execute on function public.confirm_route_pickup_batch(
  uuid,
  public.route_status,
  public.route_status,
  timestamptz,
  boolean,
  jsonb,
  uuid[],
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  uuid[],
  uuid[],
  uuid[]
) to authenticated;

select pg_notify('pgrst', 'reload schema');
