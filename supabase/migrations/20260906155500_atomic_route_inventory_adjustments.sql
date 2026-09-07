-- Route stop inventory adjustments move physical stock between a route's
-- machine, operator bag, and waste. Serialize them with every other route
-- custody writer and make both creation and cancellation exact-idempotent.

alter table public.inventory_adjustments
  add column if not exists storage_movement_id uuid references public.inventory_movements(id) on delete set null,
  add column if not exists inventory_reversal_movement_id uuid references public.inventory_movements(id) on delete set null,
  add column if not exists storage_reversal_movement_id uuid references public.inventory_movements(id) on delete set null;

create unique index if not exists idx_inventory_adjustments_storage_movement
  on public.inventory_adjustments(storage_movement_id)
  where storage_movement_id is not null;
create unique index if not exists idx_inventory_adjustments_inventory_reversal
  on public.inventory_adjustments(inventory_reversal_movement_id)
  where inventory_reversal_movement_id is not null;
create unique index if not exists idx_inventory_adjustments_storage_reversal
  on public.inventory_adjustments(storage_reversal_movement_id)
  where storage_reversal_movement_id is not null;

-- This legacy AFTER trigger silently added a second, unlinked bag -> storage
-- movement. The RPC below owns and links the complete two-leg return instead.
drop trigger if exists inventory_adjustments_post_machine_return_to_storage
  on public.inventory_adjustments;
drop function if exists public.snacky_post_machine_return_to_storage();

-- Every writer that touches machine or machine-storage stock is protected by
-- one statement-level invariant. Transition tables let a multi-row statement
-- acquire its complete machine/product key set in deterministic order before
-- validating that healthy balances do not cross below zero and legacy-negative
-- balances do not become worse.
drop trigger if exists trg_snacky_machine_product_movement_lock
  on public.inventory_movements;
drop function if exists public.snacky_lock_machine_product_movement();

create index if not exists idx_inventory_movements_machine_to_balance
  on public.inventory_movements(to_entity_type, to_entity_id, product_id)
  include (quantity)
  where to_entity_type in (
    'machine'::public.inventory_entity_type,
    'machine_storage'::public.inventory_entity_type
  ) and to_entity_id is not null;
create index if not exists idx_inventory_movements_machine_from_balance
  on public.inventory_movements(from_entity_type, from_entity_id, product_id)
  include (quantity)
  where from_entity_type in (
    'machine'::public.inventory_entity_type,
    'machine_storage'::public.inventory_entity_type
  ) and from_entity_id is not null;

create or replace function public._snacky_assert_machine_balance_changes(p_changes jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_change record;
  v_after_balance bigint;
  v_before_balance bigint;
begin
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'array' then
    raise exception 'Machine balance changes must be a JSON array.' using errcode = '22023';
  end if;

  for v_change in
    select distinct parsed.machine_id, parsed.product_id
    from pg_catalog.jsonb_to_recordset(p_changes) as parsed(
      entity_type text,
      machine_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    where parsed.machine_id is not null and parsed.product_id is not null
    order by parsed.machine_id, parsed.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:machine-stock:' || v_change.machine_id::text || ':' || v_change.product_id::text,
        0
      )
    );
  end loop;

  for v_change in
    select
      parsed.entity_type,
      parsed.machine_id,
      parsed.product_id,
      pg_catalog.sum(parsed.delta_quantity)::bigint as delta_quantity
    from pg_catalog.jsonb_to_recordset(p_changes) as parsed(
      entity_type text,
      machine_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    where parsed.machine_id is not null
      and parsed.product_id is not null
      and parsed.entity_type in ('machine', 'machine_storage')
    group by parsed.entity_type, parsed.machine_id, parsed.product_id
    having pg_catalog.sum(parsed.delta_quantity) <> 0
    order by parsed.machine_id, parsed.product_id, parsed.entity_type
  loop
    select coalesce(pg_catalog.sum(leg.quantity_delta), 0::bigint)
    into v_after_balance
    from (
      select movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = v_change.product_id
        and movement.to_entity_type::text = v_change.entity_type
        and movement.to_entity_id = v_change.machine_id
      union all
      select -movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = v_change.product_id
        and movement.from_entity_type::text = v_change.entity_type
        and movement.from_entity_id = v_change.machine_id
    ) leg;

    v_before_balance := v_after_balance - v_change.delta_quantity;
    if v_after_balance < (
      case when v_before_balance < 0 then v_before_balance else 0::bigint end
    ) then
      raise exception 'Machine movement would worsen recorded stock below zero.'
        using
          errcode = '23514',
          detail = pg_catalog.format(
            'entity_type=%s machine_id=%s product_id=%s before=%s delta=%s after=%s',
            v_change.entity_type,
            v_change.machine_id,
            v_change.product_id,
            v_before_balance,
            v_change.delta_quantity,
            v_after_balance
          );
    end if;
  end loop;
end;
$function$;

revoke all on function public._snacky_assert_machine_balance_changes(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.snacky_guard_machine_balance_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_changes jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'entity_type', grouped.entity_type,
    'machine_id', grouped.machine_id,
    'product_id', grouped.product_id,
    'delta_quantity', grouped.delta_quantity
  ) order by grouped.machine_id, grouped.product_id, grouped.entity_type), '[]'::jsonb)
  into v_changes
  from (
    select leg.entity_type, leg.machine_id, leg.product_id,
      pg_catalog.sum(leg.delta_quantity)::bigint as delta_quantity
    from (
      select inserted.to_entity_type::text, inserted.to_entity_id, inserted.product_id,
        inserted.quantity::bigint
      from new_rows inserted
      where inserted.to_entity_type::text in ('machine', 'machine_storage') and inserted.to_entity_id is not null
      union all
      select inserted.from_entity_type::text, inserted.from_entity_id, inserted.product_id,
        -inserted.quantity::bigint
      from new_rows inserted
      where inserted.from_entity_type::text in ('machine', 'machine_storage') and inserted.from_entity_id is not null
    ) leg(entity_type, machine_id, product_id, delta_quantity)
    group by leg.entity_type, leg.machine_id, leg.product_id
    having pg_catalog.sum(leg.delta_quantity) <> 0
  ) grouped;
  perform public._snacky_assert_machine_balance_changes(v_changes);
  return null;
end;
$function$;

create or replace function public.snacky_guard_machine_balance_update()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_changes jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'entity_type', grouped.entity_type,
    'machine_id', grouped.machine_id,
    'product_id', grouped.product_id,
    'delta_quantity', grouped.delta_quantity
  ) order by grouped.machine_id, grouped.product_id, grouped.entity_type), '[]'::jsonb)
  into v_changes
  from (
    select leg.entity_type, leg.machine_id, leg.product_id,
      pg_catalog.sum(leg.delta_quantity)::bigint as delta_quantity
    from (
      select updated.to_entity_type::text, updated.to_entity_id, updated.product_id, updated.quantity::bigint
      from new_rows updated
      where updated.to_entity_type::text in ('machine', 'machine_storage') and updated.to_entity_id is not null
      union all
      select updated.from_entity_type::text, updated.from_entity_id, updated.product_id, -updated.quantity::bigint
      from new_rows updated
      where updated.from_entity_type::text in ('machine', 'machine_storage') and updated.from_entity_id is not null
      union all
      select previous.to_entity_type::text, previous.to_entity_id, previous.product_id, -previous.quantity::bigint
      from old_rows previous
      where previous.to_entity_type::text in ('machine', 'machine_storage') and previous.to_entity_id is not null
      union all
      select previous.from_entity_type::text, previous.from_entity_id, previous.product_id, previous.quantity::bigint
      from old_rows previous
      where previous.from_entity_type::text in ('machine', 'machine_storage') and previous.from_entity_id is not null
    ) leg(entity_type, machine_id, product_id, delta_quantity)
    group by leg.entity_type, leg.machine_id, leg.product_id
    having pg_catalog.sum(leg.delta_quantity) <> 0
  ) grouped;
  perform public._snacky_assert_machine_balance_changes(v_changes);
  return null;
end;
$function$;

create or replace function public.snacky_guard_machine_balance_delete()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_changes jsonb;
begin
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'entity_type', grouped.entity_type,
    'machine_id', grouped.machine_id,
    'product_id', grouped.product_id,
    'delta_quantity', grouped.delta_quantity
  ) order by grouped.machine_id, grouped.product_id, grouped.entity_type), '[]'::jsonb)
  into v_changes
  from (
    select leg.entity_type, leg.machine_id, leg.product_id,
      pg_catalog.sum(leg.delta_quantity)::bigint as delta_quantity
    from (
      select removed.to_entity_type::text, removed.to_entity_id, removed.product_id, -removed.quantity::bigint
      from old_rows removed
      where removed.to_entity_type::text in ('machine', 'machine_storage') and removed.to_entity_id is not null
      union all
      select removed.from_entity_type::text, removed.from_entity_id, removed.product_id, removed.quantity::bigint
      from old_rows removed
      where removed.from_entity_type::text in ('machine', 'machine_storage') and removed.from_entity_id is not null
    ) leg(entity_type, machine_id, product_id, delta_quantity)
    group by leg.entity_type, leg.machine_id, leg.product_id
    having pg_catalog.sum(leg.delta_quantity) <> 0
  ) grouped;
  perform public._snacky_assert_machine_balance_changes(v_changes);
  return null;
end;
$function$;

revoke all on function public.snacky_guard_machine_balance_insert() from public, anon, authenticated, service_role;
revoke all on function public.snacky_guard_machine_balance_update() from public, anon, authenticated, service_role;
revoke all on function public.snacky_guard_machine_balance_delete() from public, anon, authenticated, service_role;

-- PostgreSQL fires same-event triggers alphabetically. Keep the machine guard
-- after the operator-bag guard so a machine <-> bag statement always follows
-- the canonical custody/bag -> machine lock hierarchy used by the RPCs.
drop trigger if exists trg_snacky_machine_balance_insert on public.inventory_movements;
drop trigger if exists trg_snacky_zz_machine_balance_insert on public.inventory_movements;
create trigger trg_snacky_zz_machine_balance_insert
after insert on public.inventory_movements
referencing new table as new_rows
for each statement execute function public.snacky_guard_machine_balance_insert();

drop trigger if exists trg_snacky_machine_balance_update on public.inventory_movements;
drop trigger if exists trg_snacky_zz_machine_balance_update on public.inventory_movements;
create trigger trg_snacky_zz_machine_balance_update
after update on public.inventory_movements
referencing old table as old_rows new table as new_rows
for each statement execute function public.snacky_guard_machine_balance_update();

drop trigger if exists trg_snacky_machine_balance_delete on public.inventory_movements;
drop trigger if exists trg_snacky_zz_machine_balance_delete on public.inventory_movements;
create trigger trg_snacky_zz_machine_balance_delete
after delete on public.inventory_movements
referencing old table as old_rows
for each statement execute function public.snacky_guard_machine_balance_delete();

-- Link only exact legacy trigger rows. Never manufacture missing inventory.
update public.inventory_adjustments adjustment
set storage_movement_id = movement.id,
    updated_at = pg_catalog.now()
from public.inventory_movements movement
where adjustment.adjustment_type = 'returned_from_machine'
  and adjustment.storage_movement_id is null
  and adjustment.inventory_movement_id is not null
  and movement.idempotency_key = 'machine-return-storage:' || adjustment.id::text
  and movement.source_type = 'inventory_adjustment'
  and movement.source_id = adjustment.id
  and movement.product_id = adjustment.product_id
  and movement.quantity = adjustment.quantity
  and movement.from_entity_type::text = 'operator_bag'
  and movement.from_entity_id = adjustment.operator_id
  and movement.to_entity_type::text = 'storage'
  and movement.to_entity_id is not null
  and movement.reason::text = 'operator_bag_to_storage'
  and movement.related_route_id = adjustment.route_id
  and movement.related_route_stop_id = adjustment.route_stop_id
  and movement.related_machine_id = adjustment.machine_id
  and movement.unit_cost_lyd is not distinct from adjustment.unit_cost_lyd
  and movement.line_total_lyd is not distinct from adjustment.total_cost_lyd
  and movement.reversed_movement_id is null;

-- An old returned record without both exact legs is explicitly review-only.
update public.inventory_adjustments adjustment
set status = 'pending_storage_confirmation',
    notes = pg_catalog.concat_ws(
      ' - ',
      nullif(adjustment.notes, ''),
      'Legacy returned-product ledger is incomplete; inventory review is required.'
    ),
    updated_at = pg_catalog.now()
where adjustment.adjustment_type = 'returned_from_machine'
  and adjustment.status = 'confirmed'
  and (adjustment.inventory_movement_id is null or adjustment.storage_movement_id is null);

create or replace function public.create_route_inventory_adjustment(
  p_adjustment_id uuid,
  p_adjustment_type text,
  p_product_id uuid,
  p_machine_id uuid,
  p_route_id uuid,
  p_route_stop_id uuid,
  p_quantity integer,
  p_reason text,
  p_notes text default null,
  p_photo_url text default null,
  p_client_submission_id text default null
)
returns table (
  id uuid,
  adjustment_type text,
  product_id uuid,
  product_name text,
  machine_id uuid,
  location_id uuid,
  route_id uuid,
  route_stop_id uuid,
  operator_id uuid,
  quantity integer,
  unit_cost_lyd numeric,
  total_cost_lyd numeric,
  reason text,
  notes text,
  photo_url text,
  status text,
  inventory_movement_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
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
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_photo_url text := nullif(pg_catalog.btrim(coalesce(p_photo_url, '')), '');
  v_adjustment_id uuid;
  v_route public.routes%rowtype;
  v_stop public.route_stops%rowtype;
  v_product public.products%rowtype;
  v_existing public.inventory_adjustments%rowtype;
  v_existing_by_id public.inventory_adjustments%rowtype;
  v_existing_by_submission public.inventory_adjustments%rowtype;
  v_movement public.inventory_movements%rowtype;
  v_storage_movement public.inventory_movements%rowtype;
  v_has_existing_by_id boolean := false;
  v_has_existing_by_submission boolean := false;
  v_location_id uuid;
  v_storage_id uuid;
  v_unit_cost numeric(12,4);
  v_total_cost numeric(12,2);
  v_route_bag_qty bigint := 0;
  v_global_bag_qty bigint := 0;
  v_storage_on_hand bigint := 0;
  v_storage_reserved bigint := 0;
  v_machine_qty bigint := 0;
  v_has_custody_lease boolean := false;
  v_from_type public.inventory_entity_type;
  v_from_id uuid;
  v_to_type public.inventory_entity_type;
  v_to_id uuid;
  v_movement_reason public.movement_reason;
  v_movement_id uuid;
  v_storage_movement_id uuid;
  v_movement_key text;
  v_storage_movement_key text;
  v_movement_notes text;
  v_expected_payload jsonb;
  v_expected_storage_payload jsonb;
  v_collision_count integer := 0;
  v_updated_count integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to record a route inventory adjustment.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  v_is_manager := public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  if p_route_id is null or p_route_stop_id is null or p_machine_id is null then
    raise exception 'Route, stop, and machine are required.' using errcode = '22023';
  end if;
  if p_product_id is null then
    raise exception 'Product is required.' using errcode = '23502';
  end if;
  if p_adjustment_type not in ('damaged', 'returned_from_machine') then
    raise exception 'Unsupported inventory adjustment type.' using errcode = '22023';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'Quantity must be greater than 0.' using errcode = '23514';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) > 2000 then
    raise exception 'A reason between 1 and 2000 characters is required.' using errcode = '22023';
  end if;
  if v_notes is not null and pg_catalog.length(v_notes) > 4000 then
    raise exception 'Adjustment notes cannot exceed 4000 characters.' using errcode = '22023';
  end if;
  if v_photo_url is not null and pg_catalog.length(v_photo_url) > 4000 then
    raise exception 'Adjustment photo URL cannot exceed 4000 characters.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  -- Unlocked lookup is only a preflight. It ensures retries are identified
  -- before terminal-state checks; every row is re-read under the route mutex.
  if p_adjustment_id is not null then
    select adjustment.*
    into v_existing_by_id
    from public.inventory_adjustments adjustment
    where adjustment.id = p_adjustment_id;
    v_has_existing_by_id := found;
  end if;

  select adjustment.*
  into v_existing_by_submission
  from public.inventory_adjustments adjustment
  where adjustment.client_submission_id = v_submission_id;
  v_has_existing_by_submission := found;

  if v_has_existing_by_id and v_has_existing_by_submission
    and v_existing_by_id.id is distinct from v_existing_by_submission.id
  then
    raise exception 'Adjustment id and submission id identify different records.' using errcode = '23505';
  end if;
  if v_has_existing_by_id and v_existing_by_id.route_id is distinct from p_route_id then
    raise exception 'Adjustment id is already assigned to another route.' using errcode = '23505';
  end if;
  if v_has_existing_by_submission and v_existing_by_submission.route_id is distinct from p_route_id then
    raise exception 'Submission id is already assigned to another route.' using errcode = '23505';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || p_route_id::text, 0)
  );

  select route_row.*
  into v_route
  from public.routes route_row
  where route_row.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0002';
  end if;
  if not v_is_manager and not public.snacky_operator_can_access_route(p_route_id) then
    raise exception 'You are not authorized to adjust inventory for this route.' using errcode = '42501';
  end if;

  select stop_row.*
  into v_stop
  from public.route_stops stop_row
  where stop_row.id = p_route_stop_id
  for update;

  if not found then
    raise exception 'Route stop not found.' using errcode = 'P0002';
  end if;
  if v_stop.route_id is distinct from p_route_id then
    raise exception 'This stop does not belong to the selected route.' using errcode = '22023';
  end if;
  if v_stop.machine_id is distinct from p_machine_id then
    raise exception 'This machine does not match the selected stop.' using errcode = '22023';
  end if;

  -- Re-read both uniqueness dimensions under the shared route mutex.
  v_has_existing_by_id := false;
  v_has_existing_by_submission := false;
  if p_adjustment_id is not null then
    select adjustment.*
    into v_existing_by_id
    from public.inventory_adjustments adjustment
    where adjustment.id = p_adjustment_id
    for update;
    v_has_existing_by_id := found;
  end if;

  select adjustment.*
  into v_existing_by_submission
  from public.inventory_adjustments adjustment
  where adjustment.client_submission_id = v_submission_id
  for update;
  v_has_existing_by_submission := found;

  if v_has_existing_by_id and v_has_existing_by_submission
    and v_existing_by_id.id is distinct from v_existing_by_submission.id
  then
    raise exception 'Adjustment id and submission id identify different records.' using errcode = '23505';
  elsif v_has_existing_by_submission then
    v_existing := v_existing_by_submission;
  elsif v_has_existing_by_id then
    v_existing := v_existing_by_id;
  else
    v_existing.id := null;
  end if;

  if coalesce(v_existing.adjustment_type, p_adjustment_type) = 'returned_from_machine' then
    if v_existing.id is not null then
      if v_existing.storage_movement_id is null then
        raise exception 'Returned-product adjustment has no exact storage movement link. Use inventory review.' using errcode = '23514';
      end if;
      select movement.to_entity_id
      into v_storage_id
      from public.inventory_movements movement
      where movement.id = v_existing.storage_movement_id;
      if not found or v_storage_id is null then
        raise exception 'Returned-product adjustment storage destination cannot be verified. Use inventory review.' using errcode = '23514';
      end if;
    else
      v_storage_id := public.snacky_route_leftover_storage_location_id(p_route_id);
      if v_storage_id is null then
        raise exception 'No active storage location is available for the returned product.' using errcode = '23514';
      end if;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(p_product_id::text),
      pg_catalog.hashtext(v_storage_id::text)
    );
  end if;

  if v_route.operator_id is null then
    raise exception 'This route has no assigned operator, so bag custody cannot be verified.' using errcode = '23514';
  end if;

  -- Bag/custody locks precede the product and movement rows across every route
  -- adjustment path. The statement-level balance guard takes these same keys.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:operator-custody:' || v_route.operator_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:operator-bag:' || v_route.operator_id::text || ':' || p_product_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:machine-stock:' || p_machine_id::text || ':' || p_product_id::text,
      0
    )
  );

  select product_row.*
  into v_product
  from public.products product_row
  where product_row.id = p_product_id
  for update;

  if not found then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;

  -- Exact replay is accepted before any route/stop terminal-state rejection,
  -- but only when the immutable parent and its canonical ledger row still agree.
  if v_existing.id is not null then
    if (p_adjustment_id is not null and v_existing.id is distinct from p_adjustment_id)
      or v_existing.client_submission_id is distinct from v_submission_id
      or v_existing.route_id is distinct from p_route_id
      or v_existing.route_stop_id is distinct from p_route_stop_id
      or v_existing.machine_id is distinct from p_machine_id
      or v_existing.operator_id is distinct from v_route.operator_id
      or v_existing.adjustment_type is distinct from p_adjustment_type
      or v_existing.product_id is distinct from p_product_id
      or v_existing.quantity is distinct from p_quantity
      or v_existing.reason is distinct from v_reason
      or v_existing.notes is distinct from v_notes
      or v_existing.photo_url is distinct from v_photo_url
      or v_existing.status is distinct from 'confirmed'
      or v_existing.inventory_movement_id is null
    then
      raise exception 'Adjustment retry does not match the committed immutable record.' using errcode = '23505';
    end if;

    perform 1
    from public.inventory_movements movement
    where movement.id = v_existing.inventory_movement_id
      or movement.idempotency_key in (
        'route-inventory-adjustment:create:v2:' || v_submission_id,
        v_submission_id
      )
      or (movement.source_type = 'inventory_adjustment' and movement.source_id = v_existing.id)
    order by movement.id
    for update;

    select movement.*
    into v_movement
    from public.inventory_movements movement
    where movement.id = v_existing.inventory_movement_id
    for update;

    if not found then
      raise exception 'Adjustment retry has no linked inventory movement. Stop and review it.' using errcode = '23514';
    end if;

    if v_existing.adjustment_type = 'damaged' then
      v_from_type := 'operator_bag'::public.inventory_entity_type;
      v_from_id := v_existing.operator_id;
      v_to_type := 'waste'::public.inventory_entity_type;
      v_to_id := null;
      v_movement_reason := 'damaged'::public.movement_reason;
    else
      v_from_type := 'machine'::public.inventory_entity_type;
      v_from_id := v_existing.machine_id;
      v_to_type := 'operator_bag'::public.inventory_entity_type;
      v_to_id := v_existing.operator_id;
      v_movement_reason := 'returned_from_machine'::public.movement_reason;
    end if;
    v_movement_key := 'route-inventory-adjustment:create:v2:' || v_submission_id;
    v_expected_payload := pg_catalog.jsonb_build_object(
      'contract_version', 2,
      'adjustment_id', v_existing.id,
      'client_submission_id', v_submission_id,
      'adjustment_type', v_existing.adjustment_type,
      'product_id', v_existing.product_id,
      'machine_id', v_existing.machine_id,
      'route_id', v_existing.route_id,
      'route_stop_id', v_existing.route_stop_id,
      'operator_id', v_existing.operator_id,
      'quantity', v_existing.quantity,
      'reason', v_existing.reason,
      'notes', v_existing.notes,
      'photo_url', v_existing.photo_url,
      'leg', case when v_existing.adjustment_type = 'damaged' then 'bag_to_waste' else 'machine_to_bag' end
    );
    v_movement_notes := pg_catalog.concat(
      case when v_existing.adjustment_type = 'damaged' then 'Damaged products' else 'Returned from machine' end,
      ': ', v_existing.reason,
      case when v_existing.notes is null then '' else ' - ' || v_existing.notes end
    );

    if v_movement.product_id is distinct from v_existing.product_id
      or v_movement.quantity is distinct from v_existing.quantity
      or v_movement.from_entity_type is distinct from v_from_type
      or v_movement.from_entity_id is distinct from v_from_id
      or v_movement.to_entity_type is distinct from v_to_type
      or v_movement.to_entity_id is distinct from v_to_id
      or v_movement.reason is distinct from v_movement_reason
      or v_movement.related_route_id is distinct from v_existing.route_id
      or v_movement.related_route_stop_id is distinct from v_existing.route_stop_id
      or v_movement.related_machine_id is distinct from v_existing.machine_id
      or v_movement.related_purchase_id is not null
      or v_movement.related_purchase_line_id is not null
      or v_movement.related_refill_order_id is not null
      or v_movement.related_pickup_batch_id is not null
      or v_movement.import_batch_id is not null
      or v_movement.historical_route_deduction_line_id is not null
      or v_movement.unit_cost_lyd is distinct from v_existing.unit_cost_lyd
      or v_movement.line_total_lyd is distinct from v_existing.total_cost_lyd
      or v_movement.reversed_movement_id is not null
      or v_movement.correction_reason is not null
      or v_movement.source_type is distinct from 'inventory_adjustment'
      or v_movement.source_id is distinct from v_existing.id
      or v_movement.notes is distinct from v_movement_notes
      or not (
        (v_movement.idempotency_key = v_movement_key
          and v_movement.idempotency_payload = v_expected_payload)
        or (v_movement.idempotency_key = v_submission_id
          and v_movement.idempotency_payload is null)
      )
    then
      raise exception 'Adjustment retry does not match its linked immutable ledger movement.' using errcode = '23514';
    end if;

    if v_existing.adjustment_type = 'returned_from_machine' then
      select movement.*
      into v_storage_movement
      from public.inventory_movements movement
      where movement.id = v_existing.storage_movement_id
      for update;
      v_storage_movement_key := 'route-inventory-adjustment:create:v2:' || v_submission_id || ':bag-to-storage';
      v_expected_storage_payload := v_expected_payload || pg_catalog.jsonb_build_object('leg', 'bag_to_storage');

      if not found
        or v_storage_movement.product_id is distinct from v_existing.product_id
        or v_storage_movement.quantity is distinct from v_existing.quantity
        or v_storage_movement.from_entity_type::text <> 'operator_bag'
        or v_storage_movement.from_entity_id is distinct from v_existing.operator_id
        or v_storage_movement.to_entity_type::text <> 'storage'
        or v_storage_movement.to_entity_id is distinct from v_storage_id
        or v_storage_movement.reason::text <> 'operator_bag_to_storage'
        or v_storage_movement.related_route_id is distinct from v_existing.route_id
        or v_storage_movement.related_route_stop_id is distinct from v_existing.route_stop_id
        or v_storage_movement.related_machine_id is distinct from v_existing.machine_id
        or v_storage_movement.related_purchase_id is not null
        or v_storage_movement.related_purchase_line_id is not null
        or v_storage_movement.related_refill_order_id is not null
        or v_storage_movement.related_pickup_batch_id is not null
        or v_storage_movement.import_batch_id is not null
        or v_storage_movement.historical_route_deduction_line_id is not null
        or v_storage_movement.unit_cost_lyd is distinct from v_existing.unit_cost_lyd
        or v_storage_movement.line_total_lyd is distinct from v_existing.total_cost_lyd
        or v_storage_movement.reversed_movement_id is not null
        or v_storage_movement.correction_reason is not null
        or v_storage_movement.source_type is distinct from 'inventory_adjustment'
        or v_storage_movement.source_id is distinct from v_existing.id
        or not (
          (v_storage_movement.idempotency_key = v_storage_movement_key
            and v_storage_movement.idempotency_payload = v_expected_storage_payload)
          or (v_storage_movement.idempotency_key = 'machine-return-storage:' || v_existing.id::text
            and v_storage_movement.idempotency_payload is null)
        )
      then
        raise exception 'Returned-product retry does not match its linked storage movement.' using errcode = '23514';
      end if;
    elsif v_existing.storage_movement_id is not null then
      raise exception 'Damaged adjustment unexpectedly links a storage movement. Stop and review it.' using errcode = '23514';
    end if;

    select pg_catalog.count(*)::integer
    into v_collision_count
    from public.inventory_movements movement
    where movement.id = v_existing.inventory_movement_id
      or movement.idempotency_key in (
        v_movement_key,
        v_storage_movement_key,
        v_submission_id,
        'machine-return-storage:' || v_existing.id::text
      )
      or (movement.source_type = 'inventory_adjustment' and movement.source_id = v_existing.id);
    if v_collision_count <> (
      case when v_existing.adjustment_type = 'returned_from_machine' then 2 else 1 end
    ) then
      raise exception 'Adjustment has an ambiguous ledger history. Stop and review it.' using errcode = '23514';
    end if;

    return query
    select
      adjustment.id,
      adjustment.adjustment_type,
      adjustment.product_id,
      adjustment.product_name,
      adjustment.machine_id,
      adjustment.location_id,
      adjustment.route_id,
      adjustment.route_stop_id,
      adjustment.operator_id,
      adjustment.quantity,
      adjustment.unit_cost_lyd,
      adjustment.total_cost_lyd,
      adjustment.reason,
      adjustment.notes,
      adjustment.photo_url,
      adjustment.status,
      adjustment.inventory_movement_id,
      adjustment.created_at,
      adjustment.updated_at
    from public.inventory_adjustments adjustment
    where adjustment.id = v_existing.id;
    return;
  end if;

  if v_route.status::text in (
    'completed', 'verified', 'payroll_pending', 'paid', 'disputed', 'reviewed', 'cancelled', 'canceled'
  ) then
    raise exception 'A terminal route cannot receive a new inventory adjustment. Use inventory review instead.' using errcode = '23514';
  end if;
  if v_stop.status::text in ('completed', 'skipped', 'cancelled', 'canceled') then
    raise exception 'A terminal route stop cannot receive a new inventory adjustment. Use inventory review instead.' using errcode = '23514';
  end if;
  if not coalesce(v_product.active, false) then
    raise exception 'Inactive products cannot be used in a new inventory adjustment.' using errcode = '23514';
  end if;

  if pg_catalog.to_regclass('public.operator_route_custody_leases') is not null then
    select exists (
      select 1
      from public.operator_route_custody_leases lease
      where lease.operator_id = v_route.operator_id
        and lease.route_id = p_route_id
    ) into v_has_custody_lease;
  end if;
  if not v_has_custody_lease then
    raise exception 'This route does not own the assigned operator bag custody. Pick up the route or resolve custody first.' using errcode = '23514';
  end if;

  select machine.location_id
  into v_location_id
  from public.machines machine
  where machine.id = v_stop.machine_id;
  if not found then
    raise exception 'Route stop machine not found.' using errcode = 'P0002';
  end if;

  if p_adjustment_type = 'damaged' then
    select coalesce(pg_catalog.sum(
      case
        when movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_route.operator_id then movement.quantity::bigint
        else 0::bigint
      end
      + case
        when movement.from_entity_type::text = 'operator_bag'
          and movement.from_entity_id = v_route.operator_id then -movement.quantity::bigint
        else 0::bigint
      end
    ), 0::bigint)
    into v_route_bag_qty
    from public.inventory_movements movement
    where movement.related_route_id = p_route_id
      and movement.product_id = p_product_id;

    select coalesce(pg_catalog.sum(leg.quantity_delta), 0::bigint)
    into v_global_bag_qty
    from (
      select movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = p_product_id
        and movement.to_entity_type::text = 'operator_bag'
        and movement.to_entity_id = v_route.operator_id
      union all
      select -movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = p_product_id
        and movement.from_entity_type::text = 'operator_bag'
        and movement.from_entity_id = v_route.operator_id
    ) leg;

    if v_route_bag_qty < p_quantity::bigint or v_global_bag_qty < p_quantity::bigint then
      raise exception 'Damaged quantity exceeds verified stock in this route operator bag.' using errcode = '23514';
    end if;
    v_from_type := 'operator_bag'::public.inventory_entity_type;
    v_from_id := v_route.operator_id;
    v_to_type := 'waste'::public.inventory_entity_type;
    v_to_id := null;
    v_movement_reason := 'damaged'::public.movement_reason;
  else
    select coalesce(pg_catalog.sum(
      case
        when movement.to_entity_type::text = 'machine'
          and movement.to_entity_id = v_stop.machine_id then movement.quantity::bigint
        else 0::bigint
      end
      + case
        when movement.from_entity_type::text = 'machine'
          and movement.from_entity_id = v_stop.machine_id then -movement.quantity::bigint
        else 0::bigint
      end
    ), 0::bigint)
    into v_machine_qty
    from public.inventory_movements movement
    where movement.product_id = p_product_id;

    if v_machine_qty < p_quantity::bigint then
      raise exception 'Returned quantity exceeds the verified machine stock for this product. No inventory was changed.' using errcode = '23514';
    end if;
    v_from_type := 'machine'::public.inventory_entity_type;
    v_from_id := v_stop.machine_id;
    v_to_type := 'operator_bag'::public.inventory_entity_type;
    v_to_id := v_route.operator_id;
    v_movement_reason := 'returned_from_machine'::public.movement_reason;
  end if;

  v_adjustment_id := coalesce(p_adjustment_id, gen_random_uuid());
  v_unit_cost := coalesce(
    nullif(v_product.average_cost_lyd, 0),
    nullif(v_product.last_purchase_cost_lyd, 0),
    nullif(v_product.current_cost_price_lyd, 0),
    nullif(v_product.cost_price, 0),
    0
  )::numeric(12,4);
  v_total_cost := pg_catalog.round((v_unit_cost * p_quantity)::numeric, 2);
  v_movement_key := 'route-inventory-adjustment:create:v2:' || v_submission_id;
  v_storage_movement_key := v_movement_key || ':bag-to-storage';
  v_expected_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'adjustment_id', v_adjustment_id,
    'client_submission_id', v_submission_id,
    'adjustment_type', p_adjustment_type,
    'product_id', p_product_id,
    'machine_id', p_machine_id,
    'route_id', p_route_id,
    'route_stop_id', p_route_stop_id,
    'operator_id', v_route.operator_id,
    'quantity', p_quantity,
    'reason', v_reason,
    'notes', v_notes,
    'photo_url', v_photo_url,
    'leg', case when p_adjustment_type = 'damaged' then 'bag_to_waste' else 'machine_to_bag' end
  );
  v_expected_storage_payload := v_expected_payload || pg_catalog.jsonb_build_object('leg', 'bag_to_storage');
  v_movement_notes := pg_catalog.concat(
    case when p_adjustment_type = 'damaged' then 'Damaged products' else 'Returned from machine' end,
    ': ', v_reason,
    case when v_notes is null then '' else ' - ' || v_notes end
  );

  -- Any pre-existing parent or ledger fragment is ambiguous. Never relink or
  -- silently reuse it because that can attach somebody else's stock movement.
  select pg_catalog.count(*)::integer
  into v_collision_count
  from public.inventory_movements movement
  where movement.idempotency_key in (
      v_movement_key,
      v_storage_movement_key,
      v_submission_id,
      'machine-return-storage:' || v_adjustment_id::text
    )
    or (movement.source_type = 'inventory_adjustment' and movement.source_id = v_adjustment_id);
  if v_collision_count <> 0 then
    raise exception 'A conflicting adjustment ledger fragment already exists. Stop and review it.' using errcode = '23514';
  end if;

  insert into public.inventory_adjustments (
    id,
    adjustment_type,
    product_id,
    product_name,
    machine_id,
    location_id,
    route_id,
    route_stop_id,
    operator_id,
    quantity,
    unit_cost_lyd,
    total_cost_lyd,
    reason,
    notes,
    photo_url,
    status,
    created_by_user_id,
    client_submission_id
  ) values (
    v_adjustment_id,
    p_adjustment_type,
    p_product_id,
    v_product.name,
    v_stop.machine_id,
    v_location_id,
    p_route_id,
    p_route_stop_id,
    v_route.operator_id,
    p_quantity,
    v_unit_cost,
    v_total_cost,
    v_reason,
    v_notes,
    v_photo_url,
    'confirmed',
    v_actor_user_id,
    v_submission_id
  );

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
    unit_cost_lyd,
    line_total_lyd,
    source_type,
    source_id,
    idempotency_key,
    idempotency_payload,
    created_by,
    notes
  ) values (
    p_product_id,
    p_quantity,
    v_from_type,
    v_from_id,
    v_to_type,
    v_to_id,
    v_movement_reason,
    p_route_id,
    p_route_stop_id,
    v_stop.machine_id,
    v_unit_cost,
    v_total_cost,
    'inventory_adjustment',
    v_adjustment_id,
    v_movement_key,
    v_expected_payload,
    v_actor_team_member_id,
    v_movement_notes
  )
  returning public.inventory_movements.id into v_movement_id;

  if p_adjustment_type = 'returned_from_machine' then
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
      unit_cost_lyd,
      line_total_lyd,
      source_type,
      source_id,
      idempotency_key,
      idempotency_payload,
      created_by,
      notes
    ) values (
      p_product_id,
      p_quantity,
      'operator_bag'::public.inventory_entity_type,
      v_route.operator_id,
      'storage'::public.inventory_entity_type,
      v_storage_id,
      'operator_bag_to_storage'::public.movement_reason,
      p_route_id,
      p_route_stop_id,
      v_stop.machine_id,
      v_unit_cost,
      v_total_cost,
      'inventory_adjustment',
      v_adjustment_id,
      v_storage_movement_key,
      v_expected_storage_payload,
      v_actor_team_member_id,
      pg_catalog.concat('Returned from machine and posted atomically to storage: ', v_reason)
    )
    returning public.inventory_movements.id into v_storage_movement_id;
  end if;

  update public.inventory_adjustments adjustment
  set inventory_movement_id = v_movement_id,
      storage_movement_id = v_storage_movement_id,
      updated_at = pg_catalog.now()
  where adjustment.id = v_adjustment_id
    and adjustment.status = 'confirmed'
    and adjustment.inventory_movement_id is null
    and adjustment.storage_movement_id is null;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'Adjustment movement link could not be committed atomically.' using errcode = '23514';
  end if;

  return query
  select
    adjustment.id,
    adjustment.adjustment_type,
    adjustment.product_id,
    adjustment.product_name,
    adjustment.machine_id,
    adjustment.location_id,
    adjustment.route_id,
    adjustment.route_stop_id,
    adjustment.operator_id,
    adjustment.quantity,
    adjustment.unit_cost_lyd,
    adjustment.total_cost_lyd,
    adjustment.reason,
    adjustment.notes,
    adjustment.photo_url,
    adjustment.status,
    adjustment.inventory_movement_id,
    adjustment.created_at,
    adjustment.updated_at
  from public.inventory_adjustments adjustment
  where adjustment.id = v_adjustment_id;
end;
$function$;

create or replace function public.cancel_inventory_adjustment(
  p_adjustment_id uuid,
  p_reason text default null
)
returns public.inventory_adjustments
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_reason_input text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_effective_reason text := coalesce(v_reason_input, 'Cancelled inventory adjustment');
  v_preflight public.inventory_adjustments%rowtype;
  v_adjustment public.inventory_adjustments%rowtype;
  v_route public.routes%rowtype;
  v_stop public.route_stops%rowtype;
  v_product public.products%rowtype;
  v_original public.inventory_movements%rowtype;
  v_storage_movement public.inventory_movements%rowtype;
  v_reversal public.inventory_movements%rowtype;
  v_storage_reversal public.inventory_movements%rowtype;
  v_storage_id uuid;
  v_has_custody_lease boolean := false;
  v_route_bag_qty bigint := 0;
  v_global_bag_qty bigint := 0;
  v_storage_on_hand bigint := 0;
  v_storage_reserved bigint := 0;
  v_reversal_count integer := 0;
  v_storage_reversal_count integer := 0;
  v_cancel_candidate_count integer := 0;
  v_updated_count integer := 0;
  v_reversal_key text;
  v_storage_reversal_key text;
  v_legacy_reversal_key text;
  v_reversal_notes text;
  v_storage_reversal_notes text;
  v_expected_payload jsonb;
  v_storage_expected_payload jsonb;
  v_original_expected_payload jsonb;
  v_original_key text;
  v_original_notes text;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to cancel an inventory adjustment.' using errcode = '42501';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only an owner or admin can cancel inventory adjustments.' using errcode = '42501';
  end if;
  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  if p_adjustment_id is null then
    raise exception 'Inventory adjustment is required.' using errcode = '22023';
  end if;
  if pg_catalog.length(v_effective_reason) > 2000 then
    raise exception 'Cancellation reason cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  -- Read only enough to derive the shared route mutex, then revalidate under it.
  select adjustment.*
  into v_preflight
  from public.inventory_adjustments adjustment
  where adjustment.id = p_adjustment_id;
  if not found then
    raise exception 'Inventory adjustment not found.' using errcode = 'P0002';
  end if;
  if v_preflight.route_id is null then
    raise exception 'Inventory adjustment has no route and cannot be cancelled safely.' using errcode = '23514';
  end if;
  if v_preflight.adjustment_type = 'returned_from_machine' then
    if v_preflight.storage_movement_id is null then
      raise exception 'Returned-product adjustment has no exact storage movement link. Use inventory review.' using errcode = '23514';
    end if;
    select movement.to_entity_id
    into v_storage_id
    from public.inventory_movements movement
    where movement.id = v_preflight.storage_movement_id;
    if not found or v_storage_id is null then
      raise exception 'Returned-product adjustment storage destination cannot be verified. Use inventory review.' using errcode = '23514';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || v_preflight.route_id::text, 0)
  );

  select route_row.*
  into v_route
  from public.routes route_row
  where route_row.id = v_preflight.route_id
  for update;
  if not found then
    raise exception 'Adjustment route not found.' using errcode = '23514';
  end if;

  if v_preflight.route_stop_id is null then
    raise exception 'Inventory adjustment has no route stop and cannot be cancelled safely.' using errcode = '23514';
  end if;
  select stop_row.*
  into v_stop
  from public.route_stops stop_row
  where stop_row.id = v_preflight.route_stop_id
  for update;
  if not found then
    raise exception 'Adjustment route stop not found.' using errcode = '23514';
  end if;

  if v_storage_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext(v_preflight.product_id::text),
      pg_catalog.hashtext(v_storage_id::text)
    );
  end if;

  select adjustment.*
  into v_adjustment
  from public.inventory_adjustments adjustment
  where adjustment.id = p_adjustment_id
  for update;
  if not found
    or v_adjustment.route_id is distinct from v_preflight.route_id
    or v_adjustment.route_stop_id is distinct from v_preflight.route_stop_id
    or v_adjustment.route_id is distinct from v_route.id
    or v_adjustment.route_stop_id is distinct from v_stop.id
    or v_adjustment.machine_id is distinct from v_stop.machine_id
    or v_adjustment.operator_id is distinct from v_route.operator_id
    or v_adjustment.product_id is null
    or v_adjustment.inventory_movement_id is null
    or v_adjustment.adjustment_type not in ('damaged', 'returned_from_machine')
    or (v_adjustment.adjustment_type = 'returned_from_machine' and v_adjustment.storage_movement_id is null)
    or (v_adjustment.adjustment_type = 'damaged' and v_adjustment.storage_movement_id is not null)
  then
    raise exception 'Inventory adjustment parent scope is inconsistent. Stop and review it.' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:operator-custody:' || v_adjustment.operator_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:operator-bag:' || v_adjustment.operator_id::text || ':' || v_adjustment.product_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:machine-stock:' || v_adjustment.machine_id::text || ':' || v_adjustment.product_id::text,
      0
    )
  );

  select product_row.*
  into v_product
  from public.products product_row
  where product_row.id = v_adjustment.product_id
  for update;
  if not found then
    raise exception 'Adjustment product not found.' using errcode = '23514';
  end if;

  select movement.*
  into v_original
  from public.inventory_movements movement
  where movement.id = v_adjustment.inventory_movement_id
  for update;
  if not found then
    raise exception 'Adjustment has no linked inventory movement. Stop and review it.' using errcode = '23514';
  end if;

  if v_adjustment.adjustment_type = 'returned_from_machine' then
    select movement.*
    into v_storage_movement
    from public.inventory_movements movement
    where movement.id = v_adjustment.storage_movement_id
    for update;
    if not found then
      raise exception 'Returned-product adjustment has no linked storage movement. Use inventory review.' using errcode = '23514';
    end if;
  else
    v_storage_movement.id := null;
  end if;

  if v_adjustment.adjustment_type = 'damaged' then
    if v_original.from_entity_type::text <> 'operator_bag'
      or v_original.from_entity_id is distinct from v_adjustment.operator_id
      or v_original.to_entity_type::text <> 'waste'
      or v_original.to_entity_id is not null
      or v_original.reason::text <> 'damaged'
    then
      raise exception 'Damaged adjustment movement is malformed. Stop and review it.' using errcode = '23514';
    end if;
  else
    if v_original.from_entity_type::text <> 'machine'
      or v_original.from_entity_id is distinct from v_adjustment.machine_id
      or v_original.to_entity_type::text <> 'operator_bag'
      or v_original.to_entity_id is distinct from v_adjustment.operator_id
      or v_original.reason::text <> 'returned_from_machine'
    then
      raise exception 'Returned-product adjustment movement is malformed. Stop and review it.' using errcode = '23514';
    end if;
  end if;

  if v_original.product_id is distinct from v_adjustment.product_id
    or v_original.quantity is distinct from v_adjustment.quantity
    or v_original.related_route_id is distinct from v_adjustment.route_id
    or v_original.related_route_stop_id is distinct from v_adjustment.route_stop_id
    or v_original.related_machine_id is distinct from v_adjustment.machine_id
    or v_original.related_purchase_id is not null
    or v_original.related_purchase_line_id is not null
    or v_original.related_refill_order_id is not null
    or v_original.related_pickup_batch_id is not null
    or v_original.import_batch_id is not null
    or v_original.historical_route_deduction_line_id is not null
    or v_original.unit_cost_lyd is distinct from v_adjustment.unit_cost_lyd
    or v_original.line_total_lyd is distinct from v_adjustment.total_cost_lyd
    or v_original.reversed_movement_id is not null
    or v_original.correction_reason is not null
    or v_original.source_type is distinct from 'inventory_adjustment'
    or v_original.source_id is distinct from v_adjustment.id
  then
    raise exception 'Inventory adjustment movement does not match its immutable parent. Stop and review it.' using errcode = '23514';
  end if;

  v_original_key := 'route-inventory-adjustment:create:v2:' || v_adjustment.client_submission_id;
  v_original_expected_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'adjustment_id', v_adjustment.id,
    'client_submission_id', v_adjustment.client_submission_id,
    'adjustment_type', v_adjustment.adjustment_type,
    'product_id', v_adjustment.product_id,
    'machine_id', v_adjustment.machine_id,
    'route_id', v_adjustment.route_id,
    'route_stop_id', v_adjustment.route_stop_id,
    'operator_id', v_adjustment.operator_id,
    'quantity', v_adjustment.quantity,
    'reason', v_adjustment.reason,
    'notes', v_adjustment.notes,
    'photo_url', v_adjustment.photo_url,
    'leg', case when v_adjustment.adjustment_type = 'damaged' then 'bag_to_waste' else 'machine_to_bag' end
  );
  v_original_notes := pg_catalog.concat(
    case when v_adjustment.adjustment_type = 'damaged' then 'Damaged products' else 'Returned from machine' end,
    ': ', v_adjustment.reason,
    case when v_adjustment.notes is null then '' else ' - ' || v_adjustment.notes end
  );
  if v_adjustment.client_submission_id is null
    or v_original.notes is distinct from v_original_notes
    or not (
      (v_original.idempotency_key = v_original_key
        and v_original.idempotency_payload = v_original_expected_payload)
      or (v_original.idempotency_key = v_adjustment.client_submission_id
        and v_original.idempotency_payload is null)
    )
  then
    raise exception 'Inventory adjustment movement has invalid idempotency provenance. Stop and review it.' using errcode = '23514';
  end if;

  if v_adjustment.adjustment_type = 'returned_from_machine' then
    v_storage_expected_payload := v_original_expected_payload || pg_catalog.jsonb_build_object('leg', 'bag_to_storage');
    if v_storage_movement.product_id is distinct from v_adjustment.product_id
      or v_storage_movement.quantity is distinct from v_adjustment.quantity
      or v_storage_movement.from_entity_type::text <> 'operator_bag'
      or v_storage_movement.from_entity_id is distinct from v_adjustment.operator_id
      or v_storage_movement.to_entity_type::text <> 'storage'
      or v_storage_movement.to_entity_id is distinct from v_storage_id
      or v_storage_movement.reason::text <> 'operator_bag_to_storage'
      or v_storage_movement.related_route_id is distinct from v_adjustment.route_id
      or v_storage_movement.related_route_stop_id is distinct from v_adjustment.route_stop_id
      or v_storage_movement.related_machine_id is distinct from v_adjustment.machine_id
      or v_storage_movement.related_purchase_id is not null
      or v_storage_movement.related_purchase_line_id is not null
      or v_storage_movement.related_refill_order_id is not null
      or v_storage_movement.related_pickup_batch_id is not null
      or v_storage_movement.import_batch_id is not null
      or v_storage_movement.historical_route_deduction_line_id is not null
      or v_storage_movement.unit_cost_lyd is distinct from v_adjustment.unit_cost_lyd
      or v_storage_movement.line_total_lyd is distinct from v_adjustment.total_cost_lyd
      or v_storage_movement.reversed_movement_id is not null
      or v_storage_movement.correction_reason is not null
      or v_storage_movement.source_type is distinct from 'inventory_adjustment'
      or v_storage_movement.source_id is distinct from v_adjustment.id
      or not (
        (v_storage_movement.idempotency_key = 'route-inventory-adjustment:create:v2:' || v_adjustment.client_submission_id || ':bag-to-storage'
          and v_storage_movement.idempotency_payload = v_storage_expected_payload)
        or (v_storage_movement.idempotency_key = 'machine-return-storage:' || v_adjustment.id::text
          and v_storage_movement.idempotency_payload is null)
      )
    then
      raise exception 'Returned-product storage movement does not match its immutable parent. Use inventory review.' using errcode = '23514';
    end if;
  end if;

  v_reversal_key := 'route-inventory-adjustment:cancel:v2:' || p_adjustment_id::text || ':primary';
  v_storage_reversal_key := 'route-inventory-adjustment:cancel:v2:' || p_adjustment_id::text || ':storage';
  v_legacy_reversal_key := 'inventory-adjustment-cancel:' || p_adjustment_id::text;
  v_expected_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'adjustment_id', p_adjustment_id,
    'original_movement_id', v_original.id,
    'reason', v_effective_reason,
    'leg', 'primary'
  );
  v_storage_expected_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'adjustment_id', p_adjustment_id,
    'original_movement_id', v_storage_movement.id,
    'reason', v_effective_reason,
    'leg', 'storage'
  );
  v_reversal_notes := pg_catalog.concat(
    'Cancelled inventory adjustment ', pg_catalog.left(p_adjustment_id::text, 8), ': ', v_effective_reason
  );
  v_storage_reversal_notes := pg_catalog.concat(
    'Cancelled returned-product storage posting ', pg_catalog.left(p_adjustment_id::text, 8), ': ', v_effective_reason
  );

  -- Lock every candidate reversal deterministically before deciding replay/new.
  perform 1
  from public.inventory_movements movement
  where movement.reversed_movement_id in (v_original.id, v_storage_movement.id)
    or movement.idempotency_key in (v_reversal_key, v_storage_reversal_key, v_legacy_reversal_key)
    or (movement.source_type = 'inventory_adjustment_cancel' and movement.source_id = p_adjustment_id)
  order by movement.id
  for update;

  select pg_catalog.count(*)::integer
  into v_reversal_count
  from public.inventory_movements movement
  where movement.reversed_movement_id = v_original.id
    or movement.idempotency_key in (v_reversal_key, v_legacy_reversal_key);

  if v_reversal_count = 1 then
    select movement.*
    into v_reversal
    from public.inventory_movements movement
    where movement.reversed_movement_id = v_original.id
      or movement.idempotency_key in (v_reversal_key, v_legacy_reversal_key)
    order by movement.id
    limit 1;
  elsif v_reversal_count > 1 then
    raise exception 'Inventory adjustment has ambiguous cancellation movements. Stop and review it.' using errcode = '23514';
  else
    v_reversal.id := null;
  end if;

  if v_adjustment.adjustment_type = 'returned_from_machine' then
    select pg_catalog.count(*)::integer
    into v_storage_reversal_count
    from public.inventory_movements movement
    where movement.reversed_movement_id = v_storage_movement.id
      or movement.idempotency_key = v_storage_reversal_key;

    if v_storage_reversal_count = 1 then
      select movement.*
      into v_storage_reversal
      from public.inventory_movements movement
      where movement.reversed_movement_id = v_storage_movement.id
        or movement.idempotency_key = v_storage_reversal_key
      order by movement.id
      limit 1;
    elsif v_storage_reversal_count > 1 then
      raise exception 'Returned-product adjustment has ambiguous storage reversals. Use inventory review.' using errcode = '23514';
    else
      v_storage_reversal.id := null;
    end if;
  else
    v_storage_reversal.id := null;
  end if;

  select pg_catalog.count(*)::integer
  into v_cancel_candidate_count
  from public.inventory_movements movement
  where movement.reversed_movement_id in (v_original.id, v_storage_movement.id)
    or movement.idempotency_key in (v_reversal_key, v_storage_reversal_key, v_legacy_reversal_key)
    or (movement.source_type = 'inventory_adjustment_cancel' and movement.source_id = p_adjustment_id);

  -- Exact cancellation replay is accepted even if the route later became
  -- terminal, but the parent and signed reversal must both remain exact.
  if v_adjustment.status = 'cancelled' then
    if v_cancel_candidate_count <> (
        case when v_adjustment.adjustment_type = 'returned_from_machine' then 2 else 1 end
      )
      or v_adjustment.cancellation_reason is distinct from v_effective_reason
      or v_adjustment.cancelled_at is null
      or v_adjustment.cancelled_by_user_id is null
      or v_reversal.id is null
      or v_adjustment.inventory_reversal_movement_id is distinct from v_reversal.id
      or v_reversal.product_id is distinct from v_original.product_id
      or v_reversal.quantity is distinct from v_original.quantity
      or v_reversal.from_entity_type is distinct from v_original.to_entity_type
      or v_reversal.from_entity_id is distinct from v_original.to_entity_id
      or v_reversal.to_entity_type is distinct from v_original.from_entity_type
      or v_reversal.to_entity_id is distinct from v_original.from_entity_id
      or v_reversal.reason::text <> 'manual_correction'
      or v_reversal.related_route_id is distinct from v_original.related_route_id
      or v_reversal.related_route_stop_id is distinct from v_original.related_route_stop_id
      or v_reversal.related_machine_id is distinct from v_original.related_machine_id
      or v_reversal.related_purchase_id is distinct from v_original.related_purchase_id
      or v_reversal.related_purchase_line_id is distinct from v_original.related_purchase_line_id
      or v_reversal.related_refill_order_id is distinct from v_original.related_refill_order_id
      or v_reversal.related_pickup_batch_id is distinct from v_original.related_pickup_batch_id
      or v_reversal.import_batch_id is distinct from v_original.import_batch_id
      or v_reversal.historical_route_deduction_line_id is distinct from v_original.historical_route_deduction_line_id
      or v_reversal.unit_cost_lyd is distinct from v_original.unit_cost_lyd
      or v_reversal.line_total_lyd is distinct from -v_original.line_total_lyd
      or v_reversal.reversed_movement_id is distinct from v_original.id
      or v_reversal.correction_reason is distinct from v_effective_reason
      or v_reversal.source_type is distinct from 'inventory_adjustment_cancel'
      or v_reversal.source_id is distinct from p_adjustment_id
      or v_reversal.notes is distinct from v_reversal_notes
      or not (
        (v_reversal.idempotency_key = v_reversal_key
          and v_reversal.idempotency_payload = v_expected_payload)
        or (v_reversal.idempotency_key = v_legacy_reversal_key
          and v_reversal.idempotency_payload is null)
      )
      or (
        v_adjustment.adjustment_type = 'damaged'
        and (
          v_adjustment.storage_reversal_movement_id is not null
          or v_storage_reversal.id is not null
        )
      )
      or (
        v_adjustment.adjustment_type = 'returned_from_machine'
        and (
          v_storage_reversal.id is null
          or v_adjustment.storage_reversal_movement_id is distinct from v_storage_reversal.id
          or v_storage_reversal.product_id is distinct from v_storage_movement.product_id
          or v_storage_reversal.quantity is distinct from v_storage_movement.quantity
          or v_storage_reversal.from_entity_type is distinct from v_storage_movement.to_entity_type
          or v_storage_reversal.from_entity_id is distinct from v_storage_movement.to_entity_id
          or v_storage_reversal.to_entity_type is distinct from v_storage_movement.from_entity_type
          or v_storage_reversal.to_entity_id is distinct from v_storage_movement.from_entity_id
          or v_storage_reversal.reason::text <> 'manual_correction'
          or v_storage_reversal.related_route_id is distinct from v_storage_movement.related_route_id
          or v_storage_reversal.related_route_stop_id is distinct from v_storage_movement.related_route_stop_id
          or v_storage_reversal.related_machine_id is distinct from v_storage_movement.related_machine_id
          or v_storage_reversal.related_purchase_id is distinct from v_storage_movement.related_purchase_id
          or v_storage_reversal.related_purchase_line_id is distinct from v_storage_movement.related_purchase_line_id
          or v_storage_reversal.related_refill_order_id is distinct from v_storage_movement.related_refill_order_id
          or v_storage_reversal.related_pickup_batch_id is distinct from v_storage_movement.related_pickup_batch_id
          or v_storage_reversal.import_batch_id is distinct from v_storage_movement.import_batch_id
          or v_storage_reversal.historical_route_deduction_line_id is distinct from v_storage_movement.historical_route_deduction_line_id
          or v_storage_reversal.unit_cost_lyd is distinct from v_storage_movement.unit_cost_lyd
          or v_storage_reversal.line_total_lyd is distinct from -v_storage_movement.line_total_lyd
          or v_storage_reversal.reversed_movement_id is distinct from v_storage_movement.id
          or v_storage_reversal.correction_reason is distinct from v_effective_reason
          or v_storage_reversal.source_type is distinct from 'inventory_adjustment_cancel'
          or v_storage_reversal.source_id is distinct from p_adjustment_id
          or v_storage_reversal.notes is distinct from v_storage_reversal_notes
          or v_storage_reversal.idempotency_key is distinct from v_storage_reversal_key
          or v_storage_reversal.idempotency_payload is distinct from v_storage_expected_payload
        )
      )
    then
      raise exception 'Cancelled adjustment replay does not match its immutable reversal. Stop and review it.' using errcode = '23514';
    end if;
    return v_adjustment;
  end if;

  if v_adjustment.status <> 'confirmed' then
    raise exception 'Only a confirmed inventory adjustment can be cancelled.' using errcode = '23514';
  end if;
  if v_cancel_candidate_count <> 0
    or v_reversal.id is not null
    or v_storage_reversal.id is not null
  then
    raise exception 'A cancellation movement exists without a matching cancelled parent. Stop and review it.' using errcode = '23514';
  end if;
  if v_route.status::text in (
    'completed', 'verified', 'payroll_pending', 'paid', 'disputed', 'reviewed', 'cancelled', 'canceled'
  ) or v_stop.status::text in ('completed', 'skipped', 'cancelled', 'canceled') then
    raise exception 'Terminal route history cannot be changed here. Use inventory review instead.' using errcode = '23514';
  end if;

  if pg_catalog.to_regclass('public.operator_route_custody_leases') is not null then
    select exists (
      select 1
      from public.operator_route_custody_leases lease
      where lease.operator_id = v_adjustment.operator_id
        and lease.route_id = v_adjustment.route_id
    ) into v_has_custody_lease;
  end if;
  if not v_has_custody_lease then
    raise exception 'This route no longer owns operator bag custody. Use inventory review instead.' using errcode = '23514';
  end if;

  -- A returned product was credited to storage. Reversing that leg is a real
  -- storage debit, so preserve both physical stock and active reservations.
  if v_adjustment.adjustment_type = 'returned_from_machine' then
    select coalesce(inventory.quantity, 0)::bigint
    into v_storage_on_hand
    from public.current_inventory_by_location inventory
    where inventory.storage_location_id = v_storage_id
      and inventory.product_id = v_adjustment.product_id;
    if not found then
      v_storage_on_hand := 0;
    end if;

    select coalesce(pg_catalog.sum(
      greatest(
        coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0),
        0
      )::bigint
    ), 0::bigint)
    into v_storage_reserved
    from public.route_stock_lines stock_line
    join public.routes reserved_route on reserved_route.id = stock_line.route_id
    where stock_line.product_id = v_adjustment.product_id
      and reserved_route.status::text in (
        'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready',
        'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'
      );

    if v_storage_on_hand < v_adjustment.quantity::bigint then
      raise exception 'Cancellation would exceed physical storage stock. Use inventory review instead.' using errcode = '23514';
    end if;
    if v_storage_on_hand - v_storage_reserved < v_adjustment.quantity::bigint then
      raise exception 'Cancellation would consume stock reserved for active routes. Use inventory review instead.' using errcode = '23514';
    end if;
  end if;

  if v_adjustment.adjustment_type = 'returned_from_machine' then
    -- Reverse storage -> bag first, then bag -> machine below. The bag never
    -- becomes negative at a statement boundary and both legs roll back together.
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
      related_purchase_id,
      related_purchase_line_id,
      related_machine_id,
      related_refill_order_id,
      related_pickup_batch_id,
      import_batch_id,
      historical_route_deduction_line_id,
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
    ) values (
      v_storage_movement.product_id,
      v_storage_movement.quantity,
      v_storage_movement.to_entity_type,
      v_storage_movement.to_entity_id,
      v_storage_movement.from_entity_type,
      v_storage_movement.from_entity_id,
      'manual_correction'::public.movement_reason,
      v_storage_movement.related_route_id,
      v_storage_movement.related_route_stop_id,
      v_storage_movement.related_purchase_id,
      v_storage_movement.related_purchase_line_id,
      v_storage_movement.related_machine_id,
      v_storage_movement.related_refill_order_id,
      v_storage_movement.related_pickup_batch_id,
      v_storage_movement.import_batch_id,
      v_storage_movement.historical_route_deduction_line_id,
      v_storage_movement.unit_cost_lyd,
      -v_storage_movement.line_total_lyd,
      v_storage_movement.id,
      v_effective_reason,
      'inventory_adjustment_cancel',
      p_adjustment_id,
      v_storage_reversal_key,
      v_storage_expected_payload,
      v_actor_team_member_id,
      v_storage_reversal_notes
    )
    returning * into v_storage_reversal;
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
    related_route_stop_id,
    related_purchase_id,
    related_purchase_line_id,
    related_machine_id,
    related_refill_order_id,
    related_pickup_batch_id,
    import_batch_id,
    historical_route_deduction_line_id,
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
  ) values (
    v_original.product_id,
    v_original.quantity,
    v_original.to_entity_type,
    v_original.to_entity_id,
    v_original.from_entity_type,
    v_original.from_entity_id,
    'manual_correction'::public.movement_reason,
    v_original.related_route_id,
    v_original.related_route_stop_id,
    v_original.related_purchase_id,
    v_original.related_purchase_line_id,
    v_original.related_machine_id,
    v_original.related_refill_order_id,
    v_original.related_pickup_batch_id,
    v_original.import_batch_id,
    v_original.historical_route_deduction_line_id,
    v_original.unit_cost_lyd,
    -v_original.line_total_lyd,
    v_original.id,
    v_effective_reason,
    'inventory_adjustment_cancel',
    p_adjustment_id,
    v_reversal_key,
    v_expected_payload,
    v_actor_team_member_id,
    v_reversal_notes
  )
  returning * into v_reversal;

  update public.inventory_adjustments adjustment
  set status = 'cancelled',
      cancellation_reason = v_effective_reason,
      cancelled_at = pg_catalog.now(),
      cancelled_by_user_id = v_actor_user_id,
      inventory_reversal_movement_id = v_reversal.id,
      storage_reversal_movement_id = v_storage_reversal.id,
      updated_at = pg_catalog.now()
  where adjustment.id = p_adjustment_id
    and adjustment.status = 'confirmed'
    and adjustment.inventory_movement_id = v_original.id
    and adjustment.inventory_reversal_movement_id is null
    and adjustment.storage_reversal_movement_id is null
  returning * into v_adjustment;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'Adjustment cancellation parent could not be committed atomically.' using errcode = '23514';
  end if;

  return v_adjustment;
end;
$function$;

-- Parent rows are written only by the two hardened RPCs. Callers may still
-- read permitted rows through existing RLS policies.
revoke all on table public.inventory_adjustments from public, anon, authenticated;
grant select on table public.inventory_adjustments to authenticated;
grant all on table public.inventory_adjustments to service_role;

revoke all on function public.create_route_inventory_adjustment(
  uuid, text, uuid, uuid, uuid, uuid, integer, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_route_inventory_adjustment(
  uuid, text, uuid, uuid, uuid, uuid, integer, text, text, text, text
) to authenticated, service_role;

revoke all on function public.cancel_inventory_adjustment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_inventory_adjustment(uuid, text)
  to authenticated, service_role;

-- Stop inventory previously trusted actor UUIDs supplied by a service-role
-- caller. Keep the already-audited ledger implementation private and expose an
-- authenticated wrapper that derives both identities from the JWT instead.
do $migration$
begin
  if pg_catalog.to_regprocedure(
    'public.snacky_commit_route_stop_inventory_v1(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb)'
  ) is not null then
    alter function public.snacky_commit_route_stop_inventory_v1(
      uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb
    ) rename to snacky_commit_route_stop_inventory_v1_private;
  end if;

  if pg_catalog.to_regprocedure(
    'public.snacky_commit_route_stop_inventory_v1_private(uuid,uuid,uuid,uuid,uuid,text,jsonb,jsonb)'
  ) is not null then
    revoke all on function public.snacky_commit_route_stop_inventory_v1_private(
      uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb
    ) from public, anon, authenticated, service_role;
  end if;
end;
$migration$;

create or replace function public.snacky_commit_route_stop_inventory_v1(
  p_route_id uuid,
  p_route_stop_id uuid,
  p_machine_id uuid,
  p_submission_id text,
  p_fill_lines jsonb,
  p_machine_storage_lines jsonb
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
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to commit route stop inventory.' using errcode = '42501';
  end if;
  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;

  return public.snacky_commit_route_stop_inventory_v1_private(
    p_route_id,
    p_route_stop_id,
    p_machine_id,
    v_actor_user_id,
    v_actor_team_member_id,
    p_submission_id,
    p_fill_lines,
    p_machine_storage_lines
  );
end;
$function$;

revoke all on function public.snacky_commit_route_stop_inventory_v1(
  uuid, uuid, uuid, text, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.snacky_commit_route_stop_inventory_v1(
  uuid, uuid, uuid, text, jsonb, jsonb
) to authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');
