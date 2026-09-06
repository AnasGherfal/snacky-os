-- Serialize every operator personal purchase against the same physical
-- storage/product balance used by route pickup and purchase receipt RPCs.
-- Both supported API signatures delegate to one command implementation so a
-- backdated entry cannot bypass the live-stock and idempotency contracts.

create or replace function public.operator_money_reserved_qty(
  p_product_id uuid
)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(pg_catalog.sum(
    greatest(
      coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0),
      0
    )::bigint
  ), 0::bigint)::integer
  from public.route_stock_lines stock_line
  join public.routes route_row on route_row.id = stock_line.route_id
  where stock_line.product_id = p_product_id
    and route_row.status::text in (
      'draft', 'planned', 'assigned', 'in_progress', 'pickup_confirmed',
      'pending_pickup', 'available', 'ready', 'started', 'filling',
      'machine_filling', 'partially_completed', 'stop_completed'
    );
$function$;

create or replace function public.operator_money_available_storage(
  p_product_id uuid
)
returns table (
  storage_location_id uuid,
  storage_name text,
  on_hand_qty integer,
  reserved_qty integer,
  available_qty integer
)
language sql
stable
security definer
set search_path = ''
as $function$
  with stock as (
    select
      storage.id as storage_location_id,
      storage.name as storage_name,
      coalesce(inventory.quantity_on_hand, 0)::integer as on_hand_qty
    from public.storage_locations storage
    left join public.current_inventory_by_location inventory
      on inventory.location_type = 'storage'
     and inventory.location_id = storage.id
     and inventory.product_id = p_product_id
    where coalesce(storage.active, true) = true
      and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
  ), ranked as (
    select
      stock.*,
      coalesce(pg_catalog.sum(stock.on_hand_qty) over (
        order by stock.on_hand_qty desc, stock.storage_name, stock.storage_location_id
        rows between unbounded preceding and 1 preceding
      ), 0)::integer as stock_before,
      public.operator_money_reserved_qty(p_product_id)::integer as total_reserved
    from stock
  )
  select
    ranked.storage_location_id,
    ranked.storage_name,
    ranked.on_hand_qty,
    least(
      ranked.on_hand_qty,
      greatest(ranked.total_reserved - ranked.stock_before, 0)
    )::integer as reserved_qty,
    greatest(
      ranked.on_hand_qty
        - greatest(ranked.total_reserved - ranked.stock_before, 0),
      0
    )::integer as available_qty
  from ranked
  order by available_qty desc, ranked.storage_name, ranked.storage_location_id;
$function$;

create or replace function public._snacky_create_operator_personal_purchase_v2(
  p_person_id uuid,
  p_period_id uuid,
  p_product_id uuid,
  p_storage_location_id uuid,
  p_quantity integer,
  p_purchased_at timestamptz,
  p_note text,
  p_client_submission_id text,
  p_selected_period boolean
)
returns public.operator_personal_purchases
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_is_manager boolean;
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_request_payload jsonb;
  v_period public.operator_money_periods%rowtype;
  v_effective_period_id uuid;
  v_effective_purchased_at timestamptz;
  v_local_date date;
  v_storage_lock record;
  v_price numeric(12,2);
  v_on_hand bigint := 0;
  v_reserved bigint := 0;
  v_available bigint := 0;
  v_purchase public.operator_personal_purchases%rowtype;
  v_existing_movement public.inventory_movements%rowtype;
  v_purchase_id uuid;
  v_movement_id uuid;
  v_result_payload jsonb;
begin
  if v_actor_user_id is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;

  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable personal purchase submission id between 1 and 200 characters is required.'
      using errcode = '22023';
  end if;
  if p_person_id is null or p_product_id is null or p_storage_location_id is null then
    raise exception 'Operator, product, and storage location are required.' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be positive.' using errcode = '23514';
  end if;
  if pg_catalog.length(coalesce(p_note, '')) > 2000 then
    raise exception 'Personal purchase notes cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  if coalesce(p_selected_period, false) then
    if p_period_id is null or p_purchased_at is null then
      raise exception 'Selected money period and item taken date are required.' using errcode = '22023';
    end if;
    if p_purchased_at > pg_catalog.now() + interval '5 minutes' then
      raise exception 'Item taken date cannot be in the future.' using errcode = '23514';
    end if;
  elsif p_period_id is not null or p_purchased_at is not null then
    raise exception 'Current-period purchases cannot override their period or item taken date.'
      using errcode = '22023';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'mode', case when coalesce(p_selected_period, false) then 'selected_period' else 'current_period' end,
    'person_id', p_person_id,
    'period_id', p_period_id,
    'product_id', p_product_id,
    'storage_location_id', p_storage_location_id,
    'quantity', p_quantity,
    'purchased_at', p_purchased_at,
    'note', v_note
  );

  -- One client operation owns one result, even across the two public wrappers.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:operator-personal-purchase:v2:' || v_submission_id,
      0
    )
  );

  -- A lost-response retry is evaluated before mutable period, product, and
  -- stock state. The original actor and every immutable business field must
  -- still match, otherwise the reused key is rejected rather than aliased.
  select purchase.*
  into v_purchase
  from public.operator_personal_purchases purchase
  where purchase.client_submission_id = v_submission_id
  for update;

  if found then
    if v_purchase.created_by is distinct from v_actor_team_member_id
      or v_purchase.person_id is distinct from p_person_id
      or v_purchase.product_id is distinct from p_product_id
      or v_purchase.storage_location_id is distinct from p_storage_location_id
      or v_purchase.quantity is distinct from p_quantity
      or nullif(pg_catalog.btrim(coalesce(v_purchase.note, '')), '') is distinct from v_note
      or (
        coalesce(p_selected_period, false)
        and (
          v_purchase.period_id is distinct from p_period_id
          or v_purchase.purchased_at is distinct from p_purchased_at
        )
      )
    then
      raise exception 'This personal purchase submission id was already used with a different immutable payload.'
        using errcode = '23505';
    end if;

    if v_purchase.inventory_movement_id is null then
      raise exception 'The saved personal purchase has no inventory movement proof; manual review is required.'
        using errcode = '23514';
    end if;

    select movement.*
    into v_existing_movement
    from public.inventory_movements movement
    where movement.id = v_purchase.inventory_movement_id
    for update;

    if not found
      or v_existing_movement.product_id is distinct from v_purchase.product_id
      or v_existing_movement.quantity is distinct from v_purchase.quantity
      or v_existing_movement.from_entity_type::text <> 'storage'
      or v_existing_movement.from_entity_id is distinct from v_purchase.storage_location_id
      or v_existing_movement.to_entity_type::text <> 'operator_personal_purchase'
      or v_existing_movement.to_entity_id is distinct from v_purchase.person_id
      or v_existing_movement.reason::text <> 'operator_personal_purchase'
      or v_existing_movement.idempotency_key is distinct from v_submission_id
      or v_existing_movement.created_by is distinct from v_purchase.created_by
      or v_existing_movement.source_type is distinct from 'operator_personal_purchase'
      or v_existing_movement.source_id is distinct from v_purchase.id
      or v_existing_movement.reversed_movement_id is not null
      or exists (
        select 1
        from public.inventory_movements reversal
        where reversal.reversed_movement_id = v_existing_movement.id
      )
      or pg_catalog.jsonb_typeof(v_existing_movement.idempotency_payload) is distinct from 'object'
      or v_existing_movement.idempotency_payload -> 'request' is distinct from v_request_payload
      or v_existing_movement.idempotency_payload #> '{result,purchase_id}' is distinct from pg_catalog.to_jsonb(v_purchase.id)
      or v_existing_movement.idempotency_payload #> '{result,period_id}' is distinct from pg_catalog.to_jsonb(v_purchase.period_id)
      or v_existing_movement.idempotency_payload #> '{result,purchased_at}' is distinct from pg_catalog.to_jsonb(v_purchase.purchased_at)
      or v_existing_movement.idempotency_payload #> '{result,unit_price_lyd}' is distinct from pg_catalog.to_jsonb(v_purchase.unit_price_lyd)
    then
      raise exception 'The saved personal purchase inventory proof does not match its immutable request; manual review is required.'
        using errcode = '23514';
    end if;

    return v_purchase;
  end if;

  v_is_manager := public.snacky_current_profile_has_any_role(array['owner', 'admin']);
  if coalesce(p_selected_period, false) then
    if not v_is_manager then
      raise exception 'Only owner/admin can add an item to a selected money period.' using errcode = '42501';
    end if;

    select period.*
    into v_period
    from public.operator_money_periods period
    where period.id = p_period_id
      and period.person_id = p_person_id
    for update;

    if not found then
      raise exception 'Money period not found for this operator.' using errcode = 'P0002';
    end if;
    if v_period.lifecycle_status <> 'open' or v_period.settled_at is not null then
      raise exception 'The selected operator money period is closed or settled.' using errcode = '23514';
    end if;

    v_local_date := (p_purchased_at at time zone 'Africa/Tripoli')::date;
    if v_local_date < v_period.period_start or v_local_date > v_period.period_end then
      raise exception 'Item taken date must be inside the selected money period.' using errcode = '23514';
    end if;
    v_effective_period_id := v_period.id;
    v_effective_purchased_at := p_purchased_at;
  else
    if not v_is_manager and v_actor_team_member_id is distinct from p_person_id then
      raise exception 'Operators can only buy for themselves.' using errcode = '42501';
    end if;
    v_effective_purchased_at := pg_catalog.now();
    v_effective_period_id := public.snacky_operator_money_period_for_timestamp(
      p_person_id,
      v_effective_purchased_at,
      true
    );
  end if;

  if not exists (
    select 1
    from public.storage_locations storage
    where storage.id = p_storage_location_id
      and coalesce(storage.active, true) = true
      and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
  ) then
    raise exception 'The selected storage location is missing or inactive.' using errcode = '23503';
  end if;

  -- Route pickup V3 and purchase receive/void acquire these two-key advisory
  -- locks in storage-id/product-id order. Lock every active storage for this
  -- product in that same deterministic order because route reservations are
  -- distributed once across the complete storage set.
  for v_storage_lock in
    select storage.id
    from public.storage_locations storage
    where coalesce(storage.active, true) = true
      and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
    order by storage.id, p_product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_product_id::text),
      pg_catalog.hashtext(v_storage_lock.id::text)
    );
  end loop;

  select coalesce(
      nullif(product.current_selling_price_lyd, 0),
      nullif(product.selling_price, 0),
      0
    )::numeric(12,2)
  into v_price
  from public.products product
  where product.id = p_product_id
    and product.active = true
  for share;

  if not found then
    raise exception 'Active product not found.' using errcode = 'P0002';
  end if;
  if v_price <= 0 then
    raise exception 'Product selling price is missing or invalid.' using errcode = '23514';
  end if;

  -- Recheck the selected location after waiting for the advisory lock so a
  -- concurrent storage retirement cannot be mistaken for available stock.
  perform 1
  from public.storage_locations storage
  where storage.id = p_storage_location_id
    and coalesce(storage.active, true) = true
    and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
  for share;
  if not found then
    raise exception 'The selected storage location became inactive.' using errcode = '40001';
  end if;

  select coalesce(inventory.on_hand_qty, 0)::bigint,
         coalesce(inventory.reserved_qty, 0)::bigint,
         coalesce(inventory.available_qty, 0)::bigint
  into v_on_hand, v_reserved, v_available
  from public.operator_money_available_storage(p_product_id) inventory
  where inventory.storage_location_id = p_storage_location_id;

  if not found then
    raise exception 'The selected storage location is unavailable.' using errcode = '23503';
  end if;
  if v_on_hand < p_quantity::bigint then
    raise exception 'Not enough physical storage stock. Needed %, physically on hand %.',
      p_quantity,
      greatest(v_on_hand, 0::bigint)
      using errcode = '23514';
  end if;
  if v_available < p_quantity::bigint then
    raise exception 'Not enough available storage stock after route reservations. Needed %, available %, reserved %.',
      p_quantity,
      greatest(v_available, 0::bigint),
      greatest(v_reserved, 0::bigint)
      using errcode = '23514';
  end if;

  v_purchase_id := pg_catalog.gen_random_uuid();
  v_result_payload := pg_catalog.jsonb_build_object(
    'purchase_id', v_purchase_id,
    'period_id', v_effective_period_id,
    'purchased_at', v_effective_purchased_at,
    'unit_price_lyd', v_price
  );

  insert into public.inventory_movements (
    product_id,
    quantity,
    from_entity_type,
    from_entity_id,
    to_entity_type,
    to_entity_id,
    reason,
    idempotency_key,
    idempotency_payload,
    source_type,
    source_id,
    created_by,
    notes
  ) values (
    p_product_id,
    p_quantity,
    'storage',
    p_storage_location_id,
    'operator_personal_purchase',
    p_person_id,
    'operator_personal_purchase',
    v_submission_id,
    pg_catalog.jsonb_build_object(
      'request', v_request_payload,
      'result', v_result_payload
    ),
    'operator_personal_purchase',
    v_purchase_id,
    v_actor_team_member_id,
    pg_catalog.concat_ws(
      ' · ',
      v_note,
      'Recorded for operator money period ' || v_effective_period_id::text,
      'Item taken date ' || ((v_effective_purchased_at at time zone 'Africa/Tripoli')::date)::text
    )
  )
  returning id into v_movement_id;

  insert into public.operator_personal_purchases (
    id,
    person_id,
    period_id,
    product_id,
    storage_location_id,
    quantity,
    unit_price_lyd,
    note,
    inventory_movement_id,
    client_submission_id,
    created_by,
    purchased_at
  ) values (
    v_purchase_id,
    p_person_id,
    v_effective_period_id,
    p_product_id,
    p_storage_location_id,
    p_quantity,
    v_price,
    v_note,
    v_movement_id,
    v_submission_id,
    v_actor_team_member_id,
    v_effective_purchased_at
  )
  returning * into v_purchase;

  return v_purchase;
end;
$function$;

create or replace function public.create_operator_personal_purchase(
  p_person_id uuid,
  p_product_id uuid,
  p_storage_location_id uuid,
  p_quantity integer,
  p_unit_price_lyd numeric,
  p_note text,
  p_client_submission_id text
)
returns public.operator_personal_purchases
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  -- p_unit_price_lyd remains only for PostgREST signature compatibility. The
  -- canonical product selling price is always selected inside the command.
  return public._snacky_create_operator_personal_purchase_v2(
    p_person_id,
    null,
    p_product_id,
    p_storage_location_id,
    p_quantity,
    null,
    p_note,
    p_client_submission_id,
    false
  );
end;
$function$;

create or replace function public.create_operator_personal_purchase_for_period(
  p_person_id uuid,
  p_period_id uuid,
  p_product_id uuid,
  p_storage_location_id uuid,
  p_quantity integer,
  p_purchased_at timestamptz,
  p_note text,
  p_client_submission_id text
)
returns public.operator_personal_purchases
language plpgsql
volatile
security definer
set search_path = ''
as $function$
begin
  return public._snacky_create_operator_personal_purchase_v2(
    p_person_id,
    p_period_id,
    p_product_id,
    p_storage_location_id,
    p_quantity,
    p_purchased_at,
    p_note,
    p_client_submission_id,
    true
  );
end;
$function$;

revoke all on function public.operator_money_reserved_qty(uuid)
  from public, anon, authenticated;
grant execute on function public.operator_money_reserved_qty(uuid)
  to service_role;

revoke all on function public.operator_money_available_storage(uuid)
  from public, anon, authenticated;
grant execute on function public.operator_money_available_storage(uuid)
  to service_role;

revoke all on function public._snacky_create_operator_personal_purchase_v2(
  uuid, uuid, uuid, uuid, integer, timestamptz, text, text, boolean
) from public, anon, authenticated, service_role;

revoke all on function public.create_operator_personal_purchase(
  uuid, uuid, uuid, integer, numeric, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_operator_personal_purchase(
  uuid, uuid, uuid, integer, numeric, text, text
) to authenticated, service_role;

revoke all on function public.create_operator_personal_purchase_for_period(
  uuid, uuid, uuid, uuid, integer, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_operator_personal_purchase_for_period(
  uuid, uuid, uuid, uuid, integer, timestamptz, text, text
) to authenticated, service_role;

-- This drift-only legacy writer targets a second debt table, accepts a browser
-- price, uses the operator-bag endpoint without a route, and does not share the
-- storage lock. It has no repository caller and must not remain an alternate
-- authenticated inventory write surface where it happens to exist.
do $legacy_writer$
begin
  if pg_catalog.to_regprocedure(
    'public.snacky_record_operator_personal_purchase(jsonb)'
  ) is not null then
    execute 'revoke all on function public.snacky_record_operator_personal_purchase(jsonb) from public, anon, authenticated, service_role';
  end if;
end;
$legacy_writer$;

select pg_catalog.pg_notify('pgrst', 'reload schema');
