-- Repair the historical 15-vs-16 argument pickup RPC call without replacing or
-- dropping any existing function.
--
-- The public two-stage wrapper currently calls confirm_route_pickup_batch_core
-- with 15 positional arguments. The only existing core overload has 16 arguments,
-- so PostgreSQL applies its defaults and shifts p_selected_machine_ids into the
-- acknowledgement slot. This bridge provides the exact 15-argument signature the
-- wrapper intended to call, derives acknowledgements from the checked rows, and
-- forwards all 16 arguments to the existing core in the correct order.
--
-- This migration is additive and idempotent. It does not modify route data,
-- pickup batches, inventory movements, or audit history.

create or replace function public.confirm_route_pickup_batch_core(
  p_route_id uuid,
  p_expected_route_status public.route_status,
  p_next_route_status public.route_status,
  p_started_at timestamptz,
  p_replace_pick_list boolean,
  p_pickup_batch jsonb,
  p_batch_stop_ids uuid[],
  p_new_stop_item_rows jsonb,
  p_inventory_movements jsonb,
  p_pick_list_rows jsonb,
  p_stock_line_rows jsonb,
  p_stop_item_picks jsonb,
  p_refill_line_picks jsonb,
  p_selected_stop_ids uuid[],
  p_selected_machine_ids uuid[]
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
as $function$
declare
  v_acknowledged_pickup_line_ids uuid[] := '{}'::uuid[];
begin
  if jsonb_typeof(coalesce(p_pick_list_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Pickup checklist payload is invalid.' using errcode = 'P0001';
  end if;

  select coalesce(
    array_agg(distinct x.route_stop_item_id order by x.route_stop_item_id),
    '{}'::uuid[]
  )
  into v_acknowledged_pickup_line_ids
  from jsonb_to_recordset(coalesce(p_pick_list_rows, '[]'::jsonb))
    as x(route_stop_item_id uuid, is_checked boolean)
  where x.route_stop_item_id is not null
    and coalesce(x.is_checked, false) = true;

  return query
  select *
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
    v_acknowledged_pickup_line_ids,
    p_selected_machine_ids
  );
end;
$function$;

revoke all on function public.confirm_route_pickup_batch_core(
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
  uuid[]
) from public;

grant execute on function public.confirm_route_pickup_batch_core(
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
  uuid[]
) to authenticated;

select pg_notify('pgrst', 'reload schema');