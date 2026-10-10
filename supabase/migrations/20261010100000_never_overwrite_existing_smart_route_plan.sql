-- Preserve manually created and already assigned routes.
-- AI Smart Route is a manager-side draft planner; it must not replace an
-- existing approved pickup/refill plan even before the operator collects stock.
DO $guard$
DECLARE
  v_definition text;
  v_needle text := '  if jsonb_typeof(p_items) is distinct from ''array''';
  v_check text := $check$
  if v_route.status::text not in ('draft', 'assigned', 'available', 'ready') then
    raise exception 'Smart Route cannot change a route once work has started. Existing manual instructions are protected.';
  end if;
  if exists (select 1 from public.route_stop_items where route_id = p_route_id)
    or exists (select 1 from public.route_stock_lines where route_id = p_route_id)
    or exists (select 1 from public.refill_orders where route_id = p_route_id)
    or exists (select 1 from public.route_pick_list_items where route_id = p_route_id and coalesce(is_active, true))
  then
    raise exception 'Smart Route cannot overwrite an existing route plan. Keep the manually assigned products and quantities.';
  end if;

$check$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_definition
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'snacky_apply_smart_route_plan_v1'
    AND pg_get_function_identity_arguments(p.oid) = 'p_route_id uuid, p_items jsonb';
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'The Smart Route apply function does not exist.';
  END IF;
  IF position('Smart Route cannot overwrite an existing route plan' in v_definition) = 0 THEN
    IF position(v_needle in v_definition) = 0 THEN
      RAISE EXCEPTION 'Unrecognized Smart Route function definition: aborting protection migration.';
    END IF;
    EXECUTE replace(v_definition, v_needle, v_check || v_needle);
  END IF;
END;
$guard$;
