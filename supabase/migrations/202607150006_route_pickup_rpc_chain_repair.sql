-- Repair the pickup RPC overload chain created by the two-stage rollout.
--
-- Historical state before this migration:
--   * the original 15-argument function performed the atomic route/inventory work;
--   * a 16-argument acknowledgement wrapper was added around it;
--   * that 16-argument wrapper was later renamed to confirm_route_pickup_batch_core;
--   * the replacement public wrapper then called that renamed 16-argument wrapper
--     with only 15 positional arguments.
--
-- Because the acknowledgement parameter is argument 15 and selected_machine_ids
-- is argument 16, the positional call shifted selected_machine_ids into the
-- acknowledgement slot. That can raise a false acknowledgement mismatch after
-- the outer wrapper already validated the correct checked rows.
--
-- This migration gives the real 15-argument atomic function a unique name,
-- restores a 15-argument compatibility wrapper, and makes the public 16-argument
-- function delegate directly to the uniquely named atomic function. The explicit
-- browser acknowledgement array is retained for API compatibility, but the
-- authoritative required-line validation is derived from p_pick_list_rows and
-- persisted route_stop_items, so a redundant array can never strand a route.

DO $repair$
BEGIN
  IF to_regprocedure(
    'public.confirm_route_pickup_batch_atomic_core(uuid,public.route_status,public.route_status,timestamp with time zone,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[])'
  ) IS NULL THEN
    IF to_regprocedure(
      'public.confirm_route_pickup_batch(uuid,public.route_status,public.route_status,timestamp with time zone,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[])'
    ) IS NULL THEN
      RAISE EXCEPTION 'Pickup RPC repair could not find the original 15-argument atomic function.'
        USING ERRCODE = '42883';
    END IF;

    EXECUTE $sql$
      ALTER FUNCTION public.confirm_route_pickup_batch(
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
      ) RENAME TO confirm_route_pickup_batch_atomic_core
    $sql$;
  END IF;
END
$repair$;

-- Preserve compatibility for callers that still use the original 15-argument
-- contract. This wrapper has one unambiguous target and performs no validation of
-- its own; all route and inventory writes remain inside the original atomic body.
CREATE OR REPLACE FUNCTION public.confirm_route_pickup_batch(
  p_route_id uuid,
  p_expected_route_status public.route_status,
  p_next_route_status public.route_status,
  p_started_at timestamptz,
  p_replace_pick_list boolean DEFAULT false,
  p_pickup_batch jsonb DEFAULT NULL,
  p_batch_stop_ids uuid[] DEFAULT '{}'::uuid[],
  p_new_stop_item_rows jsonb DEFAULT '[]'::jsonb,
  p_inventory_movements jsonb DEFAULT '[]'::jsonb,
  p_pick_list_rows jsonb DEFAULT '[]'::jsonb,
  p_stock_line_rows jsonb DEFAULT '[]'::jsonb,
  p_stop_item_picks jsonb DEFAULT '[]'::jsonb,
  p_refill_line_picks jsonb DEFAULT '[]'::jsonb,
  p_selected_stop_ids uuid[] DEFAULT '{}'::uuid[],
  p_selected_machine_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS TABLE(
  pickup_batch_id uuid,
  route_status public.route_status,
  picked_stop_ids uuid[],
  pending_stop_count integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
  SELECT *
  FROM public.confirm_route_pickup_batch_atomic_core(
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
$function$;

-- Canonical two-stage public contract. No defaults are used on this overload so
-- PostgreSQL/PostgREST cannot confuse it with the 15-argument compatibility
-- function.
CREATE OR REPLACE FUNCTION public.confirm_route_pickup_batch(
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
  p_acknowledged_pickup_line_ids uuid[],
  p_selected_machine_ids uuid[]
)
RETURNS TABLE(
  pickup_batch_id uuid,
  route_status public.route_status,
  picked_stop_ids uuid[],
  pending_stop_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $function$
DECLARE
  v_pick_list_rows jsonb := COALESCE(p_pick_list_rows, '[]'::jsonb);
  v_new_stop_item_rows jsonb := COALESCE(p_new_stop_item_rows, '[]'::jsonb);
  v_checked_pickup_line_ids uuid[] := '{}'::uuid[];
  v_required_pickup_line_ids uuid[] := '{}'::uuid[];
  v_invalid_count integer := 0;
  v_pickup_batch_id uuid := NULLIF(COALESCE(p_pickup_batch->>'id', ''), '')::uuid;
  v_expected_product_summary jsonb := COALESCE(p_pickup_batch->'product_summary', '[]'::jsonb);
  v_saved_summary_signatures text[] := '{}'::text[];
  v_confirm_summary_signatures text[] := '{}'::text[];
  v_saved_selected_stop_ids uuid[] := '{}'::uuid[];
  v_confirm_selected_stop_ids uuid[] := '{}'::uuid[];
  v_saved_batch record;
  v_result record;
BEGIN
  IF jsonb_typeof(v_pick_list_rows) <> 'array' THEN
    RAISE EXCEPTION 'Pickup checklist payload is invalid.' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_new_stop_item_rows) <> 'array' THEN
    RAISE EXCEPTION 'New pickup item payload is invalid.' USING ERRCODE = 'P0001';
  END IF;

  -- The final checked rows are authoritative. They are created on the server
  -- immediately before this RPC, including deterministic IDs for manual lines.
  SELECT COALESCE(array_agg(DISTINCT x.route_stop_item_id ORDER BY x.route_stop_item_id), '{}'::uuid[])
  INTO v_checked_pickup_line_ids
  FROM jsonb_to_recordset(v_pick_list_rows)
    AS x(route_stop_item_id uuid, is_checked boolean)
  WHERE x.route_stop_item_id IS NOT NULL
    AND COALESCE(x.is_checked, false) = true;

  -- Persisted positive-quantity lines for the selected prepared stops are the
  -- required set. Zero-quantity lines and unassigned spare-stock rows do not
  -- participate in line acknowledgement validation.
  SELECT COALESCE(array_agg(DISTINCT rsi.id ORDER BY rsi.id), '{}'::uuid[])
  INTO v_required_pickup_line_ids
  FROM public.route_stop_items rsi
  JOIN public.route_stops rs ON rs.id = rsi.route_stop_id
  WHERE rs.route_id = p_route_id
    AND COALESCE(rsi.planned_quantity, 0) > 0
    AND (
      COALESCE(array_length(p_selected_stop_ids, 1), 0) = 0
      OR rsi.route_stop_id = ANY(p_selected_stop_ids)
    );

  -- A required route line may never be skipped. This is the only acknowledgement
  -- gate needed: the redundant browser array cannot create a false mismatch.
  SELECT count(*)
  INTO v_invalid_count
  FROM unnest(v_required_pickup_line_ids) AS required_id
  WHERE NOT (required_id = ANY(v_checked_pickup_line_ids));

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'Every required pickup line must be checked before confirming pickup.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Reject checked IDs that belong neither to this route/selected stop set nor to
  -- deterministic new rows being inserted in this same atomic operation.
  SELECT count(*)
  INTO v_invalid_count
  FROM unnest(v_checked_pickup_line_ids) AS checked_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.route_stop_items rsi
    JOIN public.route_stops rs ON rs.id = rsi.route_stop_id
    WHERE rsi.id = checked_id
      AND rs.route_id = p_route_id
      AND (
        COALESCE(array_length(p_selected_stop_ids, 1), 0) = 0
        OR rsi.route_stop_id = ANY(p_selected_stop_ids)
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(v_new_stop_item_rows) AS x(id uuid, route_stop_id uuid)
    WHERE x.id = checked_id
      AND (
        COALESCE(array_length(p_selected_stop_ids, 1), 0) = 0
        OR x.route_stop_id = ANY(p_selected_stop_ids)
      )
  );

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'Pickup checklist contains a stale or foreign route line.'
      USING ERRCODE = 'P0001';
  END IF;

  -- p_acknowledged_pickup_line_ids remains in the API for compatibility and
  -- diagnostics. It is intentionally not a second route-blocking source of truth.
  PERFORM COALESCE(array_length(p_acknowledged_pickup_line_ids, 1), 0);

  IF v_pickup_batch_id IS NULL THEN
    RAISE EXCEPTION 'Pickup must be prepared before confirmation.' USING ERRCODE = 'P0001';
  END IF;

  SELECT
    b.id,
    b.route_id,
    b.status,
    b.selected_stop_ids,
    b.product_summary,
    b.prepared_at,
    b.confirmed_at,
    b.returned_to_assigned_at
  INTO v_saved_batch
  FROM public.route_pickup_batches b
  WHERE b.id = v_pickup_batch_id
    AND b.route_id = p_route_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Prepared pickup batch was not found.' USING ERRCODE = 'P0001';
  END IF;

  IF v_saved_batch.returned_to_assigned_at IS NOT NULL THEN
    RAISE EXCEPTION 'Returned pickup batches cannot be confirmed.' USING ERRCODE = 'P0001';
  END IF;

  IF v_saved_batch.prepared_at IS NULL THEN
    RAISE EXCEPTION 'Pickup must be prepared before confirmation.' USING ERRCODE = 'P0001';
  END IF;

  IF jsonb_typeof(v_expected_product_summary) <> 'array' THEN
    RAISE EXCEPTION 'Prepared pickup summary is invalid.' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(
    array_agg(DISTINCT (COALESCE(x.product_id, '') || ':' || COALESCE(x.quantity, 0)::text)
      ORDER BY (COALESCE(x.product_id, '') || ':' || COALESCE(x.quantity, 0)::text)),
    '{}'::text[]
  )
  INTO v_saved_summary_signatures
  FROM jsonb_to_recordset(COALESCE(v_saved_batch.product_summary, '[]'::jsonb))
    AS x(product_id text, quantity integer);

  SELECT COALESCE(
    array_agg(DISTINCT (COALESCE(x.product_id, '') || ':' || COALESCE(x.quantity, 0)::text)
      ORDER BY (COALESCE(x.product_id, '') || ':' || COALESCE(x.quantity, 0)::text)),
    '{}'::text[]
  )
  INTO v_confirm_summary_signatures
  FROM jsonb_to_recordset(v_expected_product_summary)
    AS x(product_id text, quantity integer);

  IF v_saved_summary_signatures <> v_confirm_summary_signatures THEN
    RAISE EXCEPTION 'Prepared pickup summary does not match the saved preparation snapshot.'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[])
  INTO v_saved_selected_stop_ids
  FROM unnest(COALESCE(v_saved_batch.selected_stop_ids, '{}'::uuid[])) AS x;

  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[])
  INTO v_confirm_selected_stop_ids
  FROM unnest(COALESCE(p_selected_stop_ids, '{}'::uuid[])) AS x;

  IF v_saved_selected_stop_ids <> v_confirm_selected_stop_ids THEN
    RAISE EXCEPTION 'Prepared pickup stops do not match the current confirmation payload.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Delegate directly to the original atomic implementation. No wrapper-to-wrapper
  -- positional call remains, so selected_machine_ids cannot be shifted into the
  -- acknowledgement slot.
  SELECT *
  INTO v_result
  FROM public.confirm_route_pickup_batch_atomic_core(
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

  UPDATE public.route_pickup_batches
  SET
    status = 'confirmed',
    selected_stop_ids = COALESCE(p_selected_stop_ids, selected_stop_ids),
    product_summary = COALESCE(v_expected_product_summary, product_summary),
    storage_deducted = COALESCE((p_pickup_batch->>'storage_deducted')::boolean, storage_deducted),
    confirmed_at = COALESCE(NULLIF(p_pickup_batch->>'confirmed_at', '')::timestamptz, confirmed_at, now()),
    updated_at = now()
  WHERE id = v_pickup_batch_id;

  pickup_batch_id := v_result.pickup_batch_id;
  route_status := v_result.route_status;
  picked_stop_ids := v_result.picked_stop_ids;
  pending_stop_count := v_result.pending_stop_count;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.confirm_route_pickup_batch(
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
) FROM public;

GRANT EXECUTE ON FUNCTION public.confirm_route_pickup_batch(
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
) TO authenticated;

REVOKE ALL ON FUNCTION public.confirm_route_pickup_batch(
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
) FROM public;

GRANT EXECUTE ON FUNCTION public.confirm_route_pickup_batch(
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
) TO authenticated;

SELECT pg_notify('pgrst', 'reload schema');
