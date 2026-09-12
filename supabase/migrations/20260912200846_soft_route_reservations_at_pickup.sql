-- Route reservations are planning guidance, not physical custody.
--
-- When an operator is physically collecting a route, another route's pending
-- reservation must not block stock that is still recorded in storage. The
-- pickup remains protected by the physical on-hand check and the atomic
-- inventory ledger transaction. A later route that encounters the resulting
-- shortage records its lower picked quantity for review instead of falsifying
-- stock or breaking the current pickup.

do $soft_route_reservations_at_pickup$
declare
  v_definition text;
  v_before text;
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure(
      'public.snacky_confirm_route_pickup_batch_v3(uuid,public.route_status,public.route_status,timestamp with time zone,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[],uuid[])'
    )
  ) into v_definition;

  if v_definition is null then
    raise exception 'Missing route pickup V3 function.' using errcode = '42883';
  end if;

  v_before := v_definition;
  v_definition := pg_catalog.replace(
    v_definition,
    $hard_reservation_guard$
    if not v_is_admin_correction then
      select coalesce(pg_catalog.sum(
        greatest(
          coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0),
          0
        )::bigint
      ), 0::bigint)
      into v_stock_reserved_elsewhere
      from public.route_stock_lines stock_line
      join public.routes route_row on route_row.id = stock_line.route_id
      where stock_line.product_id = v_storage_lock.product_id
        and stock_line.route_id is distinct from p_route_id
        and route_row.status::text in (
          'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready',
          'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'
        );

      if v_stock_on_hand - v_stock_reserved_elsewhere < v_stock_needed then
        raise exception 'Not enough available storage stock after route reservations. Needed %, available %.',
          v_stock_needed,
          greatest(v_stock_on_hand - v_stock_reserved_elsewhere, 0::bigint)
          using errcode = '23514';
      end if;
    end if;
$hard_reservation_guard$,
    $soft_reservation_guard$
    -- Reservations remain visible to planning and system-health screens, but
    -- physical pickup order decides custody. The physical on-hand guard above
    -- is the authoritative safety limit for this transaction.
$soft_reservation_guard$
  );

  if v_definition = v_before then
    raise exception 'Could not locate the route pickup reservation guard.' using errcode = '23514';
  end if;

  if pg_catalog.strpos(
    v_definition,
    'Not enough physical storage stock. Needed %, physically on hand %.'
  ) = 0 then
    raise exception 'Physical stock protection was removed unexpectedly.' using errcode = '23514';
  end if;

  if pg_catalog.strpos(
    v_definition,
    'Not enough available storage stock after route reservations.'
  ) > 0 then
    raise exception 'Route reservations still hard-block pickup.' using errcode = '23514';
  end if;

  execute v_definition;
end;
$soft_route_reservations_at_pickup$;

comment on function public.snacky_confirm_route_pickup_batch_v3(
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
) is
  'Atomically confirms route pickup against physical storage stock. Other route reservations are soft planning signals and never block a physical pickup.';

select pg_catalog.pg_notify('pgrst', 'reload schema');
