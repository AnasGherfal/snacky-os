-- Purchase receipt and void are inventory commands, not a sequence of REST
-- writes. Persist an immutable command receipt so a lost response can be
-- replayed exactly, while malformed legacy purchase ledgers fail to review.

create table if not exists public.purchase_inventory_operations (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchase_orders(id) on delete restrict,
  action text not null,
  client_submission_id text not null,
  request_payload jsonb not null,
  result_payload jsonb not null,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint purchase_inventory_operations_action_check
    check (action in ('receive', 'void')),
  constraint purchase_inventory_operations_submission_nonblank
    check (nullif(btrim(client_submission_id), '') is not null),
  constraint purchase_inventory_operations_request_object
    check (jsonb_typeof(request_payload) = 'object'),
  constraint purchase_inventory_operations_result_object
    check (jsonb_typeof(result_payload) = 'object'),
  constraint purchase_inventory_operations_purchase_action_key
    unique (purchase_id, action),
  constraint purchase_inventory_operations_submission_key
    unique (client_submission_id)
);

create index if not exists idx_purchase_inventory_operations_created
  on public.purchase_inventory_operations(created_at desc);

alter table public.purchase_inventory_operations enable row level security;
revoke all on table public.purchase_inventory_operations
  from public, anon, authenticated, service_role;

comment on table public.purchase_inventory_operations is
  'Private immutable exactly-once command receipts for atomic purchase receive and void operations.';

create or replace function public.snacky_guard_purchase_inventory_operation_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Completed purchase inventory command receipts are immutable.'
    using errcode = '23514';
end;
$function$;

revoke all on function public.snacky_guard_purchase_inventory_operation_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_purchase_inventory_operations_immutable
  on public.purchase_inventory_operations;
create trigger snacky_purchase_inventory_operations_immutable
before update or delete on public.purchase_inventory_operations
for each row
execute function public.snacky_guard_purchase_inventory_operation_immutable();

-- A void can invalidate the last purchase pointer while the historical numeric
-- value remains the only known cost. Name that provenance honestly instead of
-- relabeling it as a manual edit.
alter table public.products
  drop constraint if exists products_cost_price_source_check;
alter table public.products
  add constraint products_cost_price_source_check
  check (cost_price_source in (
    'initial_import', 'latest_purchase', 'manual', 'vms', 'average_cost',
    'historical_memory'
  ));

-- Lock every storage/product balance and immutable movement involved in an
-- existing purchase receipt. Callers lock the purchase row and its lines first.
-- The order is shared by receive, void, and their exact-retry verification:
-- purchase -> sorted storage/product -> sorted product -> sorted movement.
-- Multi-key storage locks are ordered storage first, then product, matching
-- route pickup V3's pre-lock order.
create or replace function public._snacky_lock_purchase_receipt_inventory_v1(
  p_purchase_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_storage_lock record;
  v_product_lock record;
  v_movement_lock record;
begin
  for v_storage_lock in
    select distinct
      movement.product_id,
      movement.to_entity_id as storage_location_id
    from public.inventory_movements movement
    where movement.reason::text = 'purchase_received'
      and (
        movement.related_purchase_id = p_purchase_id
        or movement.related_purchase_line_id in (
          select line.id
          from public.purchase_order_lines line
          where line.purchase_order_id = p_purchase_id
        )
      )
      and movement.product_id is not null
      and movement.to_entity_type::text = 'storage'
      and movement.to_entity_id is not null
    order by movement.to_entity_id, movement.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_storage_lock.product_id::text),
      pg_catalog.hashtext(v_storage_lock.storage_location_id::text)
    );
  end loop;

  for v_product_lock in
    select product.id
    from public.products product
    where product.id in (
      select distinct line.product_id
      from public.purchase_order_lines line
      where line.purchase_order_id = p_purchase_id
    )
    order by product.id
    for update
  loop
    null;
  end loop;

  for v_movement_lock in
    select movement.id
    from public.inventory_movements movement
    where movement.reason::text = 'purchase_received'
      and (
        movement.related_purchase_id = p_purchase_id
        or movement.related_purchase_line_id in (
          select line.id
          from public.purchase_order_lines line
          where line.purchase_order_id = p_purchase_id
        )
      )
    order by movement.to_entity_id, movement.product_id, movement.id
    for update
  loop
    null;
  end loop;

  for v_movement_lock in
    select reversal.id
    from public.inventory_movements receipt
    join public.inventory_movements reversal
      on reversal.reversed_movement_id = receipt.id
    where receipt.reason::text = 'purchase_received'
      and (
        receipt.related_purchase_id = p_purchase_id
        or receipt.related_purchase_line_id in (
          select line.id
          from public.purchase_order_lines line
          where line.purchase_order_id = p_purchase_id
        )
      )
    order by receipt.to_entity_id, receipt.product_id, receipt.id, reversal.id
    for update of reversal
  loop
    null;
  end loop;
end;
$function$;

revoke all on function public._snacky_lock_purchase_receipt_inventory_v1(uuid)
  from public, anon, authenticated, service_role;

-- Prove that every positive purchase line owns exactly one matching receipt and
-- that the expected reversal state is exact. This function never repairs data.
create or replace function public._snacky_assert_purchase_inventory_state_v1(
  p_purchase_id uuid,
  p_expected_state text,
  p_void_reason text default null,
  p_require_receipt_provenance boolean default false,
  p_require_reversal_provenance boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_purchase public.purchase_orders%rowtype;
  v_state text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_expected_state, '')), ''));
  v_void_reason text := nullif(pg_catalog.btrim(coalesce(p_void_reason, '')), '');
  v_line_count integer;
  v_invalid_line_count integer;
  v_received_qty_mismatch_count integer;
  v_receipt_count integer;
  v_receipt_mismatch_count integer;
  v_reversal_count integer;
  v_reversal_mismatch_count integer;
  v_total_units bigint;
  v_receipt_ids jsonb;
  v_reversal_ids jsonb;
  v_storage_ids jsonb;
begin
  if v_state is null or v_state not in ('received', 'voided') then
    raise exception 'Purchase inventory state assertion must be received or voided.' using errcode = '22023';
  end if;

  select purchase.*
  into v_purchase
  from public.purchase_orders purchase
  where purchase.id = p_purchase_id;

  if not found then
    raise exception 'Purchase was not found.' using errcode = '23503';
  end if;

  if v_purchase.status is distinct from v_state then
    raise exception 'Purchase inventory needs review: purchase status is %, expected %. Nothing was changed.',
      coalesce(v_purchase.status, 'null'),
      v_state
      using errcode = '23514';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where line.product_id is null
        or coalesce(line.total_units, 0) <= 0
        or coalesce(line.received_qty, 0) < 0
        or coalesce(line.unit_cost_lyd, line.unit_cost, 0) < 0
        or coalesce(line.line_total_lyd, line.line_total, 0) < 0
    )::integer,
    coalesce(pg_catalog.sum(line.total_units::bigint), 0::bigint)
  into v_line_count, v_invalid_line_count, v_total_units
  from public.purchase_order_lines line
  where line.purchase_order_id = p_purchase_id;

  if v_line_count = 0 or v_invalid_line_count > 0 then
    raise exception 'Purchase inventory needs review: purchase lines are missing or invalid. Nothing was changed.'
      using errcode = '23514';
  end if;

  select pg_catalog.count(*)::integer
  into v_received_qty_mismatch_count
  from public.purchase_order_lines line
  where line.purchase_order_id = p_purchase_id
    and (
      (v_state = 'received' and line.received_qty is distinct from line.total_units)
      or (v_state = 'voided' and coalesce(line.received_qty, 0) <> 0)
    );

  if v_received_qty_mismatch_count > 0 then
    raise exception 'Purchase inventory needs review: line received quantities do not match the % state. Nothing was changed.',
      v_state
      using errcode = '23514';
  end if;

  select pg_catalog.count(*)::integer
  into v_receipt_count
  from public.inventory_movements movement
  where movement.reason::text = 'purchase_received'
    and (
      movement.related_purchase_id = p_purchase_id
      or movement.related_purchase_line_id in (
        select line.id
        from public.purchase_order_lines line
        where line.purchase_order_id = p_purchase_id
      )
    );

  if v_receipt_count <> v_line_count then
    raise exception 'Purchase inventory needs review: expected % receipt movements but found %. Nothing was changed.',
      v_line_count,
      v_receipt_count
      using errcode = '23514';
  end if;

  select pg_catalog.count(*)::integer
  into v_receipt_mismatch_count
  from public.purchase_order_lines line
  left join public.inventory_movements movement
    on movement.related_purchase_line_id = line.id
   and movement.reason::text = 'purchase_received'
  where line.purchase_order_id = p_purchase_id
    and (
      movement.id is null
      or movement.related_purchase_id is distinct from p_purchase_id
      or movement.product_id is distinct from line.product_id
      or movement.quantity is distinct from line.total_units
      or movement.from_entity_type::text is distinct from 'supplier'
      or movement.from_entity_id is distinct from v_purchase.supplier_id
      or movement.to_entity_type::text is distinct from 'storage'
      or movement.to_entity_id is null
      or movement.reversed_movement_id is not null
      or pg_catalog.round(coalesce(movement.unit_cost_lyd, 0)::numeric, 4)
        is distinct from pg_catalog.round(coalesce(line.unit_cost_lyd, line.unit_cost, 0)::numeric, 4)
      or pg_catalog.round(coalesce(movement.line_total_lyd, 0)::numeric, 2)
        is distinct from pg_catalog.round(coalesce(line.line_total_lyd, line.line_total, 0)::numeric, 2)
      or (
        p_require_receipt_provenance
        and (
          movement.source_type is distinct from 'purchase_receipt'
          or movement.source_id is distinct from p_purchase_id
          or movement.idempotency_key is distinct from (
            'purchase-receipt:v1:' || p_purchase_id::text || ':' || line.id::text
          )
          or not (coalesce(movement.idempotency_payload, '{}'::jsonb) @> pg_catalog.jsonb_build_object(
            'contract_version', 1,
            'purchase_id', p_purchase_id,
            'purchase_line_id', line.id,
            'product_id', line.product_id,
            'storage_location_id', movement.to_entity_id,
            'quantity', line.total_units
          ))
        )
      )
    );

  if v_receipt_mismatch_count > 0 then
    raise exception 'Purchase inventory needs review: one or more receipt movements do not exactly match their purchase lines. Nothing was changed.'
      using errcode = '23514';
  end if;

  select pg_catalog.count(*)::integer
  into v_reversal_count
  from public.inventory_movements receipt
  join public.inventory_movements reversal
    on reversal.reversed_movement_id = receipt.id
  where receipt.reason::text = 'purchase_received'
    and receipt.related_purchase_id = p_purchase_id;

  if v_state = 'received' and v_reversal_count <> 0 then
    raise exception 'Purchase inventory needs review: a received purchase already has reversal movements. Nothing was changed.'
      using errcode = '23514';
  end if;

  if v_state = 'voided' then
    if v_void_reason is null then
      raise exception 'Purchase inventory needs review: a voided purchase has no reason. Nothing was changed.'
        using errcode = '23514';
    end if;

    if v_purchase.payment_status is distinct from 'voided'
      or nullif(pg_catalog.btrim(coalesce(v_purchase.void_reason, '')), '') is distinct from v_void_reason
    then
      raise exception 'Purchase inventory needs review: void status metadata is incomplete or inconsistent. Nothing was changed.'
        using errcode = '23514';
    end if;

    if v_reversal_count <> v_receipt_count then
      raise exception 'Purchase inventory needs review: expected % receipt reversals but found %. Nothing was changed.',
        v_receipt_count,
        v_reversal_count
        using errcode = '23514';
    end if;

    select pg_catalog.count(*)::integer
    into v_reversal_mismatch_count
    from public.inventory_movements receipt
    left join public.inventory_movements reversal
      on reversal.reversed_movement_id = receipt.id
    where receipt.reason::text = 'purchase_received'
      and receipt.related_purchase_id = p_purchase_id
      and (
        reversal.id is null
        or reversal.product_id is distinct from receipt.product_id
        or reversal.quantity is distinct from receipt.quantity
        or reversal.from_entity_type is distinct from receipt.to_entity_type
        or reversal.from_entity_id is distinct from receipt.to_entity_id
        or reversal.to_entity_type is distinct from receipt.from_entity_type
        or reversal.to_entity_id is distinct from receipt.from_entity_id
        or reversal.reason::text is distinct from 'manual_correction'
        or reversal.related_purchase_id is distinct from p_purchase_id
        or reversal.related_purchase_line_id is distinct from receipt.related_purchase_line_id
        or reversal.related_route_id is distinct from receipt.related_route_id
        or reversal.related_route_stop_id is distinct from receipt.related_route_stop_id
        or reversal.related_machine_id is distinct from receipt.related_machine_id
        or pg_catalog.round(coalesce(reversal.unit_cost_lyd, 0)::numeric, 4)
          is distinct from pg_catalog.round(coalesce(receipt.unit_cost_lyd, 0)::numeric, 4)
        or pg_catalog.round(coalesce(reversal.line_total_lyd, 0)::numeric, 2)
          is distinct from -pg_catalog.round(coalesce(receipt.line_total_lyd, 0)::numeric, 2)
        or nullif(pg_catalog.btrim(coalesce(reversal.correction_reason, '')), '') is distinct from v_void_reason
        or reversal.source_type is distinct from 'purchase_void'
        or reversal.source_id is distinct from p_purchase_id
        or (
          p_require_reversal_provenance
          and (
            reversal.idempotency_key is distinct from (
              'purchase-void:v1:' || p_purchase_id::text || ':' || receipt.id::text
            )
            or not (coalesce(reversal.idempotency_payload, '{}'::jsonb) @> pg_catalog.jsonb_build_object(
              'contract_version', 1,
              'purchase_id', p_purchase_id,
              'receipt_movement_id', receipt.id,
              'reason', v_void_reason
            ))
          )
        )
      );

    if v_reversal_mismatch_count > 0 then
      raise exception 'Purchase inventory needs review: one or more reversal movements do not exactly negate their receipts. Nothing was changed.'
        using errcode = '23514';
    end if;
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(receipt_row.id order by receipt_row.line_position, receipt_row.line_id),
    '[]'::jsonb
  )
  into v_receipt_ids
  from (
    select movement.id, line.line_position, line.id as line_id
    from public.purchase_order_lines line
    join public.inventory_movements movement
      on movement.related_purchase_line_id = line.id
     and movement.reason::text = 'purchase_received'
    where line.purchase_order_id = p_purchase_id
  ) receipt_row;

  select coalesce(
    pg_catalog.jsonb_agg(reversal_row.id order by reversal_row.line_position, reversal_row.line_id),
    '[]'::jsonb
  )
  into v_reversal_ids
  from (
    select reversal.id, line.line_position, line.id as line_id
    from public.purchase_order_lines line
    join public.inventory_movements receipt
      on receipt.related_purchase_line_id = line.id
     and receipt.reason::text = 'purchase_received'
    join public.inventory_movements reversal
      on reversal.reversed_movement_id = receipt.id
    where line.purchase_order_id = p_purchase_id
  ) reversal_row;

  select coalesce(
    pg_catalog.jsonb_agg(storage_row.storage_location_id order by storage_row.storage_location_id),
    '[]'::jsonb
  )
  into v_storage_ids
  from (
    select distinct movement.to_entity_id as storage_location_id
    from public.inventory_movements movement
    where movement.reason::text = 'purchase_received'
      and movement.related_purchase_id = p_purchase_id
      and movement.to_entity_type::text = 'storage'
      and movement.to_entity_id is not null
  ) storage_row;

  return pg_catalog.jsonb_build_object(
    'line_count', v_line_count,
    'receipt_movement_count', v_receipt_count,
    'reversal_movement_count', v_reversal_count,
    'total_units', v_total_units,
    'receipt_movement_ids', v_receipt_ids,
    'reversal_movement_ids', v_reversal_ids,
    'storage_location_ids', v_storage_ids
  );
end;
$function$;

revoke all on function public._snacky_assert_purchase_inventory_state_v1(uuid, text, text, boolean, boolean)
  from public, anon, authenticated, service_role;

-- Validate the immutable purchase accounting projection while the caller holds
-- the purchase and line locks. Inventory and payments must never turn a
-- malformed negative or internally inconsistent header into a real balance.
create or replace function public._snacky_assert_purchase_accounting_v1(
  p_purchase_id uuid
)
returns numeric
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_purchase public.purchase_orders%rowtype;
  v_line_count integer;
  v_invalid_line_count integer;
  v_calculated_total numeric(14,2);
  v_selected_total numeric(14,2);
  v_expected_adjustment numeric(14,2);
begin
  select purchase.*
  into v_purchase
  from public.purchase_orders purchase
  where purchase.id = p_purchase_id;
  if not found then
    raise exception 'Purchase accounting cannot be verified because the purchase is missing.'
      using errcode = '23503';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where coalesce(line.total_units, 0) <= 0
        or line.unit_cost_lyd is null
        or line.unit_cost is null
        or line.unit_cost_lyd < 0
        or line.unit_cost < 0
        or line.line_total_lyd is null
        or line.line_total is null
        or line.line_total_lyd < 0
        or line.line_total < 0
        or pg_catalog.round(line.unit_cost::numeric, 2)
          is distinct from pg_catalog.round(line.unit_cost_lyd::numeric, 2)
        or pg_catalog.round(line.line_total::numeric, 2)
          is distinct from pg_catalog.round(line.line_total_lyd::numeric, 2)
        or pg_catalog.round(line.line_total_lyd::numeric, 2)
          is distinct from pg_catalog.round(
            line.unit_cost_lyd::numeric * line.total_units,
            2
          )
    )::integer,
    pg_catalog.round(coalesce(pg_catalog.sum(
      line.line_total_lyd
    ), 0), 2)::numeric(14,2)
  into v_line_count, v_invalid_line_count, v_calculated_total
  from public.purchase_order_lines line
  where line.purchase_order_id = p_purchase_id;

  if v_line_count <= 0 or v_invalid_line_count > 0 then
    raise exception 'Purchase accounting needs review: line quantities, unit costs, and line totals do not reconcile. Nothing was changed.'
      using errcode = '23514';
  end if;

  if v_purchase.calculated_total_lyd is null
    or v_purchase.total_amount is null
    or v_purchase.calculated_total_lyd < 0
    or v_purchase.total_amount < 0
    or coalesce(v_purchase.manual_total_lyd, 0) < 0
    or pg_catalog.round(v_purchase.calculated_total_lyd::numeric, 2) is distinct from v_calculated_total
  then
    raise exception 'Purchase accounting needs review: the calculated or recorded total is negative or inconsistent. Nothing was changed.'
      using errcode = '23514';
  end if;

  v_selected_total := pg_catalog.round(
    coalesce(v_purchase.manual_total_lyd, v_purchase.calculated_total_lyd)::numeric,
    2
  )::numeric(14,2);
  if v_selected_total <= 0
    or pg_catalog.round(v_purchase.total_amount::numeric, 2) is distinct from v_selected_total
    or (
      v_purchase.manual_total_lyd is null
      and (
        v_purchase.total_source is distinct from 'calculated'
        or (
          v_purchase.total_adjustment_lyd is not null
          and pg_catalog.round(v_purchase.total_adjustment_lyd::numeric, 2) <> 0
        )
      )
    )
    or (
      v_purchase.manual_total_lyd is not null
      and (
        v_purchase.total_source is distinct from 'manual'
        or v_purchase.total_adjustment_lyd is null
      )
    )
  then
    raise exception 'Purchase accounting needs review: the payable total header is invalid. Nothing was changed.'
      using errcode = '23514';
  end if;

  if v_purchase.manual_total_lyd is not null then
    v_expected_adjustment := pg_catalog.round(
      v_selected_total - v_calculated_total,
      2
    )::numeric(14,2);
    if pg_catalog.round(v_purchase.total_adjustment_lyd::numeric, 2)
      is distinct from v_expected_adjustment
    then
      raise exception 'Purchase accounting needs review: the manual receipt adjustment does not reconcile. Nothing was changed.'
        using errcode = '23514';
    end if;
  end if;

  return v_selected_total;
end;
$function$;

revoke all on function public._snacky_assert_purchase_accounting_v1(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.snacky_receive_purchase_v1(
  p_purchase_id uuid,
  p_client_submission_id text,
  p_receiving_storage_location_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_request_payload jsonb;
  v_operation public.purchase_inventory_operations%rowtype;
  v_has_operation boolean := false;
  v_purchase public.purchase_orders%rowtype;
  v_storage_location_id uuid;
  v_storage_candidate_count integer := 0;
  v_line_lock record;
  v_product_lock record;
  v_requested_product_count integer;
  v_locked_product_count integer := 0;
  v_existing_movement_count integer;
  v_inventory_snapshot jsonb;
  v_result_payload jsonb;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to receive a purchase.' using errcode = '42501';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']) then
    raise exception 'You do not have permission to receive purchases.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  if p_purchase_id is null then
    raise exception 'Purchase is required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable purchase receipt submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'action', 'receive',
    'purchase_id', p_purchase_id,
    'requested_storage_location_id', p_receiving_storage_location_id
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:purchase-inventory-submission:' || v_submission_id, 0)
  );

  select operation.*
  into v_operation
  from public.purchase_inventory_operations operation
  where operation.client_submission_id = v_submission_id;
  v_has_operation := found;

  if v_has_operation and (
    v_operation.purchase_id is distinct from p_purchase_id
    or v_operation.action is distinct from 'receive'
    or v_operation.actor_user_id is distinct from v_actor_user_id
    or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
    or v_operation.request_payload is distinct from v_request_payload
    or v_operation.result_payload is null
  ) then
    raise exception 'This purchase receipt submission id belongs to another actor or immutable request.'
      using errcode = '23505';
  end if;

  select purchase.*
  into v_purchase
  from public.purchase_orders purchase
  where purchase.id = p_purchase_id
  for update;

  if not found then
    raise exception 'Purchase was not found.' using errcode = '23503';
  end if;

  for v_line_lock in
    select line.id
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_id
    order by line.product_id, line.line_position, line.id
    for update
  loop
    null;
  end loop;

  if not v_has_operation then
    select operation.*
    into v_operation
    from public.purchase_inventory_operations operation
    where operation.purchase_id = p_purchase_id
      and operation.action = 'receive';
    v_has_operation := found;
  end if;

  if v_has_operation then
    if v_operation.client_submission_id is distinct from v_submission_id
      or v_operation.actor_user_id is distinct from v_actor_user_id
      or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
      or v_operation.request_payload is distinct from v_request_payload
      or v_operation.result_payload is null
    then
      raise exception 'This purchase was already received with a different immutable request.' using errcode = '23505';
    end if;

    perform public._snacky_lock_purchase_receipt_inventory_v1(p_purchase_id);
    perform public._snacky_assert_purchase_accounting_v1(p_purchase_id);
    v_inventory_snapshot := public._snacky_assert_purchase_inventory_state_v1(
      p_purchase_id,
      'received',
      null,
      true,
      false
    );
    if v_operation.result_payload -> 'inventory' is distinct from v_inventory_snapshot then
      raise exception 'Purchase inventory needs review: the saved receipt result no longer matches the ledger. Nothing was changed.'
        using errcode = '23514';
    end if;

    return v_operation.result_payload;
  end if;

  if v_purchase.status = 'received' then
    perform public._snacky_lock_purchase_receipt_inventory_v1(p_purchase_id);
    perform public._snacky_assert_purchase_accounting_v1(p_purchase_id);
    v_inventory_snapshot := public._snacky_assert_purchase_inventory_state_v1(
      p_purchase_id,
      'received',
      null,
      false,
      false
    );
    if p_receiving_storage_location_id is not null and exists (
      select 1
      from public.inventory_movements movement
      where movement.reason::text = 'purchase_received'
        and movement.related_purchase_id = p_purchase_id
        and movement.to_entity_id is distinct from p_receiving_storage_location_id
    ) then
      raise exception 'This purchase was already received into a different storage location.'
        using errcode = '23514';
    end if;
    return pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'purchase_id', p_purchase_id,
      'status', 'received',
      'purchase', pg_catalog.to_jsonb(v_purchase),
      'inventory', v_inventory_snapshot,
      'already_applied', true,
      'legacy_verified', true
    );
  end if;

  if v_purchase.status <> 'draft' then
    raise exception 'Only a draft purchase can be received.' using errcode = '23514';
  end if;

  if v_purchase.payment_status = 'voided' then
    raise exception 'A draft purchase marked voided cannot be received. Correct the draft payment status first.'
      using errcode = '23514';
  end if;

  if v_purchase.supplier_id is null or not exists (
    select 1
    from public.suppliers supplier
    where supplier.id = v_purchase.supplier_id
  ) then
    raise exception 'Select a valid supplier before receiving this purchase.'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_id
  ) or exists (
    select 1
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_id
      and (
        line.product_id is null
        or coalesce(line.total_units, 0) <= 0
        or coalesce(line.received_qty, 0) <> 0
        or coalesce(line.unit_cost_lyd, line.unit_cost, 0) < 0
        or coalesce(line.line_total_lyd, line.line_total, 0) < 0
      )
  ) then
    raise exception 'Purchase inventory needs review: draft purchase lines are missing, invalid, or already marked received. Nothing was changed.'
      using errcode = '23514';
  end if;

  perform public._snacky_assert_purchase_accounting_v1(p_purchase_id);

  select pg_catalog.count(*)::integer
  into v_existing_movement_count
  from public.inventory_movements movement
  where movement.related_purchase_id = p_purchase_id
    or movement.related_purchase_line_id in (
      select line.id
      from public.purchase_order_lines line
      where line.purchase_order_id = p_purchase_id
    );

  if v_existing_movement_count <> 0 then
    raise exception 'Purchase inventory needs review: a draft purchase already has % linked inventory movement(s). Nothing was changed.',
      v_existing_movement_count
      using errcode = '23514';
  end if;

  if p_receiving_storage_location_id is not null then
    v_storage_location_id := p_receiving_storage_location_id;
  elsif v_purchase.receiving_storage_location_id is not null then
    v_storage_location_id := v_purchase.receiving_storage_location_id;
  else
    select pg_catalog.count(*)::integer
    into v_storage_candidate_count
    from public.storage_locations storage
    where storage.active = true
      and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other');

    if v_storage_candidate_count > 1 then
      raise exception 'More than one active physical storage exists. Select the receipt storage explicitly.'
        using errcode = '23514';
    elsif v_storage_candidate_count = 1 then
      select storage.id
      into v_storage_location_id
      from public.storage_locations storage
      where storage.active = true
        and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other');
    end if;
  end if;

  perform 1
  from public.storage_locations storage
  where storage.id = v_storage_location_id
    and storage.active = true
    and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
  for share;
  if not found then
    raise exception 'The selected purchase receipt storage is missing, inactive, or unsupported.'
      using errcode = '23514';
  end if;

  select pg_catalog.count(distinct line.product_id)::integer
  into v_requested_product_count
  from public.purchase_order_lines line
  where line.purchase_order_id = p_purchase_id;

  for v_product_lock in
    select distinct line.product_id
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_id
    order by line.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_product_lock.product_id::text),
      pg_catalog.hashtext(v_storage_location_id::text)
    );
  end loop;

  for v_product_lock in
    select product.id, product.active
    from public.products product
    where product.id in (
      select distinct line.product_id
      from public.purchase_order_lines line
      where line.purchase_order_id = p_purchase_id
    )
    order by product.id
    for update
  loop
    v_locked_product_count := v_locked_product_count + 1;
    if v_product_lock.active is not true then
      raise exception 'Purchase inventory needs review: a draft product is inactive. Replace it before receiving stock. Nothing was changed.'
        using errcode = '23514';
    end if;
  end loop;

  if v_locked_product_count <> v_requested_product_count then
    raise exception 'Purchase inventory needs review: a draft product is missing. Nothing was changed.'
      using errcode = '23514';
  end if;

  -- A legacy direct writer does not take the purchase lock. Recheck under the
  -- inventory locks and fail the whole transaction instead of filling gaps.
  select pg_catalog.count(*)::integer
  into v_existing_movement_count
  from public.inventory_movements movement
  where movement.related_purchase_id = p_purchase_id
    or movement.related_purchase_line_id in (
      select line.id
      from public.purchase_order_lines line
      where line.purchase_order_id = p_purchase_id
    );

  if v_existing_movement_count <> 0 then
    raise exception 'Purchase inventory needs review: linked inventory appeared while receiving this purchase. Nothing was changed.'
      using errcode = '40001';
  end if;

  insert into public.inventory_movements (
    product_id,
    quantity,
    from_entity_type,
    from_entity_id,
    to_entity_type,
    to_entity_id,
    reason,
    related_purchase_id,
    related_purchase_line_id,
    unit_cost_lyd,
    line_total_lyd,
    source_type,
    source_id,
    idempotency_key,
    idempotency_payload,
    created_by,
    notes
  )
  select
    line.product_id,
    line.total_units,
    'supplier'::public.inventory_entity_type,
    v_purchase.supplier_id,
    'storage'::public.inventory_entity_type,
    v_storage_location_id,
    'purchase_received'::public.movement_reason,
    p_purchase_id,
    line.id,
    pg_catalog.round(coalesce(line.unit_cost_lyd, line.unit_cost, 0)::numeric, 4),
    pg_catalog.round(coalesce(line.line_total_lyd, line.line_total, 0)::numeric, 2),
    'purchase_receipt',
    p_purchase_id,
    'purchase-receipt:v1:' || p_purchase_id::text || ':' || line.id::text,
    pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'purchase_id', p_purchase_id,
      'purchase_line_id', line.id,
      'product_id', line.product_id,
      'storage_location_id', v_storage_location_id,
      'quantity', line.total_units
    ),
    v_actor_team_member_id,
    'Purchase received'
  from public.purchase_order_lines line
  where line.purchase_order_id = p_purchase_id
  order by line.product_id, line.line_position, line.id;

  update public.purchase_order_lines line
  set received_qty = line.total_units
  where line.purchase_order_id = p_purchase_id;

  with latest_line as (
    select distinct on (line.product_id)
      line.product_id,
      line.id as purchase_line_id,
      pg_catalog.round(coalesce(line.unit_cost_lyd, line.unit_cost, 0)::numeric, 4) as latest_cost
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_id
      and coalesce(line.unit_cost_lyd, line.unit_cost, 0) > 0
    order by line.product_id, line.line_position desc, line.id desc
  )
  update public.products product
  set cost_price = pg_catalog.round(latest_line.latest_cost, 2),
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      last_purchase_date = coalesce(
        v_purchase.order_date,
        (pg_catalog.now() at time zone 'Africa/Tripoli')::date
      ),
      last_supplier_id = v_purchase.supplier_id,
      last_purchase_line_id = latest_line.purchase_line_id,
      cost_price_source = 'latest_purchase',
      price_updated_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  from latest_line
  where product.id = latest_line.product_id;

  update public.purchase_orders purchase
  set status = 'received',
      receiving_storage_location_id = v_storage_location_id,
      received_at = pg_catalog.now(),
      received_date = (pg_catalog.now() at time zone 'Africa/Tripoli')::date,
      received_by = v_actor_team_member_id,
      updated_at = pg_catalog.now()
  where purchase.id = p_purchase_id
    and purchase.status = 'draft'
  returning purchase.* into v_purchase;

  if not found then
    raise exception 'Purchase changed while it was being received. Nothing was changed.' using errcode = '40001';
  end if;

  v_inventory_snapshot := public._snacky_assert_purchase_inventory_state_v1(
    p_purchase_id,
    'received',
    null,
    true,
    false
  );

  v_result_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'purchase_id', p_purchase_id,
    'status', 'received',
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'inventory', v_inventory_snapshot,
    'already_applied', false,
    'legacy_verified', false
  );

  insert into public.purchase_inventory_operations (
    purchase_id,
    action,
    client_submission_id,
    request_payload,
    result_payload,
    actor_user_id,
    actor_team_member_id
  ) values (
    p_purchase_id,
    'receive',
    v_submission_id,
    v_request_payload,
    v_result_payload,
    v_actor_user_id,
    v_actor_team_member_id
  );

  return v_result_payload;
end;
$function$;

revoke all on function public.snacky_receive_purchase_v1(uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.snacky_receive_purchase_v1(uuid, text, uuid)
  to authenticated;

create or replace function public.snacky_void_received_purchase_v1(
  p_purchase_id uuid,
  p_reason text,
  p_client_submission_id text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_request_payload jsonb;
  v_operation public.purchase_inventory_operations%rowtype;
  v_has_operation boolean := false;
  v_purchase public.purchase_orders%rowtype;
  v_line_lock record;
  v_stock_group record;
  v_latest_cost record;
  v_inventory_snapshot jsonb;
  v_result_payload jsonb;
  v_available bigint;
  v_reserved bigint;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to void a received purchase.' using errcode = '42501';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']) then
    raise exception 'You do not have permission to void received purchases.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  if p_purchase_id is null then
    raise exception 'Purchase is required.' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) > 2000 then
    raise exception 'A void reason between 1 and 2000 characters is required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable purchase void submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'action', 'void',
    'purchase_id', p_purchase_id,
    'reason', v_reason
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:purchase-inventory-submission:' || v_submission_id, 0)
  );

  select operation.*
  into v_operation
  from public.purchase_inventory_operations operation
  where operation.client_submission_id = v_submission_id;
  v_has_operation := found;

  if v_has_operation and (
    v_operation.purchase_id is distinct from p_purchase_id
    or v_operation.action is distinct from 'void'
    or v_operation.actor_user_id is distinct from v_actor_user_id
    or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
    or v_operation.request_payload is distinct from v_request_payload
    or v_operation.result_payload is null
  ) then
    raise exception 'This purchase void submission id belongs to another actor or immutable request.'
      using errcode = '23505';
  end if;

  select purchase.*
  into v_purchase
  from public.purchase_orders purchase
  where purchase.id = p_purchase_id
  for update;

  if not found then
    raise exception 'Purchase was not found.' using errcode = '23503';
  end if;

  for v_line_lock in
    select line.id
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_id
    order by line.product_id, line.line_position, line.id
    for update
  loop
    null;
  end loop;

  if not v_has_operation then
    select operation.*
    into v_operation
    from public.purchase_inventory_operations operation
    where operation.purchase_id = p_purchase_id
      and operation.action = 'void';
    v_has_operation := found;
  end if;

  if v_has_operation then
    if v_operation.client_submission_id is distinct from v_submission_id
      or v_operation.actor_user_id is distinct from v_actor_user_id
      or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
      or v_operation.request_payload is distinct from v_request_payload
      or v_operation.result_payload is null
    then
      raise exception 'This purchase was already voided with a different immutable request.' using errcode = '23505';
    end if;

    perform public._snacky_lock_purchase_receipt_inventory_v1(p_purchase_id);
    v_inventory_snapshot := public._snacky_assert_purchase_inventory_state_v1(
      p_purchase_id,
      'voided',
      v_reason,
      false,
      true
    );
    if v_operation.result_payload -> 'inventory' is distinct from v_inventory_snapshot then
      raise exception 'Purchase inventory needs review: the saved void result no longer matches the ledger. Nothing was changed.'
        using errcode = '23514';
    end if;

    return v_operation.result_payload;
  end if;

  if v_purchase.status = 'voided' then
    if nullif(pg_catalog.btrim(coalesce(v_purchase.void_reason, '')), '') is distinct from v_reason then
      raise exception 'This legacy purchase was already voided with a different reason.'
        using errcode = '23514';
    end if;
    perform public._snacky_lock_purchase_receipt_inventory_v1(p_purchase_id);
    v_inventory_snapshot := public._snacky_assert_purchase_inventory_state_v1(
      p_purchase_id,
      'voided',
      v_reason,
      false,
      false
    );
    return pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'purchase_id', p_purchase_id,
      'status', 'voided',
      'purchase', pg_catalog.to_jsonb(v_purchase),
      'inventory', v_inventory_snapshot,
      'already_applied', true,
      'legacy_verified', true
    );
  end if;

  if v_purchase.status <> 'received' then
    raise exception 'Only a received purchase can be voided.' using errcode = '23514';
  end if;

  if v_purchase.payment_status in ('paid', 'partially_paid') or exists (
    select 1
    from public.purchase_payments payment
    where payment.purchase_order_id = p_purchase_id
  ) then
    raise exception 'A paid or partially paid purchase cannot be inventory-voided. Record an explicit supplier return/refund instead.'
      using errcode = '23514';
  end if;

  perform public._snacky_lock_purchase_receipt_inventory_v1(p_purchase_id);

  -- Refuse all partial or malformed legacy states. The operator must reconcile
  -- known legacy mismatches from physical evidence; this command never
  -- manufactures a missing receipt or reversal.
  v_inventory_snapshot := public._snacky_assert_purchase_inventory_state_v1(
    p_purchase_id,
    'received',
    null,
    false,
    false
  );

  for v_stock_group in
    select
      receipt.product_id,
      receipt.to_entity_id as storage_location_id,
      pg_catalog.sum(receipt.quantity::bigint)::bigint as quantity_to_reverse
    from public.inventory_movements receipt
    where receipt.reason::text = 'purchase_received'
      and receipt.related_purchase_id = p_purchase_id
    group by receipt.product_id, receipt.to_entity_id
    order by receipt.to_entity_id, receipt.product_id
  loop
    select coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0::bigint)
    into v_available
    from public.current_inventory_by_location inventory
    where inventory.location_type = 'storage'
      and inventory.location_id = v_stock_group.storage_location_id
      and inventory.product_id = v_stock_group.product_id;

    if v_available < v_stock_group.quantity_to_reverse then
      raise exception 'Purchase inventory needs review: product % needs % units in storage to void, but only % remain. Nothing was changed.',
        v_stock_group.product_id,
        v_stock_group.quantity_to_reverse,
        greatest(v_available, 0::bigint)
        using errcode = '23514';
    end if;

    select coalesce(pg_catalog.sum(
      greatest(
        coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0),
        0
      )::bigint
    ), 0::bigint)
    into v_reserved
    from public.route_stock_lines stock_line
    join public.routes route_row on route_row.id = stock_line.route_id
    where stock_line.product_id = v_stock_group.product_id
      and route_row.status::text in (
        'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready',
        'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'
      );

    if v_available - v_reserved < v_stock_group.quantity_to_reverse then
      raise exception 'Purchase inventory needs review: product % needs % unreserved units to void, but only % are available after active route reservations. Nothing was changed.',
        v_stock_group.product_id,
        v_stock_group.quantity_to_reverse,
        greatest(v_available - v_reserved, 0::bigint)
        using errcode = '23514';
    end if;
  end loop;

  insert into public.inventory_movements (
    product_id,
    quantity,
    from_entity_type,
    from_entity_id,
    to_entity_type,
    to_entity_id,
    reason,
    related_purchase_id,
    related_purchase_line_id,
    related_route_id,
    related_route_stop_id,
    related_machine_id,
    unit_cost_lyd,
    line_total_lyd,
    reversed_movement_id,
    correction_reason,
    source_type,
    source_id,
    idempotency_key,
    idempotency_payload,
    created_by,
    notes
  )
  select
    receipt.product_id,
    receipt.quantity,
    receipt.to_entity_type,
    receipt.to_entity_id,
    receipt.from_entity_type,
    receipt.from_entity_id,
    'manual_correction'::public.movement_reason,
    p_purchase_id,
    receipt.related_purchase_line_id,
    receipt.related_route_id,
    receipt.related_route_stop_id,
    receipt.related_machine_id,
    receipt.unit_cost_lyd,
    case
      when receipt.line_total_lyd is null then null
      else -receipt.line_total_lyd
    end,
    receipt.id,
    v_reason,
    'purchase_void',
    p_purchase_id,
    'purchase-void:v1:' || p_purchase_id::text || ':' || receipt.id::text,
    pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'purchase_id', p_purchase_id,
      'receipt_movement_id', receipt.id,
      'reason', v_reason
    ),
    v_actor_team_member_id,
    'Voided purchase ' || coalesce(v_purchase.receipt_number, pg_catalog.left(p_purchase_id::text, 8)) || ': ' || v_reason
  from public.inventory_movements receipt
  where receipt.reason::text = 'purchase_received'
    and receipt.related_purchase_id = p_purchase_id
  order by receipt.to_entity_id, receipt.product_id, receipt.id;

  update public.purchase_order_lines line
  set received_qty = 0
  where line.purchase_order_id = p_purchase_id;

  update public.purchase_orders purchase
  set status = 'voided',
      payment_status = 'voided',
      voided_at = pg_catalog.now(),
      voided_by = v_actor_team_member_id,
      void_reason = v_reason,
      updated_at = pg_catalog.now()
  where purchase.id = p_purchase_id
    and purchase.status = 'received'
  returning purchase.* into v_purchase;

  if not found then
    raise exception 'Purchase changed while it was being voided. Nothing was changed.' using errcode = '40001';
  end if;

  -- If this purchase supplied the product's current cost memory, move that
  -- pointer to the latest remaining received purchase. When none remains, keep
  -- the numeric cost as explicit memory but clear the invalid purchase link.
  for v_line_lock in
    select distinct line.product_id
    from public.purchase_order_lines line
    where line.purchase_order_id = p_purchase_id
    order by line.product_id
  loop
    if exists (
      select 1
      from public.products product
      join public.purchase_order_lines current_line
        on current_line.id = product.last_purchase_line_id
      where product.id = v_line_lock.product_id
        and current_line.purchase_order_id = p_purchase_id
    ) then
      select
        line.id as purchase_line_id,
        pg_catalog.round(coalesce(line.unit_cost_lyd, line.unit_cost, 0)::numeric, 4) as latest_cost,
        coalesce(purchase.received_date, purchase.order_date, line.created_at::date) as purchase_date,
        purchase.supplier_id
      into v_latest_cost
      from public.purchase_order_lines line
      join public.purchase_orders purchase
        on purchase.id = line.purchase_order_id
      where line.product_id = v_line_lock.product_id
        and purchase.id <> p_purchase_id
        and purchase.status = 'received'
        and coalesce(line.unit_cost_lyd, line.unit_cost, 0) > 0
      order by
        coalesce(purchase.received_at, purchase.received_date::timestamptz, purchase.order_date::timestamptz, line.created_at) desc,
        line.line_position desc,
        line.id desc
      limit 1;

      if found then
        update public.products product
        set cost_price = pg_catalog.round(v_latest_cost.latest_cost, 2),
            current_cost_price_lyd = v_latest_cost.latest_cost,
            last_purchase_cost_lyd = v_latest_cost.latest_cost,
            last_purchase_date = v_latest_cost.purchase_date,
            last_supplier_id = v_latest_cost.supplier_id,
            last_purchase_line_id = v_latest_cost.purchase_line_id,
            cost_price_source = 'latest_purchase',
            price_updated_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
        where product.id = v_line_lock.product_id;
      else
        update public.products product
        set last_purchase_cost_lyd = null,
            last_purchase_date = null,
            last_supplier_id = null,
            last_purchase_line_id = null,
            cost_price = case
              when coalesce(product.average_cost_lyd, 0) > 0
                then pg_catalog.round(product.average_cost_lyd, 2)
              else product.cost_price
            end,
            current_cost_price_lyd = case
              when coalesce(product.average_cost_lyd, 0) > 0
                then product.average_cost_lyd
              else product.current_cost_price_lyd
            end,
            cost_price_source = case
              when coalesce(product.average_cost_lyd, 0) > 0 then 'average_cost'
              else 'historical_memory'
            end,
            price_updated_at = pg_catalog.now(),
            updated_at = pg_catalog.now()
        where product.id = v_line_lock.product_id;
      end if;
    end if;
  end loop;

  v_inventory_snapshot := public._snacky_assert_purchase_inventory_state_v1(
    p_purchase_id,
    'voided',
    v_reason,
    false,
    true
  );

  v_result_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'purchase_id', p_purchase_id,
    'status', 'voided',
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'inventory', v_inventory_snapshot,
    'already_applied', false,
    'legacy_verified', false
  );

  insert into public.purchase_inventory_operations (
    purchase_id,
    action,
    client_submission_id,
    request_payload,
    result_payload,
    actor_user_id,
    actor_team_member_id
  ) values (
    p_purchase_id,
    'void',
    v_submission_id,
    v_request_payload,
    v_result_payload,
    v_actor_user_id,
    v_actor_team_member_id
  );

  return v_result_payload;
end;
$function$;

revoke all on function public.snacky_void_received_purchase_v1(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.snacky_void_received_purchase_v1(uuid, text, text)
  to authenticated;

comment on function public.snacky_receive_purchase_v1(uuid, text, uuid)
is 'Authenticated, serialized, exact-retry purchase receipt. It refuses partial legacy inventory rather than repairing it.';

comment on function public.snacky_void_received_purchase_v1(uuid, text, text)
is 'Authenticated, serialized, exact-retry purchase void. It reverses exact receipt movements and purchase state in one transaction.';

select pg_notify('pgrst', 'reload schema');
