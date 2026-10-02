-- Complete production contract for the single-signature Snacky pickup v2 RPC.
--
-- Production reached the RPC but exposed several pieces of schema drift one at a
-- time: missing active-row columns, a UUID/text mismatch, duplicate prepared batch
-- insertion, and ON CONFLICT targets without matching unique constraints.
--
-- This migration repairs and verifies the complete write contract used by
-- public.snacky_confirm_route_pickup_batch_v2 in one pass. It does not delete,
-- truncate, reset, or cascade any route, pickup, checklist, inventory, VMS,
-- finance, payroll, or audit data.

-- ---------------------------------------------------------------------------
-- 1. Required pickup-list active-row columns.
-- ---------------------------------------------------------------------------

do $migration$
begin
  if to_regclass('public.route_pick_list_items') is null then
    raise exception 'Required table public.route_pick_list_items does not exist.'
      using errcode = '42P01';
  end if;
end
$migration$;

alter table public.route_pick_list_items
  add column if not exists is_active boolean,
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_reason text;

update public.route_pick_list_items
set is_active = true
where is_active is null;

alter table public.route_pick_list_items
  alter column is_active set default true,
  alter column is_active set not null;

create index if not exists idx_route_pick_list_items_route_id_is_active
  on public.route_pick_list_items(route_id, is_active);

create index if not exists idx_route_pick_list_items_active_route_stop_item
  on public.route_pick_list_items(route_id, route_stop_item_id)
  where is_active = true;

-- The RPC uses ON CONFLICT (id) for these two tables. Ensure PostgreSQL always has
-- an exact unique inference target even on older production table versions.
create unique index if not exists snacky_route_stop_items_id_uq
  on public.route_stop_items(id);

create unique index if not exists snacky_route_pick_list_items_id_uq
  on public.route_pick_list_items(id);

-- ---------------------------------------------------------------------------
-- 2. Prepared pickup-batch insert idempotency.
-- ---------------------------------------------------------------------------

create or replace function public.snacky_route_pickup_batch_insert_idempotency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
declare
  v_existing public.route_pickup_batches%rowtype;
  v_existing_json jsonb;
begin
  select b.*
  into v_existing
  from public.route_pickup_batches b
  where b.id = new.id
  for update;

  if not found then
    return new;
  end if;

  if v_existing.route_id is distinct from new.route_id
     or v_existing.operator_id is distinct from new.operator_id then
    raise exception 'Pickup batch id already belongs to another route or operator.'
      using errcode = '23505';
  end if;

  v_existing_json := to_jsonb(v_existing);
  if nullif(v_existing_json->>'returned_to_assigned_at', '') is not null then
    raise exception 'Returned pickup batches cannot be confirmed.'
      using errcode = 'P0001';
  end if;

  update public.route_pickup_batches as existing_batch
  set
    status = case
      when new.status::text = 'confirmed' then new.status
      else existing_batch.status
    end,
    selected_stop_ids = coalesce(new.selected_stop_ids, existing_batch.selected_stop_ids),
    product_summary = coalesce(new.product_summary, existing_batch.product_summary),
    storage_deducted = coalesce(new.storage_deducted, existing_batch.storage_deducted),
    confirmed_at = coalesce(new.confirmed_at, existing_batch.confirmed_at),
    updated_at = now()
  where existing_batch.id = new.id;

  return null;
end;
$function$;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'route_pickup_batches'
      and t.tgname = 'snacky_route_pickup_batch_insert_idempotency'
      and not t.tgisinternal
  ) then
    create trigger snacky_route_pickup_batch_insert_idempotency
      before insert on public.route_pickup_batches
      for each row
      execute function public.snacky_route_pickup_batch_insert_idempotency();
  end if;
end
$trigger$;

-- ---------------------------------------------------------------------------
-- 3. Idempotency guards that do not require fragile business-key constraints.
-- ---------------------------------------------------------------------------

-- Inventory movements are immutable. A repeated deterministic idempotency key is
-- suppressed after taking a transaction-scoped advisory lock.
create or replace function public.snacky_pickup_v2_inventory_movement_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
begin
  if new.idempotency_key is null or btrim(new.idempotency_key) = '' then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:inventory-movement:' || new.idempotency_key, 0)
  );

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.idempotency_key = new.idempotency_key
  ) then
    return null;
  end if;

  return new;
end;
$function$;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'inventory_movements'
      and t.tgname = 'snacky_pickup_v2_inventory_movement_guard'
      and not t.tgisinternal
  ) then
    create trigger snacky_pickup_v2_inventory_movement_guard
      before insert on public.inventory_movements
      for each row
      execute function public.snacky_pickup_v2_inventory_movement_guard();
  end if;
end
$trigger$;

-- Route stock lines use update-or-insert semantics. This guard updates every
-- existing row for the route/product pair and suppresses a duplicate insert.
create or replace function public.snacky_pickup_v2_route_stock_line_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
begin
  if new.route_id is null or new.product_id is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:route-stock-line:' || new.route_id::text || ':' || new.product_id::text,
      0
    )
  );

  update public.route_stock_lines existing_line
  set
    planned_qty = new.planned_qty,
    picked_qty = new.picked_qty,
    updated_at = coalesce(new.updated_at, now())
  where existing_line.route_id = new.route_id
    and existing_line.product_id = new.product_id;

  if found then
    return null;
  end if;

  return new;
end;
$function$;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'route_stock_lines'
      and t.tgname = 'snacky_pickup_v2_route_stock_line_guard'
      and not t.tgisinternal
  ) then
    create trigger snacky_pickup_v2_route_stock_line_guard
      before insert on public.route_stock_lines
      for each row
      execute function public.snacky_pickup_v2_route_stock_line_guard();
  end if;
end
$trigger$;

-- Batch-stop links also remain idempotent on older schemas that may not have the
-- expected pair constraint.
create or replace function public.snacky_pickup_v2_batch_stop_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
begin
  perform pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:pickup-batch-stop:' || new.pickup_batch_id::text || ':' || new.route_stop_id::text,
      0
    )
  );

  if exists (
    select 1
    from public.route_pickup_batch_stops link
    where link.pickup_batch_id = new.pickup_batch_id
      and link.route_stop_id = new.route_stop_id
  ) then
    return null;
  end if;

  return new;
end;
$function$;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'route_pickup_batch_stops'
      and t.tgname = 'snacky_pickup_v2_batch_stop_guard'
      and not t.tgisinternal
  ) then
    create trigger snacky_pickup_v2_batch_stop_guard
      before insert on public.route_pickup_batch_stops
      for each row
      execute function public.snacky_pickup_v2_batch_stop_guard();
  end if;
end
$trigger$;

-- ---------------------------------------------------------------------------
-- 4. Patch the deployed v2 RPC once, independent of PostgreSQL whitespace.
-- ---------------------------------------------------------------------------

do $patch$
declare
  v_proc regprocedure := to_regprocedure(
    'public.snacky_confirm_route_pickup_batch_v2(uuid,public.route_status,public.route_status,timestamp with time zone,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[],uuid[])'
  );
  v_definition text;
  v_patched_definition text;
begin
  if v_proc is null then
    raise exception 'Required pickup function public.snacky_confirm_route_pickup_batch_v2 was not found.'
      using errcode = '42883';
  end if;

  select pg_get_functiondef(v_proc::oid)
  into v_definition;

  v_patched_definition := v_definition;

  -- Production inventory_movements.source_id is UUID. The app already submits a
  -- deterministic UUID string; cast it explicitly in the atomic insert.
  if not (
    v_patched_definition ~* 'nullif\([[:space:]]*x\.source_id[[:space:]]*,[[:space:]]*''''[[:space:]]*\)::uuid'
  ) then
    v_patched_definition := regexp_replace(
      v_patched_definition,
      '(x\.source_type[[:space:]]*,[[:space:]]*)x\.source_id([[:space:]]*,[[:space:]]*x\.idempotency_key)',
      E'\\1nullif(x.source_id, '''')::uuid\\2',
      'i'
    );
  end if;

  -- Do not require a unique constraint on the historical idempotency-key column.
  -- The advisory-lock trigger above is the authoritative duplicate guard.
  v_patched_definition := regexp_replace(
    v_patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*idempotency_key[[:space:]]*\)[[:space:]]+do[[:space:]]+nothing',
    'on conflict do nothing',
    'i'
  );

  -- Do not require a historical route/product unique constraint. The guarded
  -- update-or-insert trigger above provides the intended upsert behavior.
  v_patched_definition := regexp_replace(
    v_patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*route_id[[:space:]]*,[[:space:]]*product_id[[:space:]]*\)[[:space:]]*do[[:space:]]+update[[:space:]]+set[[:space:]]*planned_qty[[:space:]]*=[[:space:]]*excluded\.planned_qty[[:space:]]*,[[:space:]]*picked_qty[[:space:]]*=[[:space:]]*excluded\.picked_qty[[:space:]]*,[[:space:]]*updated_at[[:space:]]*=[[:space:]]*excluded\.updated_at',
    'on conflict do nothing',
    'i'
  );

  if v_patched_definition is distinct from v_definition then
    execute v_patched_definition;
  end if;

  select pg_get_functiondef(v_proc::oid)
  into v_definition;

  if not (
    v_definition ~* 'nullif\([[:space:]]*x\.source_id[[:space:]]*,[[:space:]]*''''[[:space:]]*\)::uuid'
  ) then
    raise exception 'Pickup v2 source_id UUID cast is not installed.'
      using errcode = '42804';
  end if;

  if v_definition ~* 'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*idempotency_key[[:space:]]*\)' then
    raise exception 'Pickup v2 still depends on a missing inventory idempotency unique constraint.'
      using errcode = '42P10';
  end if;

  if v_definition ~* 'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*route_id[[:space:]]*,[[:space:]]*product_id[[:space:]]*\)' then
    raise exception 'Pickup v2 still depends on a missing route stock-line unique constraint.'
      using errcode = '42P10';
  end if;
end
$patch$;

-- ---------------------------------------------------------------------------
-- 5. Full table/column/type preflight for everything the v2 RPC writes.
-- ---------------------------------------------------------------------------

do $audit$
declare
  v_missing text;
  v_source_id_type text;
  v_function_count integer;
begin
  select string_agg(required_relation || '.' || required_column, ', ' order by required_relation, required_column)
  into v_missing
  from (
    values
      ('routes', 'id'), ('routes', 'operator_id'), ('routes', 'status'), ('routes', 'started_at'),
      ('route_stops', 'id'), ('route_stops', 'route_id'), ('route_stops', 'machine_id'), ('route_stops', 'status'),
      ('route_pickup_batches', 'id'), ('route_pickup_batches', 'route_id'), ('route_pickup_batches', 'operator_id'),
      ('route_pickup_batches', 'status'), ('route_pickup_batches', 'selected_stop_ids'),
      ('route_pickup_batches', 'product_summary'), ('route_pickup_batches', 'storage_deducted'),
      ('route_pickup_batches', 'confirmed_at'), ('route_pickup_batches', 'updated_at'),
      ('route_pickup_batch_stops', 'pickup_batch_id'), ('route_pickup_batch_stops', 'route_stop_id'),
      ('route_stop_items', 'id'), ('route_stop_items', 'route_id'), ('route_stop_items', 'route_stop_id'),
      ('route_stop_items', 'machine_id'), ('route_stop_items', 'product_id'), ('route_stop_items', 'machine_slot_id'),
      ('route_stop_items', 'slot_code'), ('route_stop_items', 'planned_quantity'),
      ('route_stop_items', 'picked_quantity'), ('route_stop_items', 'source'), ('route_stop_items', 'notes'),
      ('route_stop_items', 'updated_at'),
      ('route_pick_list_items', 'id'), ('route_pick_list_items', 'route_id'),
      ('route_pick_list_items', 'route_stop_id'), ('route_pick_list_items', 'route_stop_item_id'),
      ('route_pick_list_items', 'machine_id'), ('route_pick_list_items', 'product_id'),
      ('route_pick_list_items', 'planned_qty'), ('route_pick_list_items', 'picked_qty'),
      ('route_pick_list_items', 'action_type'), ('route_pick_list_items', 'pickup_batch_id'),
      ('route_pick_list_items', 'reason'), ('route_pick_list_items', 'notes'),
      ('route_pick_list_items', 'needs_review'), ('route_pick_list_items', 'created_by'),
      ('route_pick_list_items', 'is_active'), ('route_pick_list_items', 'superseded_at'),
      ('route_pick_list_items', 'superseded_reason'), ('route_pick_list_items', 'updated_at'),
      ('inventory_movements', 'product_id'), ('inventory_movements', 'quantity'),
      ('inventory_movements', 'from_entity_type'), ('inventory_movements', 'from_entity_id'),
      ('inventory_movements', 'to_entity_type'), ('inventory_movements', 'to_entity_id'),
      ('inventory_movements', 'reason'), ('inventory_movements', 'related_route_id'),
      ('inventory_movements', 'related_pickup_batch_id'), ('inventory_movements', 'source_type'),
      ('inventory_movements', 'source_id'), ('inventory_movements', 'idempotency_key'),
      ('inventory_movements', 'created_by'), ('inventory_movements', 'notes'),
      ('route_stock_lines', 'route_id'), ('route_stock_lines', 'product_id'),
      ('route_stock_lines', 'planned_qty'), ('route_stock_lines', 'picked_qty'),
      ('route_stock_lines', 'updated_at'),
      ('refill_order_lines', 'id'), ('refill_order_lines', 'refill_order_id'),
      ('refill_order_lines', 'picked_qty'),
      ('refill_orders', 'id'), ('refill_orders', 'route_id'), ('refill_orders', 'machine_id'),
      ('refill_orders', 'status')
  ) as required(required_relation, required_column)
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = required.required_relation
      and c.column_name = required.required_column
  );

  if v_missing is not null then
    raise exception 'Pickup v2 production schema is missing required columns: %', v_missing
      using errcode = '42703';
  end if;

  select format_type(a.atttypid, a.atttypmod)
  into v_source_id_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'inventory_movements'
    and a.attname = 'source_id'
    and a.attnum > 0
    and not a.attisdropped;

  if v_source_id_type <> 'uuid' then
    raise exception 'Expected public.inventory_movements.source_id to be uuid, found %.', v_source_id_type
      using errcode = '42804';
  end if;

  select count(*)
  into v_function_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'snacky_confirm_route_pickup_batch_v2';

  if v_function_count <> 1 then
    raise exception 'Expected exactly one public.snacky_confirm_route_pickup_batch_v2 signature, found %.', v_function_count
      using errcode = '42725';
  end if;

  if to_regprocedure('public.snacky_current_profile_has_any_role(text[])') is null then
    raise exception 'Required permission function public.snacky_current_profile_has_any_role(text[]) is missing.'
      using errcode = '42883';
  end if;

  if to_regprocedure('public.snacky_operator_can_access_route(uuid)') is null then
    raise exception 'Required permission function public.snacky_operator_can_access_route(uuid) is missing.'
      using errcode = '42883';
  end if;
end
$audit$;

revoke all on function public.snacky_route_pickup_batch_insert_idempotency() from public;
revoke all on function public.snacky_pickup_v2_inventory_movement_guard() from public;
revoke all on function public.snacky_pickup_v2_route_stock_line_guard() from public;
revoke all on function public.snacky_pickup_v2_batch_stop_guard() from public;

select pg_notify('pgrst', 'reload schema');
