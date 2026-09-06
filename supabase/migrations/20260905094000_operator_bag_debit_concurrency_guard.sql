-- Canonical operator-bag concurrency invariant.
--
-- This migration performs no historical data rewrite. It validates only the
-- net effect of new INSERT/UPDATE/DELETE statements. PostgreSQL transition
-- tables are available only to AFTER triggers, so the statement triggers below
-- acquire every affected owner/product lock in deterministic order and raise
-- before the statement can return or commit when a debit is unsafe.

-- Keep the post-lock balance reads proportional to one owner/product ledger,
-- not to the lifetime size of inventory_movements. These predicates exactly
-- match the two endpoint scans in the assertion helper below.
create index if not exists idx_inventory_movements_operator_bag_to_balance
  on public.inventory_movements (to_entity_id, product_id)
  include (quantity)
  where to_entity_type = 'operator_bag'::public.inventory_entity_type
    and to_entity_id is not null;

create index if not exists idx_inventory_movements_operator_bag_from_balance
  on public.inventory_movements (from_entity_id, product_id)
  include (quantity)
  where from_entity_type = 'operator_bag'::public.inventory_entity_type
    and from_entity_id is not null;

create or replace function public._snacky_assert_operator_bag_balance_changes(
  p_changes jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_change record;
  v_after_balance bigint;
  v_before_balance bigint;
begin
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'array' then
    raise exception 'Operator-bag balance changes must be a JSON array.' using errcode = '22023';
  end if;

  -- The operator-wide custody lock is always acquired before any of that
  -- operator's product locks. Besides coordinating route ownership, this
  -- prevents a multi-statement transaction that already touched product A
  -- from deadlocking with a concurrent first statement for product B.
  for v_change in
    select distinct parsed.bag_owner_id
    from pg_catalog.jsonb_to_recordset(p_changes) as parsed(
      bag_owner_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    where parsed.bag_owner_id is not null
    order by parsed.bag_owner_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-custody:' || v_change.bag_owner_id::text,
        0
      )
    );
  end loop;

  -- Acquire the complete product key set before reading any balance. This
  -- matches the route stop/finalizer namespace and owner/product ordering,
  -- preventing two multi-key statements from taking bag locks oppositely.
  for v_change in
    select
      parsed.bag_owner_id,
      parsed.product_id,
      pg_catalog.sum(parsed.delta_quantity)::bigint as delta_quantity
    from pg_catalog.jsonb_to_recordset(p_changes) as parsed(
      bag_owner_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    where parsed.bag_owner_id is not null
      and parsed.product_id is not null
    group by parsed.bag_owner_id, parsed.product_id
    having pg_catalog.sum(parsed.delta_quantity) <> 0
    order by parsed.bag_owner_id, parsed.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_change.bag_owner_id::text || ':' || v_change.product_id::text,
        0
      )
    );
  end loop;

  -- The current ledger already contains this statement's rows. Derive the
  -- immediately-prior balance by subtracting its grouped endpoint delta.
  for v_change in
    select
      parsed.bag_owner_id,
      parsed.product_id,
      pg_catalog.sum(parsed.delta_quantity)::bigint as delta_quantity
    from pg_catalog.jsonb_to_recordset(p_changes) as parsed(
      bag_owner_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    where parsed.bag_owner_id is not null
      and parsed.product_id is not null
    group by parsed.bag_owner_id, parsed.product_id
    having pg_catalog.sum(parsed.delta_quantity) <> 0
    order by parsed.bag_owner_id, parsed.product_id
  loop
    select coalesce(pg_catalog.sum(legs.quantity_delta), 0)::bigint
    into v_after_balance
    from (
      select movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = v_change.product_id
        and movement.to_entity_type = 'operator_bag'::public.inventory_entity_type
        and movement.to_entity_id = v_change.bag_owner_id

      union all

      select -movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = v_change.product_id
        and movement.from_entity_type = 'operator_bag'::public.inventory_entity_type
        and movement.from_entity_id = v_change.bag_owner_id
    ) legs;

    v_before_balance := v_after_balance - v_change.delta_quantity;

    -- Healthy balances may not cross below zero. A legacy-negative balance may
    -- remain unchanged or improve, but no new statement may make it worse.
    if v_after_balance < (case when v_before_balance < 0 then v_before_balance else 0::bigint end) then
      raise exception 'Operator bag movement would worsen recorded stock below zero.'
        using
          errcode = '23514',
          detail = pg_catalog.format(
            'operator_id=%s product_id=%s before=%s delta=%s after=%s',
            v_change.bag_owner_id,
            v_change.product_id,
            v_before_balance,
            v_change.delta_quantity,
            v_after_balance
          );
    end if;
  end loop;
end;
$$;

revoke all on function public._snacky_assert_operator_bag_balance_changes(jsonb)
  from public, anon, authenticated;

create or replace function public.snacky_guard_operator_bag_balance_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_changes jsonb;
begin
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'bag_owner_id', grouped.bag_owner_id,
        'product_id', grouped.product_id,
        'delta_quantity', grouped.delta_quantity
      )
      order by grouped.bag_owner_id, grouped.product_id
    ),
    '[]'::jsonb
  )
  into v_changes
  from (
    select
      legs.bag_owner_id,
      legs.product_id,
      pg_catalog.sum(legs.delta_quantity)::bigint as delta_quantity
    from (
      select
        inserted.to_entity_id as bag_owner_id,
        inserted.product_id,
        inserted.quantity::bigint as delta_quantity
      from new_rows inserted
      where inserted.to_entity_type::text = 'operator_bag'
        and inserted.to_entity_id is not null

      union all

      select
        inserted.from_entity_id as bag_owner_id,
        inserted.product_id,
        -inserted.quantity::bigint as delta_quantity
      from new_rows inserted
      where inserted.from_entity_type::text = 'operator_bag'
        and inserted.from_entity_id is not null
    ) legs
    group by legs.bag_owner_id, legs.product_id
    having pg_catalog.sum(legs.delta_quantity) <> 0
  ) grouped;

  perform public._snacky_assert_operator_bag_balance_changes(v_changes);
  return null;
end;
$$;

create or replace function public.snacky_guard_operator_bag_balance_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_changes jsonb;
begin
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'bag_owner_id', grouped.bag_owner_id,
        'product_id', grouped.product_id,
        'delta_quantity', grouped.delta_quantity
      )
      order by grouped.bag_owner_id, grouped.product_id
    ),
    '[]'::jsonb
  )
  into v_changes
  from (
    select
      legs.bag_owner_id,
      legs.product_id,
      pg_catalog.sum(legs.delta_quantity)::bigint as delta_quantity
    from (
      select
        updated.to_entity_id as bag_owner_id,
        updated.product_id,
        updated.quantity::bigint as delta_quantity
      from new_rows updated
      where updated.to_entity_type::text = 'operator_bag'
        and updated.to_entity_id is not null

      union all

      select
        updated.from_entity_id as bag_owner_id,
        updated.product_id,
        -updated.quantity::bigint as delta_quantity
      from new_rows updated
      where updated.from_entity_type::text = 'operator_bag'
        and updated.from_entity_id is not null

      union all

      select
        previous.to_entity_id as bag_owner_id,
        previous.product_id,
        -previous.quantity::bigint as delta_quantity
      from old_rows previous
      where previous.to_entity_type::text = 'operator_bag'
        and previous.to_entity_id is not null

      union all

      select
        previous.from_entity_id as bag_owner_id,
        previous.product_id,
        previous.quantity::bigint as delta_quantity
      from old_rows previous
      where previous.from_entity_type::text = 'operator_bag'
        and previous.from_entity_id is not null
    ) legs
    group by legs.bag_owner_id, legs.product_id
    having pg_catalog.sum(legs.delta_quantity) <> 0
  ) grouped;

  perform public._snacky_assert_operator_bag_balance_changes(v_changes);
  return null;
end;
$$;

create or replace function public.snacky_guard_operator_bag_balance_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_changes jsonb;
begin
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'bag_owner_id', grouped.bag_owner_id,
        'product_id', grouped.product_id,
        'delta_quantity', grouped.delta_quantity
      )
      order by grouped.bag_owner_id, grouped.product_id
    ),
    '[]'::jsonb
  )
  into v_changes
  from (
    select
      legs.bag_owner_id,
      legs.product_id,
      pg_catalog.sum(legs.delta_quantity)::bigint as delta_quantity
    from (
      select
        removed.to_entity_id as bag_owner_id,
        removed.product_id,
        -removed.quantity::bigint as delta_quantity
      from old_rows removed
      where removed.to_entity_type::text = 'operator_bag'
        and removed.to_entity_id is not null

      union all

      select
        removed.from_entity_id as bag_owner_id,
        removed.product_id,
        removed.quantity::bigint as delta_quantity
      from old_rows removed
      where removed.from_entity_type::text = 'operator_bag'
        and removed.from_entity_id is not null
    ) legs
    group by legs.bag_owner_id, legs.product_id
    having pg_catalog.sum(legs.delta_quantity) <> 0
  ) grouped;

  perform public._snacky_assert_operator_bag_balance_changes(v_changes);
  return null;
end;
$$;

revoke all on function public.snacky_guard_operator_bag_balance_insert()
  from public, anon, authenticated;
revoke all on function public.snacky_guard_operator_bag_balance_update()
  from public, anon, authenticated;
revoke all on function public.snacky_guard_operator_bag_balance_delete()
  from public, anon, authenticated;

drop trigger if exists trg_snacky_operator_bag_balance_insert
  on public.inventory_movements;
create trigger trg_snacky_operator_bag_balance_insert
after insert on public.inventory_movements
referencing new table as new_rows
for each statement
execute function public.snacky_guard_operator_bag_balance_insert();

drop trigger if exists trg_snacky_operator_bag_balance_update
  on public.inventory_movements;
create trigger trg_snacky_operator_bag_balance_update
after update on public.inventory_movements
referencing old table as old_rows new table as new_rows
for each statement
execute function public.snacky_guard_operator_bag_balance_update();

drop trigger if exists trg_snacky_operator_bag_balance_delete
  on public.inventory_movements;
create trigger trg_snacky_operator_bag_balance_delete
after delete on public.inventory_movements
referencing old table as old_rows
for each statement
execute function public.snacky_guard_operator_bag_balance_delete();
