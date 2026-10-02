-- Route-side sales and customer compensation are inventory events, not a
-- parent row followed by a best-effort ledger write. Keep each business event,
-- its operator-bag movement, and the parent link in one database transaction.

alter table public.route_manual_sales
  add column if not exists needs_review boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists created_by_team_member_id uuid references public.team_members(id) on delete set null,
  add column if not exists cancelled_by_team_member_id uuid references public.team_members(id) on delete set null,
  add column if not exists inventory_reversal_movement_id uuid references public.inventory_movements(id) on delete set null;

alter table public.route_customer_compensations
  add column if not exists created_by_team_member_id uuid references public.team_members(id) on delete set null;

-- Preserve the authenticated actor separately from the route's assigned
-- operator. A manager can perform an action for an operator's route; the bag
-- endpoint remains the operator while the audit actor remains the manager.
update public.route_manual_sales sale_row
set created_by_team_member_id = profile_row.team_member_id
from public.profiles profile_row
where sale_row.created_by_team_member_id is null
  and sale_row.created_by_user_id = profile_row.id
  and profile_row.team_member_id is not null;

update public.route_manual_sales sale_row
set cancelled_by_team_member_id = profile_row.team_member_id
from public.profiles profile_row
where sale_row.cancelled_by_team_member_id is null
  and sale_row.cancelled_by_user_id = profile_row.id
  and profile_row.team_member_id is not null;

update public.route_customer_compensations compensation_row
set created_by_team_member_id = profile_row.team_member_id
from public.profiles profile_row
where compensation_row.created_by_team_member_id is null
  and compensation_row.created_by_user_id = profile_row.id
  and profile_row.team_member_id is not null;

create unique index if not exists idx_route_manual_sales_inventory_reversal
  on public.route_manual_sales (inventory_reversal_movement_id)
  where inventory_reversal_movement_id is not null;

-- XY-synced machines can legitimately have no internal location mapping yet.
-- The machine and route/stop links remain authoritative, so do not block the
-- business event while that optional mapping is completed.
alter table public.route_manual_sales
  alter column location_id drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_manual_sales'::pg_catalog.regclass
      and constraint_row.conname = 'route_manual_sales_review_reason_required'
  ) then
    alter table public.route_manual_sales
      add constraint route_manual_sales_review_reason_required
      check (
        not needs_review
        or nullif(pg_catalog.btrim(coalesce(review_reason, '')), '') is not null
      ) not valid;
  end if;
end
$$;

-- Surface legacy product-backed parents that were committed without a ledger
-- child. There is no trustworthy way to infer when or whether stock moved, so
-- never manufacture history during deployment; put every orphan in the
-- durable review queue instead. Productless sales intentionally have no child.
update public.route_manual_sales sale_row
set needs_review = true,
    review_reason = coalesce(
      nullif(pg_catalog.btrim(sale_row.review_reason), ''),
      'Legacy manual sale has no linked inventory movement. Inventory was not changed; reconcile this event from physical evidence.'
    )
where sale_row.product_id is not null
  and sale_row.inventory_movement_id is null
  and not sale_row.needs_review;

-- A cancelled legacy parent is trustworthy only when it owns one exact,
-- actor-bound reversal receipt. Never attach or manufacture a historical
-- movement during deployment: missing, ambiguous, or malformed history is a
-- durable review item. This also catches reversals whose quantity/endpoints
-- look right but whose cost direction is wrong.
update public.route_manual_sales sale_row
set needs_review = true,
    review_reason = 'Legacy cancelled manual sale has a missing, ambiguous, or non-exact inventory reversal. Inventory was not changed; reconcile this event from physical evidence.'
where sale_row.status::text = 'cancelled'
  and sale_row.product_id is not null
  and (
    sale_row.inventory_movement_id is null
    or sale_row.inventory_reversal_movement_id is null
    or (
      select pg_catalog.count(*)
      from public.inventory_movements candidate
      where candidate.reversed_movement_id = sale_row.inventory_movement_id
        or candidate.idempotency_key = 'route-manual-sale-cancel:'
          || sale_row.route_id::text || ':'
          || sale_row.route_stop_id::text || ':'
          || sale_row.id::text
        or (
          candidate.source_type = 'route_manual_sale_cancel'
          and candidate.source_id = sale_row.id
        )
    ) <> 1
    or not exists (
      select 1
      from public.inventory_movements original
      join public.inventory_movements reversal
        on reversal.id = sale_row.inventory_reversal_movement_id
      where original.id = sale_row.inventory_movement_id
        and reversal.reversed_movement_id = original.id
        and reversal.idempotency_key = 'route-manual-sale-cancel:'
          || sale_row.route_id::text || ':'
          || sale_row.route_stop_id::text || ':'
          || sale_row.id::text
        and reversal.source_type = 'route_manual_sale_cancel'
        and reversal.source_id = sale_row.id
        and reversal.product_id = original.product_id
        and reversal.quantity = original.quantity
        and reversal.from_entity_type::text = original.to_entity_type::text
        and reversal.from_entity_id is not distinct from original.to_entity_id
        and reversal.to_entity_type::text = original.from_entity_type::text
        and reversal.to_entity_id is not distinct from original.from_entity_id
        and reversal.unit_cost_lyd is not distinct from original.unit_cost_lyd
        and reversal.line_total_lyd is not distinct from case
          when original.line_total_lyd is null then null
          else -original.line_total_lyd
        end
        and reversal.created_by is not distinct from sale_row.cancelled_by_team_member_id
    )
  );

create index if not exists idx_route_manual_sales_needs_review
  on public.route_manual_sales (route_id, sale_time desc)
  where needs_review;

-- This existing audit trigger inherited the caller's search_path and used
-- unqualified relations. Every protected ledger writer correctly pins an
-- empty search_path, which made the trigger fail with `team_members does not
-- exist` and rolled back the movement. Keep it invoker-scoped, but qualify all
-- relations and built-ins so atomic ledger functions can actually execute.
create or replace function public.log_inventory_movement_activity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  activity_actor_user_id uuid;
  activity_actor_name text;
  activity_actor_role text;
begin
  if new.created_by is not null then
    select
      profile_row.id,
      coalesce(team_row.full_name, profile_row.full_name),
      coalesce(team_row.role::text, profile_row.role::text)
    into activity_actor_user_id, activity_actor_name, activity_actor_role
    from public.team_members team_row
    left join public.profiles profile_row on profile_row.team_member_id = team_row.id
    where team_row.id = new.created_by
    order by profile_row.created_at nulls last
    limit 1;
  end if;

  insert into public.system_activity_logs (
    actor_user_id,
    actor_team_member_id,
    actor_name,
    actor_role,
    action,
    entity_type,
    entity_id,
    entity_label,
    summary,
    after_data,
    metadata
  ) values (
    activity_actor_user_id,
    new.created_by,
    activity_actor_name,
    activity_actor_role,
    'create_inventory_movement',
    'inventory_movement',
    new.id,
    pg_catalog.concat(pg_catalog.replace(new.reason::text, '_', ' '), ' ', new.quantity::text),
    pg_catalog.concat('Created ', pg_catalog.replace(new.reason::text, '_', ' '), ' movement for ', new.quantity::text, ' units'),
    pg_catalog.to_jsonb(new),
    pg_catalog.jsonb_build_object(
      'product_id', new.product_id,
      'quantity', new.quantity,
      'from_entity_type', new.from_entity_type,
      'from_entity_id', new.from_entity_id,
      'to_entity_type', new.to_entity_type,
      'to_entity_id', new.to_entity_id,
      'movement_reason', new.reason,
      'related_route_id', new.related_route_id,
      'related_route_stop_id', new.related_route_stop_id,
      'related_purchase_id', new.related_purchase_id,
      'related_purchase_line_id', new.related_purchase_line_id,
      'related_machine_id', new.related_machine_id,
      'reversed_movement_id', new.reversed_movement_id,
      'import_batch_id', new.import_batch_id,
      'historical_route_deduction_line_id', new.historical_route_deduction_line_id,
      'original_text', new.original_text
    )
  );

  return new;
end;
$function$;

revoke all on function public.log_inventory_movement_activity()
  from public, anon, authenticated;

-- Direct Data API writes could bypass the parent/ledger transaction. Remove
-- every inherited/public table capability (including DELETE, TRUNCATE,
-- REFERENCES, TRIGGER, and MAINTAIN), then restore authenticated read-only
-- access. Protected RPCs own all business writes; service-role maintenance
-- retains its explicit administrative access.
revoke all on table public.route_manual_sales from public, anon, authenticated;
grant select on table public.route_manual_sales to authenticated;
grant all on table public.route_manual_sales to service_role;

revoke all on table public.route_customer_compensations from public, anon, authenticated;
grant select on table public.route_customer_compensations to authenticated;
grant all on table public.route_customer_compensations to service_role;

create or replace function public.snacky_create_route_manual_sale_v1(
  p_route_id uuid,
  p_route_stop_id uuid,
  p_machine_id uuid,
  p_product_id uuid,
  p_product_name text,
  p_quantity integer,
  p_unit_sale_price_lyd numeric,
  p_payment_method text,
  p_notes text,
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
  v_is_manager boolean := false;
  v_route public.routes%rowtype;
  v_stop public.route_stops%rowtype;
  v_machine public.machines%rowtype;
  v_product record;
  v_sale public.route_manual_sales%rowtype;
  v_movement public.inventory_movements%rowtype;
  v_operator_id uuid;
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_fallback_product_name text := nullif(pg_catalog.btrim(coalesce(p_product_name, '')), '');
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_payment_method text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_payment_method, '')));
  v_unit_sale_price numeric(12,2);
  v_product_name text;
  v_unit_cost numeric(12,4) := 0;
  v_route_bag_qty bigint;
  v_global_bag_qty bigint;
  v_expected_movement_key text;
  v_expected_movement_payload jsonb;
  v_review_reason text;
  v_movement_created boolean := false;
  v_movement_recovered boolean := false;
  v_has_custody_lease boolean := true;
  v_updated_count integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to save a manual sale.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  v_is_manager := public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);

  if p_route_id is null or p_route_stop_id is null or p_machine_id is null then
    raise exception 'Route, stop, and machine are required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'Quantity must be greater than 0.' using errcode = '23514';
  end if;
  -- Only a productless/free-text sale needs an explicit operator-entered
  -- amount. Catalog-backed prices are authoritative product data and are read
  -- below while this transaction holds the route lock; never trust the API's
  -- suggested/displayed price for the recorded financial event.
  if p_product_id is null then
    if p_unit_sale_price_lyd is null
      or p_unit_sale_price_lyd <= 0
      or p_unit_sale_price_lyd >= 10000000000
    then
      raise exception 'A productless sale requires a unit price greater than 0 that fits the LYD amount field.' using errcode = '23514';
    end if;
    v_unit_sale_price := pg_catalog.round(p_unit_sale_price_lyd, 2)::numeric(12,2);
  end if;
  if v_payment_method not in ('cash', 'card', 'other') then
    raise exception 'Payment method must be cash, card, or other.' using errcode = '22023';
  end if;
  if p_product_id is null and v_fallback_product_name is null then
    raise exception 'Choose a product or provide a product name.' using errcode = '22023';
  end if;
  if pg_catalog.length(coalesce(v_fallback_product_name, '')) > 500 then
    raise exception 'Product name cannot exceed 500 characters.' using errcode = '22023';
  end if;
  if pg_catalog.length(coalesce(v_notes, '')) > 2000 then
    raise exception 'Manual sale notes cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  -- Canonical lock order: route row, stop row, operator custody, product bag.
  -- The route lock serializes sales, compensation, stop completion, and route
  -- finalization. It is deliberately acquired before reading an old parent.
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
    and stop_row.route_id = p_route_id
  for update;

  if not found then
    raise exception 'The selected stop does not belong to this route.' using errcode = '23503';
  end if;
  if v_stop.machine_id is distinct from p_machine_id then
    raise exception 'This manual sale does not match the selected stop machine.' using errcode = '23514';
  end if;

  select machine_row.*
  into v_machine
  from public.machines machine_row
  where machine_row.id = v_stop.machine_id
  for share;

  if not found then
    raise exception 'The stop machine was not found.' using errcode = '23503';
  end if;
  -- Lost-response retries remain valid even after the stop or route becomes
  -- terminal. Validate the complete client-owned payload before lifecycle
  -- rejection. Dynamic product names, costs, route assignment, and location
  -- are intentionally not replay inputs because they can change later.
  select sale_row.*
  into v_sale
  from public.route_manual_sales sale_row
  where sale_row.client_submission_id = v_submission_id
  for update;

  if found then
    if v_sale.route_id is distinct from p_route_id
      or v_sale.route_stop_id is distinct from p_route_stop_id
      or v_sale.machine_id is distinct from p_machine_id
      or v_sale.product_id is distinct from p_product_id
      or (p_product_id is null and v_sale.product_name is distinct from v_fallback_product_name)
      or v_sale.quantity is distinct from p_quantity
      or (
        p_product_id is null
        and v_sale.unit_sale_price_lyd is distinct from v_unit_sale_price
      )
      or v_sale.payment_method is distinct from v_payment_method
      or nullif(pg_catalog.btrim(coalesce(v_sale.notes, '')), '') is distinct from v_notes
      or v_sale.client_submission_id is distinct from v_submission_id
      or v_sale.created_by_user_id is distinct from v_actor_user_id
      or v_sale.created_by_team_member_id is distinct from v_actor_team_member_id
    then
      raise exception 'This manual-sale submission id was already used with a different immutable payload.' using errcode = '23505';
    end if;

    if v_sale.product_id is null then
      if v_sale.inventory_movement_id is not null then
        raise exception 'A productless manual sale cannot own an inventory movement.' using errcode = '23514';
      end if;
    else
      v_expected_movement_key := 'route-manual-sale:'
        || v_sale.route_id::text || ':' || v_sale.route_stop_id::text || ':'
        || v_sale.id::text || ':' || v_sale.product_id::text || ':'
        || v_sale.operator_id::text || ':' || v_sale.quantity::text;
      v_expected_movement_payload := pg_catalog.jsonb_build_object(
        'contract_version', 2,
        'event_type', 'route_manual_sale',
        'sale_id', v_sale.id,
        'client_submission_id', v_sale.client_submission_id,
        'actor_user_id', v_sale.created_by_user_id,
        'actor_team_member_id', v_sale.created_by_team_member_id,
        'route_id', v_sale.route_id,
        'route_stop_id', v_sale.route_stop_id,
        'machine_id', v_sale.machine_id,
        'operator_id', v_sale.operator_id,
        'product_id', v_sale.product_id,
        'product_name', v_sale.product_name,
        'quantity', v_sale.quantity,
        'unit_sale_price_lyd', v_sale.unit_sale_price_lyd,
        'payment_method', v_sale.payment_method,
        'notes', nullif(pg_catalog.btrim(coalesce(v_sale.notes, '')), '')
      );

      if v_sale.inventory_movement_id is not null then
        select movement_row.*
        into v_movement
        from public.inventory_movements movement_row
        where movement_row.id = v_sale.inventory_movement_id;
      elsif not v_sale.needs_review then
        select movement_row.*
        into v_movement
        from public.inventory_movements movement_row
        where movement_row.idempotency_key = v_expected_movement_key;

        if found then
          v_movement_recovered := true;
        else
          v_review_reason := 'Manual sale was saved by an older workflow, but no canonical inventory movement exists. Inventory was not changed.';
          update public.route_manual_sales sale_row
          set needs_review = true,
              review_reason = v_review_reason,
              updated_at = pg_catalog.now()
          where sale_row.id = v_sale.id;
          get diagnostics v_updated_count = row_count;
          if v_updated_count <> 1 then
            raise exception 'Could not persist manual-sale inventory review state.' using errcode = '40001';
          end if;
          select sale_row.* into v_sale
          from public.route_manual_sales sale_row
          where sale_row.id = v_sale.id;
        end if;
      end if;

      if v_sale.inventory_movement_id is not null or v_movement_recovered then
        if not found
          or v_movement.idempotency_key is distinct from v_expected_movement_key
          or v_movement.source_type is distinct from 'route_manual_sale'
          or v_movement.source_id is distinct from v_sale.id
          or v_movement.reason::text <> 'manual_sale'
          or v_movement.product_id is distinct from v_sale.product_id
          or v_movement.quantity is distinct from v_sale.quantity
          or v_movement.from_entity_type::text <> 'operator_bag'
          or v_movement.from_entity_id is distinct from v_sale.operator_id
          or v_movement.to_entity_type::text <> 'customer'
          or v_movement.to_entity_id is not null
          or v_movement.related_route_id is distinct from v_sale.route_id
          or v_movement.related_route_stop_id is distinct from v_sale.route_stop_id
          or v_movement.related_machine_id is distinct from v_sale.machine_id
          or v_movement.created_by is distinct from v_sale.created_by_team_member_id
          or v_movement.idempotency_payload is distinct from v_expected_movement_payload
          or v_movement.line_total_lyd is distinct from (case
            when v_movement.unit_cost_lyd is null then null
            else pg_catalog.round(v_movement.unit_cost_lyd * v_sale.quantity::numeric, 2)
          end)
        then
          raise exception 'Manual-sale inventory movement conflicts with the saved business event.' using errcode = '23505';
        end if;

        if v_sale.inventory_movement_id is null then
          update public.route_manual_sales sale_row
          set inventory_movement_id = v_movement.id,
              needs_review = false,
              review_reason = null,
              updated_at = pg_catalog.now()
          where sale_row.id = v_sale.id
            and sale_row.inventory_movement_id is null;
          get diagnostics v_updated_count = row_count;
          if v_updated_count <> 1 then
            raise exception 'Could not attach the recovered manual-sale inventory movement.' using errcode = '40001';
          end if;
          select sale_row.* into v_sale
          from public.route_manual_sales sale_row
          where sale_row.id = v_sale.id;
        end if;
      end if;
    end if;

    return pg_catalog.jsonb_build_object(
      'sale', pg_catalog.to_jsonb(v_sale),
      'inventoryMovementCreated', v_sale.inventory_movement_id is not null,
      'inventoryMovementRecovered', v_movement_recovered,
      'alreadyApplied', true,
      'warning', case when v_sale.needs_review then v_sale.review_reason else null end,
      'recordedBagQtyBefore', null
    );
  end if;

  if v_route.status::text in (
    'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed',
    'cancelled', 'canceled', 'archived', 'deleted'
  ) then
    raise exception 'This route is closed, so a new manual sale cannot be added.' using errcode = '23514';
  end if;
  if v_stop.status::text in ('completed', 'skipped', 'canceled') then
    raise exception 'This stop is closed, so a new manual sale cannot be added.' using errcode = '23514';
  end if;

  v_operator_id := coalesce(v_route.operator_id, v_actor_team_member_id);

  if p_product_id is not null then
    select
      product_row.id,
      product_row.name,
      coalesce(
        nullif(product_row.average_cost_lyd, 0),
        nullif(product_row.last_purchase_cost_lyd, 0),
        nullif(product_row.current_cost_price_lyd, 0),
        nullif(product_row.cost_price, 0),
        0
      )::numeric(12,4) as unit_cost,
      coalesce(
        nullif(product_row.current_selling_price_lyd, 0),
        nullif(product_row.selling_price, 0),
        0
      )::numeric(12,2) as unit_sale_price
    into v_product
    from public.products product_row
    where product_row.id = p_product_id;

    if not found then
      raise exception 'Selected product was not found.' using errcode = '23503';
    end if;

    v_product_name := pg_catalog.btrim(v_product.name);
    v_unit_cost := v_product.unit_cost;
    v_unit_sale_price := v_product.unit_sale_price;

    if v_unit_sale_price <= 0 then
      raise exception 'The selected product has no valid canonical selling price. Update its product price before recording this sale.' using errcode = '23514';
    end if;

    if v_route.operator_id is null then
      v_review_reason := 'Manual sale inventory could not be verified because the route has no assigned operator. Inventory was not changed.';
    else
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('snacky:operator-custody:' || v_route.operator_id::text, 0)
      );
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'snacky:operator-bag:' || v_route.operator_id::text || ':' || p_product_id::text,
          0
        )
      );

      select coalesce(pg_catalog.sum(
        case
          when movement.to_entity_type::text = 'operator_bag'
            and movement.to_entity_id = v_route.operator_id
            then movement.quantity::bigint
          else 0::bigint
        end
        + case
          when movement.from_entity_type::text = 'operator_bag'
            and movement.from_entity_id = v_route.operator_id
            then -movement.quantity::bigint
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

      if pg_catalog.to_regclass('public.operator_route_custody_leases') is not null then
        execute 'select exists (
          select 1 from public.operator_route_custody_leases lease
          where lease.operator_id = $1 and lease.route_id = $2
        )'
        into v_has_custody_lease
        using v_route.operator_id, p_route_id;
      end if;

      if not v_has_custody_lease then
        v_review_reason := 'Manual sale inventory could not be verified because this route does not own the operator bag custody lease. Inventory was not changed.';
      elsif v_route_bag_qty < p_quantity::bigint then
        v_review_reason := pg_catalog.format(
          'Manual sale exceeds recorded stock for this route by %s unit(s). Inventory was not changed.',
          p_quantity::bigint - greatest(v_route_bag_qty, 0::bigint)
        );
      elsif v_global_bag_qty < p_quantity::bigint then
        v_review_reason := pg_catalog.format(
          'Manual sale exceeds the operator''s recorded bag stock by %s unit(s). Inventory was not changed.',
          p_quantity::bigint - greatest(v_global_bag_qty, 0::bigint)
        );
      end if;
    end if;
  else
    v_product_name := v_fallback_product_name;
  end if;

  insert into public.route_manual_sales (
    route_id,
    route_stop_id,
    machine_id,
    location_id,
    operator_id,
    product_id,
    product_name,
    quantity,
    unit_sale_price_lyd,
    payment_method,
    notes,
    status,
    client_submission_id,
    needs_review,
    review_reason,
    created_by_user_id,
    created_by_team_member_id
  ) values (
    p_route_id,
    p_route_stop_id,
    p_machine_id,
    v_machine.location_id,
    v_operator_id,
    p_product_id,
    v_product_name,
    p_quantity,
    v_unit_sale_price,
    v_payment_method,
    v_notes,
    'confirmed',
    v_submission_id,
    v_review_reason is not null,
    v_review_reason,
    v_actor_user_id,
    v_actor_team_member_id
  )
  returning * into v_sale;

  if p_product_id is not null and v_review_reason is null then
    v_expected_movement_key := 'route-manual-sale:'
      || p_route_id::text || ':' || p_route_stop_id::text || ':'
      || v_sale.id::text || ':' || p_product_id::text || ':'
      || v_route.operator_id::text || ':' || p_quantity::text;
    v_expected_movement_payload := pg_catalog.jsonb_build_object(
      'contract_version', 2,
      'event_type', 'route_manual_sale',
      'sale_id', v_sale.id,
      'client_submission_id', v_sale.client_submission_id,
      'actor_user_id', v_actor_user_id,
      'actor_team_member_id', v_actor_team_member_id,
      'route_id', v_sale.route_id,
      'route_stop_id', v_sale.route_stop_id,
      'machine_id', v_sale.machine_id,
      'operator_id', v_sale.operator_id,
      'product_id', v_sale.product_id,
      'product_name', v_sale.product_name,
      'quantity', v_sale.quantity,
      'unit_sale_price_lyd', v_sale.unit_sale_price_lyd,
      'payment_method', v_sale.payment_method,
      'notes', nullif(pg_catalog.btrim(coalesce(v_sale.notes, '')), '')
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
      'operator_bag'::public.inventory_entity_type,
      v_route.operator_id,
      'customer'::public.inventory_entity_type,
      null,
      'manual_sale'::public.movement_reason,
      p_route_id,
      p_route_stop_id,
      p_machine_id,
      v_unit_cost,
      pg_catalog.round(v_unit_cost * p_quantity::numeric, 2),
      'route_manual_sale',
      v_sale.id,
      v_expected_movement_key,
      v_expected_movement_payload,
      v_actor_team_member_id,
      'Manual route sale: ' || v_product_name
    )
    returning * into v_movement;

    update public.route_manual_sales sale_row
    set inventory_movement_id = v_movement.id,
        updated_at = pg_catalog.now()
    where sale_row.id = v_sale.id
      and sale_row.inventory_movement_id is null;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception 'Could not attach the manual-sale inventory movement.' using errcode = '40001';
    end if;
    v_sale.inventory_movement_id := v_movement.id;
    v_sale.updated_at := pg_catalog.now();
    v_movement_created := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'sale', pg_catalog.to_jsonb(v_sale),
    'inventoryMovementCreated', v_movement_created,
    'inventoryMovementRecovered', false,
    'alreadyApplied', false,
    'warning', v_review_reason,
    'recordedBagQtyBefore', v_route_bag_qty
  );
end;
$function$;

revoke all on function public.snacky_create_route_manual_sale_v1(
  uuid, uuid, uuid, uuid, text, integer, numeric, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.snacky_create_route_manual_sale_v1(
  uuid, uuid, uuid, uuid, text, integer, numeric, text, text, text
) to authenticated;

create or replace function public.snacky_create_route_customer_compensation_v1(
  p_route_id uuid,
  p_route_stop_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_claim_type text,
  p_claimed_amount_lyd numeric,
  p_notes text,
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
  v_is_manager boolean := false;
  v_route public.routes%rowtype;
  v_stop public.route_stops%rowtype;
  v_machine public.machines%rowtype;
  v_product record;
  v_record public.route_customer_compensations%rowtype;
  v_movement public.inventory_movements%rowtype;
  v_operator_id uuid;
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_claim_type text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_claim_type, '')));
  v_claimed_amount numeric(12,2);
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_unit_cost numeric(12,4) := 0;
  v_route_bag_qty bigint;
  v_global_bag_qty bigint;
  v_expected_movement_key text;
  v_expected_movement_payload jsonb;
  v_review_reason text;
  v_movement_created boolean := false;
  v_movement_recovered boolean := false;
  v_has_custody_lease boolean := true;
  v_updated_count integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to save a customer compensation.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  v_is_manager := public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);

  if p_route_id is null or p_route_stop_id is null or p_product_id is null then
    raise exception 'Route, stop, and product are required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;
  if coalesce(p_quantity, 0) <= 0 then
    raise exception 'Quantity must be greater than 0.' using errcode = '23514';
  end if;
  if v_claim_type not in ('paid_no_product', 'wrong_product', 'damaged_or_stuck', 'other') then
    raise exception 'Invalid customer compensation reason.' using errcode = '22023';
  end if;
  if p_claimed_amount_lyd is not null
    and (p_claimed_amount_lyd < 0 or p_claimed_amount_lyd >= 10000000000)
  then
    raise exception 'Claimed amount must be nonnegative and fit the LYD amount field.' using errcode = '23514';
  end if;
  v_claimed_amount := case
    when p_claimed_amount_lyd is null then null
    else pg_catalog.round(p_claimed_amount_lyd, 2)::numeric(12,2)
  end;
  if pg_catalog.length(coalesce(v_notes, '')) > 2000 then
    raise exception 'Compensation notes cannot exceed 2000 characters.' using errcode = '22023';
  end if;

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
    and stop_row.route_id = p_route_id
  for update;

  if not found then
    raise exception 'The selected stop does not belong to this route.' using errcode = '23503';
  end if;

  select machine_row.*
  into v_machine
  from public.machines machine_row
  where machine_row.id = v_stop.machine_id
  for share;

  if not found then
    raise exception 'The stop machine was not found.' using errcode = '23503';
  end if;

  -- As with manual sales, an exact already-committed retry is resolved before
  -- checking current lifecycle state.
  select compensation_row.*
  into v_record
  from public.route_customer_compensations compensation_row
  where compensation_row.client_submission_id = v_submission_id
  for update;

  if found then
    if v_record.route_id is distinct from p_route_id
      or v_record.route_stop_id is distinct from p_route_stop_id
      or v_record.machine_id is distinct from v_stop.machine_id
      or v_record.product_id is distinct from p_product_id
      or v_record.quantity is distinct from p_quantity
      or v_record.claim_type is distinct from v_claim_type
      or v_record.claimed_amount_lyd is distinct from v_claimed_amount
      or nullif(pg_catalog.btrim(coalesce(v_record.notes, '')), '') is distinct from v_notes
      or v_record.client_submission_id is distinct from v_submission_id
      or v_record.created_by_user_id is distinct from v_actor_user_id
      or v_record.created_by_team_member_id is distinct from v_actor_team_member_id
    then
      raise exception 'This compensation submission id was already used with a different immutable payload.' using errcode = '23505';
    end if;

    v_expected_movement_key := 'customer-compensation:'
      || v_record.route_id::text || ':' || v_record.route_stop_id::text || ':'
      || v_record.id::text || ':' || v_record.product_id::text || ':'
      || v_record.operator_id::text || ':' || v_record.quantity::text;
    v_expected_movement_payload := pg_catalog.jsonb_build_object(
      'contract_version', 2,
      'event_type', 'route_customer_compensation',
      'compensation_id', v_record.id,
      'client_submission_id', v_record.client_submission_id,
      'actor_user_id', v_record.created_by_user_id,
      'actor_team_member_id', v_record.created_by_team_member_id,
      'route_id', v_record.route_id,
      'route_stop_id', v_record.route_stop_id,
      'machine_id', v_record.machine_id,
      'operator_id', v_record.operator_id,
      'product_id', v_record.product_id,
      'product_name', v_record.product_name,
      'quantity', v_record.quantity,
      'claim_type', v_record.claim_type,
      'claimed_amount_lyd', v_record.claimed_amount_lyd,
      'notes', nullif(pg_catalog.btrim(coalesce(v_record.notes, '')), '')
    );

    if v_record.inventory_movement_id is not null then
      select movement_row.*
      into v_movement
      from public.inventory_movements movement_row
      where movement_row.id = v_record.inventory_movement_id;
    elsif not v_record.needs_review then
      select movement_row.*
      into v_movement
      from public.inventory_movements movement_row
      where movement_row.idempotency_key = v_expected_movement_key;

      if found then
        v_movement_recovered := true;
      else
        v_review_reason := 'Customer compensation was saved by an older workflow, but no canonical inventory movement exists. Inventory was not changed.';
        update public.route_customer_compensations compensation_row
        set needs_review = true,
            review_reason = v_review_reason,
            updated_at = pg_catalog.now()
        where compensation_row.id = v_record.id;
        get diagnostics v_updated_count = row_count;
        if v_updated_count <> 1 then
          raise exception 'Could not persist compensation inventory review state.' using errcode = '40001';
        end if;
        select compensation_row.* into v_record
        from public.route_customer_compensations compensation_row
        where compensation_row.id = v_record.id;
      end if;
    end if;

    if v_record.inventory_movement_id is not null or v_movement_recovered then
      if not found
        or v_movement.idempotency_key is distinct from v_expected_movement_key
        or v_movement.source_type is distinct from 'route_customer_compensation'
        or v_movement.source_id is distinct from v_record.id
        or v_movement.reason::text <> 'customer_compensation'
        or v_movement.product_id is distinct from v_record.product_id
        or v_movement.quantity is distinct from v_record.quantity
        or v_movement.from_entity_type::text <> 'operator_bag'
        or v_movement.from_entity_id is distinct from v_record.operator_id
        or v_movement.to_entity_type::text <> 'customer'
        or v_movement.to_entity_id is not null
        or v_movement.related_route_id is distinct from v_record.route_id
        or v_movement.related_route_stop_id is distinct from v_record.route_stop_id
        or v_movement.related_machine_id is distinct from v_record.machine_id
        or v_movement.created_by is distinct from v_record.created_by_team_member_id
        or v_movement.idempotency_payload is distinct from v_expected_movement_payload
        or v_movement.line_total_lyd is distinct from (case
          when v_movement.unit_cost_lyd is null then null
          else pg_catalog.round(v_movement.unit_cost_lyd * v_record.quantity::numeric, 2)
        end)
      then
        raise exception 'Compensation inventory movement conflicts with the saved business event.' using errcode = '23505';
      end if;

      if v_record.inventory_movement_id is null then
        update public.route_customer_compensations compensation_row
        set inventory_movement_id = v_movement.id,
            needs_review = false,
            review_reason = null,
            updated_at = pg_catalog.now()
        where compensation_row.id = v_record.id
          and compensation_row.inventory_movement_id is null;
        get diagnostics v_updated_count = row_count;
        if v_updated_count <> 1 then
          raise exception 'Could not attach the recovered compensation inventory movement.' using errcode = '40001';
        end if;
        select compensation_row.* into v_record
        from public.route_customer_compensations compensation_row
        where compensation_row.id = v_record.id;
      end if;
    end if;

    return pg_catalog.jsonb_build_object(
      'record', pg_catalog.to_jsonb(v_record),
      'inventoryMovementCreated', v_record.inventory_movement_id is not null,
      'inventoryMovementRecovered', v_movement_recovered,
      'alreadyApplied', true,
      'warning', case when v_record.needs_review then v_record.review_reason else null end,
      'recordedBagQtyBefore', null
    );
  end if;

  if v_route.status::text in (
    'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed',
    'cancelled', 'canceled', 'archived', 'deleted'
  ) then
    raise exception 'This route is closed, so a new customer compensation cannot be added.' using errcode = '23514';
  end if;
  if v_stop.status::text in ('completed', 'skipped', 'canceled') then
    raise exception 'This stop is closed, so a new customer compensation cannot be added.' using errcode = '23514';
  end if;

  select
    product_row.id,
    product_row.name,
    coalesce(
      nullif(product_row.average_cost_lyd, 0),
      nullif(product_row.last_purchase_cost_lyd, 0),
      nullif(product_row.current_cost_price_lyd, 0),
      nullif(product_row.cost_price, 0),
      0
    )::numeric(12,4) as unit_cost
  into v_product
  from public.products product_row
  where product_row.id = p_product_id;

  if not found then
    raise exception 'Selected product was not found.' using errcode = '23503';
  end if;
  v_unit_cost := v_product.unit_cost;
  v_operator_id := coalesce(v_route.operator_id, v_actor_team_member_id);

  if v_route.operator_id is null then
    v_review_reason := 'Compensation inventory could not be verified because the route has no assigned operator. Inventory was not changed.';
  else
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('snacky:operator-custody:' || v_route.operator_id::text, 0)
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_route.operator_id::text || ':' || p_product_id::text,
        0
      )
    );

    select coalesce(pg_catalog.sum(
      case
        when movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_route.operator_id
          then movement.quantity::bigint
        else 0::bigint
      end
      + case
        when movement.from_entity_type::text = 'operator_bag'
          and movement.from_entity_id = v_route.operator_id
          then -movement.quantity::bigint
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

    if pg_catalog.to_regclass('public.operator_route_custody_leases') is not null then
      execute 'select exists (
        select 1 from public.operator_route_custody_leases lease
        where lease.operator_id = $1 and lease.route_id = $2
      )'
      into v_has_custody_lease
      using v_route.operator_id, p_route_id;
    end if;

    if not v_has_custody_lease then
      v_review_reason := 'Compensation inventory could not be verified because this route does not own the operator bag custody lease. Inventory was not changed.';
    elsif v_route_bag_qty < p_quantity::bigint then
      v_review_reason := pg_catalog.format(
        'Customer compensation exceeds recorded stock for this route by %s unit(s). Inventory was not changed.',
        p_quantity::bigint - greatest(v_route_bag_qty, 0::bigint)
      );
    elsif v_global_bag_qty < p_quantity::bigint then
      v_review_reason := pg_catalog.format(
        'Customer compensation exceeds the operator''s recorded bag stock by %s unit(s). Inventory was not changed.',
        p_quantity::bigint - greatest(v_global_bag_qty, 0::bigint)
      );
    end if;
  end if;

  insert into public.route_customer_compensations (
    route_id,
    route_stop_id,
    machine_id,
    location_id,
    operator_id,
    product_id,
    product_name,
    quantity,
    claim_type,
    claimed_amount_lyd,
    notes,
    client_submission_id,
    needs_review,
    review_reason,
    created_by_user_id,
    created_by_team_member_id
  ) values (
    p_route_id,
    p_route_stop_id,
    v_stop.machine_id,
    v_machine.location_id,
    v_operator_id,
    p_product_id,
    pg_catalog.btrim(v_product.name),
    p_quantity,
    v_claim_type,
    v_claimed_amount,
    v_notes,
    v_submission_id,
    v_review_reason is not null,
    v_review_reason,
    v_actor_user_id,
    v_actor_team_member_id
  )
  returning * into v_record;

  if v_review_reason is null then
    v_expected_movement_key := 'customer-compensation:'
      || p_route_id::text || ':' || p_route_stop_id::text || ':'
      || v_record.id::text || ':' || p_product_id::text || ':'
      || v_route.operator_id::text || ':' || p_quantity::text;
    v_expected_movement_payload := pg_catalog.jsonb_build_object(
      'contract_version', 2,
      'event_type', 'route_customer_compensation',
      'compensation_id', v_record.id,
      'client_submission_id', v_record.client_submission_id,
      'actor_user_id', v_actor_user_id,
      'actor_team_member_id', v_actor_team_member_id,
      'route_id', v_record.route_id,
      'route_stop_id', v_record.route_stop_id,
      'machine_id', v_record.machine_id,
      'operator_id', v_record.operator_id,
      'product_id', v_record.product_id,
      'product_name', v_record.product_name,
      'quantity', v_record.quantity,
      'claim_type', v_record.claim_type,
      'claimed_amount_lyd', v_record.claimed_amount_lyd,
      'notes', nullif(pg_catalog.btrim(coalesce(v_record.notes, '')), '')
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
      'operator_bag'::public.inventory_entity_type,
      v_route.operator_id,
      'customer'::public.inventory_entity_type,
      null,
      'customer_compensation'::public.movement_reason,
      p_route_id,
      p_route_stop_id,
      v_stop.machine_id,
      v_unit_cost,
      pg_catalog.round(v_unit_cost * p_quantity::numeric, 2),
      'route_customer_compensation',
      v_record.id,
      v_expected_movement_key,
      v_expected_movement_payload,
      v_actor_team_member_id,
      'Customer compensation: ' || pg_catalog.btrim(v_product.name)
    )
    returning * into v_movement;

    update public.route_customer_compensations compensation_row
    set inventory_movement_id = v_movement.id,
        updated_at = pg_catalog.now()
    where compensation_row.id = v_record.id
      and compensation_row.inventory_movement_id is null;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception 'Could not attach the compensation inventory movement.' using errcode = '40001';
    end if;
    v_record.inventory_movement_id := v_movement.id;
    v_record.updated_at := pg_catalog.now();
    v_movement_created := true;
  end if;

  return pg_catalog.jsonb_build_object(
    'record', pg_catalog.to_jsonb(v_record),
    'inventoryMovementCreated', v_movement_created,
    'inventoryMovementRecovered', false,
    'alreadyApplied', false,
    'warning', v_review_reason,
    'recordedBagQtyBefore', v_route_bag_qty
  );
end;
$function$;

revoke all on function public.snacky_create_route_customer_compensation_v1(
  uuid, uuid, uuid, integer, text, numeric, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.snacky_create_route_customer_compensation_v1(
  uuid, uuid, uuid, integer, text, numeric, text, text
) to authenticated;

-- Retain the old implementation only as a revoked forensic reference. The
-- public entry point below owns the complete actor-bound cancellation receipt;
-- it never delegates to code that can manufacture a missing historical leg.
do $$
begin
  if pg_catalog.to_regprocedure(
    'public.snacky_cancel_route_manual_sale_v1_legacy(uuid,uuid,uuid,text)'
  ) is null then
    if pg_catalog.to_regprocedure(
      'public.snacky_cancel_route_manual_sale_v1(uuid,uuid,uuid,text)'
    ) is null then
      raise exception 'Required manual-sale cancellation function is missing.' using errcode = '42883';
    end if;

    alter function public.snacky_cancel_route_manual_sale_v1(uuid, uuid, uuid, text)
      rename to snacky_cancel_route_manual_sale_v1_legacy;
  end if;
end
$$;

revoke all on function public.snacky_cancel_route_manual_sale_v1_legacy(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;

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
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_is_manager boolean := false;
  v_route public.routes%rowtype;
  v_stop public.route_stops%rowtype;
  v_sale public.route_manual_sales%rowtype;
  v_original public.inventory_movements%rowtype;
  v_reversal public.inventory_movements%rowtype;
  v_candidate public.inventory_movements%rowtype;
  v_reversal_key text;
  v_original_key text;
  v_reason text := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_cancellation_reason, '')), ''),
    'Cancelled from route stop'
  );
  v_expected_original_payload jsonb;
  v_expected_reversal_payload jsonb;
  v_original_exact boolean := false;
  v_reversal_exact boolean := false;
  v_candidate_count integer := 0;
  v_updated_count integer := 0;
  v_review_reason text;
  v_was_cancelled boolean := false;
begin
  if v_actor_user_id is null then
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || p_route_id::text, 0)
  );

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
    and stop_row.route_id = p_route_id
  for update;

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

  if v_sale.status::text not in ('confirmed', 'cancelled') then
    raise exception 'Manual sale has an unsupported status.' using errcode = '23514';
  end if;
  v_was_cancelled := v_sale.status::text = 'cancelled';
  v_reversal_key := 'route-manual-sale-cancel:'
    || p_route_id::text || ':' || p_route_stop_id::text || ':' || p_sale_id::text;

  if v_sale.product_id is not null and v_sale.operator_id is not null then
    -- Lock the route custody account and its product before any ledger row.
    -- A manager is the audit actor, while the assigned operator remains the
    -- bag endpoint whose stock is being restored.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('snacky:operator-custody:' || v_sale.operator_id::text, 0)
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_sale.operator_id::text || ':' || v_sale.product_id::text,
        0
      )
    );
  end if;

  if v_sale.inventory_movement_id is not null then
    select movement_row.*
    into v_original
    from public.inventory_movements movement_row
    where movement_row.id = v_sale.inventory_movement_id
    for update;
  end if;

  for v_candidate in
    select movement_row.*
    from public.inventory_movements movement_row
    where movement_row.reversed_movement_id = v_sale.inventory_movement_id
      or movement_row.idempotency_key = v_reversal_key
      or (
        movement_row.source_type = 'route_manual_sale_cancel'
        and movement_row.source_id = v_sale.id
      )
    order by movement_row.id
    for update
  loop
    v_candidate_count := v_candidate_count + 1;
    if v_candidate_count = 1 then
      v_reversal := v_candidate;
    end if;
  end loop;

  if v_sale.product_id is not null
    and v_sale.operator_id is not null
    and v_sale.inventory_movement_id is not null
    and v_sale.created_by_user_id is not null
    and v_sale.created_by_team_member_id is not null
  then
    v_original_key := 'route-manual-sale:'
      || v_sale.route_id::text || ':' || v_sale.route_stop_id::text || ':'
      || v_sale.id::text || ':' || v_sale.product_id::text || ':'
      || v_sale.operator_id::text || ':' || v_sale.quantity::text;
    v_expected_original_payload := pg_catalog.jsonb_build_object(
      'contract_version', 2,
      'event_type', 'route_manual_sale',
      'sale_id', v_sale.id,
      'client_submission_id', v_sale.client_submission_id,
      'actor_user_id', v_sale.created_by_user_id,
      'actor_team_member_id', v_sale.created_by_team_member_id,
      'route_id', v_sale.route_id,
      'route_stop_id', v_sale.route_stop_id,
      'machine_id', v_sale.machine_id,
      'operator_id', v_sale.operator_id,
      'product_id', v_sale.product_id,
      'product_name', v_sale.product_name,
      'quantity', v_sale.quantity,
      'unit_sale_price_lyd', v_sale.unit_sale_price_lyd,
      'payment_method', v_sale.payment_method,
      'notes', nullif(pg_catalog.btrim(coalesce(v_sale.notes, '')), '')
    );
    v_original_exact := coalesce((v_original.id is not null
      and v_original.idempotency_key = v_original_key
      and v_original.idempotency_payload = v_expected_original_payload
      and v_original.source_type = 'route_manual_sale'
      and v_original.source_id = v_sale.id
      and v_original.reason::text = 'manual_sale'
      and v_original.product_id = v_sale.product_id
      and v_original.quantity = v_sale.quantity
      and v_original.from_entity_type::text = 'operator_bag'
      and v_original.from_entity_id = v_sale.operator_id
      and v_original.to_entity_type::text = 'customer'
      and v_original.to_entity_id is null
      and v_original.related_route_id = v_sale.route_id
      and v_original.related_route_stop_id = v_sale.route_stop_id
      and v_original.related_machine_id = v_sale.machine_id
      and v_original.created_by = v_sale.created_by_team_member_id
      and v_original.line_total_lyd is not distinct from (case
        when v_original.unit_cost_lyd is null then null
        else pg_catalog.round(v_original.unit_cost_lyd * v_sale.quantity::numeric, 2)
      end)), false);
  end if;

  v_expected_reversal_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'event_type', 'route_manual_sale_cancel',
    'sale_id', v_sale.id,
    'original_movement_id', v_sale.inventory_movement_id,
    'cancellation_reason', v_reason,
    'actor_user_id', v_actor_user_id,
    'actor_team_member_id', v_actor_team_member_id,
    'route_id', v_sale.route_id,
    'route_stop_id', v_sale.route_stop_id,
    'machine_id', v_sale.machine_id,
    'operator_id', v_sale.operator_id,
    'product_id', v_sale.product_id,
    'quantity', v_sale.quantity
  );

  v_reversal_exact := coalesce((v_candidate_count = 1
    and v_reversal.id is not null
    and v_reversal.id = v_sale.inventory_reversal_movement_id
    and v_reversal.idempotency_key = v_reversal_key
    and v_reversal.idempotency_payload = v_expected_reversal_payload
    and v_reversal.source_type = 'route_manual_sale_cancel'
    and v_reversal.source_id = v_sale.id
    and v_reversal.reversed_movement_id = v_sale.inventory_movement_id
    and v_reversal.reason::text = 'manual_sale'
    and v_reversal.product_id = v_sale.product_id
    and v_reversal.quantity = v_sale.quantity
    and v_reversal.from_entity_type::text = 'customer'
    and v_reversal.from_entity_id is null
    and v_reversal.to_entity_type::text = 'operator_bag'
    and v_reversal.to_entity_id = v_sale.operator_id
    and v_reversal.related_route_id = v_sale.route_id
    and v_reversal.related_route_stop_id = v_sale.route_stop_id
    and v_reversal.related_machine_id = v_sale.machine_id
    and v_reversal.unit_cost_lyd is not distinct from v_original.unit_cost_lyd
    and v_reversal.line_total_lyd is not distinct from (case
      when v_original.line_total_lyd is null then null
      else -v_original.line_total_lyd
    end)
    and v_reversal.created_by = v_actor_team_member_id), false);

  -- Exact cancellation replay is resolved before route/stop terminal checks,
  -- but it is exact only for the same authenticated actor and reason.
  if v_was_cancelled then
    -- A legacy review flag is semantic, not tied to one historical message.
    -- It is not an exact replay receipt, so return the durable review result
    -- without entering replay logic or creating another movement.
    if v_sale.needs_review then
      return query select false, true;
      return;
    end if;

    if v_sale.cancellation_reason is distinct from v_reason
      or v_sale.cancelled_by_user_id is distinct from v_actor_user_id
      or v_sale.cancelled_by_team_member_id is distinct from v_actor_team_member_id
    then
      raise exception 'Manual sale cancellation was already completed by a different actor or with a different reason.' using errcode = '23505';
    end if;

    if v_sale.product_id is null then
      if v_sale.inventory_movement_id is null
        and v_sale.inventory_reversal_movement_id is null
        and v_candidate_count = 0
      then
        return query select false, true;
        return;
      end if;
    elsif v_original_exact and v_reversal_exact then
      return query select true, true;
      return;
    end if;

    v_review_reason := 'Cancelled manual sale has a missing, ambiguous, or non-exact inventory reversal. Inventory was not changed; reconcile this event from physical evidence.';
    update public.route_manual_sales sale_row
    set needs_review = true,
        review_reason = v_review_reason,
        updated_at = pg_catalog.now()
    where sale_row.id = v_sale.id;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception 'Could not persist manual-sale cancellation review state.' using errcode = '40001';
    end if;
    return query select false, true;
    return;
  end if;

  if v_route.status::text in (
    'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed',
    'cancelled', 'canceled', 'archived', 'deleted'
  ) then
    raise exception 'A terminal route manual sale cannot be changed; use an audited inventory correction.' using errcode = '23514';
  end if;
  if v_stop.status::text in ('completed', 'skipped', 'canceled') then
    raise exception 'A closed stop manual sale cannot be changed; use an audited inventory correction.' using errcode = '23514';
  end if;

  if v_sale.needs_review then
    return query select false, false;
    return;
  end if;

  if v_sale.product_id is null then
    if v_sale.inventory_movement_id is not null
      or v_sale.inventory_reversal_movement_id is not null
      or v_candidate_count <> 0
    then
      v_review_reason := 'Productless manual sale has unexpected inventory history. Inventory was not changed; reconcile this event from physical evidence.';
    end if;
  elsif not coalesce(v_original_exact, false) or v_candidate_count <> 0 then
    v_review_reason := 'Manual sale cannot be cancelled because its original inventory receipt is missing, ambiguous, or non-exact. Inventory was not changed; reconcile this event from physical evidence.';
  end if;

  if v_review_reason is not null then
    update public.route_manual_sales sale_row
    set needs_review = true,
        review_reason = v_review_reason,
        updated_at = pg_catalog.now()
    where sale_row.id = v_sale.id;
    get diagnostics v_updated_count = row_count;
    if v_updated_count <> 1 then
      raise exception 'Could not persist manual-sale cancellation review state.' using errcode = '40001';
    end if;
    return query select false, false;
    return;
  end if;

  if v_sale.product_id is not null then
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
      reversed_movement_id,
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
      v_original.reason,
      v_original.related_route_id,
      v_original.related_route_stop_id,
      v_original.related_machine_id,
      v_original.unit_cost_lyd,
      case when v_original.line_total_lyd is null then null else -v_original.line_total_lyd end,
      v_original.id,
      'route_manual_sale_cancel',
      v_sale.id,
      v_reversal_key,
      v_expected_reversal_payload,
      v_actor_team_member_id,
      'Manual route sale cancelled: ' || v_sale.product_name || ' — ' || v_reason
    )
    returning * into v_reversal;
  end if;

  update public.route_manual_sales sale_row
  set status = 'cancelled',
      cancellation_reason = v_reason,
      cancelled_at = pg_catalog.now(),
      cancelled_by_user_id = v_actor_user_id,
      cancelled_by_team_member_id = v_actor_team_member_id,
      inventory_reversal_movement_id = case
        when v_sale.product_id is null then null
        else v_reversal.id
      end,
      needs_review = false,
      review_reason = null,
      updated_at = pg_catalog.now()
  where sale_row.id = v_sale.id
    and sale_row.status::text = 'confirmed'
    and sale_row.inventory_reversal_movement_id is null;
  get diagnostics v_updated_count = row_count;
  if v_updated_count <> 1 then
    raise exception 'Could not atomically link the manual-sale cancellation receipt.' using errcode = '40001';
  end if;

  return query select v_reversal.id is not null, false;
end;
$function$;

revoke all on function public.snacky_cancel_route_manual_sale_v1(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.snacky_cancel_route_manual_sale_v1(
  uuid, uuid, uuid, text
) to authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');
