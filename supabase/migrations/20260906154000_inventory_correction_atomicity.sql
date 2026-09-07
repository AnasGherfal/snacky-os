-- Generic inventory corrections are reversals of one immutable ledger row.
-- The original, its single reversal, route projection, and any review state
-- must be decided while PostgreSQL owns the relevant locks.

create or replace function public.snacky_create_inventory_movement_correction_v1(
  p_original_movement_id uuid,
  p_reason text
)
returns table (
  correction_movement_id uuid,
  already_applied boolean,
  review_required boolean,
  review_discrepancy_id uuid,
  related_route_id uuid,
  related_purchase_id uuid,
  product_id uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_preflight public.inventory_movements%rowtype;
  v_original public.inventory_movements%rowtype;
  v_exact public.inventory_movements%rowtype;
  v_winner public.inventory_movements%rowtype;
  v_route public.routes%rowtype;
  v_review public.route_inventory_discrepancies%rowtype;
  v_correction_key text;
  v_review_key text;
  v_expected_payload jsonb;
  v_expected_notes text;
  v_route_is_terminal boolean := false;
  v_exact_found boolean := false;
  v_winner_found boolean := false;
  v_review_found boolean := false;
  v_storage_on_hand bigint := 0;
  v_storage_reserved bigint := 0;
  v_machine_on_hand bigint := 0;
  v_bag_owner_id uuid;
  v_is_domain_managed boolean := false;
  v_domain_managed_reason text;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to create an inventory correction.' using errcode = '42501';
  end if;

  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'Only an owner or admin can create an inventory correction.' using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;

  if p_original_movement_id is null then
    raise exception 'The original inventory movement is required.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'A correction reason is required.' using errcode = '22023';
  end if;
  if pg_catalog.length(v_reason) > 1800 then
    raise exception 'Correction reason cannot exceed 1800 characters.' using errcode = '22023';
  end if;

  -- Read immutable routing keys first, then take the canonical parent lock
  -- before locking the ledger row. Route finalization uses route -> ledger,
  -- so this order cannot deadlock it.
  select movement.*
  into v_preflight
  from public.inventory_movements movement
  where movement.id = p_original_movement_id;

  if not found then
    raise exception 'Inventory movement was not found.' using errcode = '23503';
  end if;

  if v_preflight.related_route_id is not null then
    -- Share the route-inventory mutex used by finalization and discrepancy
    -- resolution before taking any route, review, or ledger row lock.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:route-inventory:' || v_preflight.related_route_id::text,
        0
      )
    );

    select route_row.*
    into v_route
    from public.routes route_row
    where route_row.id = v_preflight.related_route_id
    for update;

    if not found then
      raise exception 'The movement route was not found.' using errcode = '23503';
    end if;

    v_route_is_terminal := v_route.status::text in (
      'completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed',
      'cancelled', 'canceled', 'archived', 'deleted'
    );
  end if;

  v_correction_key := 'inventory-correction:v1:' || p_original_movement_id::text;
  v_review_key := 'inventory-correction-review:v1:' || p_original_movement_id::text;
  v_expected_payload := pg_catalog.jsonb_build_object(
    'version', 1,
    'original_movement_id', p_original_movement_id,
    'reason', v_reason
  );
  v_expected_notes := 'Correction for movement '
    || pg_catalog.left(p_original_movement_id::text, 8) || ': ' || v_reason;

  -- Match route-ledger writers: parent row first, then storage, custody/bag,
  -- machine/product and product-row locks, and only then ledger rows.
  -- The keys come from an unlocked preflight read and are revalidated after
  -- the original row is locked, so a concurrent mutation cannot redirect the
  -- correction to a different stock account.
  if not v_route_is_terminal then
    if v_preflight.to_entity_type::text = 'storage' then
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(v_preflight.product_id::text),
        pg_catalog.hashtext(v_preflight.to_entity_id::text)
      );
    end if;

    for v_bag_owner_id in
      select endpoint.owner_id
      from (
        select v_preflight.from_entity_id as owner_id
        where v_preflight.from_entity_type::text = 'operator_bag'
        union
        select v_preflight.to_entity_id as owner_id
        where v_preflight.to_entity_type::text = 'operator_bag'
      ) endpoint
      where endpoint.owner_id is not null
      order by endpoint.owner_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('snacky:operator-custody:' || v_bag_owner_id::text, 0)
      );
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'snacky:operator-bag:' || v_bag_owner_id::text || ':' || v_preflight.product_id::text,
          0
        )
      );
    end loop;

    if v_preflight.to_entity_type::text in ('machine', 'machine_storage') then
      if v_preflight.to_entity_id is null then
        raise exception 'The credited machine account is missing its machine id. Open an inventory review instead.'
          using errcode = '23514';
      end if;

      -- This is the same global machine/product mutex used by the statement-
      -- level inventory ledger guard installed by the route adjustment package.
      -- Holding it before the balance read closes the correction TOCTOU window.
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'snacky:machine-stock:' || v_preflight.to_entity_id::text || ':' || v_preflight.product_id::text,
          0
        )
      );
    end if;

    perform product_row.id
    from public.products product_row
    where product_row.id = v_preflight.product_id
    for update;

    if not found then
      raise exception 'The movement product was not found.' using errcode = '23503';
    end if;
  end if;

  -- This exact reversal namespace serializes retries even if an old caller
  -- does not yet rely on the unique reversed_movement_id constraint.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:inventory-correction:' || p_original_movement_id::text, 0)
  );

  select movement.*
  into v_original
  from public.inventory_movements movement
  where movement.id = p_original_movement_id
  for update;

  if not found then
    raise exception 'Inventory movement was not found.' using errcode = '23503';
  end if;
  if v_original.product_id is distinct from v_preflight.product_id
    or v_original.quantity is distinct from v_preflight.quantity
    or v_original.from_entity_type is distinct from v_preflight.from_entity_type
    or v_original.from_entity_id is distinct from v_preflight.from_entity_id
    or v_original.to_entity_type is distinct from v_preflight.to_entity_type
    or v_original.to_entity_id is distinct from v_preflight.to_entity_id
    or v_original.related_route_id is distinct from v_preflight.related_route_id
    or v_original.related_route_stop_id is distinct from v_preflight.related_route_stop_id
    or v_original.related_purchase_id is distinct from v_preflight.related_purchase_id
    or v_original.related_purchase_line_id is distinct from v_preflight.related_purchase_line_id
    or v_original.related_machine_id is distinct from v_preflight.related_machine_id
    or v_original.related_refill_order_id is distinct from v_preflight.related_refill_order_id
    or v_original.related_pickup_batch_id is distinct from v_preflight.related_pickup_batch_id
    or v_original.import_batch_id is distinct from v_preflight.import_batch_id
    or v_original.unit_cost_lyd is distinct from v_preflight.unit_cost_lyd
    or v_original.line_total_lyd is distinct from v_preflight.line_total_lyd
  then
    raise exception 'Inventory movement changed while the correction was being prepared. Retry the request.' using errcode = '40001';
  end if;

  -- Parent-owned ledger rows must be corrected through the workflow that owns
  -- the parent and its projections. The generic command is intentionally
  -- limited to unparented manual/storage entries; otherwise it could reverse
  -- stock without also reversing a purchase, pickup, sale, compensation,
  -- adjustment, historical import, or an earlier correction.
  v_domain_managed_reason := case
    when v_original.reversed_movement_id is not null then 'reversal_of_reversal'
    when v_original.related_purchase_id is not null
      or v_original.related_purchase_line_id is not null then 'purchase_receipt'
    when v_original.related_pickup_batch_id is not null then 'route_pickup'
    when v_original.related_route_id is not null
      or v_original.related_route_stop_id is not null then 'route_inventory'
    when v_original.reason::text = 'operator_personal_purchase'
      or v_original.source_type = 'operator_personal_purchase'
      or v_original.from_entity_type::text = 'operator_personal_purchase'
      or v_original.to_entity_type::text = 'operator_personal_purchase'
      then 'operator_personal_purchase'
    when v_original.reason::text = 'manual_sale'
      or v_original.source_type in ('route_manual_sale', 'route_manual_sale_cancel')
      then 'route_manual_sale'
    when v_original.reason::text = 'customer_compensation'
      or v_original.source_type in (
        'route_customer_compensation',
        'route_customer_compensation_cancel'
      ) then 'route_customer_compensation'
    when v_original.source_type in (
      'inventory_adjustment',
      'inventory_adjustment_cancel'
    ) then 'inventory_adjustment'
    when v_original.reason::text = 'historical_route_deduction'
      or v_original.source_type = 'historical_route_deduction'
      or v_original.historical_route_deduction_line_id is not null
      then 'historical_route_deduction'
    when v_original.related_refill_order_id is not null then 'refill_order'
    when v_original.import_batch_id is not null then 'import_batch'
    else null
  end;
  v_is_domain_managed := v_domain_managed_reason is not null;

  select movement.*
  into v_exact
  from public.inventory_movements movement
  where movement.idempotency_key = v_correction_key
  for update;
  v_exact_found := found;

  select movement.*
  into v_winner
  from public.inventory_movements movement
  where movement.reversed_movement_id = p_original_movement_id
  order by movement.id
  limit 1
  for update;
  v_winner_found := found;

  if v_exact_found and v_winner_found and v_exact.id is distinct from v_winner.id then
    raise exception 'Inventory correction key and reversal winner disagree. Stop and review the ledger.' using errcode = '23505';
  end if;
  if not v_winner_found and v_exact_found then
    v_winner := v_exact;
    v_winner_found := true;
  end if;

  -- Validate any exact or legacy winner first. Only an unmanaged original may
  -- return it as a clean correction: managed originals must still route into
  -- their owning workflow (or the durable route review) so a legacy generic
  -- reversal can never conceal parent/ledger split-brain.
  if v_winner_found then
    if v_winner.product_id is distinct from v_original.product_id
      or v_winner.quantity is distinct from v_original.quantity
      or v_winner.from_entity_type is distinct from v_original.to_entity_type
      or v_winner.from_entity_id is distinct from v_original.to_entity_id
      or v_winner.to_entity_type is distinct from v_original.from_entity_type
      or v_winner.to_entity_id is distinct from v_original.from_entity_id
      or v_winner.reason::text <> 'manual_correction'
      or v_winner.related_route_id is distinct from v_original.related_route_id
      or v_winner.related_route_stop_id is distinct from v_original.related_route_stop_id
      or v_winner.related_purchase_id is distinct from v_original.related_purchase_id
      or v_winner.related_purchase_line_id is distinct from v_original.related_purchase_line_id
      or v_winner.related_machine_id is distinct from v_original.related_machine_id
      or v_winner.related_refill_order_id is distinct from v_original.related_refill_order_id
      or v_winner.related_pickup_batch_id is distinct from v_original.related_pickup_batch_id
      or v_winner.import_batch_id is distinct from v_original.import_batch_id
      or v_winner.unit_cost_lyd is distinct from v_original.unit_cost_lyd
      or v_winner.line_total_lyd is distinct from (
        case
          when v_original.line_total_lyd is null then null
          else -v_original.line_total_lyd
        end
      )
      or v_winner.reversed_movement_id is distinct from v_original.id
      or v_winner.correction_reason is distinct from v_reason
      or v_winner.source_type is distinct from 'inventory_movement_correction'
      or v_winner.source_id is distinct from v_original.id
      or (v_winner.idempotency_key = v_correction_key and v_winner.idempotency_payload is distinct from v_expected_payload)
    then
      raise exception 'This movement already has a different or malformed correction (%).', v_winner.id
        using errcode = '23505';
    end if;

    if not v_is_domain_managed then
      -- A previously committed machine debit is replayable only while its
      -- verified ledger account is nonnegative. A legacy winner that already
      -- damaged machine stock is a review case, not a clean success.
      if v_original.to_entity_type::text in ('machine', 'machine_storage') then
        select coalesce(pg_catalog.sum(leg.quantity_delta), 0::bigint)
        into v_machine_on_hand
        from (
          select movement.quantity::bigint as quantity_delta
          from public.inventory_movements movement
          where movement.product_id = v_original.product_id
            and movement.to_entity_type = v_original.to_entity_type
            and movement.to_entity_id = v_original.to_entity_id
          union all
          select -movement.quantity::bigint as quantity_delta
          from public.inventory_movements movement
          where movement.product_id = v_original.product_id
            and movement.from_entity_type = v_original.to_entity_type
            and movement.from_entity_id = v_original.to_entity_id
        ) leg;

        if v_machine_on_hand < 0 then
          raise exception 'The existing generic reversal left verified % stock below zero (%). Open an inventory review instead.',
            v_original.to_entity_type::text,
            v_machine_on_hand
            using errcode = '23514';
        end if;
      end if;

      if v_original.related_route_id is not null and not v_route_is_terminal then
        perform public._snacky_sync_route_stock_lines(v_original.related_route_id);
      end if;

      return query select
        v_winner.id,
        true,
        false,
        null::uuid,
        v_original.related_route_id,
        v_original.related_purchase_id,
        v_original.product_id;
      return;
    end if;
  end if;

  -- Route-scoped rows have an established durable review projection. Other
  -- managed domains fail closed without a ledger write and must use their own
  -- atomic cancel/void command.
  if v_is_domain_managed and v_original.related_route_id is null then
    raise exception 'This % movement is managed by its source workflow and cannot be reversed with a generic inventory correction.',
      v_domain_managed_reason
      using errcode = '23514';
  end if;

  -- Route-owned custody (active or terminal) is workflow evidence. Save an
  -- explicit review case instead of inserting a generic reversal that would
  -- bypass its pickup, stop, sale, compensation, or adjustment parent.
  if v_route_is_terminal or v_is_domain_managed then
    select discrepancy.*
    into v_review
    from public.route_inventory_discrepancies discrepancy
    where discrepancy.idempotency_key = v_review_key
    for update;
    v_review_found := found;

    if v_review_found then
      if v_review.route_id is distinct from v_original.related_route_id
        or v_review.route_stop_id is distinct from v_original.related_route_stop_id
        or v_review.machine_id is distinct from v_original.related_machine_id
        or v_review.product_id is distinct from v_original.product_id
        or v_review.discrepancy_type <> 'other'
        or v_review.recorded_quantity is distinct from v_original.quantity
        or v_review.actual_quantity <> 0
        or v_review.difference_quantity is distinct from -v_original.quantity
        or v_review.absolute_quantity is distinct from v_original.quantity
        or v_review.source_type <> 'inventory_movement_correction_review'
        or v_review.source_id is distinct from v_original.id
        or v_review.details ->> 'requested_reason' is distinct from v_reason
        or v_review.details ->> 'domain_managed_reason' is distinct from v_domain_managed_reason
        or v_review.details ->> 'legacy_generic_reversal_id' is distinct from (
          case when v_winner_found then v_winner.id::text else null end
        )
      then
        raise exception 'Route correction review conflicts with the saved request.' using errcode = '23505';
      end if;
    else
      insert into public.route_inventory_discrepancies (
        route_id,
        route_stop_id,
        machine_id,
        operator_id,
        product_id,
        discrepancy_type,
        recorded_quantity,
        actual_quantity,
        difference_quantity,
        absolute_quantity,
        status,
        source_type,
        source_id,
        idempotency_key,
        details,
        detected_by_user_id,
        detected_by_team_member_id
      ) values (
        v_original.related_route_id,
        v_original.related_route_stop_id,
        v_original.related_machine_id,
        v_route.operator_id,
        v_original.product_id,
        'other',
        v_original.quantity,
        0,
        -v_original.quantity,
        v_original.quantity,
        'open',
        'inventory_movement_correction_review',
        v_original.id,
        v_review_key,
        pg_catalog.jsonb_build_object(
          'request_kind', case
            when v_route_is_terminal then 'terminal_route_inventory_correction'
            else 'domain_managed_inventory_correction'
          end,
          'domain_managed_reason', v_domain_managed_reason,
          'original_movement_id', v_original.id,
          'legacy_generic_reversal_id', case when v_winner_found then v_winner.id else null end,
          'requested_reason', v_reason,
          'physical_count_asserted', false,
          'original_from_entity_type', v_original.from_entity_type::text,
          'original_from_entity_id', v_original.from_entity_id,
          'original_to_entity_type', v_original.to_entity_type::text,
          'original_to_entity_id', v_original.to_entity_id,
          'original_line_total_lyd', v_original.line_total_lyd
        ),
        v_actor_user_id,
        v_actor_team_member_id
      )
      returning * into v_review;

      update public.route_inventory_reconciliations reconciliation
      set status = 'needs_review',
          details = coalesce(reconciliation.details, '{}'::jsonb)
            || pg_catalog.jsonb_build_object('latest_correction_review_id', v_review.id),
          updated_at = pg_catalog.now()
      where reconciliation.route_id = v_original.related_route_id;

      if v_original.related_route_stop_id is not null then
        update public.route_stop_inventory_commits stop_commit
        set inventory_needs_review = true,
            updated_at = pg_catalog.now()
        where stop_commit.route_stop_id = v_original.related_route_stop_id;
      end if;
    end if;

    return query select
      null::uuid,
      v_review_found,
      true,
      v_review.id,
      v_original.related_route_id,
      v_original.related_purchase_id,
      v_original.product_id;
    return;
  end if;

  -- A reversal whose source is storage is a real storage debit. Its canonical
  -- product/storage lock is already held; prove physical ledger on-hand before
  -- inserting anything. Administrative status never authorizes a negative
  -- storage balance.
  if v_original.to_entity_type::text = 'storage' then
    select coalesce(pg_catalog.sum(inventory.quantity_on_hand::bigint), 0::bigint)
    into v_storage_on_hand
    from public.current_inventory_by_location inventory
    where inventory.location_type = 'storage'
      and inventory.location_id = v_original.to_entity_id
      and inventory.product_id = v_original.product_id;

    if v_storage_on_hand < v_original.quantity::bigint then
      raise exception 'Correction cannot remove % unit(s) from storage because only % are physically recorded on hand. Open an inventory review instead.',
        v_original.quantity,
        greatest(v_storage_on_hand, 0::bigint)
        using errcode = '23514';
    end if;

    select coalesce(pg_catalog.sum(
      greatest(
        coalesce(stock_line.planned_qty, 0) - coalesce(stock_line.picked_qty, 0),
        0
      )::bigint
    ), 0::bigint)
    into v_storage_reserved
    from public.route_stock_lines stock_line
    join public.routes route_row on route_row.id = stock_line.route_id
    where stock_line.product_id = v_original.product_id
      and route_row.status::text in (
        'draft', 'assigned', 'in_progress', 'pickup_confirmed', 'available', 'ready',
        'started', 'filling', 'machine_filling', 'partially_completed', 'stop_completed'
      );

    if v_storage_on_hand - v_storage_reserved < v_original.quantity::bigint then
      raise exception 'Correction cannot remove % unit(s) from storage because active routes reserve stock; only % are genuinely available. Open an inventory review instead.',
        v_original.quantity,
        greatest(v_storage_on_hand - v_storage_reserved, 0::bigint)
        using errcode = '23514';
    end if;
  end if;

  -- Reversing a credit to a machine account is a real machine debit. The
  -- shared machine/product mutex was taken from the preflight key and the
  -- locked original was revalidated, so no concurrent ledger writer can move
  -- this balance between verification and insert. The later global statement
  -- trigger independently enforces the same invariant for every write path.
  if v_original.to_entity_type::text in ('machine', 'machine_storage') then
    select coalesce(pg_catalog.sum(leg.quantity_delta), 0::bigint)
    into v_machine_on_hand
    from (
      select movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = v_original.product_id
        and movement.to_entity_type = v_original.to_entity_type
        and movement.to_entity_id = v_original.to_entity_id
      union all
      select -movement.quantity::bigint as quantity_delta
      from public.inventory_movements movement
      where movement.product_id = v_original.product_id
        and movement.from_entity_type = v_original.to_entity_type
        and movement.from_entity_id = v_original.to_entity_id
    ) leg;

    if v_machine_on_hand < v_original.quantity::bigint then
      raise exception 'Correction cannot remove % unit(s) from verified % stock because only % are recorded on hand. Open an inventory review instead.',
        v_original.quantity,
        v_original.to_entity_type::text,
        greatest(v_machine_on_hand, 0::bigint)
        using errcode = '23514';
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
    related_route_stop_id,
    related_purchase_id,
    related_purchase_line_id,
    related_machine_id,
    related_refill_order_id,
    related_pickup_batch_id,
    import_batch_id,
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
    v_original.unit_cost_lyd,
    case
      when v_original.line_total_lyd is null then null
      else -v_original.line_total_lyd
    end,
    v_original.id,
    v_reason,
    'inventory_movement_correction',
    v_original.id,
    v_correction_key,
    v_expected_payload,
    v_actor_team_member_id,
    v_expected_notes
  )
  returning * into v_winner;

  if v_original.related_route_id is not null then
    perform public._snacky_sync_route_stock_lines(v_original.related_route_id);

    -- If the original row was review evidence, its reversal invalidates that
    -- evidence. Reopen every affected projection inside this transaction.
    update public.route_inventory_reconciliations reconciliation
    set status = 'needs_review',
        details = coalesce(reconciliation.details, '{}'::jsonb)
          || pg_catalog.jsonb_build_object('reversed_review_evidence_movement_id', v_original.id),
        updated_at = pg_catalog.now()
    where reconciliation.route_id = v_original.related_route_id
      and (
        exists (
          select 1
          from public.route_inventory_discrepancies discrepancy
          where discrepancy.route_id = reconciliation.route_id
            and discrepancy.correcting_movement_id = v_original.id
        )
        or exists (
          select 1
          from public.route_inventory_reconciliation_lines reconciliation_line
          where reconciliation_line.reconciliation_id = reconciliation.id
            and (
              reconciliation_line.adjustment_movement_id = v_original.id
              or reconciliation_line.return_movement_id = v_original.id
            )
        )
      );

    update public.route_inventory_discrepancies discrepancy
    set status = case
          when discrepancy.status in ('resolved', 'accepted_loss', 'voided') then 'open'
          else discrepancy.status
        end,
        resolution_type = null,
        resolution_notes = null,
        resolved_by_user_id = null,
        resolved_by_team_member_id = null,
        resolved_at = null,
        correcting_movement_id = null,
        details = coalesce(discrepancy.details, '{}'::jsonb)
          || pg_catalog.jsonb_build_object('reversed_review_evidence_movement_id', v_original.id),
        updated_at = pg_catalog.now()
    where discrepancy.route_id = v_original.related_route_id
      and discrepancy.correcting_movement_id = v_original.id;

    update public.route_inventory_reconciliation_lines reconciliation_line
    set review_status = case
          when reconciliation_line.variance_quantity = 0 then 'balanced'
          else 'open'
        end,
        adjustment_movement_id = case
          when reconciliation_line.adjustment_movement_id = v_original.id then null
          else reconciliation_line.adjustment_movement_id
        end,
        return_movement_id = case
          when reconciliation_line.return_movement_id = v_original.id then null
          else reconciliation_line.return_movement_id
        end,
        resolved_by_user_id = null,
        resolved_by_team_member_id = null,
        resolution_note = null,
        resolved_at = null,
        updated_at = pg_catalog.now()
    where reconciliation_line.route_id = v_original.related_route_id
      and (
        reconciliation_line.adjustment_movement_id = v_original.id
        or reconciliation_line.return_movement_id = v_original.id
      );

    if v_original.related_route_stop_id is not null then
      update public.route_stop_inventory_commits stop_commit
      set inventory_needs_review = true,
          updated_at = pg_catalog.now()
      where stop_commit.route_stop_id = v_original.related_route_stop_id;
    end if;
  end if;

  return query select
    v_winner.id,
    false,
    false,
    null::uuid,
    v_original.related_route_id,
    v_original.related_purchase_id,
    v_original.product_id;
end;
$function$;

revoke all on function public.snacky_create_inventory_movement_correction_v1(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.snacky_create_inventory_movement_correction_v1(uuid, text)
  to authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');
