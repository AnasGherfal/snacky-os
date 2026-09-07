-- Replace the legacy row-trigger idempotency mutex with a database-enforced
-- uniqueness contract. PostgreSQL UNIQUE constraints allow multiple NULLs,
-- while every non-null client key is protected from duplicate ledger writes.
--
-- This also removes the idempotency-lock -> custody/bag-lock inversion caused
-- by the old BEFORE ROW trigger. Inventory writers now rely on ON CONFLICT or
-- handle SQLSTATE 23505 explicitly after one canonical uniqueness check.

do $preflight$
declare
  v_duplicate_key text;
  v_duplicate_count bigint;
begin
  select duplicate_group.idempotency_key, duplicate_group.row_count
  into v_duplicate_key, v_duplicate_count
  from (
    select movement.idempotency_key, pg_catalog.count(*)::bigint as row_count
    from public.inventory_movements movement
    where movement.idempotency_key is not null
    group by movement.idempotency_key
    having pg_catalog.count(*) > 1
    order by movement.idempotency_key
    limit 1
  ) duplicate_group;

  if found then
    raise exception 'Cannot install inventory movement idempotency uniqueness: key % has % rows.',
      v_duplicate_key,
      v_duplicate_count
      using errcode = '23505';
  end if;
end;
$preflight$;

-- A non-partial index is required so `ON CONFLICT (idempotency_key)` can infer
-- the arbiter without a matching WHERE predicate. NULL keys remain unlimited.
create unique index if not exists inventory_movements_idempotency_key_key
  on public.inventory_movements(idempotency_key);

do $constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.inventory_movements'::pg_catalog.regclass
      and constraint_row.conname = 'inventory_movements_idempotency_key_key'
      and constraint_row.contype = 'u'
  ) then
    alter table public.inventory_movements
      add constraint inventory_movements_idempotency_key_key
      unique using index inventory_movements_idempotency_key_key;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_attribute attribute_row
      on attribute_row.attrelid = constraint_row.conrelid
     and attribute_row.attnum = constraint_row.conkey[1]
    where constraint_row.conrelid = 'public.inventory_movements'::pg_catalog.regclass
      and constraint_row.conname = 'inventory_movements_idempotency_key_key'
      and constraint_row.contype = 'u'
      and pg_catalog.array_length(constraint_row.conkey, 1) = 1
      and attribute_row.attname = 'idempotency_key'
  ) then
    raise exception 'Inventory movement idempotency uniqueness was not installed on the expected column.'
      using errcode = '23514';
  end if;
end;
$constraint$;

-- One ledger movement can be reversed only once. Older deployments may have
-- skipped the migration that introduced this guard, so prove the live history
-- is compatible before installing (or accepting) the partial unique index.
do $reversal_preflight$
declare
  v_reversed_movement_id uuid;
  v_reversal_count bigint;
begin
  select reversal_group.reversed_movement_id, reversal_group.row_count
  into v_reversed_movement_id, v_reversal_count
  from (
    select movement.reversed_movement_id, pg_catalog.count(*)::bigint as row_count
    from public.inventory_movements movement
    where movement.reversed_movement_id is not null
    group by movement.reversed_movement_id
    having pg_catalog.count(*) > 1
    order by movement.reversed_movement_id
    limit 1
  ) reversal_group;

  if found then
    raise exception 'Cannot install inventory reversal uniqueness: movement % already has % reversals.',
      v_reversed_movement_id,
      v_reversal_count
      using errcode = '23505';
  end if;
end;
$reversal_preflight$;

create unique index if not exists idx_inventory_movements_reversed_movement_id_unique
  on public.inventory_movements(reversed_movement_id)
  where reversed_movement_id is not null;

do $reversal_constraint$
begin
  if not exists (
    select 1
    from pg_catalog.pg_index index_row
    join pg_catalog.pg_class index_class
      on index_class.oid = index_row.indexrelid
    join pg_catalog.pg_namespace index_namespace
      on index_namespace.oid = index_class.relnamespace
    join pg_catalog.pg_attribute attribute_row
      on attribute_row.attrelid = index_row.indrelid
     and attribute_row.attnum = index_row.indkey[0]
    where index_row.indrelid = 'public.inventory_movements'::pg_catalog.regclass
      and index_namespace.nspname = 'public'
      and index_class.relname = 'idx_inventory_movements_reversed_movement_id_unique'
      and index_row.indisunique
      and index_row.indisvalid
      and index_row.indisready
      and index_row.indnkeyatts = 1
      and index_row.indexprs is null
      and index_row.indpred is not null
      and attribute_row.attname = 'reversed_movement_id'
      and pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
        in ('(reversed_movement_id IS NOT NULL)', 'reversed_movement_id IS NOT NULL')
  ) then
    raise exception 'Inventory reversal uniqueness was not installed with the expected non-null predicate.'
      using errcode = '23514';
  end if;
end;
$reversal_constraint$;

-- RPC-backed commands record the exact immutable request next to their ledger
-- result. This lets a lost-response retry distinguish an exact replay from a
-- reused client operation id even after the first call changed stock.
alter table public.inventory_movements
  add column if not exists idempotency_payload jsonb;

do $payload_column$
begin
  if not exists (
    select 1
    from pg_catalog.pg_attribute attribute_row
    where attribute_row.attrelid = 'public.inventory_movements'::pg_catalog.regclass
      and attribute_row.attname = 'idempotency_payload'
      and attribute_row.atttypid = 'pg_catalog.jsonb'::pg_catalog.regtype
      and attribute_row.attnum > 0
      and not attribute_row.attisdropped
  ) then
    raise exception 'Inventory movement idempotency payload storage is not jsonb.'
      using errcode = '42804';
  end if;
end;
$payload_column$;

-- Keep only the constraint-owned full index after the stronger contract is
-- proven. The old partial index cannot arbitrate a plain ON CONFLICT target.
drop index if exists public.idx_inventory_movements_idempotency_key;

-- The unique constraint is now the sole duplicate arbiter. Removing this
-- trigger eliminates per-row advisory locks and lets bulk inserts follow the
-- canonical route -> custody owner -> owner/product lock order.
drop trigger if exists snacky_pickup_v2_inventory_movement_guard
  on public.inventory_movements;
drop function if exists public.snacky_pickup_v2_inventory_movement_guard();

-- Simple storage adjustments previously calculated stock in one request and
-- inserted the movement in another. Two concurrent counts could both use the
-- same stale balance, and retries had no stable operation key. Serialize on
-- the same product/storage advisory lock used by route pickup, calculate the
-- delta, and insert the immutable ledger result in one transaction.
create or replace function public.snacky_create_storage_adjustment_v1(
  p_client_submission_id text,
  p_product_id uuid,
  p_storage_location_id uuid,
  p_adjustment_type text,
  p_quantity integer,
  p_reason_key text,
  p_note text default null,
  p_created_at timestamptz default null
)
returns table (
  movement_id uuid,
  already_applied boolean,
  quantity_before integer,
  quantity_after integer,
  quantity_delta integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_team_member_id uuid;
  v_submission_uuid uuid;
  v_idempotency_key text;
  v_adjustment_type text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_adjustment_type, '')), ''));
  v_reason_key text := pg_catalog.lower(nullif(pg_catalog.btrim(coalesce(p_reason_key, '')), ''));
  v_note text := nullif(pg_catalog.btrim(coalesce(p_note, '')), '');
  v_request_payload jsonb;
  v_result_payload jsonb;
  v_existing public.inventory_movements%rowtype;
  v_replay_attempt integer;
  v_storage_lock record;
  v_movement_id uuid;
  v_already_applied boolean := false;
  v_quantity_before bigint;
  v_quantity_after bigint;
  v_quantity_delta bigint;
  v_storage_total_before bigint;
  v_storage_total_after bigint;
  v_reserved_quantity bigint := 0;
  v_movement_quantity bigint;
  v_movement_reason public.movement_reason;
  v_from_entity_type public.inventory_entity_type;
  v_from_entity_id uuid;
  v_to_entity_type public.inventory_entity_type;
  v_to_entity_id uuid;
  v_effective_created_at timestamptz := coalesce(p_created_at, pg_catalog.now());
  v_notes text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to adjust storage.' using errcode = '42501';
  end if;

  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only an owner or admin can adjust physical storage counts.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;

  begin
    v_submission_uuid := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'A valid storage adjustment submission id is required.' using errcode = '22023';
  end;

  if v_submission_uuid is null then
    raise exception 'A valid storage adjustment submission id is required.' using errcode = '22023';
  end if;

  if p_product_id is null or p_storage_location_id is null then
    raise exception 'Product and storage location are required.' using errcode = '22023';
  end if;

  if v_adjustment_type is null
    or v_adjustment_type not in ('set_exact', 'add', 'remove')
  then
    raise exception 'Storage adjustment type must be set_exact, add, or remove.' using errcode = '22023';
  end if;

  if p_quantity is null
    or p_quantity < 0
    or (v_adjustment_type <> 'set_exact' and p_quantity = 0)
  then
    raise exception 'Storage adjustment quantity is invalid.' using errcode = '23514';
  end if;

  if v_reason_key is null
    or v_reason_key not in (
      'stock_count_correction',
      'damaged_expired_item',
      'missing_item',
      'found_item',
      'manual_correction',
      'other'
    )
  then
    raise exception 'Storage adjustment reason is invalid.' using errcode = '22023';
  end if;

  if pg_catalog.length(coalesce(p_note, '')) > 2000 then
    raise exception 'Storage adjustment notes cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  v_movement_reason := case v_reason_key
    when 'damaged_expired_item' then 'damaged'::public.movement_reason
    when 'missing_item' then 'theft_or_missing'::public.movement_reason
    else 'stock_count_adjustment'::public.movement_reason
  end;

  v_idempotency_key := 'storage-adjustment:v1:' || v_submission_uuid::text;
  v_request_payload := pg_catalog.jsonb_build_object(
    'version', 1,
    'product_id', p_product_id,
    'storage_location_id', p_storage_location_id,
    'adjustment_type', v_adjustment_type,
    'quantity', p_quantity,
    'reason_key', v_reason_key,
    'note', v_note,
    'created_at', p_created_at
  );

  -- Serialize one logical command before looking for its immutable receipt.
  -- Exact retries must not depend on the product or selected storage still
  -- being active after the first successful call.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:storage-adjustment:v1:' || v_submission_uuid::text,
      0
    )
  );

  -- First check before mutable catalog/stock readiness. If this is a new
  -- operation, freeze the eligible storage catalog and take every active
  -- storage/product balance lock in the same storage-id/product-id order as
  -- route pickup and purchase receipt writers. The second pass accepts an
  -- exact receipt produced by a transaction that began on the previous
  -- function version while this call waited for the balance locks.
  for v_replay_attempt in 1..2 loop
    select movement.*
    into v_existing
    from public.inventory_movements movement
    where movement.idempotency_key = v_idempotency_key;

    if found then
      if v_existing.product_id is distinct from p_product_id
        or v_existing.created_by is distinct from v_actor_team_member_id
        or v_existing.source_type is distinct from 'storage_adjustment'
        or v_existing.source_id is distinct from v_submission_uuid
        or v_existing.movement_type is distinct from 'storage_adjustment'
        or v_existing.idempotency_payload -> 'request' is distinct from v_request_payload
        or (p_created_at is not null and v_existing.created_at is distinct from p_created_at)
      then
        raise exception 'This storage adjustment submission id was already used with a different immutable payload.' using errcode = '23505';
      end if;

      begin
        v_quantity_before := (v_existing.idempotency_payload #>> '{result,quantity_before}')::bigint;
        v_quantity_after := (v_existing.idempotency_payload #>> '{result,quantity_after}')::bigint;
        v_quantity_delta := (v_existing.idempotency_payload #>> '{result,quantity_delta}')::bigint;
      exception
        when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'The saved storage adjustment result is malformed.' using errcode = '23514';
      end;

      if v_quantity_before is null
        or v_quantity_after is null
        or v_quantity_delta is null
        or v_quantity_after - v_quantity_before is distinct from v_quantity_delta
        or v_quantity_delta = 0
        or pg_catalog.abs(v_quantity_delta) is distinct from v_existing.quantity::bigint
        or v_existing.reason is distinct from v_movement_reason
        or (
          v_quantity_delta > 0
          and (
            v_existing.from_entity_type::text <> 'adjustment'
            or v_existing.from_entity_id is not null
            or v_existing.to_entity_type::text <> 'storage'
            or v_existing.to_entity_id is distinct from p_storage_location_id
          )
        )
        or (
          v_quantity_delta < 0
          and (
            v_existing.from_entity_type::text <> 'storage'
            or v_existing.from_entity_id is distinct from p_storage_location_id
            or v_existing.to_entity_type::text is distinct from case
              when v_reason_key = 'damaged_expired_item' then 'waste'
              else 'adjustment'
            end
            or v_existing.to_entity_id is not null
          )
        )
      then
        raise exception 'The saved storage adjustment does not match its immutable result.' using errcode = '23514';
      end if;

      return query
      select
        v_existing.id,
        true,
        v_quantity_before::integer,
        v_quantity_after::integer,
        v_quantity_delta::integer;
      return;
    end if;

    if v_replay_attempt = 1 then
      for v_storage_lock in
        select storage_row.id
        from public.storage_locations storage_row
        where coalesce(storage_row.active, true) = true
          and storage_row.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
        order by storage_row.id, p_product_id
        for share
      loop
        perform pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtext(p_product_id::text),
          pg_catalog.hashtext(v_storage_lock.id::text)
        );
      end loop;
    end if;
  end loop;

  perform product_row.id
    from public.products product_row
    where product_row.id = p_product_id
      and product_row.active = true
    for share;
  if not found then
    raise exception 'An active product is required.' using errcode = '23503';
  end if;

  perform storage_row.id
    from public.storage_locations storage_row
    where storage_row.id = p_storage_location_id
      and coalesce(storage_row.active, true) = true
      and storage_row.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
    for share;
  if not found then
    raise exception 'The selected storage location is missing or inactive.' using errcode = '23503';
  end if;

  select coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0::bigint)
  into v_quantity_before
  from public.current_inventory_by_location inventory
  where inventory.location_type = 'storage'
    and inventory.location_id = p_storage_location_id
    and inventory.product_id = p_product_id;

  if v_adjustment_type = 'set_exact' then
    v_quantity_after := p_quantity::bigint;
    v_quantity_delta := v_quantity_after - v_quantity_before;
  elsif v_adjustment_type = 'add' then
    v_quantity_delta := p_quantity::bigint;
    v_quantity_after := v_quantity_before + v_quantity_delta;
  else
    v_quantity_delta := -p_quantity::bigint;
    v_quantity_after := v_quantity_before + v_quantity_delta;
  end if;

  if v_quantity_delta = 0 then
    raise exception 'Storage already matches this quantity. No movement was created.' using errcode = '23514';
  end if;

  if v_quantity_after < 0 then
    raise exception 'Storage adjustment would make stock negative. Current %, requested removal %.',
      v_quantity_before,
      pg_catalog.abs(v_quantity_delta)
      using errcode = '23514';
  end if;

  -- A physical count correction may not spend units already promised to an
  -- active route. Reservations are product-wide because a route is allocated
  -- across eligible physical storages only at pickup time.
  select coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0::bigint)
  into v_storage_total_before
  from public.current_inventory_by_location inventory
  join public.storage_locations storage_row
    on storage_row.id = inventory.location_id
   and coalesce(storage_row.active, true) = true
   and storage_row.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
  where inventory.location_type = 'storage'
    and inventory.product_id = p_product_id;

  v_storage_total_after := v_storage_total_before - v_quantity_before + v_quantity_after;

  select coalesce(pg_catalog.sum(
    greatest(
      coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0),
      0
    )::bigint
  ), 0::bigint)
  into v_reserved_quantity
  from public.route_stock_lines stock_line
  join public.routes route_row on route_row.id = stock_line.route_id
  where stock_line.product_id = p_product_id
    and route_row.status::text in (
      'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready',
      'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'
    );

  if v_storage_total_after < v_reserved_quantity then
    raise exception 'Storage adjustment would leave % units while active routes reserve %. Reduce or cancel route reservations, or reconcile route inventory first.',
      greatest(v_storage_total_after, 0::bigint),
      v_reserved_quantity
      using errcode = '23514';
  end if;

  if v_quantity_after > 2147483647::bigint
    or pg_catalog.abs(v_quantity_delta) > 2147483647::bigint
  then
    raise exception 'Storage adjustment exceeds the supported inventory quantity range.' using errcode = '22003';
  end if;

  v_movement_quantity := pg_catalog.abs(v_quantity_delta);
  if v_quantity_delta > 0 then
    v_from_entity_type := 'adjustment'::public.inventory_entity_type;
    v_from_entity_id := null;
    v_to_entity_type := 'storage'::public.inventory_entity_type;
    v_to_entity_id := p_storage_location_id;
  else
    v_from_entity_type := 'storage'::public.inventory_entity_type;
    v_from_entity_id := p_storage_location_id;
    v_to_entity_type := case
      when v_reason_key = 'damaged_expired_item' then 'waste'::public.inventory_entity_type
      else 'adjustment'::public.inventory_entity_type
    end;
    v_to_entity_id := null;
  end if;

  v_notes := pg_catalog.concat_ws(
    ' - ',
    case v_reason_key
      when 'stock_count_correction' then 'Stock count correction'
      when 'damaged_expired_item' then 'Damaged/expired item'
      when 'missing_item' then 'Missing item'
      when 'found_item' then 'Found item'
      when 'manual_correction' then 'Manual correction'
      else 'Other'
    end,
    case v_adjustment_type
      when 'set_exact' then 'Set exact count from ' || v_quantity_before::text
        || ' to ' || v_quantity_after::text
        || ' (' || case when v_quantity_delta > 0 then '+' else '' end
        || v_quantity_delta::text || ')'
      when 'add' then 'Added ' || v_movement_quantity::text
      else 'Removed ' || v_movement_quantity::text
    end,
    v_note
  );

  v_result_payload := pg_catalog.jsonb_build_object(
    'quantity_before', v_quantity_before,
    'quantity_after', v_quantity_after,
    'quantity_delta', v_quantity_delta
  );

  insert into public.inventory_movements (
    product_id,
    quantity,
    from_entity_type,
    from_entity_id,
    to_entity_type,
    to_entity_id,
    reason,
    source_type,
    source_id,
    idempotency_key,
    idempotency_payload,
    movement_type,
    correction_reason,
    created_by,
    notes,
    created_at
  ) values (
    p_product_id,
    v_movement_quantity::integer,
    v_from_entity_type,
    v_from_entity_id,
    v_to_entity_type,
    v_to_entity_id,
    v_movement_reason,
    'storage_adjustment',
    v_submission_uuid,
    v_idempotency_key,
    pg_catalog.jsonb_build_object('request', v_request_payload, 'result', v_result_payload),
    'storage_adjustment',
    v_reason_key,
    v_actor_team_member_id,
    v_notes,
    v_effective_created_at
  )
  on conflict (idempotency_key) do nothing
  returning id into v_movement_id;

  if v_movement_id is null then
    -- A concurrent call can share a submission id while locking a different
    -- product/storage pair. Uniqueness chooses the canonical result; accept it
    -- only when its complete immutable request is identical.
    select movement.*
    into v_existing
    from public.inventory_movements movement
    where movement.idempotency_key = v_idempotency_key;

    if not found
      or v_existing.product_id is distinct from p_product_id
      or v_existing.created_by is distinct from v_actor_team_member_id
      or v_existing.source_type is distinct from 'storage_adjustment'
      or v_existing.source_id is distinct from v_submission_uuid
      or v_existing.movement_type is distinct from 'storage_adjustment'
      or v_existing.idempotency_payload -> 'request' is distinct from v_request_payload
      or (p_created_at is not null and v_existing.created_at is distinct from p_created_at)
    then
      raise exception 'Storage adjustment idempotency conflict.' using errcode = '23505';
    end if;

    begin
      v_quantity_before := (v_existing.idempotency_payload #>> '{result,quantity_before}')::bigint;
      v_quantity_after := (v_existing.idempotency_payload #>> '{result,quantity_after}')::bigint;
      v_quantity_delta := (v_existing.idempotency_payload #>> '{result,quantity_delta}')::bigint;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'The canonical storage adjustment result is malformed.' using errcode = '23514';
    end;

    if v_quantity_before is null
      or v_quantity_after is null
      or v_quantity_delta is null
      or v_quantity_after - v_quantity_before is distinct from v_quantity_delta
      or v_quantity_delta = 0
      or pg_catalog.abs(v_quantity_delta) is distinct from v_existing.quantity::bigint
      or v_existing.reason is distinct from v_movement_reason
      or (
        v_quantity_delta > 0
        and (
          v_existing.from_entity_type::text <> 'adjustment'
          or v_existing.from_entity_id is not null
          or v_existing.to_entity_type::text <> 'storage'
          or v_existing.to_entity_id is distinct from p_storage_location_id
        )
      )
      or (
        v_quantity_delta < 0
        and (
          v_existing.from_entity_type::text <> 'storage'
          or v_existing.from_entity_id is distinct from p_storage_location_id
          or v_existing.to_entity_type::text is distinct from case
            when v_reason_key = 'damaged_expired_item' then 'waste'
            else 'adjustment'
          end
          or v_existing.to_entity_id is not null
        )
      )
    then
      raise exception 'The canonical storage adjustment result is malformed.' using errcode = '23514';
    end if;

    v_movement_id := v_existing.id;
    v_already_applied := true;
  end if;

  return query
  select
    v_movement_id,
    v_already_applied,
    v_quantity_before::integer,
    v_quantity_after::integer,
    v_quantity_delta::integer;
end;
$$;

revoke all on function public.snacky_create_storage_adjustment_v1(
  text,
  uuid,
  uuid,
  text,
  integer,
  text,
  text,
  timestamptz
) from public, anon;
grant execute on function public.snacky_create_storage_adjustment_v1(
  text,
  uuid,
  uuid,
  text,
  integer,
  text,
  text,
  timestamptz
) to authenticated;

-- The advanced stock-movement form previously inserted the ledger row and
-- incremented route_stock_lines in separate requests. A lost response or
-- duplicate submission could therefore leave the projection different from
-- the immutable ledger. Bind one client operation to one canonical movement,
-- then recompute the projection in this same transaction.
create or replace function public.snacky_create_stock_movement_v1(
  p_client_submission_id text,
  p_product_id uuid,
  p_quantity integer,
  p_from_entity_type public.inventory_entity_type,
  p_from_entity_id uuid,
  p_to_entity_type public.inventory_entity_type,
  p_to_entity_id uuid,
  p_reason public.movement_reason,
  p_related_route_id uuid default null,
  p_notes text default null,
  p_admin_override boolean default false
)
returns table (
  movement_id uuid,
  already_applied boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_team_member_id uuid;
  v_submission_uuid uuid;
  v_idempotency_key text;
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_existing public.inventory_movements%rowtype;
  v_movement_id uuid;
  v_already_applied boolean := false;
  v_route public.routes%rowtype;
  v_is_owner_admin boolean := false;
  v_on_hand bigint := 0;
  v_reserved_elsewhere bigint := 0;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a stock movement.' using errcode = '42501';
  end if;

  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse']) then
    raise exception 'You do not have permission to create stock movements.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;

  v_is_owner_admin := public.snacky_current_profile_has_any_role(array['owner', 'admin']);
  if coalesce(p_admin_override, false) and not v_is_owner_admin then
    raise exception 'Only an owner or admin can override available storage.' using errcode = '42501';
  end if;

  begin
    v_submission_uuid := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '')::uuid;
  exception
    when invalid_text_representation then
      raise exception 'A valid stock movement submission id is required.' using errcode = '22023';
  end;

  if v_submission_uuid is null then
    raise exception 'A valid stock movement submission id is required.' using errcode = '22023';
  end if;

  v_idempotency_key := 'inventory-movement:v1:' || v_submission_uuid::text;

  -- Dynamic catalog/route/storage readiness applies only to a new movement.
  -- An exact lost-response retry must remain replayable after its successful
  -- call changed stock or an endpoint was later deactivated.
  select movement.*
  into v_existing
  from public.inventory_movements movement
  where movement.idempotency_key = v_idempotency_key;

  if found then
    if v_existing.product_id is distinct from p_product_id
      or v_existing.quantity is distinct from p_quantity
      or v_existing.from_entity_type is distinct from p_from_entity_type
      or v_existing.from_entity_id is distinct from p_from_entity_id
      or v_existing.to_entity_type is distinct from p_to_entity_type
      or v_existing.to_entity_id is distinct from p_to_entity_id
      or v_existing.reason is distinct from p_reason
      or v_existing.related_route_id is distinct from p_related_route_id
      or v_existing.created_by is distinct from v_actor_team_member_id
      or v_existing.source_type is distinct from 'manual_stock_movement'
      or v_existing.source_id is distinct from v_submission_uuid
      or nullif(pg_catalog.btrim(coalesce(v_existing.notes, '')), '') is distinct from v_notes
    then
      raise exception 'This stock movement submission id was already used with a different immutable payload.' using errcode = '23505';
    end if;

    if p_related_route_id is not null then
      perform public._snacky_sync_route_stock_lines(p_related_route_id);
    end if;

    return query select v_existing.id, true;
    return;
  end if;

  if p_product_id is null or not exists (
    select 1
    from public.products product_row
    where product_row.id = p_product_id
      and product_row.active = true
  ) then
    raise exception 'An active product is required.' using errcode = '23503';
  end if;

  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'Stock movement quantity must be greater than zero.' using errcode = '23514';
  end if;

  if pg_catalog.length(coalesce(p_notes, '')) > 2000 then
    raise exception 'Stock movement notes cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  if p_from_entity_type::text not in ('storage', 'operator_bag', 'machine', 'machine_storage', 'waste', 'adjustment')
    or p_to_entity_type::text not in ('storage', 'operator_bag', 'machine', 'machine_storage', 'waste', 'adjustment')
  then
    raise exception 'Unsupported stock movement endpoint.' using errcode = '23514';
  end if;

  if p_from_entity_type::text in ('storage', 'operator_bag', 'machine', 'machine_storage')
      and p_from_entity_id is null
    or p_to_entity_type::text in ('storage', 'operator_bag', 'machine', 'machine_storage')
      and p_to_entity_id is null
  then
    raise exception 'The selected stock movement endpoints require location ids.' using errcode = '23514';
  end if;

  if p_from_entity_type::text in ('waste', 'adjustment') and p_from_entity_id is not null
    or p_to_entity_type::text in ('waste', 'adjustment') and p_to_entity_id is not null
  then
    raise exception 'Waste and adjustment endpoints cannot have location ids.' using errcode = '23514';
  end if;

  if p_from_entity_type = p_to_entity_type
    and p_from_entity_id is not distinct from p_to_entity_id
  then
    raise exception 'A stock movement must change custody.' using errcode = '23514';
  end if;

  if p_reason::text not in (
    'storage_to_operator_bag',
    'operator_bag_to_machine',
    'operator_bag_to_storage',
    'machine_to_storage',
    'stock_count_adjustment',
    'manual_correction',
    'damaged',
    'expired',
    'product_substitution'
  ) then
    raise exception 'Unsupported reason for the stock movement form.' using errcode = '23514';
  end if;

  if p_reason::text = 'storage_to_operator_bag'
    and not (p_from_entity_type::text = 'storage' and p_to_entity_type::text = 'operator_bag')
  then
    raise exception 'Storage pickup must move from storage to an operator bag.' using errcode = '23514';
  elsif p_reason::text = 'operator_bag_to_machine'
    and not (p_from_entity_type::text = 'operator_bag' and p_to_entity_type::text = 'machine')
  then
    raise exception 'Machine fill must move from an operator bag to a machine.' using errcode = '23514';
  elsif p_reason::text = 'operator_bag_to_storage'
    and not (p_from_entity_type::text = 'operator_bag' and p_to_entity_type::text = 'storage')
  then
    raise exception 'A route return must move from an operator bag to storage.' using errcode = '23514';
  elsif p_reason::text = 'machine_to_storage'
    and not (p_from_entity_type::text = 'machine' and p_to_entity_type::text = 'storage')
  then
    raise exception 'A machine return must move from a machine to storage.' using errcode = '23514';
  elsif p_reason::text in ('damaged', 'expired') and p_to_entity_type::text <> 'waste' then
    raise exception 'Damaged or expired stock must move to waste.' using errcode = '23514';
  elsif p_reason::text in ('stock_count_adjustment', 'manual_correction')
    and p_from_entity_type::text <> 'adjustment'
    and p_to_entity_type::text <> 'adjustment'
  then
    raise exception 'A manual stock correction must involve the adjustment account.' using errcode = '23514';
  elsif p_reason::text = 'product_substitution' and p_related_route_id is null then
    raise exception 'A product substitution must be linked to a route.' using errcode = '23514';
  end if;

  if p_reason::text = 'manual_correction' and not v_is_owner_admin then
    raise exception 'Only an owner or admin can create a manual correction.' using errcode = '42501';
  end if;

  if p_from_entity_type::text = 'storage' then
    if not exists (
      select 1
      from public.storage_locations storage_row
      where storage_row.id = p_from_entity_id
        and storage_row.active = true
    ) then
      raise exception 'The selected source storage is missing or inactive.' using errcode = '23503';
    end if;
  end if;

  if p_to_entity_type::text = 'storage' then
    if not exists (
      select 1
      from public.storage_locations storage_row
      where storage_row.id = p_to_entity_id
        and storage_row.active = true
    ) then
      raise exception 'The selected destination storage is missing or inactive.' using errcode = '23503';
    end if;
  end if;

  if p_from_entity_type::text = 'operator_bag' then
    if not exists (
      select 1
      from public.team_members team_row
      where team_row.id = p_from_entity_id
        and team_row.active = true
    ) then
      raise exception 'The selected source operator bag is missing or inactive.' using errcode = '23503';
    end if;
  end if;

  if p_to_entity_type::text = 'operator_bag' then
    if not exists (
      select 1
      from public.team_members team_row
      where team_row.id = p_to_entity_id
        and team_row.active = true
    ) then
      raise exception 'The selected destination operator bag is missing or inactive.' using errcode = '23503';
    end if;
  end if;

  if p_from_entity_type::text in ('machine', 'machine_storage') and not exists (
    select 1 from public.machines machine_row where machine_row.id = p_from_entity_id
  ) then
    raise exception 'The selected source machine is missing.' using errcode = '23503';
  end if;

  if p_to_entity_type::text in ('machine', 'machine_storage') and not exists (
    select 1 from public.machines machine_row where machine_row.id = p_to_entity_id
  ) then
    raise exception 'The selected destination machine is missing.' using errcode = '23503';
  end if;

  if p_related_route_id is not null then
    select route_row.*
    into v_route
    from public.routes route_row
    where route_row.id = p_related_route_id
    for update;

    if not found then
      raise exception 'The selected route was not found.' using errcode = '23503';
    end if;

    if v_route.status::text in (
      'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed',
      'cancelled', 'canceled', 'archived', 'deleted'
    ) then
      raise exception 'A terminal route cannot receive a new stock movement.' using errcode = '23514';
    end if;

    if p_from_entity_type::text = 'operator_bag'
      and p_from_entity_id is distinct from v_route.operator_id
      or p_to_entity_type::text = 'operator_bag'
      and p_to_entity_id is distinct from v_route.operator_id
    then
      raise exception 'The operator bag must match the operator assigned to this route.' using errcode = '23514';
    end if;
  end if;

  if p_from_entity_type::text = 'storage' then
    -- Match the established pickup lock for every storage debit, including an
    -- owner/admin reservation override. An override may release a planning
    -- reservation, but it is never permission to spend units that are not
    -- physically recorded on hand.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_product_id::text),
      pg_catalog.hashtext(p_from_entity_id::text)
    );

    -- Recheck the idempotency row after waiting on storage. This makes a
    -- concurrent same-submission replay succeed even though stock is now lower.
    select movement.*
    into v_existing
    from public.inventory_movements movement
    where movement.idempotency_key = v_idempotency_key;

    if found then
      if v_existing.product_id is distinct from p_product_id
        or v_existing.quantity is distinct from p_quantity
        or v_existing.from_entity_type is distinct from p_from_entity_type
        or v_existing.from_entity_id is distinct from p_from_entity_id
        or v_existing.to_entity_type is distinct from p_to_entity_type
        or v_existing.to_entity_id is distinct from p_to_entity_id
        or v_existing.reason is distinct from p_reason
        or v_existing.related_route_id is distinct from p_related_route_id
        or v_existing.created_by is distinct from v_actor_team_member_id
        or v_existing.source_type is distinct from 'manual_stock_movement'
        or v_existing.source_id is distinct from v_submission_uuid
        or nullif(pg_catalog.btrim(coalesce(v_existing.notes, '')), '') is distinct from v_notes
      then
        raise exception 'This stock movement submission id was already used with a different immutable payload.' using errcode = '23505';
      end if;

      if p_related_route_id is not null then
        perform public._snacky_sync_route_stock_lines(p_related_route_id);
      end if;

      return query select v_existing.id, true;
      return;
    end if;

    select coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0::bigint)
    into v_on_hand
    from public.current_inventory_by_location inventory
    where inventory.location_type = 'storage'
      and inventory.location_id = p_from_entity_id
      and inventory.product_id = p_product_id;

    if v_on_hand < p_quantity::bigint then
      raise exception 'Not enough physical storage stock. Needed %, physically on hand %.',
        p_quantity,
        greatest(v_on_hand, 0::bigint)
        using errcode = '23514';
    end if;

    if not coalesce(p_admin_override, false) then
      select coalesce(pg_catalog.sum(
        greatest(
          coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0),
          0
        )::bigint
      ), 0::bigint)
      into v_reserved_elsewhere
      from public.route_stock_lines stock_line
      join public.routes route_row on route_row.id = stock_line.route_id
      where stock_line.product_id = p_product_id
        and stock_line.route_id is distinct from p_related_route_id
        and route_row.status::text in (
          'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready',
          'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'
        );

      if v_on_hand - v_reserved_elsewhere < p_quantity::bigint then
        raise exception 'Not enough available storage stock after route reservations. Needed %, available %.',
          p_quantity,
          greatest(v_on_hand - v_reserved_elsewhere, 0::bigint)
          using errcode = '23514';
      end if;
    end if;
  end if;

  insert into public.inventory_movements (
    product_id,
    quantity,
    from_entity_type,
    from_entity_id,
    to_entity_type,
    to_entity_id,
    reason,
    related_route_id,
    source_type,
    source_id,
    idempotency_key,
    created_by,
    notes
  ) values (
    p_product_id,
    p_quantity,
    p_from_entity_type,
    p_from_entity_id,
    p_to_entity_type,
    p_to_entity_id,
    p_reason,
    p_related_route_id,
    'manual_stock_movement',
    v_submission_uuid,
    v_idempotency_key,
    v_actor_team_member_id,
    v_notes
  )
  on conflict (idempotency_key) do nothing
  returning id into v_movement_id;

  if v_movement_id is null then
    select movement.*
    into v_existing
    from public.inventory_movements movement
    where movement.idempotency_key = v_idempotency_key;

    if not found
      or v_existing.product_id is distinct from p_product_id
      or v_existing.quantity is distinct from p_quantity
      or v_existing.from_entity_type is distinct from p_from_entity_type
      or v_existing.from_entity_id is distinct from p_from_entity_id
      or v_existing.to_entity_type is distinct from p_to_entity_type
      or v_existing.to_entity_id is distinct from p_to_entity_id
      or v_existing.reason is distinct from p_reason
      or v_existing.related_route_id is distinct from p_related_route_id
      or v_existing.created_by is distinct from v_actor_team_member_id
      or v_existing.source_type is distinct from 'manual_stock_movement'
      or v_existing.source_id is distinct from v_submission_uuid
      or nullif(pg_catalog.btrim(coalesce(v_existing.notes, '')), '') is distinct from v_notes
    then
      raise exception 'Inventory idempotency conflict for this stock movement submission.' using errcode = '23505';
    end if;

    v_movement_id := v_existing.id;
    v_already_applied := true;
  end if;

  if p_related_route_id is not null then
    perform public._snacky_sync_route_stock_lines(p_related_route_id);
  end if;

  return query select v_movement_id, v_already_applied;
end;
$$;

revoke all on function public.snacky_create_stock_movement_v1(
  text,
  uuid,
  integer,
  public.inventory_entity_type,
  uuid,
  public.inventory_entity_type,
  uuid,
  public.movement_reason,
  uuid,
  text,
  boolean
) from public, anon;
grant execute on function public.snacky_create_stock_movement_v1(
  text,
  uuid,
  integer,
  public.inventory_entity_type,
  uuid,
  public.inventory_entity_type,
  uuid,
  public.movement_reason,
  uuid,
  text,
  boolean
) to authenticated;

-- Cancellation used to update the sale and insert its stock reversal through
-- separate HTTP statements. Keep both effects atomic and make a retry prove
-- the exact canonical reversal instead of treating any duplicate key as good.
create or replace function public.snacky_cancel_route_manual_sale_v1(
  p_route_id uuid,
  p_route_stop_id uuid,
  p_sale_id uuid,
  p_cancellation_reason text
)
returns table (
  inventory_reversed boolean,
  already_cancelled boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_is_manager boolean := false;
  v_route public.routes%rowtype;
  v_stop public.route_stops%rowtype;
  v_sale public.route_manual_sales%rowtype;
  v_original public.inventory_movements%rowtype;
  v_reversal public.inventory_movements%rowtype;
  v_reversal_id uuid;
  v_reversal_key text;
  v_was_cancelled boolean := false;
  v_reason text := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_cancellation_reason, '')), ''),
    'Cancelled from route stop'
  );
begin
  if v_user_id is null then
    raise exception 'You must be signed in to cancel a manual sale.' using errcode = '42501';
  end if;

  if p_route_id is null or p_route_stop_id is null or p_sale_id is null then
    raise exception 'Route, stop, and manual sale are required.' using errcode = '22023';
  end if;

  if pg_catalog.length(v_reason) > 2000 then
    raise exception 'Manual sale cancellation reason cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  v_is_manager := public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);

  select route_row.*
  into v_route
  from public.routes route_row
  where route_row.id = p_route_id
  for update;

  if not found then
    raise exception 'Route was not found.' using errcode = '23503';
  end if;

  if not v_is_manager
    and (
      v_route.operator_id is distinct from v_actor_team_member_id
      or not public.snacky_operator_can_access_route(p_route_id)
    )
  then
    raise exception 'This route is not assigned to you.' using errcode = '42501';
  end if;

  select stop_row.*
  into v_stop
  from public.route_stops stop_row
  where stop_row.id = p_route_stop_id
    and stop_row.route_id = p_route_id;

  if not found then
    raise exception 'The selected stop does not belong to this route.' using errcode = '23503';
  end if;

  select sale_row.*
  into v_sale
  from public.route_manual_sales sale_row
  where sale_row.id = p_sale_id
    and sale_row.route_id = p_route_id
    and sale_row.route_stop_id = p_route_stop_id
  for update;

  if not found then
    raise exception 'Manual sale was not found.' using errcode = '23503';
  end if;

  if not v_is_manager and v_sale.operator_id is distinct from v_actor_team_member_id then
    raise exception 'This manual sale belongs to another operator.' using errcode = '42501';
  end if;

  if v_sale.machine_id is distinct from v_stop.machine_id then
    raise exception 'The manual sale does not match the stop machine.' using errcode = '23514';
  end if;

  v_was_cancelled := v_sale.status = 'cancelled';

  if not v_was_cancelled and v_route.status::text in (
    'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed',
    'cancelled', 'canceled', 'archived', 'deleted'
  ) then
    raise exception 'A terminal route manual sale cannot be changed; use an audited inventory correction.' using errcode = '23514';
  end if;

  if v_sale.inventory_movement_id is not null then
    if v_sale.product_id is null or v_sale.operator_id is null then
      raise exception 'The manual sale inventory reference is incomplete.' using errcode = '23514';
    end if;

    select movement.*
    into v_original
    from public.inventory_movements movement
    where movement.id = v_sale.inventory_movement_id;

    if not found
      or v_original.product_id is distinct from v_sale.product_id
      or v_original.quantity is distinct from v_sale.quantity
      or v_original.from_entity_type::text <> 'operator_bag'
      or v_original.from_entity_id is distinct from v_sale.operator_id
      or v_original.to_entity_type::text <> 'customer'
      or v_original.to_entity_id is not null
      or v_original.reason::text <> 'manual_sale'
      or v_original.related_route_id is distinct from p_route_id
      or v_original.related_route_stop_id is distinct from p_route_stop_id
      or v_original.related_machine_id is distinct from v_sale.machine_id
      or v_original.source_type is distinct from 'route_manual_sale'
      or v_original.source_id is distinct from p_sale_id
    then
      raise exception 'The manual sale inventory movement does not match the saved sale.' using errcode = '23514';
    end if;

    v_reversal_key := 'route-manual-sale-cancel:'
      || p_route_id::text || ':' || p_route_stop_id::text || ':' || p_sale_id::text;

    -- Read before INSERT so an exact retry does not fire terminal/custody
    -- guards again. The route and sale row locks serialize concurrent cancels.
    select movement.*
    into v_reversal
    from public.inventory_movements movement
    where movement.idempotency_key = v_reversal_key;

    if not found then
      insert into public.inventory_movements (
        product_id,
        quantity,
        from_entity_type,
        from_entity_id,
        to_entity_type,
        to_entity_id,
        reason,
        related_route_id,
        related_route_stop_id,
        related_machine_id,
        reversed_movement_id,
        source_type,
        source_id,
        idempotency_key,
        created_by,
        notes
      ) values (
        v_sale.product_id,
        v_sale.quantity,
        'customer'::public.inventory_entity_type,
        null,
        'operator_bag'::public.inventory_entity_type,
        v_sale.operator_id,
        'manual_sale'::public.movement_reason,
        p_route_id,
        p_route_stop_id,
        v_sale.machine_id,
        v_sale.inventory_movement_id,
        'route_manual_sale_cancel',
        p_sale_id,
        v_reversal_key,
        v_actor_team_member_id,
        'Manual route sale cancelled: ' || v_sale.product_name
      )
      on conflict (idempotency_key) do nothing
      returning id into v_reversal_id;

      if v_reversal_id is not null then
        select movement.*
        into v_reversal
        from public.inventory_movements movement
        where movement.id = v_reversal_id;
      else
        select movement.*
        into v_reversal
        from public.inventory_movements movement
        where movement.idempotency_key = v_reversal_key;
      end if;
    end if;

    if not found
      or v_reversal.product_id is distinct from v_sale.product_id
      or v_reversal.quantity is distinct from v_sale.quantity
      or v_reversal.from_entity_type::text <> 'customer'
      or v_reversal.from_entity_id is not null
      or v_reversal.to_entity_type::text <> 'operator_bag'
      or v_reversal.to_entity_id is distinct from v_sale.operator_id
      or v_reversal.reason::text <> 'manual_sale'
      or v_reversal.related_route_id is distinct from p_route_id
      or v_reversal.related_route_stop_id is distinct from p_route_stop_id
      or v_reversal.related_machine_id is distinct from v_sale.machine_id
      or v_reversal.source_type is distinct from 'route_manual_sale_cancel'
      or v_reversal.source_id is distinct from p_sale_id
      or v_reversal.reversed_movement_id is distinct from v_sale.inventory_movement_id
    then
      raise exception 'Manual sale cancellation idempotency conflict.' using errcode = '23505';
    end if;

    if v_reversal_id is null then
      v_reversal_id := v_reversal.id;
    end if;
  end if;

  if not v_was_cancelled then
    update public.route_manual_sales sale_row
    set status = 'cancelled',
        cancellation_reason = v_reason,
        cancelled_at = pg_catalog.now(),
        cancelled_by_user_id = v_user_id,
        updated_at = pg_catalog.now()
    where sale_row.id = p_sale_id;
  end if;

  return query
  select v_reversal_id is not null, v_was_cancelled;
end;
$$;

revoke all on function public.snacky_cancel_route_manual_sale_v1(uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.snacky_cancel_route_manual_sale_v1(uuid, uuid, uuid, text)
  to authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');
