-- One operator may carry route-scoped stock for only one route at a time.
--
-- The lease is claimed only when the authoritative post-statement route ledger
-- has a positive operator-bag balance, asserted by every route-related bag
-- touch, and released only after one of the two audited zero-custody proofs:
-- terminal reconciliation or an exact pristine pickup return. No
-- application-supplied balance participates in this state.

create table if not exists public.operator_route_custody_leases (
  operator_id uuid primary key
    references public.team_members(id) on delete restrict,
  route_id uuid not null unique
    references public.routes(id) on delete restrict,
  claim_source text not null default 'route_inventory_movement',
  claimed_at timestamptz not null default pg_catalog.now(),
  last_movement_at timestamptz not null default pg_catalog.now(),
  constraint operator_route_custody_leases_claim_source_check
    check (pg_catalog.length(pg_catalog.btrim(claim_source)) between 1 and 100)
);

-- Freeze tables in the same route -> batch -> checklist -> ledger order used by
-- pickup confirmation before any ACL, policy, or trigger DDL touches a child
-- table. This prevents deployment itself from inverting a live transaction.
lock table public.routes in share row exclusive mode;
lock table public.route_pickup_batches in access exclusive mode;
lock table public.route_pick_list_items in share row exclusive mode;
lock table public.inventory_movements in share row exclusive mode;

alter table public.route_pickup_batches
  add column if not exists confirmation_payload_hash text,
  add column if not exists confirmation_result jsonb;

do $pickup_receipt_constraints$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_pickup_batches'::pg_catalog.regclass
      and constraint_row.conname = 'route_pickup_batches_confirmation_payload_hash_check'
  ) then
    alter table public.route_pickup_batches
      add constraint route_pickup_batches_confirmation_payload_hash_check
      check (
        confirmation_payload_hash is null
        or confirmation_payload_hash ~ '^[0-9a-f]{32}$'
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_pickup_batches'::pg_catalog.regclass
      and constraint_row.conname = 'route_pickup_batches_confirmation_result_check'
  ) then
    alter table public.route_pickup_batches
      add constraint route_pickup_batches_confirmation_result_check
      check (
        confirmation_result is null
        or pg_catalog.jsonb_typeof(confirmation_result) = 'object'
      );
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_pickup_batches'::pg_catalog.regclass
      and constraint_row.conname = 'route_pickup_batches_confirmation_receipt_pair_check'
  ) then
    alter table public.route_pickup_batches
      add constraint route_pickup_batches_confirmation_receipt_pair_check
      check (
        (confirmation_payload_hash is null)
        = (confirmation_result is null)
      );
  end if;
end
$pickup_receipt_constraints$;

alter table public.operator_route_custody_leases enable row level security;
revoke all on table public.operator_route_custody_leases from public, anon, authenticated;
grant all on table public.operator_route_custody_leases to service_role;

-- Operators prepare draft snapshots directly, but confirmation and return are
-- canonical SECURITY DEFINER RPC operations. Rebuild the ACL from zero so
-- DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN cannot bypass the audit boundary.
revoke all privileges on table public.route_pickup_batches
  from public, anon, authenticated;
grant select, insert, update on table public.route_pickup_batches
  to authenticated;
grant all privileges on table public.route_pickup_batches to service_role;

drop policy if exists "snacky_route_pickup_batches_delete_by_route_access"
  on public.route_pickup_batches;

-- Pick-list rows are historical pickup proof after the atomic confirmation
-- RPC commits them. Signed-in users only read them; every write is performed
-- by a reviewed SECURITY DEFINER workflow.
revoke all privileges on table public.route_pick_list_items
  from public, anon, authenticated;
grant select on table public.route_pick_list_items to authenticated;
grant all privileges on table public.route_pick_list_items to service_role;

-- V3 owns the full pickup transaction. It validates every persisted quantity
-- representation, rebuilds ledger provenance from authenticated state, calls
-- the legacy writer with only canonical inputs, and proves every resulting row
-- before the transaction can commit. Any suppressed insert or partial update
-- therefore raises and rolls the complete route transition back.
create or replace function public.snacky_confirm_route_pickup_batch_v3(
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
returns table(
  pickup_batch_id uuid,
  route_status public.route_status,
  picked_stop_ids uuid[],
  pending_stop_count integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_request_batch_id uuid;
  v_route_operator_id uuid;
  v_route_status_before public.route_status;
  v_requested_stop_ids uuid[];
  v_is_admin_correction boolean := false;
  v_has_existing_batch boolean := false;
  v_canonical_source_type text;
  v_canonical_pickup_batch jsonb;
  v_canonical_inventory_movements jsonb := '[]'::jsonb;
  v_expected_movement_count integer := 0;
  v_actual_movement_count integer := 0;
  v_expected_machine_ids uuid[] := '{}'::uuid[];
  v_submitted_machine_ids uuid[] := '{}'::uuid[];
  v_v2_selected_machine_ids uuid[] := '{}'::uuid[];
  v_storage_lock record;
  v_product_lock uuid;
  v_stock_needed bigint;
  v_stock_on_hand bigint;
  v_stock_reserved_elsewhere bigint;
  v_existing_batch public.route_pickup_batches%rowtype;
  v_stable_row_payloads jsonb;
  v_payload_hash text;
  v_confirmation_result jsonb;
  v_pickup_batch_id uuid;
  v_route_status public.route_status;
  v_picked_stop_ids uuid[];
  v_pending_stop_count integer;
begin
  if v_actor_id is null then
    raise exception 'Not authenticated.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'The pickup actor is not linked to an active team member.'
      using errcode = '42501';
  end if;

  if p_pickup_batch is null
    or pg_catalog.jsonb_typeof(p_pickup_batch) <> 'object'
    or nullif(p_pickup_batch->>'id', '') is null
  then
    raise exception 'A stable pickup batch id is required for receipt-safe confirmation.'
      using errcode = '22023';
  end if;

  v_request_batch_id := nullif(p_pickup_batch->>'id', '')::uuid;
  v_requested_stop_ids := case
    when coalesce(pg_catalog.array_length(p_batch_stop_ids, 1), 0) > 0
      then p_batch_stop_ids
    else coalesce(p_selected_stop_ids, '{}'::uuid[])
  end;

  -- Every route inventory writer takes this transaction mutex before touching
  -- the route row. Pickup, stop completion, correction, cancellation, and
  -- terminal reconciliation therefore cannot interleave their ledger proofs.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || p_route_id::text, 0)
  );

  select route_row.operator_id, route_row.status
  into v_route_operator_id, v_route_status_before
  from public.routes route_row
  where route_row.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'User does not have permission to confirm pickup for this route.'
      using errcode = '42501';
  end if;

  if pg_catalog.jsonb_typeof(coalesce(p_new_stop_item_rows, '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_typeof(coalesce(p_inventory_movements, '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_typeof(coalesce(p_pick_list_rows, '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_typeof(coalesce(p_stock_line_rows, '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_typeof(coalesce(p_stop_item_picks, '[]'::jsonb)) <> 'array'
    or pg_catalog.jsonb_typeof(coalesce(p_refill_line_picks, '[]'::jsonb)) <> 'array'
  then
    raise exception 'Pickup confirmation row payloads must be JSON arrays.'
      using errcode = '22023';
  end if;

  v_is_admin_correction := coalesce(
    p_pickup_batch->>'workflow_kind' = 'admin_missed_pickup',
    false
  );

  if v_is_admin_correction then
    if not public.snacky_current_profile_has_any_role(array['owner', 'admin'])
      or v_route_status_before::text not in ('in_progress', 'pickup_confirmed')
      or p_expected_route_status is distinct from v_route_status_before
      or p_next_route_status is distinct from v_route_status_before
      or coalesce(p_replace_pick_list, false)
      or coalesce(pg_catalog.array_length(v_requested_stop_ids, 1), 0) <> 0
      or coalesce(pg_catalog.array_length(p_selected_machine_ids, 1), 0) <> 0
      or pg_catalog.jsonb_array_length(coalesce(p_new_stop_item_rows, '[]'::jsonb)) <> 0
      or pg_catalog.jsonb_array_length(coalesce(p_inventory_movements, '[]'::jsonb)) = 0
      or exists (
        select 1
        from pg_catalog.jsonb_to_recordset(
          coalesce(p_inventory_movements, '[]'::jsonb)
        ) as correction_movement(source_type text, reason text)
        where correction_movement.source_type is distinct from 'admin_missed_route_pickup'
          or correction_movement.reason is distinct from 'storage_to_operator_bag'
      )
    then
      raise exception 'Admin missed-pickup correction payload is invalid.'
        using errcode = '42501';
    end if;
  end if;

  v_v2_selected_machine_ids := case
    when v_is_admin_correction
      then array['00000000-0000-0000-0000-000000000000'::uuid]
    else coalesce(p_selected_machine_ids, '{}'::uuid[])
  end;

  if v_is_admin_correction and exists (
    select 1
    from public.machines machine_row
    where machine_row.id = '00000000-0000-0000-0000-000000000000'::uuid
  ) then
    raise exception 'Reserved pickup correction machine sentinel is already in use.'
      using errcode = '23514';
  end if;

  if nullif(p_pickup_batch->>'route_id', '') is not null
    and nullif(p_pickup_batch->>'route_id', '')::uuid is distinct from p_route_id
  then
    raise exception 'Pickup batch route does not match the selected route.'
      using errcode = '22023';
  end if;

  if nullif(p_pickup_batch->>'operator_id', '') is not null
    and nullif(p_pickup_batch->>'operator_id', '')::uuid is distinct from v_route_operator_id
  then
    raise exception 'Pickup batch operator does not match the route operator.'
      using errcode = '22023';
  end if;

  if v_route_operator_id is null then
    raise exception 'Route must be assigned to an operator before pickup can be confirmed.'
      using errcode = '23514';
  end if;

  -- Treat the client movement rows only as requested physical endpoints and
  -- quantities. Route, batch, source, idempotency, and actor provenance are
  -- deliberately discarded and rebuilt below from authenticated state.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(p_inventory_movements, '[]'::jsonb)
    ) as submitted(value)
    where pg_catalog.jsonb_typeof(submitted.value) <> 'object'
      or coalesce(submitted.value->>'product_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(submitted.value->>'quantity', '') !~ '^[1-9][0-9]*$'
      or pg_catalog.length(coalesce(submitted.value->>'quantity', '')) > 6
      or case
        when coalesce(submitted.value->>'quantity', '') ~ '^[1-9][0-9]*$'
          and pg_catalog.length(coalesce(submitted.value->>'quantity', '')) <= 6
        then (submitted.value->>'quantity')::integer > 100000
        else false
      end
      or coalesce(submitted.value->>'from_entity_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(submitted.value->>'to_entity_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or (
        submitted.value->>'reason' = 'storage_to_operator_bag'
        and (
          submitted.value->>'from_entity_type' is distinct from 'storage'
          or submitted.value->>'to_entity_type' is distinct from 'operator_bag'
          or (submitted.value->>'to_entity_id')::uuid is distinct from v_route_operator_id
        )
      )
      or (
        submitted.value->>'reason' = 'operator_bag_to_storage'
        and (
          submitted.value->>'from_entity_type' is distinct from 'operator_bag'
          or submitted.value->>'to_entity_type' is distinct from 'storage'
          or (submitted.value->>'from_entity_id')::uuid is distinct from v_route_operator_id
        )
      )
      or submitted.value->>'reason' not in (
        'storage_to_operator_bag',
        'operator_bag_to_storage'
      )
  ) then
    raise exception 'Pickup inventory rows require positive whole units between active storage and the assigned operator bag.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from (
      select
        (submitted.value->>'product_id')::uuid as product_id,
        submitted.value->>'reason' as reason,
        (submitted.value->>'from_entity_id')::uuid as from_entity_id,
        (submitted.value->>'to_entity_id')::uuid as to_entity_id,
        pg_catalog.count(*) as row_count
      from pg_catalog.jsonb_array_elements(
        coalesce(p_inventory_movements, '[]'::jsonb)
      ) as submitted(value)
      group by
        (submitted.value->>'product_id')::uuid,
        submitted.value->>'reason',
        (submitted.value->>'from_entity_id')::uuid,
        (submitted.value->>'to_entity_id')::uuid
      having pg_catalog.count(*) > 1
    ) duplicate_endpoint
  ) then
    raise exception 'Pickup inventory contains duplicate product and endpoint rows.'
      using errcode = '22023';
  end if;

  v_canonical_source_type := case
    when v_is_admin_correction then 'admin_missed_route_pickup'
    else 'route_pickup_batch'
  end;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'product_id', canonical.product_id,
        'quantity', canonical.quantity,
        'from_entity_type', canonical.from_entity_type,
        'from_entity_id', canonical.from_entity_id,
        'to_entity_type', canonical.to_entity_type,
        'to_entity_id', canonical.to_entity_id,
        'reason', canonical.reason,
        'related_pickup_batch_id', v_request_batch_id,
        'idempotency_key', pg_catalog.format(
          'route-pickup-v3:%s:%s',
          v_request_batch_id,
          pg_catalog.md5(
            pg_catalog.concat_ws(
              ':',
              canonical.product_id,
              canonical.quantity,
              canonical.from_entity_type,
              canonical.from_entity_id,
              canonical.to_entity_type,
              canonical.to_entity_id,
              canonical.reason
            )
          )
        ),
        'source_type', v_canonical_source_type,
        'source_id', v_request_batch_id,
        'created_by', v_actor_team_member_id,
        'notes', case
          when canonical.reason = 'operator_bag_to_storage'
            then pg_catalog.format(
              'Pickup reduction for route %s batch %s',
              p_route_id,
              v_request_batch_id
            )
          else pg_catalog.format(
            'Pickup for route %s batch %s',
            p_route_id,
            v_request_batch_id
          )
        end
      )
      order by
        canonical.product_id,
        canonical.reason,
        canonical.from_entity_id,
        canonical.to_entity_id
    ),
    '[]'::jsonb
  )
  into v_canonical_inventory_movements
  from (
    select
      (submitted.value->>'product_id')::uuid as product_id,
      (submitted.value->>'quantity')::integer as quantity,
      submitted.value->>'from_entity_type' as from_entity_type,
      (submitted.value->>'from_entity_id')::uuid as from_entity_id,
      submitted.value->>'to_entity_type' as to_entity_type,
      (submitted.value->>'to_entity_id')::uuid as to_entity_id,
      submitted.value->>'reason' as reason
    from pg_catalog.jsonb_array_elements(
      coalesce(p_inventory_movements, '[]'::jsonb)
    ) as submitted(value)
  ) canonical;

  v_expected_movement_count := pg_catalog.jsonb_array_length(
    v_canonical_inventory_movements
  );

  v_canonical_pickup_batch := pg_catalog.jsonb_build_object(
    'id', v_request_batch_id,
    'route_id', p_route_id,
    'operator_id', v_route_operator_id,
    'status', 'confirmed',
    'selected_stop_ids', pg_catalog.to_jsonb(v_requested_stop_ids),
    'product_summary', coalesce(p_pickup_batch->'product_summary', '[]'::jsonb),
    'storage_deducted', exists (
      select 1
      from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
        as movement(reason text)
      where movement.reason = 'storage_to_operator_bag'
    ),
    'confirmed_at', coalesce(
      nullif(p_pickup_batch->>'confirmed_at', '')::timestamptz,
      p_started_at,
      pg_catalog.now()
    )
  );

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_pick_list_rows, '[]'::jsonb)
    ) as submitted(
      pickup_batch_id uuid,
      is_checked boolean,
      checked_by uuid
    )
    where coalesce(submitted.is_checked, false)
      and submitted.checked_by is not null
      and submitted.checked_by is distinct from v_actor_id
      and (
        not v_is_admin_correction
        or submitted.pickup_batch_id = v_request_batch_id
      )
  ) then
    raise exception 'Pickup checklist actor does not match the authenticated user.'
      using errcode = '42501';
  end if;

  -- Normalize client timestamps out of every row payload. Business identifiers,
  -- quantities, endpoints, ordering, and acknowledgements remain hash inputs.
  select pg_catalog.jsonb_object_agg(normalized.payload_name, normalized.stable_rows)
  into v_stable_row_payloads
  from (
    select
      payload.payload_name,
      coalesce(
        pg_catalog.jsonb_agg(
          item.value - array[
            'created_at',
            'updated_at',
            'checked_at',
            'confirmed_at',
            'prepared_at',
            'started_at'
          ]::text[]
          order by (
            item.value - array[
              'created_at',
              'updated_at',
              'checked_at',
              'confirmed_at',
              'prepared_at',
              'started_at'
            ]::text[]
          )::text
        ) filter (where item.value is not null),
        '[]'::jsonb
      ) as stable_rows
    from (
      values
        ('new_stop_item_rows', coalesce(p_new_stop_item_rows, '[]'::jsonb)),
        ('inventory_movements', v_canonical_inventory_movements),
        ('pick_list_rows', coalesce(p_pick_list_rows, '[]'::jsonb)),
        ('stock_line_rows', coalesce(p_stock_line_rows, '[]'::jsonb)),
        ('stop_item_picks', coalesce(p_stop_item_picks, '[]'::jsonb)),
        ('refill_line_picks', coalesce(p_refill_line_picks, '[]'::jsonb))
    ) as payload(payload_name, payload_rows)
    left join lateral pg_catalog.jsonb_array_elements(payload.payload_rows)
      with ordinality as item(value, ordinality) on true
    group by payload.payload_name
  ) normalized;

  v_payload_hash := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'route_id', p_route_id,
      'actor_user_id', v_actor_id,
      'actor_team_member_id', v_actor_team_member_id,
      'next_route_status', p_next_route_status,
      'replace_pick_list', p_replace_pick_list,
      'pickup_batch', v_canonical_pickup_batch - array[
        'created_at',
        'updated_at',
        'confirmed_at',
        'prepared_at',
        'started_at'
      ]::text[],
      'batch_stop_ids', pg_catalog.to_jsonb(array(
        select batch_stop.value
        from pg_catalog.unnest(coalesce(p_batch_stop_ids, '{}'::uuid[])) as batch_stop(value)
        order by batch_stop.value
      )),
      'row_payloads', v_stable_row_payloads,
      'selected_stop_ids', pg_catalog.to_jsonb(array(
        select selected_stop.value
        from pg_catalog.unnest(coalesce(p_selected_stop_ids, '{}'::uuid[])) as selected_stop(value)
        order by selected_stop.value
      )),
      'acknowledged_pickup_line_ids', pg_catalog.to_jsonb(array(
        select acknowledged.value
        from pg_catalog.unnest(coalesce(p_acknowledged_pickup_line_ids, '{}'::uuid[])) as acknowledged(value)
        order by acknowledged.value
      )),
      'selected_machine_ids', pg_catalog.to_jsonb(array(
        select selected_machine.value
        from pg_catalog.unnest(coalesce(p_selected_machine_ids, '{}'::uuid[])) as selected_machine(value)
        order by selected_machine.value
      ))
    )::text
  );

  select batch_row.*
  into v_existing_batch
  from public.route_pickup_batches batch_row
  where batch_row.id = v_request_batch_id
  for update;

  v_has_existing_batch := found;

  if v_has_existing_batch then
    if v_existing_batch.route_id is distinct from p_route_id
      or v_existing_batch.operator_id is distinct from v_route_operator_id
    then
      raise exception 'Pickup batch id already belongs to another route or operator.'
        using errcode = '23505';
    end if;

    if v_existing_batch.confirmation_payload_hash is not null then
      if v_existing_batch.confirmation_payload_hash is distinct from v_payload_hash then
        raise exception 'Pickup confirmation retry payload does not match the committed receipt.'
          using errcode = '23514';
      end if;

      if v_existing_batch.confirmation_result is null
        or pg_catalog.jsonb_typeof(v_existing_batch.confirmation_result) <> 'object'
      then
        raise exception 'Pickup confirmation receipt is incomplete; manual review is required.'
          using errcode = '23514';
      end if;

      v_confirmation_result := v_existing_batch.confirmation_result;
      v_pickup_batch_id := nullif(v_confirmation_result->>'pickup_batch_id', '')::uuid;
      v_route_status := nullif(v_confirmation_result->>'route_status', '')::public.route_status;
      v_pending_stop_count := (v_confirmation_result->>'pending_stop_count')::integer;
      v_picked_stop_ids := array(
        select result_stop.value::uuid
        from pg_catalog.jsonb_array_elements_text(
          coalesce(v_confirmation_result->'picked_stop_ids', '[]'::jsonb)
        ) with ordinality as result_stop(value, ordinality)
        order by result_stop.ordinality
      );

      if v_pickup_batch_id is distinct from v_request_batch_id
        or v_route_status is null
        or v_pending_stop_count is null
      then
        raise exception 'Pickup confirmation receipt is invalid; manual review is required.'
          using errcode = '23514';
      end if;

      if coalesce((v_confirmation_result->>'movement_count')::integer, -1)
        is distinct from v_expected_movement_count
      then
        raise exception 'Pickup confirmation receipt movement count is invalid; manual review is required.'
          using errcode = '23514';
      end if;

      select pg_catalog.count(*)::integer
      into v_actual_movement_count
      from public.inventory_movements movement
      where movement.related_pickup_batch_id = v_request_batch_id
         or (
           movement.source_type = v_canonical_source_type
           and movement.source_id = v_request_batch_id
         );

      if v_actual_movement_count is distinct from v_expected_movement_count
        or exists (
          with expected as (
            select
              row_value.product_id,
              row_value.quantity,
              row_value.from_entity_type::public.inventory_entity_type as from_entity_type,
              row_value.from_entity_id,
              row_value.to_entity_type::public.inventory_entity_type as to_entity_type,
              row_value.to_entity_id,
              row_value.reason::public.movement_reason as reason,
              p_route_id as related_route_id,
              v_request_batch_id as related_pickup_batch_id,
              row_value.source_type,
              row_value.source_id,
              row_value.idempotency_key,
              row_value.created_by,
              row_value.notes
            from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
              as row_value(
                product_id uuid,
                quantity integer,
                from_entity_type text,
                from_entity_id uuid,
                to_entity_type text,
                to_entity_id uuid,
                reason text,
                source_type text,
                source_id uuid,
                idempotency_key text,
                created_by uuid,
                notes text
              )
          ),
          actual as (
            select
              movement.product_id,
              movement.quantity,
              movement.from_entity_type,
              movement.from_entity_id,
              movement.to_entity_type,
              movement.to_entity_id,
              movement.reason,
              movement.related_route_id,
              movement.related_pickup_batch_id,
              movement.source_type,
              movement.source_id,
              movement.idempotency_key,
              movement.created_by,
              movement.notes
            from public.inventory_movements movement
            where movement.related_pickup_batch_id = v_request_batch_id
               or (
                 movement.source_type = v_canonical_source_type
                 and movement.source_id = v_request_batch_id
               )
          )
          select 1
          from (
            (select * from expected except all select * from actual)
            union all
            (select * from actual except all select * from expected)
          ) mismatch
        )
      then
        raise exception 'Pickup confirmation ledger no longer matches its immutable receipt; manual review is required.'
          using errcode = '23514';
      end if;

      pickup_batch_id := v_pickup_batch_id;
      route_status := v_route_status;
      picked_stop_ids := v_picked_stop_ids;
      pending_stop_count := v_pending_stop_count;
      return next;
      return;
    end if;

    if v_existing_batch.status <> 'draft'
      or v_existing_batch.confirmed_at is not null
      or v_existing_batch.returned_to_assigned_at is not null
    then
      raise exception 'Legacy finalized pickup batch has no retry receipt; manual review is required.'
        using errcode = '23514';
    end if;
  end if;

  if coalesce(p_pickup_batch->>'status', '') <> 'confirmed' then
    raise exception 'Pickup confirmation requires a confirmed batch payload.'
      using errcode = '22023';
  end if;

  if not v_is_admin_correction then
    if not v_has_existing_batch then
      raise exception 'Pickup must be prepared before confirmation.'
        using errcode = '23514';
    end if;

    if v_existing_batch.prepared_at is null
      or v_existing_batch.prepared_by is null
      or v_existing_batch.storage_deducted
      or v_existing_batch.selected_stop_ids is distinct from v_requested_stop_ids
      or v_existing_batch.product_summary is distinct from coalesce(
        p_pickup_batch->'product_summary',
        '[]'::jsonb
      )
    then
      raise exception 'Prepared pickup batch does not match this confirmation; prepare it again.'
      using errcode = '23514';
    end if;
  end if;

  -- Batch and selected-stop inputs are two representations of one persisted
  -- snapshot. Duplicates, nulls, or a different set must fail before V2 can
  -- mark any stop as picked.
  if exists (
    select 1
    from pg_catalog.unnest(coalesce(p_batch_stop_ids, '{}'::uuid[])) value(id)
    where value.id is null
  )
    or exists (
      select 1
      from pg_catalog.unnest(coalesce(p_selected_stop_ids, '{}'::uuid[])) value(id)
      where value.id is null
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.unnest(coalesce(p_batch_stop_ids, '{}'::uuid[])) value(id)
    ) <> (
      select pg_catalog.count(distinct value.id)
      from pg_catalog.unnest(coalesce(p_batch_stop_ids, '{}'::uuid[])) value(id)
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.unnest(coalesce(p_selected_stop_ids, '{}'::uuid[])) value(id)
    ) <> (
      select pg_catalog.count(distinct value.id)
      from pg_catalog.unnest(coalesce(p_selected_stop_ids, '{}'::uuid[])) value(id)
    )
    or array(
      select value.id
      from pg_catalog.unnest(coalesce(p_batch_stop_ids, '{}'::uuid[])) value(id)
      order by value.id
    ) is distinct from array(
      select value.id
      from pg_catalog.unnest(coalesce(p_selected_stop_ids, '{}'::uuid[])) value(id)
      order by value.id
    )
  then
    raise exception 'Pickup batch stops must exactly match the selected stop set without duplicates.'
      using errcode = '22023';
  end if;

  select coalesce(
    pg_catalog.array_agg(distinct stop_row.machine_id order by stop_row.machine_id),
    '{}'::uuid[]
  )
  into v_expected_machine_ids
  from public.route_stops stop_row
  where stop_row.route_id = p_route_id
    and stop_row.id = any(v_requested_stop_ids);

  select coalesce(
    pg_catalog.array_agg(distinct selected.id order by selected.id),
    '{}'::uuid[]
  )
  into v_submitted_machine_ids
  from pg_catalog.unnest(coalesce(p_selected_machine_ids, '{}'::uuid[])) selected(id)
  where selected.id is not null;

  if not v_is_admin_correction
    and coalesce(pg_catalog.array_length(v_requested_stop_ids, 1), 0) > 0
    and (
      v_submitted_machine_ids is distinct from v_expected_machine_ids
      or coalesce(pg_catalog.array_length(p_selected_machine_ids, 1), 0)
        is distinct from coalesce(pg_catalog.array_length(v_submitted_machine_ids, 1), 0)
    )
  then
    raise exception 'Selected pickup machines must exactly match the selected route stops.'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(
      coalesce(p_pickup_batch->'product_summary', '[]'::jsonb)
    ) <> 'array'
    or pg_catalog.jsonb_array_length(
      coalesce(p_pickup_batch->'product_summary', '[]'::jsonb)
    ) = 0
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        coalesce(p_pickup_batch->'product_summary', '[]'::jsonb)
      ) summary(value)
      where pg_catalog.jsonb_typeof(summary.value) <> 'object'
        or coalesce(summary.value->>'product_id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(summary.value->>'quantity', '') !~ '^[1-9][0-9]*$'
        or pg_catalog.length(coalesce(summary.value->>'quantity', '')) > 6
        or case
          when coalesce(summary.value->>'quantity', '') ~ '^[1-9][0-9]*$'
            and pg_catalog.length(coalesce(summary.value->>'quantity', '')) <= 6
          then (summary.value->>'quantity')::integer > 100000
          else false
        end
    )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_pickup_batch->'product_summary', '[]'::jsonb)
      ) summary(value)
    ) <> (
      select pg_catalog.count(distinct (summary.value->>'product_id')::uuid)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_pickup_batch->'product_summary', '[]'::jsonb)
      ) summary(value)
    )
  then
    raise exception 'Prepared pickup product summary requires one positive whole-unit row per product.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(p_pick_list_rows, '[]'::jsonb)
    ) submitted(value)
    where pg_catalog.jsonb_typeof(submitted.value) <> 'object'
      or coalesce(submitted.value->>'id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(submitted.value->>'product_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(submitted.value->>'planned_qty', '') !~ '^[0-9]+$'
      or coalesce(submitted.value->>'picked_qty', '') !~ '^[0-9]+$'
      or pg_catalog.length(coalesce(submitted.value->>'planned_qty', '')) > 6
      or pg_catalog.length(coalesce(submitted.value->>'picked_qty', '')) > 6
      or submitted.value->>'action_type' not in (
        'planned_pick', 'extra_product', 'substitution'
      )
      or (
        (submitted.value->>'picked_qty')::integer > 0
        and coalesce((submitted.value->>'is_checked')::boolean, false) = false
      )
  )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_pick_list_rows, '[]'::jsonb)
      ) submitted(value)
    ) <> (
      select pg_catalog.count(distinct (submitted.value->>'id')::uuid)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_pick_list_rows, '[]'::jsonb)
      ) submitted(value)
    )
    or (
      not v_is_admin_correction
      and exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          coalesce(p_pick_list_rows, '[]'::jsonb)
        ) submitted(value)
        where nullif(submitted.value->>'pickup_batch_id', '')::uuid
          is distinct from v_request_batch_id
      )
    )
    or (
      not v_is_admin_correction
      and exists (
        select 1
        from pg_catalog.jsonb_to_recordset(
          coalesce(p_pick_list_rows, '[]'::jsonb)
        ) submitted(route_stop_item_id uuid)
        where submitted.route_stop_item_id is not null
        group by submitted.route_stop_item_id
        having pg_catalog.count(*) > 1
      )
    )
  then
    raise exception 'Pickup checklist rows must be unique, checked, nonnegative, and linked to this pickup batch.'
      using errcode = '22023';
  end if;

  -- created_by is team-member provenance. Normal pickup rows belong to the
  -- assigned operator; admin correction rows belong to the authenticated admin.
  -- Prior admin evidence is compared to its stored value below and is never
  -- rewritten merely because a different administrator records the correction.
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_pick_list_rows, '[]'::jsonb)
    ) submitted(created_by uuid, pickup_batch_id uuid)
    where (
      not v_is_admin_correction
      and submitted.created_by is distinct from v_route_operator_id
    )
      or (
        v_is_admin_correction
        and submitted.pickup_batch_id = v_request_batch_id
        and submitted.created_by is distinct from v_actor_team_member_id
      )
  ) then
    raise exception 'Pickup checklist creator provenance does not match the canonical actor.'
      using errcode = '42501';
  end if;

  if exists (
    with summary as (
      select
        (row_value.product_id)::uuid as product_id,
        row_value.quantity::bigint as quantity
      from pg_catalog.jsonb_to_recordset(
        coalesce(p_pickup_batch->'product_summary', '[]'::jsonb)
      ) row_value(product_id text, quantity integer)
    ),
    picked as (
      select
        row_value.product_id,
        pg_catalog.sum(row_value.picked_qty)::bigint as quantity
      from pg_catalog.jsonb_to_recordset(
        coalesce(p_pick_list_rows, '[]'::jsonb)
      ) row_value(
        product_id uuid,
        picked_qty integer,
        pickup_batch_id uuid
      )
      where not v_is_admin_correction
        or row_value.pickup_batch_id = v_request_batch_id
      group by row_value.product_id
      having pg_catalog.sum(row_value.picked_qty) > 0
    )
    select 1
    from summary
    full join picked using (product_id)
    where summary.quantity is distinct from picked.quantity
  ) then
    raise exception 'Pickup product summary does not exactly match the checked pick-list quantities.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(p_stock_line_rows, '[]'::jsonb)
    ) submitted(value)
    where pg_catalog.jsonb_typeof(submitted.value) <> 'object'
      or coalesce(submitted.value->>'product_id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or nullif(submitted.value->>'route_id', '')::uuid is distinct from p_route_id
      or coalesce(submitted.value->>'planned_qty', '') !~ '^[0-9]+$'
      or coalesce(submitted.value->>'picked_qty', '') !~ '^[0-9]+$'
      or pg_catalog.length(coalesce(submitted.value->>'planned_qty', '')) > 6
      or pg_catalog.length(coalesce(submitted.value->>'picked_qty', '')) > 6
  )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_stock_line_rows, '[]'::jsonb)
      ) submitted(value)
    ) <> (
      select pg_catalog.count(distinct (submitted.value->>'product_id')::uuid)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_stock_line_rows, '[]'::jsonb)
      ) submitted(value)
    )
  then
    raise exception 'Route stock rows must contain one nonnegative row per route product.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.route_stock_lines stock_line
    where stock_line.route_id = p_route_id
      and stock_line.product_id in (
        select (submitted.value->>'product_id')::uuid
        from pg_catalog.jsonb_array_elements(
          coalesce(p_stock_line_rows, '[]'::jsonb)
        ) submitted(value)
      )
    group by stock_line.product_id
    having pg_catalog.count(*) <> 1
  ) then
    raise exception 'Route stock has duplicate product rows; reconcile it before confirming pickup.'
      using errcode = '23514';
  end if;

  -- The route-stock delta is the authoritative ledger delta. For a new stop
  -- batch or an admin missed pickup it must also equal the prepared batch
  -- summary. For the legacy replace flow, the summary is the desired absolute
  -- picked total and the ledger may contain a return delta.
  if exists (
    with summary as (
      select
        row_value.product_id::uuid as product_id,
        row_value.quantity::bigint as summary_quantity
      from pg_catalog.jsonb_to_recordset(
        coalesce(p_pickup_batch->'product_summary', '[]'::jsonb)
      ) row_value(product_id text, quantity integer)
    ),
    submitted_stock as (
      select row_value.product_id, row_value.picked_qty::bigint as picked_qty
      from pg_catalog.jsonb_to_recordset(
        coalesce(p_stock_line_rows, '[]'::jsonb)
      ) row_value(product_id uuid, picked_qty integer)
    ),
    current_stock as (
      select stock_line.product_id, stock_line.picked_qty::bigint as picked_qty
      from public.route_stock_lines stock_line
      where stock_line.route_id = p_route_id
        and stock_line.product_id in (select product_id from submitted_stock)
    ),
    stock_delta as (
      select
        submitted_stock.product_id,
        submitted_stock.picked_qty - coalesce(current_stock.picked_qty, 0) as delta_quantity,
        submitted_stock.picked_qty
      from submitted_stock
      left join current_stock using (product_id)
    ),
    movement_delta as (
      select
        movement.product_id,
        pg_catalog.sum(
          case
            when movement.reason = 'storage_to_operator_bag' then movement.quantity::bigint
            else -movement.quantity::bigint
          end
        ) as delta_quantity
      from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
        movement(product_id uuid, quantity integer, reason text)
      group by movement.product_id
    ),
    product_set as (
      select product_id from summary
      union
      select product_id from stock_delta
      union
      select product_id from movement_delta
    )
    select 1
    from product_set product
    left join summary using (product_id)
    left join stock_delta using (product_id)
    left join movement_delta using (product_id)
    where coalesce(stock_delta.delta_quantity, 0)
        is distinct from coalesce(movement_delta.delta_quantity, 0)
      or (
        (v_is_admin_correction
          or coalesce(pg_catalog.array_length(v_requested_stop_ids, 1), 0) > 0)
        and coalesce(stock_delta.delta_quantity, 0)
          is distinct from coalesce(summary.summary_quantity, 0)
      )
      or (
        not v_is_admin_correction
        and coalesce(pg_catalog.array_length(v_requested_stop_ids, 1), 0) = 0
        and stock_delta.picked_qty is distinct from summary.summary_quantity
      )
  ) then
    raise exception 'Pickup ledger quantities do not exactly match pick-list, batch, and route-stock quantities.'
      using errcode = '23514';
  end if;

  if (v_is_admin_correction
      or coalesce(pg_catalog.array_length(v_requested_stop_ids, 1), 0) > 0)
    and exists (
      select 1
      from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
        movement(reason text)
      where movement.reason <> 'storage_to_operator_bag'
    )
  then
    raise exception 'A new pickup batch may only move stock from storage to its assigned operator bag.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
      movement(product_id uuid, reason text)
    group by movement.product_id
    having pg_catalog.count(distinct movement.reason) > 1
  ) then
    raise exception 'One pickup payload cannot both issue and return the same product.'
      using errcode = '23514';
  end if;

  if not v_is_admin_correction then
    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        coalesce(p_stop_item_picks, '[]'::jsonb)
      ) submitted(value)
      where pg_catalog.jsonb_typeof(submitted.value) <> 'object'
        or coalesce(submitted.value->>'id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(submitted.value->>'picked_quantity', '') !~ '^[0-9]+$'
        or pg_catalog.length(coalesce(submitted.value->>'picked_quantity', '')) > 6
    )
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(
          coalesce(p_stop_item_picks, '[]'::jsonb)
        ) submitted(value)
      ) <> (
        select pg_catalog.count(distinct (submitted.value->>'id')::uuid)
        from pg_catalog.jsonb_array_elements(
          coalesce(p_stop_item_picks, '[]'::jsonb)
        ) submitted(value)
      )
      or exists (
        with expected as (
          select row_value.route_stop_item_id as id, row_value.picked_qty as picked_quantity
          from pg_catalog.jsonb_to_recordset(
            coalesce(p_pick_list_rows, '[]'::jsonb)
          ) row_value(route_stop_item_id uuid, picked_qty integer)
          where row_value.route_stop_item_id is not null
        ),
        submitted as (
          select row_value.id, row_value.picked_quantity
          from pg_catalog.jsonb_to_recordset(
            coalesce(p_stop_item_picks, '[]'::jsonb)
          ) row_value(id uuid, picked_quantity integer)
        )
        select 1
        from expected
        full join submitted using (id)
        where expected.picked_quantity is distinct from submitted.picked_quantity
      )
    then
      raise exception 'Route-stop picked quantities do not exactly match the checked pick list.'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        coalesce(p_refill_line_picks, '[]'::jsonb)
      ) submitted(value)
      where pg_catalog.jsonb_typeof(submitted.value) <> 'object'
        or coalesce(submitted.value->>'id', '')
          !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or coalesce(submitted.value->>'picked_qty', '') !~ '^[0-9]+$'
        or pg_catalog.length(coalesce(submitted.value->>'picked_qty', '')) > 6
    )
      or (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(
          coalesce(p_refill_line_picks, '[]'::jsonb)
        ) submitted(value)
      ) <> (
        select pg_catalog.count(distinct (submitted.value->>'id')::uuid)
        from pg_catalog.jsonb_array_elements(
          coalesce(p_refill_line_picks, '[]'::jsonb)
        ) submitted(value)
      )
      or exists (
        with submitted_refill as (
          select
            line.product_id,
            pg_catalog.sum(row_value.picked_qty)::bigint as picked_qty
          from pg_catalog.jsonb_to_recordset(
            coalesce(p_refill_line_picks, '[]'::jsonb)
          ) row_value(id uuid, picked_qty integer)
          join public.refill_order_lines line on line.id = row_value.id
          join public.refill_orders refill on refill.id = line.refill_order_id
          where refill.route_id = p_route_id
          group by line.product_id
        ),
        expected_refill as (
          select
            row_value.product_id,
            pg_catalog.sum(row_value.picked_qty)::bigint as picked_qty
          from pg_catalog.jsonb_to_recordset(
            coalesce(p_pick_list_rows, '[]'::jsonb)
          ) row_value(
            product_id uuid,
            picked_qty integer,
            action_type text
          )
          where row_value.action_type <> 'extra_product'
            and exists (
              select 1
              from public.refill_order_lines line
              join public.refill_orders refill on refill.id = line.refill_order_id
              where refill.route_id = p_route_id
                and line.product_id = row_value.product_id
            )
          group by row_value.product_id
        )
        select 1
        from expected_refill
        full join submitted_refill using (product_id)
        where expected_refill.picked_qty is distinct from submitted_refill.picked_qty
      )
    then
      raise exception 'Refill picked quantities do not exactly match the checked route products.'
        using errcode = '23514';
    end if;
  elsif pg_catalog.jsonb_array_length(coalesce(p_stop_item_picks, '[]'::jsonb)) <> 0
    or pg_catalog.jsonb_array_length(coalesce(p_refill_line_picks, '[]'::jsonb)) <> 0
  then
    raise exception 'Admin missed pickup may not rewrite stop or refill picked quantities.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
      movement(from_entity_type text, from_entity_id uuid, to_entity_type text, to_entity_id uuid)
    join public.storage_locations storage_row
      on storage_row.id = case
        when movement.from_entity_type = 'storage' then movement.from_entity_id
        else movement.to_entity_id
      end
    where storage_row.active is distinct from true
      or storage_row.location_type::text not in (
        'main_storage', 'vehicle', 'temporary', 'other'
      )
  )
    or exists (
      select 1
      from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
        movement(from_entity_type text, from_entity_id uuid, to_entity_type text, to_entity_id uuid)
      left join public.storage_locations storage_row
        on storage_row.id = case
          when movement.from_entity_type = 'storage' then movement.from_entity_id
          else movement.to_entity_id
        end
      where storage_row.id is null
    )
  then
    raise exception 'Pickup inventory references a missing, inactive, or non-physical storage location.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      coalesce(p_new_stop_item_rows, '[]'::jsonb)
    ) submitted(value)
    where pg_catalog.jsonb_typeof(submitted.value) <> 'object'
      or coalesce(submitted.value->>'id', '')
        !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
    or (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_new_stop_item_rows, '[]'::jsonb)
      ) submitted(value)
    ) <> (
      select pg_catalog.count(distinct (submitted.value->>'id')::uuid)
      from pg_catalog.jsonb_array_elements(
        coalesce(p_new_stop_item_rows, '[]'::jsonb)
      ) submitted(value)
    )
    or exists (
      select 1
      from public.route_stop_items existing
      join pg_catalog.jsonb_to_recordset(
        coalesce(p_new_stop_item_rows, '[]'::jsonb)
      ) submitted(id uuid) on submitted.id = existing.id
    )
  then
    raise exception 'New pickup route-stop item ids must be unique and unused.'
      using errcode = '23505';
  end if;

  if v_is_admin_correction and exists (
    select 1
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_pick_list_rows, '[]'::jsonb)
    ) submitted(
      id uuid,
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      reason text,
      notes text,
      needs_review boolean,
      created_by uuid,
      is_checked boolean
    )
    left join public.route_pick_list_items existing
      on existing.id = submitted.id
     and existing.route_id = p_route_id
    where submitted.pickup_batch_id is distinct from v_request_batch_id
      and (
        existing.id is null
        or existing.pickup_batch_id is null
        or existing.route_stop_id is distinct from submitted.route_stop_id
        or existing.route_stop_item_id is distinct from submitted.route_stop_item_id
        or existing.machine_id is distinct from submitted.machine_id
        or existing.product_id is distinct from submitted.product_id
        or existing.planned_qty is distinct from submitted.planned_qty
        or existing.picked_qty is distinct from submitted.picked_qty
        or existing.action_type is distinct from submitted.action_type
        or existing.pickup_batch_id is distinct from submitted.pickup_batch_id
        or existing.reason is distinct from submitted.reason
        or existing.notes is distinct from submitted.notes
        or existing.needs_review is distinct from submitted.needs_review
        or existing.created_by is distinct from submitted.created_by
        or coalesce(existing.is_checked, false)
          is distinct from coalesce(submitted.is_checked, false)
        or existing.is_active is distinct from true
      )
  ) then
    raise exception 'Admin missed pickup may not alter prior checklist evidence.'
      using errcode = '23514';
  end if;

  if v_is_admin_correction and exists (
    select 1
    from public.route_pick_list_items existing
    join pg_catalog.jsonb_to_recordset(
      coalesce(p_pick_list_rows, '[]'::jsonb)
    ) submitted(id uuid, pickup_batch_id uuid)
      on submitted.id = existing.id
    where submitted.pickup_batch_id = v_request_batch_id
  ) then
    raise exception 'Admin missed pickup checklist row id is already in use.'
      using errcode = '23505';
  end if;

  if not v_is_admin_correction and exists (
    select 1
    from public.route_pick_list_items existing
    join pg_catalog.jsonb_to_recordset(
      coalesce(p_pick_list_rows, '[]'::jsonb)
    ) submitted(id uuid) on submitted.id = existing.id
  ) then
    raise exception 'Pickup checklist row id is already in use.'
      using errcode = '23505';
  end if;

  if exists (
    select 1
    from public.route_pick_list_items existing
    where existing.pickup_batch_id = v_request_batch_id
  ) then
    raise exception 'Pickup batch already has checklist history without an exact confirmation receipt.'
      using errcode = '23505';
  end if;

  -- V2 takes these same advisory keys while iterating an unordered GROUP BY.
  -- Acquire the complete set first in the canonical storage/product order used
  -- by purchase receive/void, so V2's later calls are harmless re-entrant locks.
  for v_storage_lock in
    with storage_product_keys as (
      select movement.from_entity_id as storage_id, movement.product_id
      from pg_catalog.jsonb_to_recordset(
        v_canonical_inventory_movements
      ) as movement(
        product_id uuid,
        from_entity_type text,
        from_entity_id uuid,
        to_entity_type text,
        to_entity_id uuid
      )
      where movement.from_entity_type = 'storage'

      union

      select movement.to_entity_id as storage_id, movement.product_id
      from pg_catalog.jsonb_to_recordset(
        v_canonical_inventory_movements
      ) as movement(
        product_id uuid,
        from_entity_type text,
        from_entity_id uuid,
        to_entity_type text,
        to_entity_id uuid
      )
      where movement.to_entity_type = 'storage'
    )
    select key_row.storage_id, key_row.product_id
    from storage_product_keys key_row
    where key_row.storage_id is not null
      and key_row.product_id is not null
    order by key_row.storage_id, key_row.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_storage_lock.product_id::text),
      pg_catalog.hashtext(v_storage_lock.storage_id::text)
    );
  end loop;

  for v_storage_lock in
    select
      movement.from_entity_id as storage_id,
      movement.product_id,
      pg_catalog.sum(movement.quantity)::bigint as needed_quantity
    from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
      movement(
        product_id uuid,
        quantity integer,
        from_entity_id uuid,
        reason text
      )
    where movement.reason = 'storage_to_operator_bag'
    group by movement.from_entity_id, movement.product_id
    order by movement.from_entity_id, movement.product_id
  loop
    v_stock_needed := v_storage_lock.needed_quantity;

    select coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0::bigint)
    into v_stock_on_hand
    from public.current_inventory_by_location inventory
    where inventory.location_type = 'storage'
      and inventory.location_id = v_storage_lock.storage_id
      and inventory.product_id = v_storage_lock.product_id;

    if v_stock_on_hand < v_stock_needed then
      raise exception 'Not enough physical storage stock. Needed %, physically on hand %.',
        v_stock_needed,
        greatest(v_stock_on_hand, 0::bigint)
        using errcode = '23514';
    end if;

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
  end loop;

  -- Match every other route-custody writer: storage locks first where present,
  -- then one operator custody lock, then sorted owner/product bag locks. The
  -- statement-level ledger guards re-enter these keys without changing order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:operator-custody:' || v_route_operator_id::text,
      0
    )
  );

  for v_product_lock in
    select distinct movement.product_id
    from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
      movement(product_id uuid)
    order by movement.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_route_operator_id::text || ':' || v_product_lock::text,
        0
      )
    );
  end loop;

  for v_product_lock in
    select distinct row_value.product_id
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_stock_line_rows, '[]'::jsonb)
    ) row_value(product_id uuid)
    order by row_value.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:route-stock-line:' || p_route_id::text || ':' || v_product_lock::text,
        0
      )
    );
  end loop;

  -- A first confirmation owns a clean batch namespace. Exact retries returned
  -- above from their immutable receipt. Any earlier row or reused key here is
  -- therefore a collision and must abort before V2 changes workflow state.
  if exists (
    select 1
    from public.inventory_movements movement
    where movement.idempotency_key in (
      select row_value.idempotency_key
      from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
        row_value(idempotency_key text)
      )
      or movement.related_pickup_batch_id = v_request_batch_id
      or (
        movement.source_type = v_canonical_source_type
        and movement.source_id = v_request_batch_id
      )
  ) then
    raise exception 'Pickup batch or movement key already has ledger history without an exact confirmation receipt.'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config(
    'snacky.route_pickup_batch_write_mode',
    'confirm',
    true
  );

  select confirmed.pickup_batch_id,
         confirmed.route_status,
         confirmed.picked_stop_ids,
         confirmed.pending_stop_count
  into v_pickup_batch_id,
       v_route_status,
       v_picked_stop_ids,
       v_pending_stop_count
  from public.snacky_confirm_route_pickup_batch_v2(
    p_route_id,
    p_expected_route_status,
    p_next_route_status,
    p_started_at,
    p_replace_pick_list,
    v_canonical_pickup_batch,
    p_batch_stop_ids,
    p_new_stop_item_rows,
    v_canonical_inventory_movements,
    p_pick_list_rows,
    p_stock_line_rows,
    p_stop_item_picks,
    p_refill_line_picks,
    p_selected_stop_ids,
    p_acknowledged_pickup_line_ids,
    v_v2_selected_machine_ids
  ) confirmed;

  if not found then
    raise exception 'Atomic pickup confirmation returned no result.'
      using errcode = 'P0001';
  end if;

  if v_pickup_batch_id is distinct from v_request_batch_id
    or v_route_status is null
    or v_pending_stop_count is null
  then
    raise exception 'Atomic pickup confirmation returned an invalid receipt result.'
      using errcode = '23514';
  end if;

  if v_is_admin_correction and v_route_status is distinct from v_route_status_before then
    raise exception 'Admin missed pickup may not change route status.'
      using errcode = '23514';
  end if;

  if not v_is_admin_correction
    and v_route_status is distinct from p_next_route_status
  then
    raise exception 'Atomic pickup confirmation returned an unexpected route transition.'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.routes route_row
    where route_row.id = p_route_id
      and route_row.status is not distinct from v_route_status
  ) then
    raise exception 'Route did not commit the pickup status returned by the atomic writer.'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.route_pickup_batches batch_row
    where batch_row.id = v_request_batch_id
      and batch_row.route_id = p_route_id
      and batch_row.operator_id = v_route_operator_id
      and batch_row.status::text = 'confirmed'
      and batch_row.selected_stop_ids is not distinct from v_requested_stop_ids
      and batch_row.product_summary is not distinct from coalesce(
        p_pickup_batch->'product_summary',
        '[]'::jsonb
      )
      and batch_row.storage_deducted is not distinct from (
        v_canonical_pickup_batch->>'storage_deducted'
      )::boolean
      and batch_row.confirmed_at is not distinct from (
        v_canonical_pickup_batch->>'confirmed_at'
      )::timestamptz
      and batch_row.returned_to_assigned_at is null
  ) then
    raise exception 'Pickup batch did not commit its exact canonical confirmation snapshot.'
      using errcode = '23514';
  end if;

  if array(
      select batch_stop.route_stop_id
      from public.route_pickup_batch_stops batch_stop
      where batch_stop.pickup_batch_id = v_request_batch_id
      order by batch_stop.route_stop_id
    ) is distinct from array(
      select requested.id
      from pg_catalog.unnest(v_requested_stop_ids) requested(id)
      order by requested.id
    )
  then
    raise exception 'Pickup batch-stop links did not commit exactly.'
      using errcode = '23514';
  end if;

  select pg_catalog.count(*)::integer
  into v_actual_movement_count
  from public.inventory_movements movement
  where movement.related_pickup_batch_id = v_request_batch_id
     or (
       movement.source_type = v_canonical_source_type
       and movement.source_id = v_request_batch_id
     );

  if v_actual_movement_count is distinct from v_expected_movement_count
    or exists (
      with expected as (
        select
          row_value.product_id,
          row_value.quantity,
          row_value.from_entity_type::public.inventory_entity_type as from_entity_type,
          row_value.from_entity_id,
          row_value.to_entity_type::public.inventory_entity_type as to_entity_type,
          row_value.to_entity_id,
          row_value.reason::public.movement_reason as reason,
          p_route_id as related_route_id,
          v_request_batch_id as related_pickup_batch_id,
          row_value.source_type,
          row_value.source_id,
          row_value.idempotency_key,
          row_value.created_by,
          row_value.notes
        from pg_catalog.jsonb_to_recordset(v_canonical_inventory_movements)
          as row_value(
            product_id uuid,
            quantity integer,
            from_entity_type text,
            from_entity_id uuid,
            to_entity_type text,
            to_entity_id uuid,
            reason text,
            source_type text,
            source_id uuid,
            idempotency_key text,
            created_by uuid,
            notes text
          )
      ),
      actual as (
        select
          movement.product_id,
          movement.quantity,
          movement.from_entity_type,
          movement.from_entity_id,
          movement.to_entity_type,
          movement.to_entity_id,
          movement.reason,
          movement.related_route_id,
          movement.related_pickup_batch_id,
          movement.source_type,
          movement.source_id,
          movement.idempotency_key,
          movement.created_by,
          movement.notes
        from public.inventory_movements movement
        where movement.related_pickup_batch_id = v_request_batch_id
           or (
             movement.source_type = v_canonical_source_type
             and movement.source_id = v_request_batch_id
           )
      )
      select 1
      from (
        (select * from expected except all select * from actual)
        union all
        (select * from actual except all select * from expected)
      ) mismatch
    )
  then
    raise exception 'Pickup ledger did not commit exactly one canonical movement per intended row.'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_stock_line_rows, '[]'::jsonb)
    ) expected(product_id uuid, planned_qty integer, picked_qty integer)
    left join public.route_stock_lines actual
      on actual.route_id = p_route_id
     and actual.product_id = expected.product_id
    where actual.product_id is null
      or actual.planned_qty is distinct from expected.planned_qty
      or actual.picked_qty is distinct from expected.picked_qty
  ) then
    raise exception 'Route stock lines did not commit the exact pickup quantities.'
      using errcode = '23514';
  end if;

  if not v_is_admin_correction and exists (
    select 1
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_stop_item_picks, '[]'::jsonb)
    ) expected(id uuid, picked_quantity integer)
    left join public.route_stop_items actual
      on actual.id = expected.id
     and actual.route_id = p_route_id
    where actual.id is null
      or actual.picked_quantity is distinct from expected.picked_quantity
  ) then
    raise exception 'Route-stop item quantities did not commit exactly.'
      using errcode = '23514';
  end if;

  if not v_is_admin_correction and exists (
    select 1
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_refill_line_picks, '[]'::jsonb)
    ) expected(id uuid, picked_qty integer)
    left join public.refill_order_lines actual on actual.id = expected.id
    left join public.refill_orders refill
      on refill.id = actual.refill_order_id
     and refill.route_id = p_route_id
    where actual.id is null
      or refill.id is null
      or actual.picked_qty is distinct from expected.picked_qty
  ) then
    raise exception 'Refill line quantities did not commit exactly.'
      using errcode = '23514';
  end if;

  if not v_is_admin_correction
    and exists (
      select 1
      from pg_catalog.unnest(v_requested_stop_ids) requested(id)
      left join public.route_stops stop_row
        on stop_row.id = requested.id
       and stop_row.route_id = p_route_id
      where stop_row.id is null
        or stop_row.status <> 'picked'::public.route_stop_status
    )
  then
    raise exception 'Selected route stops did not commit the picked transition exactly.'
      using errcode = '23514';
  end if;

  if array(
      select stop_value.id
      from pg_catalog.unnest(coalesce(v_picked_stop_ids, '{}'::uuid[])) stop_value(id)
      order by stop_value.id
    ) is distinct from array(
      select stop_value.id
      from pg_catalog.unnest(v_requested_stop_ids) stop_value(id)
      order by stop_value.id
    )
  then
    raise exception 'Pickup result stop set does not match the submitted batch.'
      using errcode = '23514';
  end if;

  update public.route_pick_list_items as pick_item
  set is_checked = coalesce(submitted.is_checked, false),
      checked_at = case
        when coalesce(submitted.is_checked, false)
          and not coalesce(pick_item.is_checked, false)
        then coalesce(submitted.checked_at, p_started_at, pg_catalog.now())
        when coalesce(submitted.is_checked, false)
        then pick_item.checked_at
        else null
      end,
      checked_by = case
        when coalesce(submitted.is_checked, false)
          and not coalesce(pick_item.is_checked, false)
        then coalesce(submitted.checked_by, v_actor_id)
        when coalesce(submitted.is_checked, false)
        then pick_item.checked_by
        else null
      end,
      updated_at = pg_catalog.now()
  from pg_catalog.jsonb_to_recordset(
    coalesce(p_pick_list_rows, '[]'::jsonb)
  ) as submitted(
    id uuid,
    is_checked boolean,
    checked_at timestamptz,
    checked_by uuid
  )
  where pick_item.id = submitted.id
    and pick_item.route_id = p_route_id
    and (
      v_pickup_batch_id is null
      or pick_item.pickup_batch_id = v_pickup_batch_id
    )
    and (
      pick_item.is_checked is distinct from coalesce(submitted.is_checked, false)
      or (
        not coalesce(submitted.is_checked, false)
        and (pick_item.checked_at is not null or pick_item.checked_by is not null)
      )
    );

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(
      coalesce(p_pick_list_rows, '[]'::jsonb)
    ) submitted(
      id uuid,
      route_stop_id uuid,
      route_stop_item_id uuid,
      machine_id uuid,
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      action_type text,
      pickup_batch_id uuid,
      is_checked boolean
    )
    left join public.route_pick_list_items saved
      on saved.id = submitted.id
     and saved.route_id = p_route_id
    where saved.id is null
      or saved.route_stop_id is distinct from submitted.route_stop_id
      or saved.route_stop_item_id is distinct from submitted.route_stop_item_id
      or saved.machine_id is distinct from submitted.machine_id
      or saved.product_id is distinct from submitted.product_id
      or saved.planned_qty is distinct from submitted.planned_qty
      or saved.picked_qty is distinct from submitted.picked_qty
      or saved.action_type is distinct from submitted.action_type
      or coalesce(saved.is_checked, false)
        is distinct from coalesce(submitted.is_checked, false)
      or (
        coalesce(submitted.is_checked, false)
        and (
          not v_is_admin_correction
          or submitted.pickup_batch_id = v_request_batch_id
        )
        and saved.checked_by is distinct from v_actor_id
      )
      or (
        not v_is_admin_correction
        and saved.pickup_batch_id is distinct from v_request_batch_id
      )
  ) then
    raise exception 'Pickup checklist evidence did not commit exactly.'
      using errcode = '23514';
  end if;

  if array(
      select saved.id
      from public.route_pick_list_items saved
      where saved.route_id = p_route_id
        and saved.pickup_batch_id = v_request_batch_id
      order by saved.id
    ) is distinct from array(
      select submitted.id
      from pg_catalog.jsonb_to_recordset(
        coalesce(p_pick_list_rows, '[]'::jsonb)
      ) submitted(id uuid, pickup_batch_id uuid)
      where submitted.pickup_batch_id = v_request_batch_id
      order by submitted.id
    )
  then
    raise exception 'Pickup batch checklist cardinality did not commit exactly.'
      using errcode = '23514';
  end if;

  v_confirmation_result := pg_catalog.jsonb_build_object(
    'pickup_batch_id', v_pickup_batch_id,
    'route_status', v_route_status,
    'picked_stop_ids', pg_catalog.to_jsonb(coalesce(v_picked_stop_ids, '{}'::uuid[])),
    'pending_stop_count', v_pending_stop_count,
    'movement_count', v_expected_movement_count
  );

  update public.route_pickup_batches batch_row
  set confirmation_payload_hash = v_payload_hash,
      confirmation_result = v_confirmation_result
  where batch_row.id = v_request_batch_id
    and batch_row.confirmation_payload_hash is null
    and batch_row.confirmation_result is null;

  if not found then
    raise exception 'Pickup confirmation receipt could not be stored atomically.'
      using errcode = '23514';
  end if;

  perform pg_catalog.set_config(
    'snacky.route_pickup_batch_write_mode',
    '',
    true
  );

  pickup_batch_id := v_pickup_batch_id;
  route_status := v_route_status;
  picked_stop_ids := v_picked_stop_ids;
  pending_stop_count := v_pending_stop_count;
  return next;
end;
$$;

revoke all on function public.snacky_confirm_route_pickup_batch_v2(
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
) from public, anon, authenticated, service_role;

-- Retire every historical pickup-confirmation entry point from API roles.
-- V3 remains the only client-executable contract. These functions are kept in
-- place because the canonical security-definer chain may still invoke internal
-- implementations as their owning database role; revoking API-role EXECUTE does
-- not remove the function owner's existing privilege.
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
) from public, anon, authenticated, service_role;

-- Production also retains the pre-acknowledgement 15-argument compatibility
-- overload. Revoke it explicitly; otherwise PostgREST can still select that
-- signature and bypass the V3 custody receipt.
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
  uuid[]
) from public, anon, authenticated, service_role;

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
) from public, anon, authenticated, service_role;

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
  uuid[],
  uuid[]
) from public, anon, authenticated, service_role;

revoke all on function public.snacky_confirm_route_pickup_batch_v3(
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
) from public, anon;

grant execute on function public.snacky_confirm_route_pickup_batch_v3(
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
) to authenticated, service_role;

-- Drafts remain editable for prepare/upsert. Confirmed and returned rows are
-- append-only audit evidence: only a marked canonical RPC may cross a terminal
-- boundary, and identity/original confirmation fields remain immutable.
create or replace function public.snacky_guard_route_pickup_batch_audit()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_mode text := coalesce(
    pg_catalog.current_setting('snacky.route_pickup_batch_write_mode', true),
    ''
  );
begin
  if tg_op = 'INSERT' then
    if new.status = 'draft'
      and new.confirmed_at is null
      and not new.storage_deducted
      and new.returned_to_assigned_at is null
      and new.returned_to_assigned_by is null
      and new.returned_to_assigned_reason is null
      and coalesce(new.returned_to_assigned_movement_count, 0) = 0
      and coalesce(new.returned_to_assigned_quantity, 0) = 0
      and new.confirmation_payload_hash is null
      and new.confirmation_result is null
    then
      return new;
    end if;

    if v_mode = 'confirm'
      and new.status = 'confirmed'
      and new.operator_id is not null
      and new.confirmed_at is not null
      and new.returned_to_assigned_at is null
      and new.returned_to_assigned_by is null
      and new.returned_to_assigned_reason is null
      and coalesce(new.returned_to_assigned_movement_count, 0) = 0
      and coalesce(new.returned_to_assigned_quantity, 0) = 0
      and new.confirmation_payload_hash is null
      and new.confirmation_result is null
    then
      return new;
    end if;

    raise exception 'Pickup batches may be confirmed only by the atomic pickup RPC.'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.route_id is distinct from old.route_id
      or new.operator_id is distinct from old.operator_id
      or new.created_at is distinct from old.created_at
    then
      raise exception 'Pickup batch identity and creation evidence are immutable.'
        using errcode = '23514';
    end if;

    if v_mode = 'confirm' then
      -- V3 installs its immutable receipt only after V2, checklist evidence,
      -- and inventory all succeeded. No other finalized field may move.
      if old.status = 'confirmed'
        and old.returned_to_assigned_at is null
        and old.confirmation_payload_hash is null
        and old.confirmation_result is null
        and new.status is not distinct from old.status
        and new.selected_stop_ids is not distinct from old.selected_stop_ids
        and new.product_summary is not distinct from old.product_summary
        and new.storage_deducted is not distinct from old.storage_deducted
        and new.confirmed_at is not distinct from old.confirmed_at
        and new.prepared_at is not distinct from old.prepared_at
        and new.prepared_by is not distinct from old.prepared_by
        and new.updated_at is not distinct from old.updated_at
        and new.returned_to_assigned_at is not distinct from old.returned_to_assigned_at
        and new.returned_to_assigned_by is not distinct from old.returned_to_assigned_by
        and new.returned_to_assigned_reason is not distinct from old.returned_to_assigned_reason
        and new.returned_to_assigned_movement_count is not distinct from old.returned_to_assigned_movement_count
        and new.returned_to_assigned_quantity is not distinct from old.returned_to_assigned_quantity
        and new.confirmation_payload_hash ~ '^[0-9a-f]{32}$'
        and pg_catalog.jsonb_typeof(new.confirmation_result) = 'object'
      then
        return new;
      end if;

      -- An internal exact receipt replay is harmless and cannot refresh any
      -- timestamp or replace any proof field.
      if old.status = 'confirmed'
        and old.returned_to_assigned_at is null
        and old.confirmation_payload_hash is not null
        and old.confirmation_result is not null
        and new.status is not distinct from old.status
        and new.selected_stop_ids is not distinct from old.selected_stop_ids
        and new.product_summary is not distinct from old.product_summary
        and new.storage_deducted is not distinct from old.storage_deducted
        and new.confirmed_at is not distinct from old.confirmed_at
        and new.prepared_at is not distinct from old.prepared_at
        and new.prepared_by is not distinct from old.prepared_by
        and new.updated_at is not distinct from old.updated_at
        and new.returned_to_assigned_at is not distinct from old.returned_to_assigned_at
        and new.returned_to_assigned_by is not distinct from old.returned_to_assigned_by
        and new.returned_to_assigned_reason is not distinct from old.returned_to_assigned_reason
        and new.returned_to_assigned_movement_count is not distinct from old.returned_to_assigned_movement_count
        and new.returned_to_assigned_quantity is not distinct from old.returned_to_assigned_quantity
        and new.confirmation_payload_hash is not distinct from old.confirmation_payload_hash
        and new.confirmation_result is not distinct from old.confirmation_result
      then
        return old;
      end if;

      if old.status = 'draft'
        and old.confirmed_at is null
        and old.prepared_at is not null
        and old.prepared_by is not null
        and old.returned_to_assigned_at is null
        and old.confirmation_payload_hash is null
        and old.confirmation_result is null
        and new.status = 'confirmed'
        and new.confirmed_at is not null
        and new.selected_stop_ids is not distinct from old.selected_stop_ids
        and new.product_summary is not distinct from old.product_summary
        and new.prepared_at is not distinct from old.prepared_at
        and new.prepared_by is not distinct from old.prepared_by
        and new.returned_to_assigned_at is null
        and new.returned_to_assigned_by is null
        and new.returned_to_assigned_reason is null
        and coalesce(new.returned_to_assigned_movement_count, 0) = 0
        and coalesce(new.returned_to_assigned_quantity, 0) = 0
        and new.confirmation_payload_hash is null
        and new.confirmation_result is null
      then
        return new;
      end if;

      raise exception 'Pickup confirmation cannot rewrite finalized batch evidence.'
        using errcode = '23514';
    end if;

    if v_mode = 'pristine_return' then
      if old.status = 'confirmed'
        and old.returned_to_assigned_at is null
        and new.status = 'cancelled'
        and not new.storage_deducted
        and new.selected_stop_ids is not distinct from old.selected_stop_ids
        and new.product_summary is not distinct from old.product_summary
        and new.confirmed_at is not distinct from old.confirmed_at
        and new.prepared_at is not distinct from old.prepared_at
        and new.prepared_by is not distinct from old.prepared_by
        and new.confirmation_payload_hash is not distinct from old.confirmation_payload_hash
        and new.confirmation_result is not distinct from old.confirmation_result
        and new.returned_to_assigned_at is not null
        and new.returned_to_assigned_by is not null
        and pg_catalog.length(pg_catalog.btrim(coalesce(new.returned_to_assigned_reason, ''))) > 0
        and coalesce(new.returned_to_assigned_movement_count, -1) >= 0
        and coalesce(new.returned_to_assigned_quantity, -1) >= 0
      then
        return new;
      end if;

      raise exception 'Pristine pickup return cannot rewrite original batch evidence.'
        using errcode = '23514';
    end if;

    if v_mode = 'route_cancel' then
      if old.status in ('draft', 'confirmed')
        and old.returned_to_assigned_at is null
        and new.status = 'cancelled'
        and new.selected_stop_ids is not distinct from old.selected_stop_ids
        and new.product_summary is not distinct from old.product_summary
        and new.storage_deducted is not distinct from old.storage_deducted
        and new.confirmed_at is not distinct from old.confirmed_at
        and new.prepared_at is not distinct from old.prepared_at
        and new.prepared_by is not distinct from old.prepared_by
        and new.confirmation_payload_hash is not distinct from old.confirmation_payload_hash
        and new.confirmation_result is not distinct from old.confirmation_result
        and new.returned_to_assigned_at is not distinct from old.returned_to_assigned_at
        and new.returned_to_assigned_by is not distinct from old.returned_to_assigned_by
        and new.returned_to_assigned_reason is not distinct from old.returned_to_assigned_reason
        and new.returned_to_assigned_movement_count is not distinct from old.returned_to_assigned_movement_count
        and new.returned_to_assigned_quantity is not distinct from old.returned_to_assigned_quantity
      then
        return new;
      end if;

      raise exception 'Route cancellation cannot rewrite pickup batch evidence.'
        using errcode = '23514';
    end if;

    if old.status = 'draft'
      and new.status = 'draft'
      and old.confirmed_at is null
      and new.confirmed_at is null
      and not old.storage_deducted
      and not new.storage_deducted
      and old.returned_to_assigned_at is null
      and new.returned_to_assigned_at is null
      and old.returned_to_assigned_by is null
      and new.returned_to_assigned_by is null
      and old.returned_to_assigned_reason is null
      and new.returned_to_assigned_reason is null
      and coalesce(old.returned_to_assigned_movement_count, 0) = 0
      and coalesce(new.returned_to_assigned_movement_count, 0) = 0
      and coalesce(old.returned_to_assigned_quantity, 0) = 0
      and coalesce(new.returned_to_assigned_quantity, 0) = 0
      and old.confirmation_payload_hash is null
      and new.confirmation_payload_hash is null
      and old.confirmation_result is null
      and new.confirmation_result is null
    then
      return new;
    end if;

    raise exception 'Confirmed and returned pickup batches are immutable.'
      using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    if old.status = 'draft'
      and old.confirmed_at is null
      and not old.storage_deducted
      and old.returned_to_assigned_at is null
      and old.confirmation_payload_hash is null
      and old.confirmation_result is null
    then
      return old;
    end if;

    raise exception 'Confirmed and returned pickup batches cannot be deleted.'
      using errcode = '42501';
  end if;

  raise exception 'Unsupported pickup batch audit operation %.', tg_op
    using errcode = '0A000';
end;
$$;

revoke all on function public.snacky_guard_route_pickup_batch_audit()
  from public, anon, authenticated;

drop trigger if exists trg_snacky_90_route_pickup_batch_audit_insert
  on public.route_pickup_batches;
create trigger trg_snacky_90_route_pickup_batch_audit_insert
before insert on public.route_pickup_batches
for each row
execute function public.snacky_guard_route_pickup_batch_audit();

drop trigger if exists trg_snacky_90_route_pickup_batch_audit_update
  on public.route_pickup_batches;
create trigger trg_snacky_90_route_pickup_batch_audit_update
before update on public.route_pickup_batches
for each row
execute function public.snacky_guard_route_pickup_batch_audit();

drop trigger if exists trg_snacky_90_route_pickup_batch_audit_delete
  on public.route_pickup_batches;
create trigger trg_snacky_90_route_pickup_batch_audit_delete
before delete on public.route_pickup_batches
for each row
execute function public.snacky_guard_route_pickup_batch_audit();

-- This is also the deployment preflight source of truth. A route contributes
-- a row for every owner with a positive endpoint-signed balance on a
-- nonterminal route. Negative and terminal balances remain discrepancy history,
-- not a claim that the operator still carries physical stock. Null and multiple
-- active owners remain visible so migration can abort instead of choosing one.
create or replace function public._snacky_active_route_custody()
returns table (
  operator_id uuid,
  route_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  with bag_legs as (
    select
      movement.related_route_id as route_id,
      movement.to_entity_id as operator_id,
      movement.product_id,
      movement.quantity::bigint as quantity_delta
    from public.inventory_movements movement
    where movement.related_route_id is not null
      and movement.to_entity_type = 'operator_bag'::public.inventory_entity_type

    union all

    select
      movement.related_route_id as route_id,
      movement.from_entity_id as operator_id,
      movement.product_id,
      -movement.quantity::bigint as quantity_delta
    from public.inventory_movements movement
    where movement.related_route_id is not null
      and movement.from_entity_type = 'operator_bag'::public.inventory_entity_type
  ), balances as (
    select
      leg.route_id,
      leg.operator_id,
      leg.product_id,
      pg_catalog.sum(leg.quantity_delta)::bigint as signed_quantity
    from bag_legs leg
    group by leg.route_id, leg.operator_id, leg.product_id
  )
  select distinct balance.operator_id, balance.route_id
  from balances balance
  join public.routes route_row on route_row.id = balance.route_id
  where balance.signed_quantity > 0
    and route_row.status::text not in (
      'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled'
    )
  order by balance.operator_id nulls first, balance.route_id;
$$;

revoke all on function public._snacky_active_route_custody()
  from public, anon, authenticated;

create or replace function public._snacky_assert_operator_route_custody_touches(
  p_touches jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_touch record;
  v_route_operator_id uuid;
  v_route_status text;
  v_existing_route_id uuid;
  v_after_balance bigint;
  v_before_balance bigint;
  v_has_positive_after boolean;
begin
  if p_touches is null or pg_catalog.jsonb_typeof(p_touches) <> 'array' then
    raise exception 'Operator route custody touches must be a JSON array.' using errcode = '22023';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    where touch.operator_id is null
       or touch.route_id is null
       or touch.product_id is null
       or touch.delta_quantity is null
  ) then
    raise exception 'Every route bag touch requires an operator, route, product, and signed quantity.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    group by touch.operator_id
    having pg_catalog.count(distinct touch.route_id) > 1
  ) then
    raise exception 'One inventory statement cannot bind an operator bag to multiple routes.' using errcode = '23514';
  end if;

  -- Lock and validate every route row before taking an operator lock. Existing
  -- pickup writers already take this row lock without the route advisory lock,
  -- while terminal writers take both; using the row lock here avoids creating
  -- the opposite row->advisory order. Multiple route rows are visited by UUID.
  for v_touch in
    select touch.route_id, touch.operator_id
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    group by touch.route_id, touch.operator_id
    order by touch.route_id, touch.operator_id
  loop
    select route_row.operator_id, route_row.status::text
    into v_route_operator_id, v_route_status
    from public.routes route_row
    where route_row.id = v_touch.route_id
    for share;

    if not found then
      raise exception 'Route custody movement references a missing route.' using errcode = '23503';
    end if;

    if v_route_operator_id is null or v_route_operator_id is distinct from v_touch.operator_id then
      raise exception 'Route bag owner must match the route operator.' using errcode = '23514';
    end if;

    if v_route_status in (
      'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled'
    ) then
      raise exception 'Terminal route history cannot claim or spend live operator custody.' using errcode = '23514';
    end if;
  end loop;

  -- Canonical order continues with every distinct operator custody lock. The
  -- 0940 balance trigger runs second, reuses this lock, and adds sorted product
  -- bag locks; explicit route RPCs pre-acquire the same route->custody->bag set.
  for v_touch in
    select distinct touch.operator_id
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    order by touch.operator_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-custody:' || v_touch.operator_id::text,
        0
      )
    );
  end loop;

  -- The route-scoped balance check below must own the same owner/product lock
  -- as the global 0940 invariant. This trigger sorts first by name, so 0940
  -- simply reuses custody and bag locks after this route-specific proof.
  for v_touch in
    select touch.operator_id, touch.product_id
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    group by touch.operator_id, touch.product_id
    order by touch.operator_id, touch.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_touch.operator_id::text || ':' || v_touch.product_id::text,
        0
      )
    );
  end loop;

  -- The statement rows are already present in this transaction. Reconstruct
  -- the immediately-prior route slice by subtracting their endpoint-signed
  -- delta from the authoritative post-statement ledger balance. A healthy
  -- route slice cannot cross below zero; legacy-negative history may stay or
  -- improve, but this operation may never make it more negative.
  for v_touch in
    select
      touch.operator_id,
      touch.route_id,
      touch.product_id,
      pg_catalog.sum(touch.delta_quantity)::bigint as delta_quantity
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    group by touch.operator_id, touch.route_id, touch.product_id
    having pg_catalog.sum(touch.delta_quantity) <> 0
    order by touch.operator_id, touch.route_id, touch.product_id
  loop
    select coalesce(pg_catalog.sum(
      case
        when movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_touch.operator_id
          then movement.quantity::bigint
        else 0::bigint
      end
      + case
        when movement.from_entity_type::text = 'operator_bag'
          and movement.from_entity_id = v_touch.operator_id
          then -movement.quantity::bigint
        else 0::bigint
      end
    ), 0::bigint)
    into v_after_balance
    from public.inventory_movements movement
    where movement.related_route_id = v_touch.route_id
      and movement.product_id = v_touch.product_id;

    v_before_balance := v_after_balance - v_touch.delta_quantity;

    if v_after_balance < (case when v_before_balance < 0 then v_before_balance else 0::bigint end) then
      raise exception 'Route operator-bag movement would worsen recorded route stock below zero.'
        using
          errcode = '23514',
          detail = pg_catalog.format(
            'route_id=%s operator_id=%s product_id=%s before=%s delta=%s after=%s',
            v_touch.route_id,
            v_touch.operator_id,
            v_touch.product_id,
            v_before_balance,
            v_touch.delta_quantity,
            v_after_balance
          );
      end if;
  end loop;

  -- Claim from the authoritative post-statement ledger, never from the shape
  -- of one row in the statement. This avoids phantom leases for net-zero
  -- inserts and correctly handles UPDATE/DELETE operations that reveal a
  -- positive balance by removing a prior outgoing leg. A same-route lease is
  -- deliberately retained at zero until an audited release proof runs.
  for v_touch in
    select touch.operator_id, touch.route_id
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    group by touch.operator_id, touch.route_id
    order by touch.operator_id, touch.route_id
  loop
    v_existing_route_id := null;
    select lease.route_id
    into v_existing_route_id
    from public.operator_route_custody_leases lease
    where lease.operator_id = v_touch.operator_id
    for update;

    if found and v_existing_route_id is distinct from v_touch.route_id then
      raise exception 'This operator already carries inventory for another route. Reconcile that route before picking another.'
        using errcode = '23514';
    end if;

    select exists (
      select 1
      from public.inventory_movements movement
      where movement.related_route_id = v_touch.route_id
        and (
          (movement.to_entity_type::text = 'operator_bag'
            and movement.to_entity_id = v_touch.operator_id)
          or
          (movement.from_entity_type::text = 'operator_bag'
            and movement.from_entity_id = v_touch.operator_id)
        )
      group by movement.product_id
      having pg_catalog.sum(
        case
          when movement.to_entity_type::text = 'operator_bag'
            and movement.to_entity_id = v_touch.operator_id
            then movement.quantity::bigint
          else 0::bigint
        end
        + case
          when movement.from_entity_type::text = 'operator_bag'
            and movement.from_entity_id = v_touch.operator_id
            then -movement.quantity::bigint
          else 0::bigint
        end
      ) > 0
    )
    into v_has_positive_after;

    if v_existing_route_id is not null then
      update public.operator_route_custody_leases lease
      set last_movement_at = pg_catalog.now()
      where lease.operator_id = v_touch.operator_id
        and lease.route_id = v_touch.route_id;
    elsif v_has_positive_after then
      insert into public.operator_route_custody_leases (
        operator_id,
        route_id,
        claim_source,
        claimed_at,
        last_movement_at
      ) values (
        v_touch.operator_id,
        v_touch.route_id,
        'route_inventory_movement',
        pg_catalog.now(),
        pg_catalog.now()
      );
    end if;
  end loop;
end;
$$;

revoke all on function public._snacky_assert_operator_route_custody_touches(jsonb)
  from public, anon, authenticated;

create or replace function public._snacky_release_operator_route_custody(
  p_operator_id uuid,
  p_route_id uuid,
  p_proof text,
  p_pickup_batch_id uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lease_route_id uuid;
  v_route public.routes%rowtype;
  v_batch public.route_pickup_batches%rowtype;
  v_pickup_count integer;
  v_pickup_quantity bigint;
  v_reversal_count integer;
  v_reversal_quantity bigint;
  v_return_source_count integer;
begin
  if p_operator_id is null or p_route_id is null then
    raise exception 'Operator and route are required to release route custody.' using errcode = '22023';
  end if;

  if p_proof not in ('terminal_reconciliation', 'pristine_pickup_return') then
    raise exception 'Unsupported route custody release proof.' using errcode = '22023';
  end if;

  select route_row.*
  into v_route
  from public.routes route_row
  where route_row.id = p_route_id
  for share;

  if not found or v_route.operator_id is distinct from p_operator_id then
    raise exception 'Route custody release does not match the assigned operator.' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:operator-custody:' || p_operator_id::text, 0)
  );

  select lease.route_id
  into v_lease_route_id
  from public.operator_route_custody_leases lease
  where lease.operator_id = p_operator_id
  for update;

  if not found then
    return false;
  end if;

  if v_lease_route_id is distinct from p_route_id then
    raise exception 'The operator custody lease belongs to another route.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public._snacky_route_bag_balances(p_route_id) balance
    where balance.signed_quantity <> 0
  ) then
    raise exception 'Route custody cannot be released while its operator-bag balance is nonzero.' using errcode = '23514';
  end if;

  if p_proof = 'terminal_reconciliation' then
    if v_route.status::text not in (
      'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled'
    ) then
      raise exception 'A nonterminal route cannot release custody with terminal proof.' using errcode = '23514';
    end if;

    if not exists (
      select 1
      from public.route_inventory_reconciliations reconciliation
      where reconciliation.route_id = p_route_id
        and reconciliation.route_status_after = v_route.status
        and reconciliation.status in ('balanced', 'needs_review')
        and (
          (reconciliation.action = 'complete'
            and v_route.status::text in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed'))
          or
          (reconciliation.action = 'cancel'
            and v_route.status::text in ('cancelled', 'canceled'))
        )
    ) then
      raise exception 'Terminal route custody requires its matching inventory reconciliation.' using errcode = '23514';
    end if;
  else
    if p_pickup_batch_id is null then
      raise exception 'Pristine pickup release requires a pickup batch.' using errcode = '22023';
    end if;

    select batch_row.*
    into v_batch
    from public.route_pickup_batches batch_row
    where batch_row.id = p_pickup_batch_id
      and batch_row.route_id = p_route_id
    for share;

    if not found
      or v_batch.operator_id is distinct from p_operator_id
      or v_batch.status <> 'cancelled'
      or v_batch.returned_to_assigned_at is null
      or coalesce(v_batch.storage_deducted, false)
    then
      raise exception 'Pickup batch does not contain a completed pristine-return proof.' using errcode = '23514';
    end if;

    select
      pg_catalog.count(*)::integer,
      coalesce(pg_catalog.sum(pickup.quantity::bigint), 0::bigint)
    into v_pickup_count, v_pickup_quantity
    from public.inventory_movements pickup
    where pickup.related_route_id = p_route_id
      and pickup.related_pickup_batch_id = p_pickup_batch_id
      and pickup.reason::text = 'storage_to_operator_bag'
      and pickup.from_entity_type::text = 'storage'
      and pickup.to_entity_type::text = 'operator_bag'
      and pickup.to_entity_id = p_operator_id;

    select
      pg_catalog.count(*)::integer,
      coalesce(pg_catalog.sum(reversal.quantity::bigint), 0::bigint)
    into v_reversal_count, v_reversal_quantity
    from public.inventory_movements pickup
    join public.inventory_movements reversal
      on reversal.reversed_movement_id = pickup.id
     and reversal.product_id = pickup.product_id
     and reversal.quantity = pickup.quantity
     and reversal.from_entity_type::text = 'operator_bag'
     and reversal.from_entity_id = pickup.to_entity_id
     and reversal.to_entity_type::text = 'storage'
     and reversal.to_entity_id = pickup.from_entity_id
     and reversal.reason::text = 'operator_bag_to_storage'
     and reversal.related_route_id = p_route_id
     and reversal.related_pickup_batch_id = p_pickup_batch_id
     and reversal.source_type = 'route_pickup_return'
     and reversal.source_id = p_pickup_batch_id
    where pickup.related_route_id = p_route_id
      and pickup.related_pickup_batch_id = p_pickup_batch_id
      and pickup.reason::text = 'storage_to_operator_bag'
      and pickup.from_entity_type::text = 'storage'
      and pickup.to_entity_type::text = 'operator_bag'
      and pickup.to_entity_id = p_operator_id;

    select pg_catalog.count(*)::integer
    into v_return_source_count
    from public.inventory_movements movement
    where movement.source_type = 'route_pickup_return'
      and movement.source_id = p_pickup_batch_id;

    if v_pickup_count <> v_reversal_count
      or v_return_source_count <> v_reversal_count
      or v_pickup_quantity <> v_reversal_quantity
      or v_reversal_count <> coalesce(v_batch.returned_to_assigned_movement_count, 0)
      or v_reversal_quantity <> coalesce(v_batch.returned_to_assigned_quantity, 0)::bigint
    then
      raise exception 'Pristine pickup reversal evidence is incomplete or does not match the saved batch.' using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.inventory_movements movement
      where movement.related_route_id = p_route_id
        and not coalesce((
          (
            movement.related_pickup_batch_id = p_pickup_batch_id
            and movement.reason::text = 'storage_to_operator_bag'
            and movement.from_entity_type::text = 'storage'
            and movement.to_entity_type::text = 'operator_bag'
          )
          or
          (
            movement.related_pickup_batch_id = p_pickup_batch_id
            and movement.source_type = 'route_pickup_return'
            and movement.source_id = p_pickup_batch_id
            and movement.reversed_movement_id is not null
          )
        ), false)
    ) then
      raise exception 'Route contains inventory activity outside the pristine pickup and its exact return.' using errcode = '23514';
    end if;

    if exists (
      select 1 from public.route_stop_fill_lines fill_line where fill_line.route_id = p_route_id
    ) or exists (
      select 1 from public.cash_collections cash_row where cash_row.route_id = p_route_id
    ) or exists (
      select 1 from public.route_manual_sales sale where sale.route_id = p_route_id and sale.status <> 'cancelled'
    ) or exists (
      select 1 from public.route_customer_compensations compensation where compensation.route_id = p_route_id
    ) or exists (
      select 1 from public.inventory_adjustments adjustment where adjustment.route_id = p_route_id and adjustment.status <> 'cancelled'
    ) or exists (
      select 1 from public.machine_refill_history history_row where history_row.route_id = p_route_id
    ) or exists (
      select 1
      from public.route_stops stop_row
      where stop_row.route_id = p_route_id
        and stop_row.status::text not in ('pending', 'picked')
    ) then
      raise exception 'Field activity exists, so this pickup is not pristine.' using errcode = '23514';
    end if;
  end if;

  delete from public.operator_route_custody_leases lease
  where lease.operator_id = p_operator_id
    and lease.route_id = p_route_id;

  return found;
end;
$$;

revoke all on function public._snacky_release_operator_route_custody(uuid, uuid, text, uuid)
  from public, anon, authenticated;

create or replace function public.snacky_guard_operator_route_custody_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_touches jsonb;
begin
  if exists (
    select 1
    from new_rows inserted
    where inserted.related_route_id is not null
      and (
        (inserted.to_entity_type::text = 'operator_bag' and inserted.to_entity_id is null)
        or (inserted.from_entity_type::text = 'operator_bag' and inserted.from_entity_id is null)
      )
  ) then
    raise exception 'Route-related operator-bag movements require an operator endpoint id.' using errcode = '23514';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'operator_id', grouped.operator_id,
        'route_id', grouped.route_id,
        'product_id', grouped.product_id,
        'delta_quantity', grouped.delta_quantity
      ) order by grouped.operator_id, grouped.route_id, grouped.product_id
    ),
    '[]'::jsonb
  )
  into v_touches
  from (
    select
      touch.operator_id,
      touch.route_id,
      touch.product_id,
      pg_catalog.sum(touch.delta_quantity)::bigint as delta_quantity
    from (
      select
        inserted.to_entity_id as operator_id,
        inserted.related_route_id as route_id,
        inserted.product_id,
        inserted.quantity::bigint as delta_quantity
      from new_rows inserted
      where inserted.related_route_id is not null
        and inserted.to_entity_type::text = 'operator_bag'

      union all

      select
        inserted.from_entity_id as operator_id,
        inserted.related_route_id as route_id,
        inserted.product_id,
        -inserted.quantity::bigint as delta_quantity
      from new_rows inserted
      where inserted.related_route_id is not null
        and inserted.from_entity_type::text = 'operator_bag'
    ) touch
    group by touch.operator_id, touch.route_id, touch.product_id
  ) grouped;

  perform public._snacky_assert_operator_route_custody_touches(v_touches);
  return null;
end;
$$;

create or replace function public.snacky_guard_operator_route_custody_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_touches jsonb;
begin
  if exists (
    select 1
    from new_rows updated
    where updated.related_route_id is not null
      and (
        (updated.to_entity_type::text = 'operator_bag' and updated.to_entity_id is null)
        or (updated.from_entity_type::text = 'operator_bag' and updated.from_entity_id is null)
      )
  ) then
    raise exception 'Route-related operator-bag movements require an operator endpoint id.' using errcode = '23514';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'operator_id', grouped.operator_id,
        'route_id', grouped.route_id,
        'product_id', grouped.product_id,
        'delta_quantity', grouped.delta_quantity
      ) order by grouped.operator_id, grouped.route_id, grouped.product_id
    ),
    '[]'::jsonb
  )
  into v_touches
  from (
    select
      touch.operator_id,
      touch.route_id,
      touch.product_id,
      pg_catalog.sum(touch.delta_quantity)::bigint as delta_quantity
    from (
      select
        updated.to_entity_id as operator_id,
        updated.related_route_id as route_id,
        updated.product_id,
        updated.quantity::bigint as delta_quantity
      from new_rows updated
      where updated.related_route_id is not null
        and updated.to_entity_type::text = 'operator_bag'

      union all

      select
        updated.from_entity_id as operator_id,
        updated.related_route_id as route_id,
        updated.product_id,
        -updated.quantity::bigint as delta_quantity
      from new_rows updated
      where updated.related_route_id is not null
        and updated.from_entity_type::text = 'operator_bag'

      union all

      select
        previous.to_entity_id as operator_id,
        previous.related_route_id as route_id,
        previous.product_id,
        -previous.quantity::bigint as delta_quantity
      from old_rows previous
      where previous.related_route_id is not null
        and previous.to_entity_type::text = 'operator_bag'

      union all

      select
        previous.from_entity_id as operator_id,
        previous.related_route_id as route_id,
        previous.product_id,
        previous.quantity::bigint as delta_quantity
      from old_rows previous
      where previous.related_route_id is not null
        and previous.from_entity_type::text = 'operator_bag'
    ) touch
    group by touch.operator_id, touch.route_id, touch.product_id
  ) grouped;

  perform public._snacky_assert_operator_route_custody_touches(v_touches);
  return null;
end;
$$;

create or replace function public.snacky_guard_operator_route_custody_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_touches jsonb;
begin
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'operator_id', grouped.operator_id,
        'route_id', grouped.route_id,
        'product_id', grouped.product_id,
        'delta_quantity', grouped.delta_quantity
      ) order by grouped.operator_id, grouped.route_id, grouped.product_id
    ),
    '[]'::jsonb
  )
  into v_touches
  from (
    select
      touch.operator_id,
      touch.route_id,
      touch.product_id,
      pg_catalog.sum(touch.delta_quantity)::bigint as delta_quantity
    from (
      select
        removed.to_entity_id as operator_id,
        removed.related_route_id as route_id,
        removed.product_id,
        -removed.quantity::bigint as delta_quantity
      from old_rows removed
      where removed.related_route_id is not null
        and removed.to_entity_type::text = 'operator_bag'

      union all

      select
        removed.from_entity_id as operator_id,
        removed.related_route_id as route_id,
        removed.product_id,
        removed.quantity::bigint as delta_quantity
      from old_rows removed
      where removed.related_route_id is not null
        and removed.from_entity_type::text = 'operator_bag'
    ) touch
    group by touch.operator_id, touch.route_id, touch.product_id
  ) grouped;

  perform public._snacky_assert_operator_route_custody_touches(v_touches);
  return null;
end;
$$;

revoke all on function public.snacky_guard_operator_route_custody_insert()
  from public, anon, authenticated;
revoke all on function public.snacky_guard_operator_route_custody_update()
  from public, anon, authenticated;
revoke all on function public.snacky_guard_operator_route_custody_delete()
  from public, anon, authenticated;

drop trigger if exists trg_snacky_00_operator_route_custody_insert
  on public.inventory_movements;
drop trigger if exists trg_snacky_operator_route_custody_insert
  on public.inventory_movements;
create trigger trg_snacky_00_operator_route_custody_insert
after insert on public.inventory_movements
referencing new table as new_rows
for each statement
execute function public.snacky_guard_operator_route_custody_insert();

drop trigger if exists trg_snacky_00_operator_route_custody_update
  on public.inventory_movements;
drop trigger if exists trg_snacky_operator_route_custody_update
  on public.inventory_movements;
create trigger trg_snacky_00_operator_route_custody_update
after update on public.inventory_movements
referencing old table as old_rows new table as new_rows
for each statement
execute function public.snacky_guard_operator_route_custody_update();

drop trigger if exists trg_snacky_00_operator_route_custody_delete
  on public.inventory_movements;
drop trigger if exists trg_snacky_operator_route_custody_delete
  on public.inventory_movements;
create trigger trg_snacky_00_operator_route_custody_delete
after delete on public.inventory_movements
referencing old table as old_rows
for each statement
execute function public.snacky_guard_operator_route_custody_delete();

create or replace function public.snacky_release_terminal_route_custody()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.operator_id is not null
    and new.status::text in (
      'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled'
    )
  then
    perform public._snacky_release_operator_route_custody(
      new.operator_id,
      new.id,
      'terminal_reconciliation',
      null
    );
  end if;
  return new;
end;
$$;

revoke all on function public.snacky_release_terminal_route_custody()
  from public, anon, authenticated;

drop trigger if exists trg_snacky_release_terminal_route_custody on public.routes;
create trigger trg_snacky_release_terminal_route_custody
after update of status on public.routes
for each row
when (old.status is distinct from new.status)
execute function public.snacky_release_terminal_route_custody();

drop trigger if exists trg_snacky_release_pristine_pickup_custody
  on public.route_pickup_batches;
drop function if exists public.snacky_release_pristine_pickup_custody();

do $$
declare
  v_conflict record;
begin
  -- Positive-only custody is appropriate for seeding a physical lease, but it
  -- is too narrow for deployment validation. Any nonzero historical slice on
  -- a live route must already belong to that route's operator, including
  -- legacy-negative slices that do not represent stock currently carried.
  select
    route_row.id as route_id,
    route_row.operator_id as assigned_operator_id,
    history.bag_owner_id,
    history.product_id,
    history.signed_quantity
  into v_conflict
  from public.routes route_row
  cross join lateral public._snacky_route_bag_history_balances(route_row.id) history
  where route_row.status::text not in (
      'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled'
    )
    and history.signed_quantity <> 0
    and (
      route_row.operator_id is null
      or history.bag_owner_id is null
      or history.bag_owner_id is distinct from route_row.operator_id
    )
  order by route_row.id, history.bag_owner_id nulls first, history.product_id
  limit 1;

  if found then
    raise exception 'Custody lease migration blocked: nonterminal route % has nonzero bag history for owner % instead of assigned operator %.',
      v_conflict.route_id,
      v_conflict.bag_owner_id,
      v_conflict.assigned_operator_id
      using
        errcode = '23514',
        detail = pg_catalog.format(
          'product_id=%s signed_quantity=%s',
          v_conflict.product_id,
          v_conflict.signed_quantity
        );
  end if;

  select active.route_id
  into v_conflict
  from public._snacky_active_route_custody() active
  group by active.route_id
  having pg_catalog.count(*) filter (where active.operator_id is null) > 0
    or pg_catalog.count(distinct active.operator_id) <> 1
  order by active.route_id
  limit 1;

  if found then
    raise exception 'Custody lease migration blocked: route % has zero or multiple active bag owners.', v_conflict.route_id
      using errcode = '23514';
  end if;

  select active.operator_id, active.route_id
  into v_conflict
  from public._snacky_active_route_custody() active
  join public.routes route_row on route_row.id = active.route_id
  where active.operator_id is distinct from route_row.operator_id
  order by active.operator_id, active.route_id
  limit 1;

  if found then
    raise exception 'Custody lease migration blocked: route % bag owner does not match routes.operator_id.', v_conflict.route_id
      using errcode = '23514';
  end if;

  select active.operator_id
  into v_conflict
  from public._snacky_active_route_custody() active
  group by active.operator_id
  having pg_catalog.count(distinct active.route_id) > 1
  order by active.operator_id
  limit 1;

  if found then
    raise exception 'Custody lease migration blocked: operator % has active stock on multiple routes.', v_conflict.operator_id
      using errcode = '23514';
  end if;

  insert into public.operator_route_custody_leases (
    operator_id,
    route_id,
    claim_source,
    claimed_at,
    last_movement_at
  )
  select
    active.operator_id,
    active.route_id,
    'migration_active_balance',
    pg_catalog.now(),
    pg_catalog.now()
  from public._snacky_active_route_custody() active
  where not exists (
    select 1
    from public.operator_route_custody_leases existing_lease
    where existing_lease.operator_id = active.operator_id
      and existing_lease.route_id = active.route_id
  )
  order by active.operator_id, active.route_id;
end;
$$;

select pg_catalog.pg_notify('pgrst', 'reload schema');
