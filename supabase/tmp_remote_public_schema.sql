


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."inventory_entity_type" AS ENUM (
    'supplier',
    'storage',
    'operator_bag',
    'machine',
    'waste',
    'adjustment',
    'historical_route'
);


ALTER TYPE "public"."inventory_entity_type" OWNER TO "postgres";


CREATE TYPE "public"."issue_priority" AS ENUM (
    'critical',
    'high',
    'normal',
    'low'
);


ALTER TYPE "public"."issue_priority" OWNER TO "postgres";


CREATE TYPE "public"."issue_status" AS ENUM (
    'open',
    'assigned',
    'in_progress',
    'resolved',
    'closed'
);


ALTER TYPE "public"."issue_status" OWNER TO "postgres";


CREATE TYPE "public"."location_type" AS ENUM (
    'school',
    'hospital',
    'mall',
    'university',
    'office',
    'gym',
    'warehouse',
    'mixed',
    'other'
);


ALTER TYPE "public"."location_type" OWNER TO "postgres";


CREATE TYPE "public"."machine_status" AS ENUM (
    'planned',
    'incoming',
    'standby',
    'active',
    'inactive',
    'maintenance',
    'relocated',
    'retired'
);


ALTER TYPE "public"."machine_status" OWNER TO "postgres";


CREATE TYPE "public"."movement_reason" AS ENUM (
    'purchase_received',
    'storage_to_operator_bag',
    'operator_bag_to_machine',
    'operator_bag_to_storage',
    'machine_to_storage',
    'damaged',
    'expired',
    'stock_count_adjustment',
    'theft_or_missing',
    'manual_correction',
    'product_substitution',
    'opening_balance',
    'historical_route_deduction'
);


ALTER TYPE "public"."movement_reason" OWNER TO "postgres";


CREATE TYPE "public"."refill_status" AS ENUM (
    'draft',
    'assigned',
    'picked',
    'in_progress',
    'completed',
    'review_required',
    'cancelled'
);


ALTER TYPE "public"."refill_status" OWNER TO "postgres";


CREATE TYPE "public"."route_status" AS ENUM (
    'draft',
    'assigned',
    'in_progress',
    'completed',
    'reviewed',
    'cancelled',
    'pickup_confirmed',
    'available',
    'ready',
    'started',
    'machine_filling',
    'canceled',
    'filling'
);


ALTER TYPE "public"."route_status" OWNER TO "postgres";


COMMENT ON TYPE "public"."route_status" IS 'Snacky OS route lifecycle. App writes stable statuses draft, assigned, in_progress, completed, reviewed, cancelled; extra values are accepted for legacy deployed rows and displayed by route-workflow helpers.';



CREATE TYPE "public"."route_stop_status" AS ENUM (
    'pending',
    'arrived',
    'refilling',
    'cash_collected',
    'completed',
    'skipped',
    'issue_reported',
    'picked',
    'in_progress',
    'canceled'
);


ALTER TYPE "public"."route_stop_status" OWNER TO "postgres";


CREATE TYPE "public"."team_role" AS ENUM (
    'owner',
    'admin',
    'supervisor',
    'operator',
    'warehouse',
    'procurement',
    'finance',
    'viewer',
    'purchasing'
);


ALTER TYPE "public"."team_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_historical_route_deduction_batch"("target_batch_id" "uuid", "actor_team_member_id" "uuid") RETURNS TABLE("inserted_movements" integer, "skipped_review_rows" integer)
    LANGUAGE "plpgsql"
    AS $$
declare
  current_status text;
  ready_count integer;
  inserted_count integer := 0;
  review_count integer := 0;
  deduction_line record;
  inserted_movement_id uuid;
begin
  select status
    into current_status
  from historical_route_deduction_batches
  where id = target_batch_id
  for update;

  if not found then
    raise exception 'Historical route deduction batch was not found.';
  end if;

  if current_status = 'applied' then
    raise exception 'This historical route deduction batch has already been applied.';
  end if;

  if current_status <> 'previewed' then
    raise exception 'Only previewed historical route deduction batches can be applied.';
  end if;

  select count(*)::integer
    into ready_count
  from historical_route_deduction_lines
  where import_batch_id = target_batch_id
    and status = 'ready'
    and product_id is not null
    and machine_id is not null
    and quantity is not null
    and quantity > 0
    and storage_location_id is not null;

  if coalesce(ready_count, 0) = 0 then
    raise exception 'This batch has no ready deduction rows to apply.';
  end if;

  for deduction_line in
    select *
    from historical_route_deduction_lines
    where import_batch_id = target_batch_id
      and status = 'ready'
      and product_id is not null
      and machine_id is not null
      and quantity is not null
      and quantity > 0
      and storage_location_id is not null
    order by line_number, id
    for update
  loop
    insert into inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_machine_id,
      created_by,
      notes,
      import_batch_id,
      original_text,
      historical_route_deduction_line_id
    )
    values (
      deduction_line.product_id,
      deduction_line.quantity,
      'storage',
      deduction_line.storage_location_id,
      'historical_route',
      null,
      'historical_route_deduction',
      deduction_line.machine_id,
      actor_team_member_id,
      concat_ws(
        ' - ',
        'Old route data was not previously deducted from storage',
        concat('Machine/location: ', coalesce(deduction_line.section_name, deduction_line.machine_alias, 'Unknown')),
        concat('Original row: ', deduction_line.original_text)
      ),
      target_batch_id,
      deduction_line.original_text,
      deduction_line.id
    )
    returning id into inserted_movement_id;

    update historical_route_deduction_lines
    set
      status = 'applied',
      movement_id = inserted_movement_id,
      applied_at = now()
    where id = deduction_line.id;

    inserted_count := inserted_count + 1;
  end loop;

  select count(*)::integer
    into review_count
  from historical_route_deduction_lines
  where import_batch_id = target_batch_id
    and status = 'needs_review';

  update historical_route_deduction_batches
  set
    status = 'applied',
    applied_by = actor_team_member_id,
    applied_at = now(),
    updated_at = now()
  where id = target_batch_id;

  return query select inserted_count, coalesce(review_count, 0);
end;
$$;


ALTER FUNCTION "public"."apply_historical_route_deduction_batch"("target_batch_id" "uuid", "actor_team_member_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_vms_sales_snapshot_import"("p_batch_id" "uuid", "p_import_mode" "text", "p_report_start_date" "date", "p_report_end_date" "date", "p_sales_rows" "jsonb") RETURNS TABLE("rows_inserted" integer, "rows_skipped_duplicate" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  requested_count integer := coalesce(jsonb_array_length(coalesce(p_sales_rows, '[]'::jsonb)), 0);
begin
  if p_import_mode = 'replace_range' then
    if p_report_start_date is null or p_report_end_date is null then
      raise exception 'replace_range requires report_start_date and report_end_date'
        using errcode = '22023';
    end if;

    update public.vms_sales_snapshots
    set import_row_status = 'reprocessed_stale'
    where import_row_status = 'imported'
      and coalesce(sales_period_end, period_end::date) between p_report_start_date and p_report_end_date;
  end if;

  insert into public.vms_sales_snapshots (
    import_batch_id,
    import_row_number,
    import_row_status,
    source_row_key,
    vms_transaction_id,
    machine_id,
    product_id,
    sold_qty,
    sales_amount,
    cash_sales_amount,
    card_sales_amount,
    cost_amount,
    profit_amount,
    period_start,
    period_end,
    machine_code,
    machine_name,
    product_number,
    product_name,
    commodity_price,
    transaction_count,
    transaction_amount,
    refund_count,
    refund_amount,
    total_transaction,
    sales_period_start,
    sales_period_end,
    sales_month,
    gross_sales_amount,
    net_sales_amount,
    cost_method,
    unit_cost_amount,
    gross_profit_amount,
    metadata
  )
  select
    p_batch_id,
    r.import_row_number,
    'imported',
    r.source_row_key,
    r.vms_transaction_id,
    r.machine_id,
    r.product_id,
    greatest(coalesce(r.sold_qty, 0), 0),
    greatest(coalesce(r.sales_amount, 0), 0),
    greatest(coalesce(r.cash_sales_amount, 0), 0),
    greatest(coalesce(r.card_sales_amount, 0), 0),
    r.cost_amount,
    r.profit_amount,
    r.period_start,
    r.period_end,
    r.machine_code,
    r.machine_name,
    r.product_number,
    r.product_name,
    r.commodity_price,
    r.transaction_count,
    r.transaction_amount,
    r.refund_count,
    r.refund_amount,
    r.total_transaction,
    r.sales_period_start,
    r.sales_period_end,
    r.sales_month,
    r.gross_sales_amount,
    r.net_sales_amount,
    r.cost_method,
    r.unit_cost_amount,
    r.gross_profit_amount,
    coalesce(r.metadata, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_sales_rows, '[]'::jsonb)) as r(
    import_row_number integer,
    source_row_key text,
    vms_transaction_id text,
    machine_id uuid,
    product_id uuid,
    sold_qty integer,
    sales_amount numeric,
    cash_sales_amount numeric,
    card_sales_amount numeric,
    cost_amount numeric,
    profit_amount numeric,
    period_start timestamptz,
    period_end timestamptz,
    machine_code text,
    machine_name text,
    product_number text,
    product_name text,
    commodity_price numeric,
    transaction_count integer,
    transaction_amount numeric,
    refund_count integer,
    refund_amount numeric,
    total_transaction numeric,
    sales_period_start date,
    sales_period_end date,
    sales_month date,
    gross_sales_amount numeric,
    net_sales_amount numeric,
    cost_method text,
    unit_cost_amount numeric,
    gross_profit_amount numeric,
    metadata jsonb
  )
  on conflict do nothing;

  get diagnostics rows_inserted = row_count;
  rows_skipped_duplicate := greatest(requested_count - rows_inserted, 0);
  return next;
end;
$$;


ALTER FUNCTION "public"."apply_vms_sales_snapshot_import"("p_batch_id" "uuid", "p_import_mode" "text", "p_report_start_date" "date", "p_report_end_date" "date", "p_sales_rows" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."backfill_missing_finance_transactions"() RETURNS TABLE("purchases_checked" integer, "purchase_transactions_created" integer, "purchase_transactions_skipped_existing" integer, "cash_collections_checked" integer, "cash_collection_transactions_created" integer, "cash_collection_transactions_skipped_existing" integer, "skipped_existing" integer, "errors" "jsonb")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_purchase record;
  v_cash record;
  v_before uuid;
  v_after uuid;
  v_purchases_checked integer := 0;
  v_purchase_created integer := 0;
  v_purchase_skipped integer := 0;
  v_cash_checked integer := 0;
  v_cash_created integer := 0;
  v_cash_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  for v_purchase in
    select po.id
    from public.purchase_orders po
    where public.finance_purchase_should_sync(po)
  loop
    v_purchases_checked := v_purchases_checked + 1;
    begin
      v_before := null;
      v_after := null;
      select ft.id into v_before
      from public.financial_transactions ft
      where (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
         or ft.linked_purchase_id = v_purchase.id
         or ft.related_purchase_id = v_purchase.id
      limit 1;

      v_after := public.sync_purchase_to_financial_transaction(v_purchase.id);
      if v_after is null then
        v_purchase_skipped := v_purchase_skipped + 1;
      elsif v_before is null then
        v_purchase_created := v_purchase_created + 1;
      else
        v_purchase_skipped := v_purchase_skipped + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'purchase', 'source_id', v_purchase.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  for v_cash in
    select cc.id
    from public.cash_collections cc
    where public.finance_cash_collection_should_sync(cc)
  loop
    v_cash_checked := v_cash_checked + 1;
    begin
      v_before := null;
      v_after := null;
      select ft.id into v_before
      from public.financial_transactions ft
      where (ft.source_type = 'cash_collection' and ft.source_id = v_cash.id)
         or ft.linked_cash_collection_id = v_cash.id
         or ft.related_cash_collection_id = v_cash.id
      limit 1;

      v_after := public.sync_cash_collection_to_financial_transaction(v_cash.id);
      if v_after is null then
        v_cash_skipped := v_cash_skipped + 1;
      elsif v_before is null then
        v_cash_created := v_cash_created + 1;
      else
        v_cash_skipped := v_cash_skipped + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'cash_collection', 'source_id', v_cash.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  return query select
    v_purchases_checked,
    v_purchase_created,
    v_purchase_skipped,
    v_cash_checked,
    v_cash_created,
    v_cash_skipped,
    v_purchase_skipped + v_cash_skipped,
    v_errors;
end;
$$;


ALTER FUNCTION "public"."backfill_missing_finance_transactions"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."confirm_route_pickup_batch"("p_route_id" "uuid", "p_expected_route_status" "public"."route_status", "p_next_route_status" "public"."route_status", "p_started_at" timestamp with time zone, "p_replace_pick_list" boolean DEFAULT false, "p_pickup_batch" "jsonb" DEFAULT NULL::"jsonb", "p_batch_stop_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_new_stop_item_rows" "jsonb" DEFAULT '[]'::"jsonb", "p_inventory_movements" "jsonb" DEFAULT '[]'::"jsonb", "p_pick_list_rows" "jsonb" DEFAULT '[]'::"jsonb", "p_stock_line_rows" "jsonb" DEFAULT '[]'::"jsonb", "p_stop_item_picks" "jsonb" DEFAULT '[]'::"jsonb", "p_refill_line_picks" "jsonb" DEFAULT '[]'::"jsonb", "p_selected_stop_ids" "uuid"[] DEFAULT '{}'::"uuid"[], "p_selected_machine_ids" "uuid"[] DEFAULT '{}'::"uuid"[]) RETURNS TABLE("pickup_batch_id" "uuid", "route_status" "public"."route_status", "picked_stop_ids" "uuid"[], "pending_stop_count" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_route record;
  v_pickup_batch_id uuid;
  v_batch_stop_ids uuid[] := case
    when coalesce(array_length(p_batch_stop_ids, 1), 0) > 0 then p_batch_stop_ids
    else coalesce(p_selected_stop_ids, '{}'::uuid[])
  end;
  v_new_stop_item_rows jsonb := coalesce(p_new_stop_item_rows, '[]'::jsonb);
  v_inventory_movements jsonb := coalesce(p_inventory_movements, '[]'::jsonb);
  v_pick_list_rows jsonb := coalesce(p_pick_list_rows, '[]'::jsonb);
  v_stock_line_rows jsonb := coalesce(p_stock_line_rows, '[]'::jsonb);
  v_stop_item_picks jsonb := coalesce(p_stop_item_picks, '[]'::jsonb);
  v_refill_line_picks jsonb := coalesce(p_refill_line_picks, '[]'::jsonb);
  v_expected_stop_count integer := coalesce(array_length(p_selected_stop_ids, 1), 0);
  v_updated_stop_count integer := 0;
  v_pending_after_count integer := 0;
  v_invalid_count integer := 0;
  v_invalid_stops text;
  v_missing_products text;
  v_product_name text;
  v_available integer;
  v_needed integer;
  v_stock record;
  v_next_route_status public.route_status;
  v_has_storage_deductions boolean := false;
begin
  if p_route_id is null then
    raise exception 'Route id is required for pickup confirmation.' using errcode = 'P0001';
  end if;

  if jsonb_typeof(v_new_stop_item_rows) <> 'array'
    or jsonb_typeof(v_inventory_movements) <> 'array'
    or jsonb_typeof(v_pick_list_rows) <> 'array'
    or jsonb_typeof(v_stock_line_rows) <> 'array'
    or jsonb_typeof(v_stop_item_picks) <> 'array'
    or jsonb_typeof(v_refill_line_picks) <> 'array'
  then
    raise exception 'Pickup confirmation payload is invalid.' using errcode = 'P0001';
  end if;

  if p_pickup_batch is not null and jsonb_typeof(p_pickup_batch) <> 'object' then
    raise exception 'Pickup batch payload is invalid.' using errcode = 'P0001';
  end if;

  select r.id, r.operator_id, r.status, r.started_at
  into v_route
  from public.routes r
  where r.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0001';
  end if;

  if v_route.operator_id is null then
    raise exception 'Route must be assigned to an operator before pickup can be confirmed.' using errcode = 'P0001';
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'cancelled') then
    raise exception 'Route status does not allow pickup confirmation: %.', v_route.status::text using errcode = 'P0001';
  end if;

  if v_route.status::text not in ('draft', 'assigned', 'in_progress', 'pickup_confirmed') then
    raise exception 'Route status does not allow pickup confirmation: %.', v_route.status::text using errcode = 'P0001';
  end if;

  if p_expected_route_status is not null and v_route.status <> p_expected_route_status then
    raise exception 'Route status changed from % to %. Refresh the route before confirming pickup.', p_expected_route_status::text, v_route.status::text
      using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'User does not have permission to confirm pickup for this route.' using errcode = '42501';
  end if;

  if p_pickup_batch is not null then
    if nullif(p_pickup_batch->>'route_id', '') is not null and nullif(p_pickup_batch->>'route_id', '')::uuid <> p_route_id then
      raise exception 'Pickup batch route does not match the selected route.' using errcode = 'P0001';
    end if;

    if nullif(p_pickup_batch->>'operator_id', '') is not null and nullif(p_pickup_batch->>'operator_id', '')::uuid <> v_route.operator_id then
      raise exception 'Pickup batch operator does not match the route operator.' using errcode = 'P0001';
    end if;

    if p_pickup_batch ? 'product_summary' and jsonb_typeof(p_pickup_batch->'product_summary') <> 'array' then
      raise exception 'Pickup batch product summary is invalid.' using errcode = 'P0001';
    end if;
  end if;

  if v_expected_stop_count > 0 then
    select count(*)
    into v_invalid_count
    from unnest(p_selected_stop_ids) as selected_stop_id
    left join public.route_stops rs
      on rs.id = selected_stop_id
     and rs.route_id = p_route_id
    where rs.id is null;

    if v_invalid_count > 0 then
      raise exception 'Selected pickup stop does not belong to this route.' using errcode = 'P0001';
    end if;

    select string_agg(format('stop %s is %s', rs.id, rs.status::text), '; ')
    into v_invalid_stops
    from public.route_stops rs
    where rs.route_id = p_route_id
      and rs.id = any(p_selected_stop_ids)
      and rs.status <> 'pending'::public.route_stop_status;

    if v_invalid_stops is not null then
      raise exception 'Stop status does not allow pickup confirmation: %.', v_invalid_stops using errcode = 'P0001';
    end if;
  end if;

  with product_ids as (
    select product_id from jsonb_to_recordset(v_inventory_movements) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_pick_list_rows) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_stock_line_rows) as x(product_id uuid)
    union all
    select product_id from jsonb_to_recordset(v_new_stop_item_rows) as x(product_id uuid)
  )
  select string_agg(product_id::text, ', ')
  into v_missing_products
  from (
    select distinct product_id
    from product_ids
    where product_id is not null
  ) ids
  left join public.products p on p.id = ids.product_id
  where p.id is null;

  if v_missing_products is not null then
    raise exception 'Product is missing from inventory/product catalog: %.', v_missing_products using errcode = 'P0001';
  end if;

  if jsonb_array_length(v_inventory_movements) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    )
    where x.product_id is null
      or coalesce(x.quantity, 0) <= 0
      or x.reason not in ('storage_to_operator_bag', 'operator_bag_to_storage')
      or (
        x.reason = 'storage_to_operator_bag'
        and (
          x.from_entity_type <> 'storage'
          or x.from_entity_id is null
          or x.to_entity_type <> 'operator_bag'
          or x.to_entity_id is distinct from v_route.operator_id
        )
      )
      or (
        x.reason = 'operator_bag_to_storage'
        and (
          x.from_entity_type <> 'operator_bag'
          or x.from_entity_id is distinct from v_route.operator_id
          or x.to_entity_type <> 'storage'
          or x.to_entity_id is null
        )
      );

    if v_invalid_count > 0 then
      raise exception 'Inventory movement could not be created because the movement payload is invalid.' using errcode = 'P0001';
    end if;

    select exists (
      select 1
      from jsonb_to_recordset(v_inventory_movements) as x(reason text)
      where x.reason = 'storage_to_operator_bag'
    )
    into v_has_storage_deductions;

    for v_stock in
      select x.product_id, x.from_entity_id, sum(x.quantity)::integer as needed_qty
      from jsonb_to_recordset(v_inventory_movements) as x(
        product_id uuid,
        quantity integer,
        from_entity_type text,
        from_entity_id uuid,
        to_entity_type text,
        to_entity_id uuid,
        reason text
      )
      where x.reason = 'storage_to_operator_bag'
      group by x.product_id, x.from_entity_id
    loop
      perform pg_advisory_xact_lock(hashtext(v_stock.product_id::text), hashtext(v_stock.from_entity_id::text));

      select p.name
      into v_product_name
      from public.products p
      where p.id = v_stock.product_id;

      select coalesce(sum(cibl.quantity_on_hand), 0)::integer
      into v_available
      from public.current_inventory_by_location cibl
      where cibl.location_type = 'storage'
        and cibl.product_id = v_stock.product_id
        and cibl.location_id = v_stock.from_entity_id;

      v_needed := coalesce(v_stock.needed_qty, 0);
      if v_available is null or v_available <= 0 then
        raise exception 'Product % is missing from inventory at the selected storage location.', coalesce(v_product_name, v_stock.product_id::text)
          using errcode = 'P0001';
      end if;

      if v_available < v_needed then
        raise exception 'Not enough storage stock for %. Needed %, available %.', coalesce(v_product_name, v_stock.product_id::text), v_needed, v_available
          using errcode = 'P0001';
      end if;
    end loop;
  end if;

  if jsonb_array_length(v_new_stop_item_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    )
    left join public.route_stops rs
      on rs.id = x.route_stop_id
     and rs.route_id = p_route_id
    where x.id is null
      or x.route_stop_id is null
      or x.machine_id is null
      or x.product_id is null
      or coalesce(x.planned_quantity, 0) < 0
      or coalesce(x.picked_quantity, 0) < 0
      or x.source not in ('refill_recommendation', 'manual_admin_assignment')
      or rs.id is null
      or rs.machine_id <> x.machine_id
      or (v_expected_stop_count > 0 and x.route_stop_id <> all(p_selected_stop_ids));

    if v_invalid_count > 0 then
      raise exception 'Added pickup product is not linked to a valid selected stop.' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_array_length(v_stop_item_picks) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_stop_item_picks) as x(id uuid, picked_quantity integer)
    left join public.route_stop_items rsi
      on rsi.id = x.id
     and rsi.route_id = p_route_id
    left join jsonb_to_recordset(v_new_stop_item_rows) as new_rsi(id uuid)
      on new_rsi.id = x.id
    where x.id is null
      or x.picked_quantity is null
      or x.picked_quantity < 0
      or coalesce(rsi.id, new_rsi.id) is null;

    if v_invalid_count > 0 then
      raise exception 'Route pick item is missing from this route.' using errcode = 'P0001';
    end if;
  end if;

  if jsonb_array_length(v_refill_line_picks) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_refill_line_picks) as x(id uuid, picked_qty integer)
    left join public.refill_order_lines rol on rol.id = x.id
    left join public.refill_orders ro
      on ro.id = rol.refill_order_id
     and ro.route_id = p_route_id
    where x.id is null
      or x.picked_qty is null
      or x.picked_qty < 0
      or ro.id is null;

    if v_invalid_count > 0 then
      raise exception 'Refill order line is missing from this route.' using errcode = 'P0001';
    end if;
  end if;

  if p_pickup_batch is not null or coalesce(array_length(v_batch_stop_ids, 1), 0) > 0 then
    v_pickup_batch_id := coalesce(nullif(p_pickup_batch->>'id', '')::uuid, gen_random_uuid());

    insert into public.route_pickup_batches (
      id,
      route_id,
      operator_id,
      status,
      selected_stop_ids,
      product_summary,
      storage_deducted,
      confirmed_at
    )
    values (
      v_pickup_batch_id,
      p_route_id,
      coalesce(nullif(p_pickup_batch->>'operator_id', '')::uuid, v_route.operator_id),
      coalesce(nullif(p_pickup_batch->>'status', ''), 'confirmed'),
      coalesce(v_batch_stop_ids, '{}'::uuid[]),
      coalesce(p_pickup_batch->'product_summary', '[]'::jsonb),
      coalesce((p_pickup_batch->>'storage_deducted')::boolean, v_has_storage_deductions),
      coalesce(nullif(p_pickup_batch->>'confirmed_at', '')::timestamptz, now())
    );

    if coalesce(array_length(v_batch_stop_ids, 1), 0) > 0 then
      insert into public.route_pickup_batch_stops (pickup_batch_id, route_stop_id)
      select v_pickup_batch_id, unnest(v_batch_stop_ids)
      on conflict do nothing;
    end if;
  end if;

  if jsonb_array_length(v_new_stop_item_rows) > 0 then
    insert into public.route_stop_items (
      id,
      route_id,
      route_stop_id,
      machine_id,
      product_id,
      machine_slot_id,
      slot_code,
      planned_quantity,
      picked_quantity,
      source,
      notes
    )
    select
      x.id,
      p_route_id,
      x.route_stop_id,
      x.machine_id,
      x.product_id,
      x.machine_slot_id,
      x.slot_code,
      x.planned_quantity,
      x.picked_quantity,
      x.source,
      x.notes
    from jsonb_to_recordset(v_new_stop_item_rows) as x(
      id uuid,
      route_stop_id uuid,
      machine_id uuid,
      product_id uuid,
      machine_slot_id uuid,
      slot_code text,
      planned_quantity integer,
      picked_quantity integer,
      source text,
      notes text
    );
  end if;

  if p_replace_pick_list then
    delete from public.route_pick_list_items
    where route_id = p_route_id;
  end if;

  if jsonb_array_length(v_pick_list_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_pick_list_rows) as x(
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
      created_by uuid
    )
    left join public.route_stops rs
      on rs.id = x.route_stop_id
     and rs.route_id = p_route_id
    left join public.route_stop_items rsi
      on rsi.id = x.route_stop_item_id
     and rsi.route_id = p_route_id
    where x.product_id is null
      or x.planned_qty is null
      or x.picked_qty is null
      or x.planned_qty < 0
      or x.picked_qty < 0
      or x.action_type not in ('planned_pick', 'extra_product', 'substitution')
      or (x.route_stop_id is not null and rs.id is null)
      or (x.route_stop_id is not null and v_expected_stop_count > 0 and x.route_stop_id <> all(p_selected_stop_ids))
      or (x.route_stop_item_id is not null and rsi.id is null)
      or (x.route_stop_item_id is not null and x.route_stop_id is not null and rsi.route_stop_id <> x.route_stop_id)
      or (x.route_stop_id is not null and x.machine_id is not null and rs.machine_id <> x.machine_id);

    if v_invalid_count > 0 then
      raise exception 'Pick list row is not valid for the selected route stops.' using errcode = 'P0001';
    end if;

    insert into public.route_pick_list_items (
      route_id,
      route_stop_id,
      route_stop_item_id,
      machine_id,
      product_id,
      planned_qty,
      picked_qty,
      action_type,
      pickup_batch_id,
      reason,
      notes,
      needs_review,
      created_by
    )
    select
      p_route_id,
      x.route_stop_id,
      x.route_stop_item_id,
      x.machine_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      x.action_type,
      coalesce(x.pickup_batch_id, v_pickup_batch_id),
      x.reason,
      x.notes,
      coalesce(x.needs_review, false),
      x.created_by
    from jsonb_to_recordset(v_pick_list_rows) as x(
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
      created_by uuid
    );
  end if;

  if jsonb_array_length(v_inventory_movements) > 0 then
    insert into public.inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_route_id,
      related_pickup_batch_id,
      created_by,
      notes
    )
    select
      x.product_id,
      x.quantity,
      x.from_entity_type::public.inventory_entity_type,
      x.from_entity_id,
      x.to_entity_type::public.inventory_entity_type,
      x.to_entity_id,
      x.reason::public.movement_reason,
      p_route_id,
      case
        when x.reason = 'storage_to_operator_bag' then coalesce(x.related_pickup_batch_id, v_pickup_batch_id)
        else x.related_pickup_batch_id
      end,
      x.created_by,
      x.notes
    from jsonb_to_recordset(v_inventory_movements) as x(
      product_id uuid,
      quantity integer,
      from_entity_type text,
      from_entity_id uuid,
      to_entity_type text,
      to_entity_id uuid,
      reason text,
      related_pickup_batch_id uuid,
      created_by uuid,
      notes text
    );
  end if;

  if jsonb_array_length(v_stock_line_rows) > 0 then
    select count(*)
    into v_invalid_count
    from jsonb_to_recordset(v_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    where x.product_id is null
      or x.planned_qty is null
      or x.picked_qty is null
      or x.planned_qty < 0
      or x.picked_qty < 0;

    if v_invalid_count > 0 then
      raise exception 'Route stock line payload is invalid.' using errcode = 'P0001';
    end if;

    insert into public.route_stock_lines (
      route_id,
      product_id,
      planned_qty,
      picked_qty,
      updated_at
    )
    select
      p_route_id,
      x.product_id,
      x.planned_qty,
      x.picked_qty,
      coalesce(x.updated_at, now())
    from jsonb_to_recordset(v_stock_line_rows) as x(
      product_id uuid,
      planned_qty integer,
      picked_qty integer,
      updated_at timestamptz
    )
    on conflict (route_id, product_id)
    do update set
      planned_qty = excluded.planned_qty,
      picked_qty = excluded.picked_qty,
      updated_at = excluded.updated_at;
  end if;

  if jsonb_array_length(v_stop_item_picks) > 0 then
    update public.route_stop_items rsi
    set picked_quantity = x.picked_quantity,
        updated_at = now()
    from jsonb_to_recordset(v_stop_item_picks) as x(id uuid, picked_quantity integer)
    where rsi.id = x.id
      and rsi.route_id = p_route_id;
  end if;

  if jsonb_array_length(v_refill_line_picks) > 0 then
    update public.refill_order_lines rol
    set picked_qty = x.picked_qty
    from jsonb_to_recordset(v_refill_line_picks) as x(id uuid, picked_qty integer),
      public.refill_orders ro
    where rol.id = x.id
      and ro.id = rol.refill_order_id
      and ro.route_id = p_route_id;
  end if;

  if v_expected_stop_count > 0 then
    update public.route_stops
    set status = 'picked'::public.route_stop_status
    where route_id = p_route_id
      and id = any(p_selected_stop_ids)
      and status = 'pending'::public.route_stop_status;

    get diagnostics v_updated_stop_count = row_count;
    if v_updated_stop_count <> v_expected_stop_count then
      raise exception 'Stop status does not allow pickup confirmation: only pending stops can be picked for this route.'
        using errcode = 'P0001';
    end if;
  end if;

  select count(*)
  into v_pending_after_count
  from public.route_stops
  where route_id = p_route_id
    and status = 'pending'::public.route_stop_status;

  if v_pending_after_count = 0 then
    v_next_route_status := 'pickup_confirmed'::public.route_status;
  else
    v_next_route_status := 'in_progress'::public.route_status;
  end if;

  update public.routes
  set status = v_next_route_status,
      started_at = coalesce(started_at, p_started_at, now())
  where id = p_route_id;

  update public.refill_orders
  set status = 'picked'::public.refill_status
  where route_id = p_route_id
    and status in ('assigned'::public.refill_status, 'in_progress'::public.refill_status, 'picked'::public.refill_status)
    and (
      coalesce(array_length(p_selected_machine_ids, 1), 0) = 0
      or machine_id = any(p_selected_machine_ids)
    );

  return query select
    v_pickup_batch_id,
    v_next_route_status,
    coalesce(p_selected_stop_ids, '{}'::uuid[]),
    v_pending_after_count;
end;
$$;


ALTER FUNCTION "public"."confirm_route_pickup_batch"("p_route_id" "uuid", "p_expected_route_status" "public"."route_status", "p_next_route_status" "public"."route_status", "p_started_at" timestamp with time zone, "p_replace_pick_list" boolean, "p_pickup_batch" "jsonb", "p_batch_stop_ids" "uuid"[], "p_new_stop_item_rows" "jsonb", "p_inventory_movements" "jsonb", "p_pick_list_rows" "jsonb", "p_stock_line_rows" "jsonb", "p_stop_item_picks" "jsonb", "p_refill_line_picks" "jsonb", "p_selected_stop_ids" "uuid"[], "p_selected_machine_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_cash_collection_finance_transaction"("p_cash_collection_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select public.sync_cash_collection_to_financial_transaction(p_cash_collection_id)
$$;


ALTER FUNCTION "public"."ensure_cash_collection_finance_transaction"("p_cash_collection_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ensure_purchase_finance_transaction"("p_purchase_id" "uuid") RETURNS "uuid"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select public.sync_purchase_to_financial_transaction(p_purchase_id)
$$;


ALTER FUNCTION "public"."ensure_purchase_finance_transaction"("p_purchase_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."cash_collections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid",
    "machine_id" "uuid" NOT NULL,
    "operator_id" "uuid",
    "vms_expected_cash" numeric(12,2),
    "actual_cash_collected" numeric(12,2),
    "variance" numeric(12,2) GENERATED ALWAYS AS (("actual_cash_collected" - "vms_expected_cash")) STORED,
    "review_status" "text" DEFAULT 'ok'::"text" NOT NULL,
    "collected_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "notes" "text",
    "cash_bag_id" "text",
    "counted_at" timestamp with time zone,
    "counted_by" "uuid",
    "voided_at" timestamp with time zone,
    "voided_by" "uuid",
    "void_reason" "text",
    CONSTRAINT "cash_collections_review_status_check" CHECK (("review_status" = ANY (ARRAY['pending_collection'::"text", 'collected_pending_count'::"text", 'counted_confirmed'::"text", 'variance_review'::"text", 'voided'::"text"])))
);


ALTER TABLE "public"."cash_collections" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_cash_collection_should_sync"("p_cash" "public"."cash_collections") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select coalesce(p_cash.review_status, '') <> 'voided'
     and coalesce(p_cash.actual_cash_collected, p_cash.vms_expected_cash) is not null
$$;


ALTER FUNCTION "public"."finance_cash_collection_should_sync"("p_cash" "public"."cash_collections") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_health_report"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'information_schema', 'pg_catalog'
    AS $$
declare
  v_expected text[] := array[
    'id', 'transaction_date', 'transaction_datetime', 'direction', 'transaction_kind', 'transaction_type',
    'location', 'description', 'notes', 'amount', 'signed_amount', 'currency', 'account_id', 'account_key',
    'transaction_effect', 'source_account_id', 'destination_account_id', 'category', 'bucket', 'final_bucket',
    'payment_method', 'transaction_status', 'review_status', 'needs_review', 'source_type', 'source_id',
    'linked_purchase_id', 'linked_cash_collection_id', 'related_cash_collection_id', 'related_purchase_id',
    'related_route_id', 'related_machine_id', 'receipt_url', 'counterparty_text', 'payer_text', 'paid_to_text',
    'payee_text', 'is_void', 'voided_at', 'void_reason', 'created_at', 'updated_at', 'created_by'
  ];
  v_missing text[];
  v_purchase_count integer;
  v_cash_count integer;
  v_transaction_count integer;
  v_linked_purchase_count integer;
  v_linked_cash_count integer;
  v_missing_purchase_count integer;
  v_missing_cash_count integer;
begin
  select coalesce(array_agg(expected_column order by expected_column), array[]::text[])
  into v_missing
  from unnest(v_expected) as expected_column
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'financial_transactions'
      and c.column_name = expected_column
  );

  select count(*)::integer into v_purchase_count
  from public.purchase_orders po
  where public.finance_purchase_should_sync(po);

  select count(*)::integer into v_cash_count
  from public.cash_collections cc
  where public.finance_cash_collection_should_sync(cc);

  select count(*)::integer into v_transaction_count from public.financial_transactions;

  select count(*)::integer
  into v_linked_purchase_count
  from public.purchase_orders po
  where public.finance_purchase_should_sync(po)
    and exists (
      select 1
      from public.financial_transactions ft
      where ft.source_type = 'purchase'
        and ft.source_id = po.id
        and ft.linked_purchase_id = po.id
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  select count(*)::integer
  into v_linked_cash_count
  from public.cash_collections cc
  where public.finance_cash_collection_should_sync(cc)
    and exists (
      select 1
      from public.financial_transactions ft
      where ft.source_type = 'cash_collection'
        and ft.source_id = cc.id
        and ft.linked_cash_collection_id = cc.id
        and coalesce(ft.transaction_status, 'active') = 'active'
        and coalesce(ft.is_void, false) = false
    );

  v_missing_purchase_count := greatest(v_purchase_count - v_linked_purchase_count, 0);
  v_missing_cash_count := greatest(v_cash_count - v_linked_cash_count, 0);

  return jsonb_build_object(
    'schema_status', case when cardinality(v_missing) = 0 then 'ok' else 'missing_columns' end,
    'missing_columns', to_jsonb(v_missing),
    'transactions_count', v_transaction_count,
    'purchases_count', v_purchase_count,
    'cash_collections_count', v_cash_count,
    'purchases_with_linked_finance_transaction', v_linked_purchase_count,
    'cash_collections_with_linked_finance_transaction', v_linked_cash_count,
    'purchases_missing_finance_transaction', v_missing_purchase_count,
    'cash_collections_missing_finance_transaction', v_missing_cash_count,
    'failed_sync_count', v_missing_purchase_count + v_missing_cash_count,
    'source_types_in_overview', (
      select coalesce(jsonb_agg(distinct ft.source_type), '[]'::jsonb)
      from public.financial_transactions ft
      where ft.source_type in ('purchase', 'cash_collection')
    ),
    'schema_columns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'column_name', c.column_name,
        'data_type', c.data_type,
        'is_nullable', c.is_nullable,
        'column_default', c.column_default,
        'ordinal_position', c.ordinal_position
      ) order by c.ordinal_position), '[]'::jsonb)
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'financial_transactions'
    ),
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'constraint_name', tc.constraint_name,
        'constraint_type', tc.constraint_type,
        'definition', coalesce(cc.check_clause, '')
      ) order by tc.constraint_name), '[]'::jsonb)
      from information_schema.table_constraints tc
      left join information_schema.check_constraints cc on cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name
      where tc.table_schema = 'public' and tc.table_name = 'financial_transactions'
    ),
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'indexname', i.indexname,
        'indexdef', i.indexdef
      ) order by i.indexname), '[]'::jsonb)
      from pg_indexes i
      where i.schemaname = 'public' and i.tablename = 'financial_transactions'
    )
  );
end;
$$;


ALTER FUNCTION "public"."finance_health_report"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "order_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "expected_delivery_date" "date",
    "received_date" "date",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "receipt_number" "text",
    "payment_method" "text" DEFAULT 'cash'::"text" NOT NULL,
    "receipt_url" "text",
    "total_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "received_by" "uuid",
    "received_at" timestamp with time zone,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "manual_total_lyd" numeric(12,2),
    "calculated_total_lyd" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_adjustment_lyd" numeric(12,2),
    "total_source" "text" DEFAULT 'calculated'::"text" NOT NULL,
    "payment_status" "text" DEFAULT 'paid'::"text" NOT NULL,
    "voided_at" timestamp with time zone,
    "voided_by" "uuid",
    "void_reason" "text",
    "receipt_file_name" "text",
    "receipt_content_type" "text",
    "receipt_storage_path" "text",
    "currency" "text" DEFAULT 'LYD'::"text",
    CONSTRAINT "purchase_orders_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['unpaid'::"text", 'paid'::"text", 'partially_paid'::"text", 'voided'::"text"]))),
    CONSTRAINT "purchase_orders_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'received'::"text", 'cancelled'::"text", 'voided'::"text"]))),
    CONSTRAINT "purchase_orders_total_source_check" CHECK (("total_source" = ANY (ARRAY['calculated'::"text", 'manual'::"text"])))
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_purchase_should_sync"("p_purchase" "public"."purchase_orders") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select coalesce(p_purchase.status, '') not in ('cancelled', 'voided')
     and coalesce(p_purchase.payment_status, '') <> 'voided'
     and abs(coalesce(
       nullif(p_purchase.manual_total_lyd, 0),
       nullif(p_purchase.total_amount, 0),
       nullif(p_purchase.calculated_total_lyd, 0),
       nullif((
         select sum(coalesce(pol.line_total_lyd, pol.line_total, pol.total_units * pol.unit_cost, pol.received_qty * pol.unit_cost, pol.ordered_qty * pol.unit_cost, 0))
         from public.purchase_order_lines pol
         where pol.purchase_order_id = p_purchase.id
       ), 0),
       0
     )) > 0
$$;


ALTER FUNCTION "public"."finance_purchase_should_sync"("p_purchase" "public"."purchase_orders") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finance_source_sync_diagnosis"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_report jsonb;
begin
  select jsonb_build_object(
    'financial_transactions_count', (select count(*) from public.financial_transactions),
    'rows_by_source', (
      select coalesce(jsonb_agg(jsonb_build_object('source_type', source_type, 'count', count) order by source_type), '[]'::jsonb)
      from (select source_type, count(*)::integer as count from public.financial_transactions group by source_type) s
    ),
    'void_status', (
      select coalesce(jsonb_agg(jsonb_build_object('is_void', is_void, 'count', count) order by is_void), '[]'::jsonb)
      from (select is_void, count(*)::integer as count from public.financial_transactions group by is_void) v
    ),
    'recent_rows', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
      from (
        select id, transaction_date, amount, currency, direction, category, source_type, source_id,
               linked_purchase_id, linked_cash_collection_id, is_void, created_at
        from public.financial_transactions
        order by created_at desc
        limit 50
      ) r
    ),
    'missing_purchase_links', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.order_date desc), '[]'::jsonb)
      from (
        select p.id, p.order_date, p.total_amount, p.payment_status
        from public.purchase_orders p
        where not exists (
          select 1 from public.financial_transactions ft
          where ft.source_type = 'purchase'
            and ft.source_id = p.id
        )
        order by p.order_date desc
        limit 50
      ) p
    ),
    'missing_cash_collection_links', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb)
      from (
        select c.id, c.collected_at as collection_datetime, c.actual_cash_collected as total_cash_counted, c.created_at
        from public.cash_collections c
        where not exists (
          select 1 from public.financial_transactions ft
          where ft.source_type = 'cash_collection'
            and ft.source_id = c.id
        )
        order by c.created_at desc
        limit 50
      ) c
    )
  ) into v_report;

  return v_report;
end;
$$;


ALTER FUNCTION "public"."finance_source_sync_diagnosis"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_vms_schema_health"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_catalog'
    AS $$
declare
  missing_tables text[];
  missing_columns text[];
begin
  with required_tables(table_name) as (
    values
      ('vms_import_batches'),
      ('vms_import_previews'),
      ('vms_import_preview_rows'),
      ('vms_import_rows'),
      ('vms_sales_raw'),
      ('vms_transactions_raw'),
      ('vms_stock_snapshots'),
      ('vms_machine_stock_snapshots'),
      ('vms_sales_snapshots'),
      ('vms_product_mappings'),
      ('vms_machine_mappings'),
      ('vms_header_mappings')
  )
  select coalesce(array_agg(rt.table_name order by rt.table_name), array[]::text[])
  into missing_tables
  from required_tables rt
  where not exists (
    select 1
    from information_schema.tables ist
    where ist.table_schema = 'public'
      and ist.table_name = rt.table_name
      and ist.table_type = 'BASE TABLE'
  );

  with required_columns(table_name, column_name) as (
    values
      ('vms_import_batches', 'id'),
      ('vms_import_batches', 'uploaded_by'),
      ('vms_import_batches', 'uploaded_at'),
      ('vms_import_batches', 'file_name'),
      ('vms_import_batches', 'original_file_name'),
      ('vms_import_batches', 'report_type'),
      ('vms_import_batches', 'report_start_date'),
      ('vms_import_batches', 'report_end_date'),
      ('vms_import_batches', 'import_mode'),
      ('vms_import_batches', 'status'),
      ('vms_import_batches', 'rows_found'),
      ('vms_import_batches', 'rows_imported'),
      ('vms_import_batches', 'rows_skipped'),
      ('vms_import_batches', 'rows_skipped_duplicate'),
      ('vms_import_batches', 'rows_needing_review'),
      ('vms_import_batches', 'row_count'),
      ('vms_import_batches', 'error_count'),
      ('vms_import_batches', 'errors'),
      ('vms_import_batches', 'unknown_machines'),
      ('vms_import_batches', 'unmapped_products'),
      ('vms_import_batches', 'column_mapping'),
      ('vms_import_batches', 'preview_summary'),
      ('vms_import_batches', 'review_summary'),
      ('vms_import_batches', 'file_hash'),
      ('vms_import_batches', 'storage_path'),
      ('vms_import_batches', 'storage_bucket'),
      ('vms_import_batches', 'source_type'),
      ('vms_import_batches', 'file_type'),
      ('vms_import_batches', 'sheet_name'),
      ('vms_import_batches', 'imported_by'),
      ('vms_import_batches', 'imported_at'),
      ('vms_import_batches', 'detected_min_datetime'),
      ('vms_import_batches', 'detected_max_datetime'),
      ('vms_import_batches', 'total_successful_sales'),
      ('vms_import_batches', 'successful_rows_count'),
      ('vms_import_batches', 'failed_rows_count'),
      ('vms_import_batches', 'refunded_rows_count'),
      ('vms_import_batches', 'is_active'),
      ('vms_import_batches', 'disabled_at'),
      ('vms_import_batches', 'disabled_by'),
      ('vms_import_batches', 'disable_reason'),
      ('vms_import_batches', 'deleted_at'),
      ('vms_import_batches', 'deleted_by'),
      ('vms_import_batches', 'delete_reason'),
      ('vms_import_batches', 'source_usage'),
      ('vms_import_batches', 'dashboard_usage'),
      ('vms_import_batches', 'latest_error'),
      ('vms_import_batches', 'parse_diagnostics'),
      ('vms_import_batches', 'failed_at'),
      ('vms_import_batches', 'last_reprocessed_at'),
      ('vms_import_batches', 'reprocess_count'),
      ('vms_import_batches', 'notes'),
      ('vms_import_batches', 'created_at'),
      ('vms_import_batches', 'updated_at'),

      ('vms_import_previews', 'id'),
      ('vms_import_previews', 'file_name'),
      ('vms_import_previews', 'file_type'),
      ('vms_import_previews', 'report_type'),
      ('vms_import_previews', 'sheets'),
      ('vms_import_previews', 'uploaded_by'),
      ('vms_import_previews', 'created_at'),

      ('vms_import_preview_rows', 'id'),
      ('vms_import_preview_rows', 'import_batch_id'),
      ('vms_import_preview_rows', 'row_number'),
      ('vms_import_preview_rows', 'raw_row'),
      ('vms_import_preview_rows', 'normalized_row'),
      ('vms_import_preview_rows', 'mapped_product_id'),
      ('vms_import_preview_rows', 'mapped_machine_id'),
      ('vms_import_preview_rows', 'status'),
      ('vms_import_preview_rows', 'review_reason'),
      ('vms_import_preview_rows', 'suggested_mapping'),
      ('vms_import_preview_rows', 'duplicate_hash'),
      ('vms_import_preview_rows', 'created_at'),

      ('vms_import_rows', 'id'),
      ('vms_import_rows', 'import_batch_id'),
      ('vms_import_rows', 'row_number'),
      ('vms_import_rows', 'raw_data'),
      ('vms_import_rows', 'normalized_data'),
      ('vms_import_rows', 'validation_status'),
      ('vms_import_rows', 'validation_errors'),
      ('vms_import_rows', 'machine_match_status'),
      ('vms_import_rows', 'product_match_status'),
      ('vms_import_rows', 'matched_machine_id'),
      ('vms_import_rows', 'matched_product_id'),
      ('vms_import_rows', 'created_at'),

      ('vms_sales_raw', 'id'),
      ('vms_sales_raw', 'import_batch_id'),
      ('vms_sales_raw', 'row_number'),
      ('vms_sales_raw', 'raw_row'),
      ('vms_sales_raw', 'normalized_row'),
      ('vms_sales_raw', 'machine_id'),
      ('vms_sales_raw', 'product_id'),
      ('vms_sales_raw', 'sale_date'),
      ('vms_sales_raw', 'sale_datetime'),
      ('vms_sales_raw', 'quantity'),
      ('vms_sales_raw', 'gross_sales_lyd'),
      ('vms_sales_raw', 'net_sales_lyd'),
      ('vms_sales_raw', 'duplicate_hash'),
      ('vms_sales_raw', 'created_at'),

      ('vms_transactions_raw', 'id'),
      ('vms_transactions_raw', 'import_batch_id'),
      ('vms_transactions_raw', 'row_number'),
      ('vms_transactions_raw', 'raw_row'),
      ('vms_transactions_raw', 'normalized_row'),
      ('vms_transactions_raw', 'machine_code'),
      ('vms_transactions_raw', 'machine_name'),
      ('vms_transactions_raw', 'mapped_machine_id'),
      ('vms_transactions_raw', 'product_number'),
      ('vms_transactions_raw', 'vms_product_name'),
      ('vms_transactions_raw', 'mapped_product_id'),
      ('vms_transactions_raw', 'order_number'),
      ('vms_transactions_raw', 'payment_time'),
      ('vms_transactions_raw', 'delivery_time'),
      ('vms_transactions_raw', 'payment_amount'),
      ('vms_transactions_raw', 'quantity'),
      ('vms_transactions_raw', 'transaction_status'),
      ('vms_transactions_raw', 'duplicate_hash'),
      ('vms_transactions_raw', 'created_at'),

      ('vms_stock_snapshots', 'id'),
      ('vms_stock_snapshots', 'import_batch_id'),
      ('vms_stock_snapshots', 'import_row_number'),
      ('vms_stock_snapshots', 'import_row_status'),
      ('vms_stock_snapshots', 'sync_run_id'),
      ('vms_stock_snapshots', 'source_provider'),
      ('vms_stock_snapshots', 'machine_id'),
      ('vms_stock_snapshots', 'vms_machine_id'),
      ('vms_stock_snapshots', 'slot_code'),
      ('vms_stock_snapshots', 'vms_product_id'),
      ('vms_stock_snapshots', 'vms_product_name'),
      ('vms_stock_snapshots', 'product_id'),
      ('vms_stock_snapshots', 'current_qty'),
      ('vms_stock_snapshots', 'capacity'),
      ('vms_stock_snapshots', 'captured_at'),
      ('vms_stock_snapshots', 'temperature_c'),
      ('vms_stock_snapshots', 'cash_balance_lyd'),
      ('vms_stock_snapshots', 'tray_status'),
      ('vms_stock_snapshots', 'metadata'),
      ('vms_stock_snapshots', 'created_at'),

      ('vms_machine_stock_snapshots', 'id'),
      ('vms_machine_stock_snapshots', 'import_batch_id'),
      ('vms_machine_stock_snapshots', 'row_number'),
      ('vms_machine_stock_snapshots', 'machine_id'),
      ('vms_machine_stock_snapshots', 'product_id'),
      ('vms_machine_stock_snapshots', 'machine_code'),
      ('vms_machine_stock_snapshots', 'machine_name'),
      ('vms_machine_stock_snapshots', 'point_name'),
      ('vms_machine_stock_snapshots', 'vms_product_code'),
      ('vms_machine_stock_snapshots', 'vms_product_name'),
      ('vms_machine_stock_snapshots', 'inventory_quantity'),
      ('vms_machine_stock_snapshots', 'out_of_stock_quantity'),
      ('vms_machine_stock_snapshots', 'inventory_capacity'),
      ('vms_machine_stock_snapshots', 'raw_row'),
      ('vms_machine_stock_snapshots', 'created_at'),

      ('vms_sales_snapshots', 'id'),
      ('vms_sales_snapshots', 'import_batch_id'),
      ('vms_sales_snapshots', 'import_row_number'),
      ('vms_sales_snapshots', 'import_row_status'),
      ('vms_sales_snapshots', 'machine_id'),
      ('vms_sales_snapshots', 'product_id'),
      ('vms_sales_snapshots', 'sold_qty'),
      ('vms_sales_snapshots', 'sales_amount'),
      ('vms_sales_snapshots', 'cash_sales_amount'),
      ('vms_sales_snapshots', 'card_sales_amount'),
      ('vms_sales_snapshots', 'period_start'),
      ('vms_sales_snapshots', 'period_end'),
      ('vms_sales_snapshots', 'cost_amount'),
      ('vms_sales_snapshots', 'profit_amount'),
      ('vms_sales_snapshots', 'metadata'),
      ('vms_sales_snapshots', 'created_at'),

      ('vms_product_mappings', 'id'),
      ('vms_product_mappings', 'vms_product_code'),
      ('vms_product_mappings', 'vms_product_id'),
      ('vms_product_mappings', 'vms_product_name'),
      ('vms_product_mappings', 'snacky_product_id'),
      ('vms_product_mappings', 'product_id'),
      ('vms_product_mappings', 'confidence_score'),
      ('vms_product_mappings', 'status'),
      ('vms_product_mappings', 'created_by'),
      ('vms_product_mappings', 'created_at'),
      ('vms_product_mappings', 'updated_at'),

      ('vms_machine_mappings', 'id'),
      ('vms_machine_mappings', 'vms_machine_code'),
      ('vms_machine_mappings', 'vms_machine_name'),
      ('vms_machine_mappings', 'machine_id'),
      ('vms_machine_mappings', 'confidence_score'),
      ('vms_machine_mappings', 'status'),
      ('vms_machine_mappings', 'created_by'),
      ('vms_machine_mappings', 'created_at'),
      ('vms_machine_mappings', 'updated_at'),

      ('vms_header_mappings', 'id'),
      ('vms_header_mappings', 'report_type'),
      ('vms_header_mappings', 'source_header'),
      ('vms_header_mappings', 'target_field'),
      ('vms_header_mappings', 'created_by'),
      ('vms_header_mappings', 'created_at'),
      ('vms_header_mappings', 'updated_at')
  )
  select coalesce(array_agg(rc.table_name || '.' || rc.column_name order by rc.table_name, rc.column_name), array[]::text[])
  into missing_columns
  from required_columns rc
  where exists (
    select 1
    from information_schema.tables ist
    where ist.table_schema = 'public'
      and ist.table_name = rc.table_name
      and ist.table_type = 'BASE TABLE'
  )
    and not exists (
      select 1
      from information_schema.columns isc
      where isc.table_schema = 'public'
        and isc.table_name = rc.table_name
        and isc.column_name = rc.column_name
    );

  return jsonb_build_object(
    'checked', true,
    'missing_tables', to_jsonb(missing_tables),
    'missing_columns', to_jsonb(missing_columns),
    'migration_status', jsonb_build_object(
      'core_tables_ready', cardinality(missing_tables) = 0,
      'required_columns_ready', cardinality(missing_columns) = 0,
      'schema_ready', cardinality(missing_tables) = 0 and cardinality(missing_columns) = 0
    )
  );
end;
$$;


ALTER FUNCTION "public"."get_vms_schema_health"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_inventory_movement_activity"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  activity_actor_user_id uuid;
  activity_actor_name text;
  activity_actor_role text;
begin
  if new.created_by is not null then
    select p.id, coalesce(tm.full_name, p.full_name), coalesce(tm.role::text, p.role::text)
      into activity_actor_user_id, activity_actor_name, activity_actor_role
    from team_members tm
    left join profiles p on p.team_member_id = tm.id
    where tm.id = new.created_by
    order by p.created_at nulls last
    limit 1;
  end if;

  insert into system_activity_logs (
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
  )
  values (
    activity_actor_user_id,
    new.created_by,
    activity_actor_name,
    activity_actor_role,
    'create_inventory_movement',
    'inventory_movement',
    new.id,
    concat(replace(new.reason::text, '_', ' '), ' ', new.quantity::text),
    concat('Created ', replace(new.reason::text, '_', ' '), ' movement for ', new.quantity::text, ' units'),
    to_jsonb(new),
    jsonb_build_object(
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
$$;


ALTER FUNCTION "public"."log_inventory_movement_activity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_issue_sla_due_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.created_at is null then
    new.created_at := now();
  end if;

  new.sla_due_at :=
    case
      when new.priority = 'critical' then new.created_at + interval '24 hours'
      when new.priority = 'high' then new.created_at + interval '24 hours'
      else new.created_at + interval '72 hours'
    end;

  return new;
end;
$$;


ALTER FUNCTION "public"."set_issue_sla_due_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_cash_collection_finance_sync_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
begin
  perform public.sync_cash_collection_to_financial_transaction(new.id);
  return new;
end;
$$;


ALTER FUNCTION "public"."snacky_cash_collection_finance_sync_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_create_purchase_with_lines"("p_supplier_id" "uuid", "p_order_date" "date", "p_receipt_number" "text", "p_payment_method" "text", "p_payment_status" "text", "p_receipt_url" "text", "p_receipt_file_name" "text", "p_receipt_content_type" "text", "p_receipt_storage_path" "text", "p_notes" "text", "p_calculated_total_lyd" numeric, "p_manual_total_lyd" numeric, "p_total_adjustment_lyd" numeric, "p_total_source" "text", "p_total_amount" numeric, "p_created_by" "uuid", "p_submit_action" "text", "p_lines" "jsonb") RETURNS TABLE("id" "uuid", "receipt_number" "text", "status" "text", "total_amount" numeric, "payment_status" "text", "movement_count" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_purchase_id uuid;
  v_storage_id uuid;
  v_submit_action text;
  v_payment_status text;
  v_total_source text;
  v_total_amount numeric;
  v_created_by uuid;
  v_actor_team_member_id uuid;
  v_movement_count integer := 0;
begin
  if not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']) then
    raise exception 'Permission denied for purchase save' using errcode = '42501';
  end if;

  select coalesce(p.team_member_id, tm.id)
  into v_actor_team_member_id
  from public.profiles p
  left join public.team_members tm
    on tm.id = p.team_member_id
    or tm.auth_user_id = p.id
  where p.id = auth.uid()
    and p.active_status = 'active'
  limit 1;

  if p_created_by is not null
    and v_actor_team_member_id is not null
    and p_created_by <> v_actor_team_member_id
    and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])
  then
    raise exception 'Permission denied for purchase actor' using errcode = '42501';
  end if;

  v_created_by := coalesce(v_actor_team_member_id, p_created_by);
  v_submit_action := case
    when lower(trim(coalesce(p_submit_action, ''))) in ('received', 'receive', 'submitted', 'submit') then 'received'
    else 'draft'
  end;
  v_payment_status := lower(trim(coalesce(p_payment_status, 'paid')));
  if v_payment_status = 'partial' then
    v_payment_status := 'partially_paid';
  end if;
  if v_payment_status not in ('paid', 'unpaid', 'partially_paid', 'voided') then
    v_payment_status := 'paid';
  end if;
  v_total_source := case
    when lower(trim(coalesce(p_total_source, ''))) = 'manual' then 'manual'
    else 'calculated'
  end;
  v_total_amount := greatest(coalesce(p_total_amount, p_manual_total_lyd, p_calculated_total_lyd, 0), 0);

  if coalesce(jsonb_typeof(p_lines), '') <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Purchase must include at least one line item' using errcode = '22023';
  end if;

  insert into public.purchase_orders (
    supplier_id,
    status,
    order_date,
    receipt_number,
    payment_method,
    payment_status,
    receipt_url,
    receipt_file_name,
    receipt_content_type,
    receipt_storage_path,
    notes,
    calculated_total_lyd,
    manual_total_lyd,
    total_adjustment_lyd,
    total_source,
    total_amount,
    created_by
  )
  values (
    p_supplier_id,
    'draft',
    coalesce(p_order_date, current_date),
    nullif(trim(coalesce(p_receipt_number, '')), ''),
    coalesce(nullif(trim(coalesce(p_payment_method, '')), ''), 'cash'),
    v_payment_status,
    nullif(trim(coalesce(p_receipt_url, '')), ''),
    nullif(trim(coalesce(p_receipt_file_name, '')), ''),
    nullif(trim(coalesce(p_receipt_content_type, '')), ''),
    nullif(trim(coalesce(p_receipt_storage_path, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    greatest(coalesce(p_calculated_total_lyd, 0), 0),
    p_manual_total_lyd,
    p_total_adjustment_lyd,
    v_total_source,
    v_total_amount,
    v_created_by
  )
  returning purchase_orders.id into v_purchase_id;

  with parsed_lines as (
    select
      line.product_id,
      greatest(coalesce(line.line_position, 0), 0) as line_position,
      floor(greatest(coalesce(line.boxes_qty, line.box_qty, line.box_quantity, 0), 0))::integer as boxes_qty,
      floor(greatest(coalesce(line.units_per_box, line.pieces_per_box, 1), 1))::integer as units_per_box,
      floor(greatest(coalesce(line.loose_units_qty, line.loose_units, 0), 0))::integer as loose_units_qty,
      line.total_units as explicit_total_units,
      line.received_units,
      line.quantity,
      line.ordered_qty,
      greatest(coalesce(line.unit_cost, line.unit_cost_lyd, 0), 0) as raw_unit_cost,
      greatest(coalesce(line.line_total, line.line_total_lyd, 0), 0) as raw_line_total
    from jsonb_to_recordset(p_lines) as line(
      product_id uuid,
      line_position integer,
      boxes_qty numeric,
      box_qty numeric,
      box_quantity numeric,
      units_per_box numeric,
      pieces_per_box numeric,
      loose_units_qty numeric,
      loose_units numeric,
      total_units numeric,
      received_units numeric,
      quantity numeric,
      ordered_qty numeric,
      unit_cost numeric,
      unit_cost_lyd numeric,
      line_total numeric,
      line_total_lyd numeric,
      notes text
    )
  ),
  normalized_lines as (
    select
      parsed_lines.product_id,
      parsed_lines.line_position,
      parsed_lines.boxes_qty,
      parsed_lines.units_per_box,
      parsed_lines.loose_units_qty,
      floor(
        greatest(
          coalesce(
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as total_units,
      floor(
        greatest(
          coalesce(
            parsed_lines.ordered_qty,
            parsed_lines.explicit_total_units,
            parsed_lines.received_units,
            parsed_lines.quantity,
            (parsed_lines.boxes_qty * parsed_lines.units_per_box + parsed_lines.loose_units_qty)::numeric
          ),
          0
        )
      )::integer as ordered_qty,
      parsed_lines.raw_unit_cost,
      parsed_lines.raw_line_total
    from parsed_lines
  ),
  priced_lines as (
    select
      normalized_lines.product_id,
      normalized_lines.line_position,
      normalized_lines.boxes_qty,
      normalized_lines.units_per_box,
      normalized_lines.loose_units_qty,
      normalized_lines.total_units,
      greatest(normalized_lines.ordered_qty, normalized_lines.total_units) as ordered_qty,
      case
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.raw_unit_cost
        when normalized_lines.raw_line_total > 0 and normalized_lines.total_units > 0 then normalized_lines.raw_line_total / normalized_lines.total_units
        else 0
      end as unit_cost,
      case
        when normalized_lines.raw_line_total > 0 then normalized_lines.raw_line_total
        when normalized_lines.raw_unit_cost > 0 then normalized_lines.total_units * normalized_lines.raw_unit_cost
        else 0
      end as line_total
    from normalized_lines
  )
  insert into public.purchase_order_lines (
    purchase_order_id,
    product_id,
    line_position,
    boxes_qty,
    units_per_box,
    loose_units_qty,
    total_units,
    ordered_qty,
    received_qty,
    unit_cost,
    unit_cost_lyd,
    line_total,
    line_total_lyd
  )
  select
    v_purchase_id,
    priced_lines.product_id,
    priced_lines.line_position,
    priced_lines.boxes_qty,
    priced_lines.units_per_box,
    priced_lines.loose_units_qty,
    priced_lines.total_units,
    priced_lines.ordered_qty,
    case when v_submit_action = 'received' then priced_lines.total_units else 0 end,
    priced_lines.unit_cost,
    priced_lines.unit_cost,
    priced_lines.line_total,
    priced_lines.line_total
  from priced_lines
  where priced_lines.product_id is not null
    and priced_lines.total_units > 0;

  if not exists (select 1 from public.purchase_order_lines where purchase_order_id = v_purchase_id) then
    raise exception 'Purchase must include at least one valid line item' using errcode = '22023';
  end if;

  if v_submit_action = 'received' then
    select sl.id
    into v_storage_id
    from public.storage_locations sl
    where sl.active = true
      and sl.location_type = 'main_storage'
    order by sl.name
    limit 1;

    if v_storage_id is null then
      select sl.id
      into v_storage_id
      from public.storage_locations sl
      where sl.active = true
        and sl.location_type in ('vehicle', 'temporary', 'other')
      order by sl.name
      limit 1;
    end if;

    if v_storage_id is null then
      raise exception 'No active storage location found' using errcode = '23514';
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
      created_by,
      notes
    )
    select
      pol.product_id,
      pol.total_units,
      'supplier',
      p_supplier_id,
      'storage',
      v_storage_id,
      'purchase_received',
      v_purchase_id,
      pol.id,
      coalesce(pol.unit_cost_lyd, pol.unit_cost, 0),
      coalesce(pol.line_total_lyd, pol.line_total, 0),
      v_created_by,
      'Purchase received'
    from public.purchase_order_lines pol
    where pol.purchase_order_id = v_purchase_id
      and pol.total_units > 0;

    get diagnostics v_movement_count = row_count;

    if v_movement_count = 0 then
      raise exception 'Purchase receipt created no inventory movements' using errcode = '23514';
    end if;

    with latest_line as (
      select distinct on (pol.product_id)
        pol.product_id,
        pol.id as purchase_line_id,
        round(coalesce(pol.unit_cost_lyd, pol.unit_cost, 0)::numeric, 4) as latest_cost
      from public.purchase_order_lines pol
      where pol.purchase_order_id = v_purchase_id
        and coalesce(pol.unit_cost_lyd, pol.unit_cost, 0) > 0
      order by pol.product_id, pol.line_position desc, pol.id desc
    )
    update public.products p
    set
      cost_price = round(latest_line.latest_cost, 2),
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      last_purchase_date = coalesce(p_order_date, current_date),
      last_supplier_id = p_supplier_id,
      last_purchase_line_id = latest_line.purchase_line_id,
      cost_price_source = 'latest_purchase',
      price_updated_at = now(),
      updated_at = now()
    from latest_line
    where p.id = latest_line.product_id;

    update public.purchase_orders po
    set
      status = 'received',
      received_at = now(),
      received_date = current_date,
      received_by = v_created_by,
      updated_at = now()
    where po.id = v_purchase_id;
  end if;

  return query
  select
    po.id,
    po.receipt_number,
    po.status,
    po.total_amount,
    po.payment_status,
    v_movement_count
  from public.purchase_orders po
  where po.id = v_purchase_id;
end;
$$;


ALTER FUNCTION "public"."snacky_create_purchase_with_lines"("p_supplier_id" "uuid", "p_order_date" "date", "p_receipt_number" "text", "p_payment_method" "text", "p_payment_status" "text", "p_receipt_url" "text", "p_receipt_file_name" "text", "p_receipt_content_type" "text", "p_receipt_storage_path" "text", "p_notes" "text", "p_calculated_total_lyd" numeric, "p_manual_total_lyd" numeric, "p_total_adjustment_lyd" numeric, "p_total_source" "text", "p_total_amount" numeric, "p_created_by" "uuid", "p_submit_action" "text", "p_lines" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_current_profile_can_add_products"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        p.can_add_products = true
        or tm.can_add_products = true
        or public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'warehouse', 'purchasing'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'warehouse', 'purchasing'])
      )
  );
$$;


ALTER FUNCTION "public"."snacky_current_profile_can_add_products"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_current_profile_can_manage_vms_mappings"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;


ALTER FUNCTION "public"."snacky_current_profile_can_manage_vms_mappings"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_current_profile_can_view_vms_import"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;


ALTER FUNCTION "public"."snacky_current_profile_can_view_vms_import"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_current_profile_has_any_role"("allowed_roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
        or public.snacky_profile_has_any_role(tm.roles, tm.role, allowed_roles)
      )
  );
$$;


ALTER FUNCTION "public"."snacky_current_profile_has_any_role"("allowed_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_operator_can_access_route"("target_route_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    join public.routes r on r.id = target_route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor', 'operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor', 'operator'])
      )
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
        or r.operator_id = coalesce(p.team_member_id, tm.id)
        or (
          r.operator_id is null
          and r.status::text in ('available', 'ready', 'assigned', 'draft')
        )
      )
  );
$$;


ALTER FUNCTION "public"."snacky_operator_can_access_route"("target_route_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_operator_can_read_product"("target_product_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select exists (
    select 1
    from public.profiles p
    left join public.team_members tm
      on tm.id = p.team_member_id
      or tm.auth_user_id = p.id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and coalesce(p.team_member_id, tm.id) is not null
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
        or public.snacky_profile_has_any_role(tm.roles, tm.role, array['operator'])
      )
      and (
        exists (
          select 1
          from public.routes r
          join public.route_stock_lines rsl on rsl.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsl.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.route_stop_items rsi on rsi.route_id = r.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rsi.product_id = target_product_id
        )
        or exists (
          select 1
          from public.routes r
          join public.refill_orders ro on ro.route_id = r.id
          join public.refill_order_lines rol on rol.refill_order_id = ro.id
          where r.operator_id = coalesce(p.team_member_id, tm.id)
            and rol.product_id = target_product_id
        )
      )
  );
$$;


ALTER FUNCTION "public"."snacky_operator_can_read_product"("target_product_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_profile_has_any_role"("profile_roles" "public"."team_role"[], "primary_role" "public"."team_role", "allowed_roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1
    from unnest(array_remove(coalesce(profile_roles, array[]::team_role[]) || array[primary_role], null)) as role_value
    where role_value::text = any(allowed_roles)
       or (role_value::text = 'procurement' and 'purchasing' = any(allowed_roles))
  );
$$;


ALTER FUNCTION "public"."snacky_profile_has_any_role"("profile_roles" "public"."team_role"[], "primary_role" "public"."team_role", "allowed_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_purchase_finance_sync_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
begin
  perform public.sync_purchase_to_financial_transaction(new.id);
  return new;
end;
$$;


ALTER FUNCTION "public"."snacky_purchase_finance_sync_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_seed_clean_text"("value" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select case
    when btrim(coalesce(value, '')) = '' then null
    when upper(btrim(coalesce(value, ''))) = 'TO_CONFIRM' then null
    else btrim(value)
  end
$$;


ALTER FUNCTION "public"."snacky_seed_clean_text"("value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_seed_date"("value" "text") RETURNS "date"
    LANGUAGE "plpgsql" IMMUTABLE
    AS $$
begin
  if public.snacky_seed_clean_text(value) is null then
    return null;
  end if;

  return public.snacky_seed_clean_text(value)::date;
exception when others then
  return null;
end;
$$;


ALTER FUNCTION "public"."snacky_seed_date"("value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_seed_numeric"("value" "text") RETURNS numeric
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select case
    when public.snacky_seed_clean_text(value) ~ '^-?[0-9]+(\.[0-9]+)?$'
      then public.snacky_seed_clean_text(value)::numeric
    else null
  end
$_$;


ALTER FUNCTION "public"."snacky_seed_numeric"("value" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_storage_can_access_route"("route_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select exists (
    select 1
    from public.profiles p
    left join public.routes r on r.id = route_id
    where p.id = auth.uid()
      and p.active_status = 'active'
      and (
        public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
        or (
          public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
          and p.team_member_id is not null
          and r.operator_id = p.team_member_id
        )
      )
  );
$$;


ALTER FUNCTION "public"."snacky_storage_can_access_route"("route_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_storage_has_role"("allowed_roles" "text"[]) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.active_status = 'active'
      and public.snacky_profile_has_any_role(p.roles, p.role, allowed_roles)
  );
$$;


ALTER FUNCTION "public"."snacky_storage_has_role"("allowed_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_storage_route_id"("object_name" "text") RETURNS "uuid"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select case
    when split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(object_name, '/', 1)::uuid
    else null
  end;
$_$;


ALTER FUNCTION "public"."snacky_storage_route_id"("object_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."snacky_sync_vms_product_mapping_aliases"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  resolved_product_name text;
begin
  new.vms_product_code = nullif(coalesce(new.vms_product_code, new.vms_product_id), '');
  new.vms_product_id = nullif(coalesce(new.vms_product_id, new.vms_product_code), '');
  new.snacky_product_id = coalesce(new.snacky_product_id, new.product_id);
  new.product_id = coalesce(new.product_id, new.snacky_product_id);
  new.status = coalesce(nullif(new.status, ''), nullif(new.match_status, ''), 'confirmed');
  new.match_status = coalesce(nullif(new.match_status, ''), new.status);
  new.confidence_score = coalesce(new.confidence_score, case when new.product_id is null then 0 else 1 end);

  if new.product_id is null then
    new.snacky_product_name = null;
  elsif nullif(new.snacky_product_name, '') is null then
    select p.name into resolved_product_name
    from public.products p
    where p.id = new.product_id;
    new.snacky_product_name = resolved_product_name;
  end if;

  new.created_at = coalesce(new.created_at, now());
  new.updated_at = now();
  return new;
end $$;


ALTER FUNCTION "public"."snacky_sync_vms_product_mapping_aliases"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_cash_collection_to_financial_transaction"("p_cash_collection_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_cash public.cash_collections%rowtype;
  v_machine_name text;
  v_machine_code text;
  v_location_name text;
  v_amount numeric(12,2);
  v_datetime timestamptz;
  v_location text;
  v_notes text;
  v_transaction_id uuid;
begin
  select * into v_cash
  from public.cash_collections
  where id = p_cash_collection_id;

  if not found then
    raise exception 'Cash collection % not found', p_cash_collection_id using errcode = 'P0002';
  end if;

  select nullif(trim(m.name), ''), nullif(trim(m.machine_code), ''), nullif(trim(l.name), '')
    into v_machine_name, v_machine_code, v_location_name
  from public.machines m
  left join public.locations l on l.id = m.location_id
  where m.id = v_cash.machine_id;

  v_amount := abs(coalesce(v_cash.actual_cash_collected, v_cash.vms_expected_cash, 0))::numeric(12,2);
  v_datetime := coalesce(v_cash.collected_at, v_cash.counted_at, now());
  v_location := coalesce(v_location_name, v_machine_name, v_machine_code);
  v_notes := concat_ws(
    ' - ',
    'Cash collection',
    coalesce(v_machine_name, v_machine_code, p_cash_collection_id::text),
    v_location_name,
    case when v_cash.actual_cash_collected is null and v_cash.vms_expected_cash is not null then 'Expected cash pending count' end,
    case when nullif(trim(v_cash.cash_bag_id), '') is not null then 'Bag ' || v_cash.cash_bag_id end
  );

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_cash_collection_id = p_cash_collection_id
     or ft.related_cash_collection_id = p_cash_collection_id
     or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if not public.finance_cash_collection_should_sync(v_cash) then
    if v_transaction_id is not null then
      update public.financial_transactions
      set transaction_status = 'voided',
          is_void = true,
          voided_at = coalesce(voided_at, now()),
          void_reason = coalesce(void_reason, 'Source cash collection no longer qualifies for finance sync'),
          source_type = 'cash_collection',
          source_id = p_cash_collection_id,
          linked_cash_collection_id = p_cash_collection_id,
          related_cash_collection_id = p_cash_collection_id,
          updated_at = now()
      where id = v_transaction_id;
    end if;
    return v_transaction_id;
  end if;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      location, description, notes, amount, signed_amount, currency, account_id, account_key,
      transaction_effect, source_account_id, destination_account_id, bucket, final_bucket,
      payment_method, transaction_status, review_status, needs_review, is_void,
      counterparty_text, payer_text, paid_to_text, payee_text,
      linked_cash_collection_id, related_cash_collection_id, related_route_id, related_machine_id, source_type, source_id,
      created_by, updated_at
    ) values (
      v_datetime::date, v_datetime, 'money_in', 'cash_collection', 'Revenue', 'Revenue',
      v_location, v_notes, v_notes, v_amount, abs(v_amount), 'LYD', 'snacky_lyd', 'snacky_lyd',
      'income', null, null, 'Revenue', 'Revenue', 'cash', 'active', 'confirmed', false, false,
      'Cash customers', 'Cash customers', null, null,
      p_cash_collection_id, p_cash_collection_id, v_cash.route_id, v_cash.machine_id, 'cash_collection', p_cash_collection_id,
      v_cash.operator_id, now()
    ) returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = v_datetime::date,
        transaction_datetime = v_datetime,
        direction = 'money_in',
        transaction_kind = 'cash_collection',
        transaction_type = 'Revenue',
        category = 'Revenue',
        location = v_location,
        description = v_notes,
        notes = v_notes,
        amount = v_amount,
        signed_amount = abs(v_amount),
        currency = 'LYD',
        account_id = 'snacky_lyd',
        account_key = 'snacky_lyd',
        transaction_effect = 'income',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Revenue',
        final_bucket = 'Revenue',
        payment_method = 'cash',
        transaction_status = 'active',
        review_status = 'confirmed',
        needs_review = false,
        is_void = false,
        voided_at = null,
        void_reason = null,
        counterparty_text = 'Cash customers',
        payer_text = 'Cash customers',
        paid_to_text = null,
        payee_text = null,
        linked_cash_collection_id = p_cash_collection_id,
        related_cash_collection_id = p_cash_collection_id,
        related_route_id = v_cash.route_id,
        related_machine_id = v_cash.machine_id,
        source_type = 'cash_collection',
        source_id = p_cash_collection_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  update public.financial_transactions ft
  set transaction_status = 'voided',
      is_void = true,
      voided_at = coalesce(ft.voided_at, now()),
      void_reason = coalesce(ft.void_reason, 'Duplicate cash collection finance transaction superseded by ' || v_transaction_id::text),
      linked_cash_collection_id = null,
      related_cash_collection_id = null,
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_cash_collection_id = p_cash_collection_id
      or ft.related_cash_collection_id = p_cash_collection_id
      or (ft.source_type = 'cash_collection' and ft.source_id = p_cash_collection_id));

  return v_transaction_id;
end;
$$;


ALTER FUNCTION "public"."sync_cash_collection_to_financial_transaction"("p_cash_collection_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_purchase_to_financial_transaction"("p_purchase_id" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
declare
  v_purchase public.purchase_orders%rowtype;
  v_supplier_name text;
  v_lines_total numeric(12,2);
  v_amount numeric(12,2);
  v_account_key text;
  v_currency text;
  v_notes text;
  v_description text;
  v_transaction_id uuid;
begin
  select * into v_purchase
  from public.purchase_orders
  where id = p_purchase_id;

  if not found then
    raise exception 'Purchase % not found', p_purchase_id using errcode = 'P0002';
  end if;

  select nullif(trim(s.name), '') into v_supplier_name
  from public.suppliers s
  where s.id = v_purchase.supplier_id;

  select coalesce(sum(coalesce(pol.line_total_lyd, pol.line_total, pol.total_units * pol.unit_cost, pol.received_qty * pol.unit_cost, pol.ordered_qty * pol.unit_cost, 0)), 0)::numeric(12,2)
    into v_lines_total
  from public.purchase_order_lines pol
  where pol.purchase_order_id = p_purchase_id;

  v_amount := abs(coalesce(nullif(v_purchase.manual_total_lyd, 0), nullif(v_purchase.total_amount, 0), nullif(v_purchase.calculated_total_lyd, 0), nullif(v_lines_total, 0), 0))::numeric(12,2);
  v_account_key := coalesce(nullif(trim(v_purchase.payment_account_id), ''), 'snacky_lyd');
  v_currency := coalesce(nullif(trim(v_purchase.currency), ''), case when lower(v_account_key) like '%usd%' then 'USD' else 'LYD' end, 'LYD');
  v_notes := concat_ws(' / ', nullif(trim(v_purchase.notes), ''), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end);
  v_description := concat_ws(' - ', 'Purchase from ' || coalesce(v_supplier_name, 'supplier'), case when nullif(trim(v_purchase.receipt_number), '') is not null then 'Receipt ' || v_purchase.receipt_number end);

  select ft.id into v_transaction_id
  from public.financial_transactions ft
  where ft.linked_purchase_id = p_purchase_id
     or ft.related_purchase_id = p_purchase_id
     or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id)
  order by case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
           ft.created_at,
           ft.id
  limit 1;

  if not public.finance_purchase_should_sync(v_purchase) then
    if v_transaction_id is not null then
      update public.financial_transactions
      set transaction_status = 'voided',
          is_void = true,
          voided_at = coalesce(voided_at, now()),
          void_reason = coalesce(void_reason, 'Source purchase no longer qualifies for finance sync'),
          source_type = 'purchase',
          source_id = p_purchase_id,
          linked_purchase_id = p_purchase_id,
          related_purchase_id = p_purchase_id,
          updated_at = now()
      where id = v_transaction_id;
    end if;
    return v_transaction_id;
  end if;

  if v_transaction_id is null then
    insert into public.financial_transactions (
      transaction_date, transaction_datetime, direction, transaction_kind, transaction_type, category,
      location, description, notes, amount, signed_amount, currency, account_id, account_key,
      transaction_effect, source_account_id, destination_account_id, bucket, final_bucket,
      payment_method, receipt_url, transaction_status, review_status, needs_review, is_void,
      counterparty_text, paid_to_text, payee_text, payer_text, linked_purchase_id, related_purchase_id,
      source_type, source_id, created_by, updated_at
    ) values (
      coalesce(v_purchase.order_date, current_date), coalesce(v_purchase.order_date, current_date)::timestamptz,
      'money_out', 'product_purchase', 'Products Restocking', 'Products Restocking', null,
      coalesce(nullif(v_description, ''), 'Purchase'), nullif(v_notes, ''), v_amount, -abs(v_amount),
      v_currency, v_account_key, v_account_key, 'expense', null, null, 'Inventory', 'Products Restocking',
      v_purchase.payment_method, v_purchase.receipt_url, 'active', 'confirmed', false, false,
      v_supplier_name, v_supplier_name, v_supplier_name, null, p_purchase_id, p_purchase_id,
      'purchase', p_purchase_id, v_purchase.created_by, now()
    ) returning id into v_transaction_id;
  else
    update public.financial_transactions
    set transaction_date = coalesce(v_purchase.order_date, current_date),
        transaction_datetime = coalesce(v_purchase.order_date, current_date)::timestamptz,
        direction = 'money_out',
        transaction_kind = 'product_purchase',
        transaction_type = 'Products Restocking',
        category = 'Products Restocking',
        location = null,
        description = coalesce(nullif(v_description, ''), 'Purchase'),
        notes = nullif(v_notes, ''),
        amount = v_amount,
        signed_amount = -abs(v_amount),
        currency = v_currency,
        account_id = v_account_key,
        account_key = v_account_key,
        transaction_effect = 'expense',
        source_account_id = null,
        destination_account_id = null,
        bucket = 'Inventory',
        final_bucket = 'Products Restocking',
        payment_method = v_purchase.payment_method,
        receipt_url = v_purchase.receipt_url,
        transaction_status = 'active',
        review_status = 'confirmed',
        needs_review = false,
        is_void = false,
        voided_at = null,
        void_reason = null,
        counterparty_text = v_supplier_name,
        paid_to_text = v_supplier_name,
        payee_text = v_supplier_name,
        payer_text = null,
        linked_purchase_id = p_purchase_id,
        related_purchase_id = p_purchase_id,
        source_type = 'purchase',
        source_id = p_purchase_id,
        updated_at = now()
    where id = v_transaction_id;
  end if;

  update public.financial_transactions ft
  set transaction_status = 'voided',
      is_void = true,
      voided_at = coalesce(ft.voided_at, now()),
      void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance transaction superseded by ' || v_transaction_id::text),
      linked_purchase_id = null,
      related_purchase_id = null,
      source_type = 'manual',
      source_id = null,
      updated_at = now()
  where ft.id <> v_transaction_id
    and (ft.linked_purchase_id = p_purchase_id
      or ft.related_purchase_id = p_purchase_id
      or (ft.source_type = 'purchase' and ft.source_id = p_purchase_id));

  return v_transaction_id;
end;
$$;


ALTER FUNCTION "public"."sync_purchase_to_financial_transaction"("p_purchase_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_route_workflow_schema"("p_route_statuses" "text"[] DEFAULT ARRAY['draft'::"text", 'assigned'::"text", 'in_progress'::"text", 'pickup_confirmed'::"text", 'completed'::"text", 'reviewed'::"text", 'cancelled'::"text"], "p_route_stop_statuses" "text"[] DEFAULT ARRAY['pending'::"text", 'picked'::"text", 'in_progress'::"text", 'completed'::"text", 'skipped'::"text", 'canceled'::"text", 'arrived'::"text", 'refilling'::"text", 'cash_collected'::"text", 'issue_reported'::"text"]) RETURNS TABLE("enum_name" "text", "missing_values" "text"[])
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
  with route_values as (
    select enumlabel::text as value
    from pg_catalog.pg_enum
    where enumtypid = 'public.route_status'::regtype
  ),
  route_stop_values as (
    select enumlabel::text as value
    from pg_catalog.pg_enum
    where enumtypid = 'public.route_stop_status'::regtype
  ),
  route_missing as (
    select array_agg(required order by ord) as values
    from unnest(p_route_statuses) with ordinality as required_status(required, ord)
    where not exists (select 1 from route_values where value = required_status.required)
  ),
  route_stop_missing as (
    select array_agg(required order by ord) as values
    from unnest(p_route_stop_statuses) with ordinality as required_status(required, ord)
    where not exists (select 1 from route_stop_values where value = required_status.required)
  )
  select 'route_status'::text, coalesce(values, '{}'::text[]) from route_missing where coalesce(array_length(values, 1), 0) > 0
  union all
  select 'route_stop_status'::text, coalesce(values, '{}'::text[]) from route_stop_missing where coalesce(array_length(values, 1), 0) > 0;
$$;


ALTER FUNCTION "public"."validate_route_workflow_schema"("p_route_statuses" "text"[], "p_route_stop_statuses" "text"[]) OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_movements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "uuid" NOT NULL,
    "quantity" integer NOT NULL,
    "from_entity_type" "public"."inventory_entity_type" NOT NULL,
    "from_entity_id" "uuid",
    "to_entity_type" "public"."inventory_entity_type" NOT NULL,
    "to_entity_id" "uuid",
    "reason" "public"."movement_reason" NOT NULL,
    "related_route_id" "uuid",
    "related_refill_order_id" "uuid",
    "created_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "related_route_stop_id" "uuid",
    "related_purchase_id" "uuid",
    "related_purchase_line_id" "uuid",
    "unit_cost_lyd" numeric(12,4),
    "line_total_lyd" numeric(12,2),
    "related_machine_id" "uuid",
    "movement_reason" "public"."movement_reason" GENERATED ALWAYS AS ("reason") STORED,
    "reversed_movement_id" "uuid",
    "correction_reason" "text",
    "related_pickup_batch_id" "uuid",
    "import_batch_id" "uuid",
    "original_text" "text",
    "historical_route_deduction_line_id" "uuid",
    CONSTRAINT "movement_quantity_positive" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."inventory_movements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."machines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "machine_code" "text" NOT NULL,
    "vms_machine_id" "text",
    "name" "text" NOT NULL,
    "machine_type" "text" DEFAULT 'lift'::"text" NOT NULL,
    "location_id" "uuid",
    "status" "public"."machine_status" DEFAULT 'planned'::"public"."machine_status" NOT NULL,
    "serial_number" "text",
    "installed_date" "date",
    "rent_amount" numeric(12,2) DEFAULT 0,
    "target_nsm" numeric(12,2) DEFAULT 2800,
    "target_uptime_percent" numeric(5,2) DEFAULT 98,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "vms_online_status" "text",
    "vms_temperature_c" numeric(8,2),
    "vms_cash_balance_lyd" numeric(12,2),
    "vms_empty_trays" integer,
    "last_vms_status_at" timestamp with time zone,
    "vms_provider" "text",
    "vms_category" "text",
    "vms_type" "text",
    "vms_location_name" "text",
    "vms_longitude" numeric(12,8),
    "vms_latitude" numeric(12,8),
    "vms_temperature_raw" "text",
    "vms_humidity_raw" "text",
    "vms_raw_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "vms_last_synced_at" timestamp with time zone
);


ALTER TABLE "public"."machines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sku" "text" NOT NULL,
    "barcode" "text",
    "name" "text" NOT NULL,
    "category" "text" DEFAULT 'snack'::"text" NOT NULL,
    "brand" "text",
    "supplier_id" "uuid",
    "cost_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "selling_price" numeric(12,2) DEFAULT 0 NOT NULL,
    "case_quantity" integer DEFAULT 1,
    "image_url" "text",
    "expiry_sensitive" boolean DEFAULT true NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "current_cost_price_lyd" numeric(12,4) DEFAULT 0 NOT NULL,
    "current_selling_price_lyd" numeric(12,2) DEFAULT 0 NOT NULL,
    "last_purchase_cost_lyd" numeric(12,4),
    "average_cost_lyd" numeric(12,4),
    "vms_selling_price_lyd" numeric(12,2),
    "cost_price_source" "text" DEFAULT 'initial_import'::"text" NOT NULL,
    "selling_price_source" "text" DEFAULT 'initial_import'::"text" NOT NULL,
    "price_updated_at" timestamp with time zone,
    "import_source" "text" DEFAULT 'initial_import'::"text" NOT NULL,
    "last_vms_import_batch_id" "uuid",
    "last_vms_seen_at" timestamp with time zone,
    "last_purchase_date" "date",
    "last_supplier_id" "uuid",
    "last_purchase_line_id" "uuid",
    CONSTRAINT "cost_price_nonnegative" CHECK (("cost_price" >= (0)::numeric)),
    CONSTRAINT "products_cost_price_source_check" CHECK (("cost_price_source" = ANY (ARRAY['initial_import'::"text", 'latest_purchase'::"text", 'manual'::"text", 'vms'::"text", 'average_cost'::"text"]))),
    CONSTRAINT "products_selling_price_source_check" CHECK (("selling_price_source" = ANY (ARRAY['initial_import'::"text", 'latest_purchase'::"text", 'manual'::"text", 'vms'::"text", 'average_cost'::"text"]))),
    CONSTRAINT "selling_price_nonnegative" CHECK (("selling_price" >= (0)::numeric))
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."storage_locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "address" "text",
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "location_type" "text" DEFAULT 'main_storage'::"text" NOT NULL,
    "related_operator_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "storage_locations_location_type_check" CHECK (("location_type" = ANY (ARRAY['main_storage'::"text", 'operator_bag'::"text", 'vehicle'::"text", 'damaged'::"text", 'expired'::"text", 'temporary'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."storage_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."team_members" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "full_name" "text" NOT NULL,
    "phone" "text",
    "email" "text",
    "role" "public"."team_role" NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "auth_user_id" "uuid",
    "active_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "must_change_password" boolean DEFAULT false NOT NULL,
    "roles" "public"."team_role"[],
    "can_add_products" boolean DEFAULT false NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."team_members" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."current_inventory_by_location" AS
 WITH "movement_locations" AS (
         SELECT "inventory_movements"."product_id",
            "inventory_movements"."from_entity_type" AS "location_type",
            "inventory_movements"."from_entity_id" AS "location_id",
            (- "inventory_movements"."quantity") AS "quantity_delta"
           FROM "public"."inventory_movements"
          WHERE ("inventory_movements"."from_entity_type" = ANY (ARRAY['storage'::"public"."inventory_entity_type", 'operator_bag'::"public"."inventory_entity_type", 'machine'::"public"."inventory_entity_type"]))
        UNION ALL
         SELECT "inventory_movements"."product_id",
            "inventory_movements"."to_entity_type" AS "location_type",
            "inventory_movements"."to_entity_id" AS "location_id",
            "inventory_movements"."quantity" AS "quantity_delta"
           FROM "public"."inventory_movements"
          WHERE ("inventory_movements"."to_entity_type" = ANY (ARRAY['storage'::"public"."inventory_entity_type", 'operator_bag'::"public"."inventory_entity_type", 'machine'::"public"."inventory_entity_type"]))
        )
 SELECT "p"."id" AS "product_id",
    "p"."name" AS "product_name",
    ("ml"."location_type")::"text" AS "location_type",
    "ml"."location_id",
    COALESCE("sl"."name", "tm"."full_name", "m"."name", 'Unknown'::"text") AS "location_name",
    ("sum"("ml"."quantity_delta"))::integer AS "quantity_on_hand"
   FROM (((("movement_locations" "ml"
     JOIN "public"."products" "p" ON (("p"."id" = "ml"."product_id")))
     LEFT JOIN "public"."storage_locations" "sl" ON ((("ml"."location_type" = 'storage'::"public"."inventory_entity_type") AND ("sl"."id" = "ml"."location_id"))))
     LEFT JOIN "public"."team_members" "tm" ON ((("ml"."location_type" = 'operator_bag'::"public"."inventory_entity_type") AND ("tm"."id" = "ml"."location_id"))))
     LEFT JOIN "public"."machines" "m" ON ((("ml"."location_type" = 'machine'::"public"."inventory_entity_type") AND ("m"."id" = "ml"."location_id"))))
  GROUP BY "p"."id", "p"."name", "ml"."location_type", "ml"."location_id", "sl"."name", "tm"."full_name", "m"."name"
 HAVING ("sum"("ml"."quantity_delta") <> 0);


ALTER VIEW "public"."current_inventory_by_location" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."financial_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "transaction_date" "date" NOT NULL,
    "direction" "text" NOT NULL,
    "transaction_kind" "text" DEFAULT 'manual'::"text" NOT NULL,
    "transaction_type" "text",
    "location" "text",
    "description" "text",
    "amount" numeric(12,2) NOT NULL,
    "signed_amount" numeric(12,2) NOT NULL,
    "bucket" "text",
    "bucket_override" "text",
    "final_bucket" "text",
    "review_status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "needs_review" boolean DEFAULT false NOT NULL,
    "source_sheet" "text",
    "source_row" integer,
    "related_purchase_id" "uuid",
    "related_cash_collection_id" "uuid",
    "created_by" "uuid",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "import_status" "text",
    "source_file" "text",
    "original_description" "text",
    "import_notes" "text",
    "transaction_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "payment_method" "text",
    "notes" "text",
    "related_route_id" "uuid",
    "related_machine_id" "uuid",
    "related_location_id" "uuid",
    "receipt_url" "text",
    "voided_at" timestamp with time zone,
    "voided_by" "uuid",
    "archived_at" timestamp with time zone,
    "archived_by" "uuid",
    "status_reason" "text",
    "currency" "text" DEFAULT 'LYD'::"text" NOT NULL,
    "account_id" "text" DEFAULT 'snacky_lyd'::"text",
    "transaction_effect" "text" DEFAULT 'expense'::"text",
    "source_account_id" "text",
    "destination_account_id" "text",
    "exchange_rate_usd_to_lyd" numeric(12,6),
    "import_batch_id" "uuid",
    "original_csv_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "review_reason" "text",
    "suggested_category" "text",
    "suggested_account" "text",
    "suggested_machine" "text",
    "confidence_score" numeric(5,4),
    "source_type" "text",
    "source_id" "uuid",
    "linked_purchase_id" "uuid",
    "linked_cash_collection_id" "uuid",
    "transaction_datetime" timestamp with time zone,
    "account_key" "text",
    "category" "text",
    "counterparty_text" "text",
    "payer_text" "text",
    "paid_to_text" "text",
    "payee_text" "text",
    "is_void" boolean DEFAULT false,
    "void_reason" "text",
    CONSTRAINT "financial_signed_direction" CHECK (((("direction" = 'money_in'::"text") AND ("signed_amount" >= (0)::numeric)) OR (("direction" = 'money_out'::"text") AND ("signed_amount" <= (0)::numeric)))),
    CONSTRAINT "financial_transactions_account_id_check" CHECK ((("account_id" IS NULL) OR ("account_id" = ANY (ARRAY['snacky_lyd'::"text", 'snacky_usd'::"text", 'owner_lyd'::"text", 'owner_usd'::"text"])))),
    CONSTRAINT "financial_transactions_amount_check" CHECK (("amount" >= (0)::numeric)),
    CONSTRAINT "financial_transactions_currency_check" CHECK (("currency" = ANY (ARRAY['LYD'::"text", 'USD'::"text"]))),
    CONSTRAINT "financial_transactions_direction_check" CHECK (("direction" = ANY (ARRAY['money_in'::"text", 'money_out'::"text"]))),
    CONSTRAINT "financial_transactions_effect_check" CHECK (("transaction_effect" = ANY (ARRAY['income'::"text", 'expense'::"text", 'transfer'::"text", 'opening_balance'::"text"]))),
    CONSTRAINT "financial_transactions_import_status_check" CHECK ((("import_status" IS NULL) OR ("import_status" = ANY (ARRAY['imported'::"text", 'auto_classified'::"text", 'needs_review'::"text", 'confirmed'::"text", 'ignored'::"text", 'skipped'::"text"])))),
    CONSTRAINT "financial_transactions_review_status_check" CHECK (("review_status" = ANY (ARRAY['confirmed'::"text", 'needs_review'::"text", 'reviewed'::"text"]))),
    CONSTRAINT "financial_transactions_transaction_kind_check" CHECK (("transaction_kind" = ANY (ARRAY['spreadsheet_import'::"text", 'manual_money_in'::"text", 'manual_money_out'::"text", 'product_purchase'::"text", 'cash_collection'::"text"]))),
    CONSTRAINT "financial_transactions_transaction_status_check" CHECK (("transaction_status" = ANY (ARRAY['active'::"text", 'voided'::"text", 'archived'::"text"]))),
    CONSTRAINT "financial_transactions_transfer_accounts_check" CHECK ((("transaction_effect" <> 'transfer'::"text") OR (("source_account_id" = ANY (ARRAY['snacky_lyd'::"text", 'snacky_usd'::"text", 'owner_lyd'::"text", 'owner_usd'::"text"])) AND ("destination_account_id" = ANY (ARRAY['snacky_lyd'::"text", 'snacky_usd'::"text", 'owner_lyd'::"text", 'owner_usd'::"text"])) AND ("source_account_id" <> "destination_account_id"))))
);


ALTER TABLE "public"."financial_transactions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."finance_account_balance_impacts" AS
 SELECT "financial_transactions"."id" AS "financial_transaction_id",
    "financial_transactions"."transaction_date",
    "financial_transactions"."account_id",
    "financial_transactions"."currency",
    "financial_transactions"."signed_amount" AS "amount_delta",
    "financial_transactions"."transaction_effect",
    "financial_transactions"."final_bucket",
    "financial_transactions"."source_file",
    "financial_transactions"."source_sheet",
    "financial_transactions"."source_row"
   FROM "public"."financial_transactions"
  WHERE (("financial_transactions"."transaction_status" = 'active'::"text") AND (COALESCE("financial_transactions"."needs_review", false) = false) AND (COALESCE("financial_transactions"."import_status", ''::"text") <> ALL (ARRAY['needs_review'::"text", 'ignored'::"text", 'skipped'::"text"])) AND ("financial_transactions"."transaction_effect" <> 'transfer'::"text") AND ("financial_transactions"."account_id" IS NOT NULL))
UNION ALL
 SELECT "financial_transactions"."id" AS "financial_transaction_id",
    "financial_transactions"."transaction_date",
    "financial_transactions"."source_account_id" AS "account_id",
        CASE
            WHEN ("right"("financial_transactions"."source_account_id", 3) = 'usd'::"text") THEN 'USD'::"text"
            ELSE 'LYD'::"text"
        END AS "currency",
    (- "abs"("financial_transactions"."amount")) AS "amount_delta",
    "financial_transactions"."transaction_effect",
    "financial_transactions"."final_bucket",
    "financial_transactions"."source_file",
    "financial_transactions"."source_sheet",
    "financial_transactions"."source_row"
   FROM "public"."financial_transactions"
  WHERE (("financial_transactions"."transaction_status" = 'active'::"text") AND (COALESCE("financial_transactions"."needs_review", false) = false) AND (COALESCE("financial_transactions"."import_status", ''::"text") <> ALL (ARRAY['needs_review'::"text", 'ignored'::"text", 'skipped'::"text"])) AND ("financial_transactions"."transaction_effect" = 'transfer'::"text") AND ("financial_transactions"."source_account_id" IS NOT NULL))
UNION ALL
 SELECT "financial_transactions"."id" AS "financial_transaction_id",
    "financial_transactions"."transaction_date",
    "financial_transactions"."destination_account_id" AS "account_id",
        CASE
            WHEN ("right"("financial_transactions"."destination_account_id", 3) = 'usd'::"text") THEN 'USD'::"text"
            ELSE 'LYD'::"text"
        END AS "currency",
    "abs"("financial_transactions"."amount") AS "amount_delta",
    "financial_transactions"."transaction_effect",
    "financial_transactions"."final_bucket",
    "financial_transactions"."source_file",
    "financial_transactions"."source_sheet",
    "financial_transactions"."source_row"
   FROM "public"."financial_transactions"
  WHERE (("financial_transactions"."transaction_status" = 'active'::"text") AND (COALESCE("financial_transactions"."needs_review", false) = false) AND (COALESCE("financial_transactions"."import_status", ''::"text") <> ALL (ARRAY['needs_review'::"text", 'ignored'::"text", 'skipped'::"text"])) AND ("financial_transactions"."transaction_effect" = 'transfer'::"text") AND ("financial_transactions"."destination_account_id" IS NOT NULL));


ALTER VIEW "public"."finance_account_balance_impacts" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."finance_account_balances" AS
 SELECT "account_id",
    "currency",
    ("sum"("amount_delta"))::numeric(12,2) AS "balance"
   FROM "public"."finance_account_balance_impacts"
  GROUP BY "account_id", "currency";


ALTER VIEW "public"."finance_account_balances" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."finance_import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_file" "text" NOT NULL,
    "source_sheet" "text" NOT NULL,
    "mode" "text" DEFAULT 'import'::"text" NOT NULL,
    "imported_by" "uuid",
    "status" "text" DEFAULT 'processing'::"text" NOT NULL,
    "row_count" integer DEFAULT 0 NOT NULL,
    "imported_count" integer DEFAULT 0 NOT NULL,
    "auto_classified_count" integer DEFAULT 0 NOT NULL,
    "confirmed_count" integer DEFAULT 0 NOT NULL,
    "needs_review_count" integer DEFAULT 0 NOT NULL,
    "ignored_count" integer DEFAULT 0 NOT NULL,
    "review_group_count" integer DEFAULT 0 NOT NULL,
    "clarification_prompts" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "error_message" "text",
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone
);


ALTER TABLE "public"."finance_import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."finance_import_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_file" "text" NOT NULL,
    "source_sheet" "text" NOT NULL,
    "source_row" integer NOT NULL,
    "import_status" "text" NOT NULL,
    "transaction_date" "date",
    "raw_date" "text",
    "amount" numeric(12,2),
    "signed_amount" numeric(12,2),
    "raw_amount" "text",
    "direction" "text",
    "raw_direction" "text",
    "category" "text",
    "raw_category" "text",
    "original_description" "text",
    "review_reason" "text",
    "financial_transaction_id" "uuid",
    "raw_record" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "import_batch_id" "uuid",
    "currency" "text",
    "account_id" "text",
    "transaction_effect" "text",
    "source_account_id" "text",
    "destination_account_id" "text",
    "review_group_key" "text",
    "suggested_category" "text",
    "suggested_account" "text",
    "suggested_currency" "text",
    "suggested_machine" "text",
    "suggested_machine_id" "uuid",
    "suggested_source_account" "text",
    "suggested_destination_account" "text",
    "confidence_score" numeric(5,4),
    "clarification_question" "text",
    CONSTRAINT "finance_import_rows_direction_check" CHECK (("direction" = ANY (ARRAY['money_in'::"text", 'money_out'::"text"]))),
    CONSTRAINT "finance_import_rows_import_status_check" CHECK (("import_status" = ANY (ARRAY['imported'::"text", 'auto_classified'::"text", 'needs_review'::"text", 'confirmed'::"text", 'ignored'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."finance_import_rows" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."finance_import_clarification_groups" AS
 SELECT COALESCE("review_group_key", "review_reason", 'needs_review'::"text") AS "review_group_key",
    ("count"(*))::integer AS "affected_rows",
    ("array_agg"(COALESCE(NULLIF("original_description", ''::"text"), "raw_category", 'Unclear transaction'::"text") ORDER BY "source_row"))[1:3] AS "example_descriptions",
    ("sum"("abs"(COALESCE("amount", (0)::numeric))))::numeric(12,2) AS "total_amount",
    COALESCE("max"("suggested_currency"), "max"("currency"), 'LYD'::"text") AS "currency",
    "max"("suggested_category") AS "suggested_category",
    "max"("suggested_account") AS "suggested_account",
    "max"("suggested_machine") AS "suggested_machine",
    "max"("suggested_source_account") AS "suggested_source_account",
    "max"("suggested_destination_account") AS "suggested_destination_account",
    ("avg"(COALESCE("confidence_score", (0)::numeric)))::numeric(5,4) AS "confidence_score",
    "max"("clarification_question") AS "clarification_question",
    "max"("review_reason") AS "review_reason"
   FROM "public"."finance_import_rows"
  WHERE ("import_status" = 'needs_review'::"text")
  GROUP BY COALESCE("review_group_key", "review_reason", 'needs_review'::"text");


ALTER VIEW "public"."finance_import_clarification_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."finance_settings" (
    "id" "text" DEFAULT 'default'::"text" NOT NULL,
    "opening_balance" numeric(12,2),
    "opening_balance_date" "date",
    "default_currency" "text" DEFAULT 'LYD'::"text" NOT NULL,
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "opening_balance_snacky_lyd" numeric(12,2) DEFAULT 0 NOT NULL,
    "opening_balance_snacky_usd" numeric(12,2) DEFAULT 0 NOT NULL,
    "opening_balance_owner_lyd" numeric(12,2) DEFAULT 0 NOT NULL,
    "opening_balance_owner_usd" numeric(12,2) DEFAULT 0 NOT NULL,
    "exchange_rate_usd_to_lyd" numeric(12,6),
    CONSTRAINT "finance_settings_currency_not_blank" CHECK ((("length"(TRIM(BOTH FROM "default_currency")) >= 2) AND ("length"(TRIM(BOTH FROM "default_currency")) <= 8))),
    CONSTRAINT "finance_settings_singleton" CHECK (("id" = 'default'::"text"))
);


ALTER TABLE "public"."finance_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."historical_route_deduction_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "original_text" "text" NOT NULL,
    "content_hash" "text",
    "row_count" integer DEFAULT 0 NOT NULL,
    "ready_row_count" integer DEFAULT 0 NOT NULL,
    "needs_review_count" integer DEFAULT 0 NOT NULL,
    "total_quantity" integer DEFAULT 0 NOT NULL,
    "created_by" "uuid",
    "previewed_at" timestamp with time zone,
    "applied_by" "uuid",
    "applied_at" timestamp with time zone,
    "cancelled_by" "uuid",
    "cancelled_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "historical_route_deduction_batches_counts_nonnegative" CHECK ((("row_count" >= 0) AND ("ready_row_count" >= 0) AND ("needs_review_count" >= 0) AND ("total_quantity" >= 0))),
    CONSTRAINT "historical_route_deduction_batches_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'previewed'::"text", 'applied'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."historical_route_deduction_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."historical_route_deduction_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid" NOT NULL,
    "line_number" integer NOT NULL,
    "section_name" "text",
    "machine_alias" "text",
    "machine_id" "uuid",
    "product_alias" "text",
    "product_id" "uuid",
    "quantity" integer,
    "original_text" "text" NOT NULL,
    "status" "text" DEFAULT 'needs_review'::"text" NOT NULL,
    "review_reason" "text",
    "storage_location_id" "uuid",
    "storage_qty_before" integer,
    "storage_qty_after" integer,
    "storage_negative_warning" boolean DEFAULT false NOT NULL,
    "movement_id" "uuid",
    "applied_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "historical_route_deduction_lines_quantity_positive" CHECK ((("quantity" IS NULL) OR ("quantity" > 0))),
    CONSTRAINT "historical_route_deduction_lines_status_check" CHECK (("status" = ANY (ARRAY['ready'::"text", 'needs_review'::"text", 'applied'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."historical_route_deduction_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."issues" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "machine_id" "uuid",
    "reported_by" "uuid",
    "assigned_to" "uuid",
    "issue_type" "text" NOT NULL,
    "priority" "public"."issue_priority" DEFAULT 'normal'::"public"."issue_priority" NOT NULL,
    "status" "public"."issue_status" DEFAULT 'open'::"public"."issue_status" NOT NULL,
    "description" "text",
    "photo_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "sla_due_at" timestamp with time zone
);


ALTER TABLE "public"."issues" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "location_type" "public"."location_type" DEFAULT 'other'::"public"."location_type" NOT NULL,
    "address" "text",
    "contact_name" "text",
    "contact_phone" "text",
    "rent_amount" numeric(12,2) DEFAULT 0,
    "rent_type" "text" DEFAULT 'monthly_fixed'::"text",
    "contract_start" "date",
    "contract_end" "date",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "latitude" numeric(12,8),
    "longitude" numeric(12,8),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL
);


ALTER TABLE "public"."locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_order_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "purchase_order_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "ordered_qty" integer NOT NULL,
    "received_qty" integer DEFAULT 0 NOT NULL,
    "unit_cost" numeric(12,2) DEFAULT 0 NOT NULL,
    "boxes_qty" integer DEFAULT 0 NOT NULL,
    "units_per_box" integer DEFAULT 1 NOT NULL,
    "loose_units_qty" integer DEFAULT 0 NOT NULL,
    "total_units" integer DEFAULT 0 NOT NULL,
    "line_total" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unit_cost_lyd" numeric(12,4) DEFAULT 0 NOT NULL,
    "line_total_lyd" numeric(12,2) DEFAULT 0 NOT NULL,
    "line_position" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "po_ordered_qty_positive" CHECK (("ordered_qty" > 0)),
    CONSTRAINT "po_received_qty_nonnegative" CHECK (("received_qty" >= 0)),
    CONSTRAINT "purchase_lines_boxes_nonnegative" CHECK (("boxes_qty" >= 0)),
    CONSTRAINT "purchase_lines_line_total_nonnegative" CHECK (("line_total" >= (0)::numeric)),
    CONSTRAINT "purchase_lines_loose_units_nonnegative" CHECK (("loose_units_qty" >= 0)),
    CONSTRAINT "purchase_lines_total_units_nonnegative" CHECK (("total_units" >= 0)),
    CONSTRAINT "purchase_lines_units_per_box_positive" CHECK (("units_per_box" > 0))
);


ALTER TABLE "public"."purchase_order_lines" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."product_reporting_costs" AS
 WITH "purchase_costs" AS (
         SELECT "pol"."product_id",
            ("sum"(((GREATEST(COALESCE(NULLIF("pol"."received_qty", 0), NULLIF("pol"."total_units", 0), NULLIF("pol"."ordered_qty", 0), 0), 0))::numeric * GREATEST(COALESCE(NULLIF("pol"."unit_cost_lyd", (0)::numeric), NULLIF("pol"."unit_cost", (0)::numeric), (0)::numeric), (0)::numeric))) / (NULLIF("sum"(GREATEST(COALESCE(NULLIF("pol"."received_qty", 0), NULLIF("pol"."total_units", 0), NULLIF("pol"."ordered_qty", 0), 0), 0)), 0))::numeric) AS "weighted_average_cost_lyd",
            ("array_agg"(GREATEST(COALESCE(NULLIF("pol"."unit_cost_lyd", (0)::numeric), NULLIF("pol"."unit_cost", (0)::numeric), (0)::numeric), (0)::numeric) ORDER BY COALESCE("po"."received_at", ("po"."order_date")::timestamp with time zone, "pol"."created_at") DESC NULLS LAST, "pol"."created_at" DESC))[1] AS "latest_purchase_cost_lyd"
           FROM ("public"."purchase_order_lines" "pol"
             LEFT JOIN "public"."purchase_orders" "po" ON (("po"."id" = "pol"."purchase_order_id")))
          WHERE (("pol"."product_id" IS NOT NULL) AND (GREATEST(COALESCE(NULLIF("pol"."unit_cost_lyd", (0)::numeric), NULLIF("pol"."unit_cost", (0)::numeric), (0)::numeric), (0)::numeric) > (0)::numeric) AND (GREATEST(COALESCE(NULLIF("pol"."received_qty", 0), NULLIF("pol"."total_units", 0), NULLIF("pol"."ordered_qty", 0), 0), 0) > 0) AND (COALESCE("po"."status", 'received'::"text") <> ALL (ARRAY['cancelled'::"text", 'voided'::"text"])))
          GROUP BY "pol"."product_id"
        )
 SELECT "p"."id" AS "product_id",
    COALESCE(NULLIF("pc"."weighted_average_cost_lyd", (0)::numeric), NULLIF("p"."average_cost_lyd", (0)::numeric), NULLIF("pc"."latest_purchase_cost_lyd", (0)::numeric), NULLIF("p"."last_purchase_cost_lyd", (0)::numeric), NULLIF("p"."current_cost_price_lyd", (0)::numeric), NULLIF("p"."cost_price", (0)::numeric)) AS "reporting_unit_cost_lyd",
        CASE
            WHEN (NULLIF("pc"."weighted_average_cost_lyd", (0)::numeric) IS NOT NULL) THEN 'weighted_average_purchase'::"text"
            WHEN (NULLIF("p"."average_cost_lyd", (0)::numeric) IS NOT NULL) THEN 'product_average_cost'::"text"
            WHEN (NULLIF("pc"."latest_purchase_cost_lyd", (0)::numeric) IS NOT NULL) THEN 'latest_purchase'::"text"
            WHEN (NULLIF("p"."last_purchase_cost_lyd", (0)::numeric) IS NOT NULL) THEN 'product_last_purchase'::"text"
            WHEN (NULLIF("p"."current_cost_price_lyd", (0)::numeric) IS NOT NULL) THEN 'current_product_cost'::"text"
            WHEN (NULLIF("p"."cost_price", (0)::numeric) IS NOT NULL) THEN 'legacy_product_cost'::"text"
            ELSE 'missing'::"text"
        END AS "cost_method",
    "pc"."weighted_average_cost_lyd",
    "pc"."latest_purchase_cost_lyd",
    "p"."average_cost_lyd",
    "p"."last_purchase_cost_lyd",
    "p"."current_cost_price_lyd",
    "p"."cost_price"
   FROM ("public"."products" "p"
     LEFT JOIN "purchase_costs" "pc" ON (("pc"."product_id" = "p"."id")));


ALTER VIEW "public"."product_reporting_costs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "source_type" "text" DEFAULT 'csv'::"text" NOT NULL,
    "file_name" "text",
    "imported_by" "uuid",
    "imported_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "row_count" integer DEFAULT 0,
    "error_count" integer DEFAULT 0,
    "notes" "text",
    "file_type" "text",
    "sheet_name" "text",
    "report_type" "text",
    "rows_imported" integer DEFAULT 0,
    "rows_skipped" integer DEFAULT 0,
    "errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "unknown_machines" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "unmapped_products" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "column_mapping" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_reprocessed_at" timestamp with time zone,
    "reprocess_count" integer DEFAULT 0 NOT NULL,
    "uploaded_by" "uuid",
    "uploaded_at" timestamp with time zone DEFAULT "now"(),
    "report_start_date" "date",
    "report_end_date" "date",
    "import_mode" "text" DEFAULT 'append'::"text" NOT NULL,
    "rows_found" integer DEFAULT 0 NOT NULL,
    "rows_skipped_duplicate" integer DEFAULT 0 NOT NULL,
    "rows_needing_review" integer DEFAULT 0 NOT NULL,
    "preview_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "review_summary" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "failed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "file_hash" "text",
    "storage_path" "text",
    "detected_min_datetime" timestamp with time zone,
    "detected_max_datetime" timestamp with time zone,
    "total_successful_sales" numeric DEFAULT 0,
    "successful_rows_count" integer DEFAULT 0,
    "failed_rows_count" integer DEFAULT 0,
    "refunded_rows_count" integer DEFAULT 0,
    "is_active" boolean DEFAULT false,
    "disabled_at" timestamp with time zone,
    "disabled_by" "uuid",
    "disable_reason" "text",
    "deleted_at" timestamp with time zone,
    "deleted_by" "uuid",
    "delete_reason" "text",
    "source_usage" "jsonb",
    "dashboard_usage" "jsonb",
    "latest_error" "text",
    "parse_diagnostics" "jsonb",
    "storage_bucket" "text",
    "original_file_name" "text",
    "last_error" "text",
    CONSTRAINT "vms_import_batches_import_mode_check" CHECK (("import_mode" = ANY (ARRAY['append'::"text", 'replace_date_range'::"text", 'preview_only'::"text"]))),
    CONSTRAINT "vms_import_batches_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'previewed'::"text", 'imported'::"text", 'imported_with_warnings'::"text", 'partially_imported'::"text", 'failed'::"text", 'cancelled'::"text", 'canceled'::"text", 'disabled'::"text", 'deleted'::"text"])))
);


ALTER TABLE "public"."vms_import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_transactions_raw" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid",
    "row_number" integer,
    "merchant_id" "text",
    "merchant_name" "text",
    "machine_code" "text",
    "machine_name" "text",
    "order_number" "text",
    "cargo_lane_number" "text",
    "product_number" "text",
    "vms_product_name" "text",
    "commodity_price_1" numeric,
    "commodity_price_2" numeric,
    "discounted_price" numeric,
    "delivery_time" timestamp with time zone,
    "shipping_status" "text",
    "purchaser" "text",
    "refund_time" timestamp with time zone,
    "remarks" "text",
    "refund_status" "text",
    "third_party_transaction_number" "text",
    "third_party_order_no" "text",
    "payment_amount" numeric,
    "payment_time" timestamp with time zone,
    "quantity" numeric,
    "raw_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "normalized_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "mapped_machine_id" "uuid",
    "mapped_product_id" "uuid",
    "transaction_status" "text" DEFAULT 'needs_review'::"text" NOT NULL,
    "duplicate_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vms_transactions_raw_status_check" CHECK (("transaction_status" = ANY (ARRAY['successful_sale'::"text", 'failed_vend'::"text", 'refunded'::"text", 'failed_payment'::"text", 'needs_review'::"text"])))
);


ALTER TABLE "public"."vms_transactions_raw" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vms_sales_clean" AS
 WITH "detailed_sales" AS (
         SELECT "tx"."id",
            "tx"."import_batch_id",
            "tx"."duplicate_hash" AS "source_row_key",
            COALESCE("tx"."order_number", "tx"."third_party_transaction_number", "tx"."third_party_order_no") AS "vms_transaction_id",
            "vib"."file_name",
            "tx"."mapped_machine_id" AS "machine_id",
            COALESCE("m"."name", "tx"."machine_name", "tx"."machine_code", 'Unmapped machine'::"text") AS "machine_name",
            COALESCE("m"."machine_code", "tx"."machine_code") AS "machine_code",
            "m"."location_id",
            COALESCE("l"."name", 'No location'::"text") AS "location_name",
            "tx"."mapped_product_id" AS "product_id",
            COALESCE("p"."name", "tx"."vms_product_name", "tx"."product_number", 'Unmapped product'::"text") AS "product_name",
            COALESCE("p"."sku", "tx"."product_number") AS "product_sku",
            (COALESCE("tx"."payment_time", "tx"."delivery_time"))::"date" AS "sale_date",
            ("date_trunc"('month'::"text", COALESCE("tx"."payment_time", "tx"."delivery_time")))::"date" AS "sales_month",
            COALESCE("vib"."report_start_date", (COALESCE("tx"."payment_time", "tx"."delivery_time"))::"date") AS "report_start_date",
            COALESCE("vib"."report_end_date", (COALESCE("tx"."payment_time", "tx"."delivery_time"))::"date") AS "report_end_date",
            (GREATEST(COALESCE("tx"."quantity", (1)::numeric), (0)::numeric))::integer AS "units_sold",
            1 AS "transaction_count",
            (GREATEST(COALESCE("tx"."payment_amount", (0)::numeric), (0)::numeric))::numeric(12,2) AS "gross_sales_amount",
            (GREATEST(COALESCE("tx"."payment_amount", (0)::numeric), (0)::numeric))::numeric(12,2) AS "net_sales_amount",
            (0)::numeric(12,2) AS "cash_sales_amount",
            (0)::numeric(12,2) AS "card_sales_amount",
            "prc"."reporting_unit_cost_lyd" AS "unit_cost_amount",
            COALESCE("prc"."cost_method", 'missing'::"text") AS "cost_method",
                CASE
                    WHEN (("prc"."reporting_unit_cost_lyd" IS NULL) OR ("prc"."reporting_unit_cost_lyd" <= (0)::numeric)) THEN NULL::numeric
                    ELSE (("prc"."reporting_unit_cost_lyd" * GREATEST(COALESCE("tx"."quantity", (1)::numeric), (0)::numeric)))::numeric(12,2)
                END AS "product_cost_amount",
                CASE
                    WHEN (("prc"."reporting_unit_cost_lyd" IS NULL) OR ("prc"."reporting_unit_cost_lyd" <= (0)::numeric)) THEN NULL::numeric
                    ELSE ((GREATEST(COALESCE("tx"."payment_amount", (0)::numeric), (0)::numeric) - ("prc"."reporting_unit_cost_lyd" * GREATEST(COALESCE("tx"."quantity", (1)::numeric), (0)::numeric))))::numeric(12,2)
                END AS "gross_profit_amount",
            (("prc"."reporting_unit_cost_lyd" IS NULL) OR ("prc"."reporting_unit_cost_lyd" <= (0)::numeric)) AS "cost_missing",
            COALESCE("tx"."payment_time", "tx"."delivery_time") AS "period_start",
            COALESCE("tx"."payment_time", "tx"."delivery_time") AS "period_end",
            "tx"."created_at",
            "jsonb_build_object"('source', 'vms_order_details_weekly', 'raw', "tx"."raw_row", 'normalized', "tx"."normalized_row", 'transaction_status', "tx"."transaction_status") AS "metadata"
           FROM ((((("public"."vms_transactions_raw" "tx"
             LEFT JOIN "public"."vms_import_batches" "vib" ON (("vib"."id" = "tx"."import_batch_id")))
             LEFT JOIN "public"."machines" "m" ON (("m"."id" = "tx"."mapped_machine_id")))
             LEFT JOIN "public"."locations" "l" ON (("l"."id" = "m"."location_id")))
             LEFT JOIN "public"."products" "p" ON (("p"."id" = "tx"."mapped_product_id")))
             LEFT JOIN "public"."product_reporting_costs" "prc" ON (("prc"."product_id" = "tx"."mapped_product_id")))
          WHERE (("tx"."transaction_status" = 'successful_sale'::"text") AND ("tx"."mapped_product_id" IS NOT NULL) AND ("tx"."mapped_machine_id" IS NOT NULL) AND (COALESCE("tx"."payment_time", "tx"."delivery_time") IS NOT NULL) AND ("vib"."status" = ANY (ARRAY['imported'::"text", 'imported_with_warnings'::"text", 'partially_imported'::"text"])) AND ("vib"."is_active" = true) AND ("vib"."deleted_at" IS NULL))
        )
 SELECT "id",
    "import_batch_id",
    "source_row_key",
    "vms_transaction_id",
    "file_name",
    "machine_id",
    "machine_name",
    "machine_code",
    "location_id",
    "location_name",
    "product_id",
    "product_name",
    "product_sku",
    "sale_date",
    "sales_month",
    "report_start_date",
    "report_end_date",
    "units_sold",
    "transaction_count",
    "gross_sales_amount",
    "net_sales_amount",
    "cash_sales_amount",
    "card_sales_amount",
    "unit_cost_amount",
    "cost_method",
    "product_cost_amount",
    "gross_profit_amount",
    "cost_missing",
    "period_start",
    "period_end",
    "created_at",
    "metadata"
   FROM "detailed_sales";


ALTER VIEW "public"."vms_sales_clean" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_location_monthly" AS
 SELECT "location_id",
    "location_name",
    "sales_month",
    ("sum"("gross_sales_amount"))::numeric(12,2) AS "gross_sales_amount",
    ("sum"("net_sales_amount"))::numeric(12,2) AS "net_sales_amount",
    ("sum"("units_sold"))::integer AS "units_sold",
    ("sum"("transaction_count"))::integer AS "transaction_count",
    (("sum"("net_sales_amount") / (NULLIF("sum"("transaction_count"), 0))::numeric))::numeric(12,2) AS "average_transaction_value",
    ("sum"(COALESCE("gross_profit_amount", (0)::numeric)))::numeric(12,2) AS "gross_profit_amount",
    "count"(DISTINCT "machine_id") AS "machine_count",
    "count"(*) FILTER (WHERE "cost_missing") AS "cost_missing_rows",
    "count"(*) AS "sales_rows"
   FROM "public"."vms_sales_clean"
  GROUP BY "location_id", "location_name", "sales_month";


ALTER VIEW "public"."kpi_location_monthly" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_machine_daily" AS
 SELECT "machine_id",
    "machine_name",
    "machine_code",
    "location_id",
    "location_name",
    "sale_date",
    ("sum"("gross_sales_amount"))::numeric(12,2) AS "gross_sales_amount",
    ("sum"("net_sales_amount"))::numeric(12,2) AS "net_sales_amount",
    ("sum"("units_sold"))::integer AS "units_sold",
    ("sum"("transaction_count"))::integer AS "transaction_count",
    (("sum"("net_sales_amount") / (NULLIF("sum"("transaction_count"), 0))::numeric))::numeric(12,2) AS "average_transaction_value",
    ("sum"(COALESCE("gross_profit_amount", (0)::numeric)))::numeric(12,2) AS "gross_profit_amount",
    "count"(*) FILTER (WHERE "cost_missing") AS "cost_missing_rows",
    "count"(*) AS "sales_rows"
   FROM "public"."vms_sales_clean"
  GROUP BY "machine_id", "machine_name", "machine_code", "location_id", "location_name", "sale_date";


ALTER VIEW "public"."kpi_machine_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_machine_monthly" AS
 SELECT "machine_id",
    "machine_name",
    "machine_code",
    "location_id",
    "location_name",
    "sales_month",
    ("sum"("gross_sales_amount"))::numeric(12,2) AS "gross_sales_amount",
    ("sum"("net_sales_amount"))::numeric(12,2) AS "net_sales_amount",
    ("sum"("units_sold"))::integer AS "units_sold",
    ("sum"("transaction_count"))::integer AS "transaction_count",
    (("sum"("net_sales_amount") / (NULLIF("sum"("transaction_count"), 0))::numeric))::numeric(12,2) AS "average_transaction_value",
    ("sum"(COALESCE("gross_profit_amount", (0)::numeric)))::numeric(12,2) AS "gross_profit_amount",
    (("sum"("net_sales_amount") / (NULLIF("count"(DISTINCT "sale_date"), 0))::numeric))::numeric(12,2) AS "average_sales_per_day",
    "count"(*) FILTER (WHERE "cost_missing") AS "cost_missing_rows",
    "count"(*) AS "sales_rows"
   FROM "public"."vms_sales_clean"
  GROUP BY "machine_id", "machine_name", "machine_code", "location_id", "location_name", "sales_month";


ALTER VIEW "public"."kpi_machine_monthly" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_product_daily" AS
 SELECT "product_id",
    "product_name",
    "product_sku",
    "sale_date",
    ("sum"("gross_sales_amount"))::numeric(12,2) AS "gross_sales_amount",
    ("sum"("net_sales_amount"))::numeric(12,2) AS "net_sales_amount",
    ("sum"("units_sold"))::integer AS "units_sold",
    ("sum"("transaction_count"))::integer AS "transaction_count",
    (("sum"("net_sales_amount") / (NULLIF("sum"("transaction_count"), 0))::numeric))::numeric(12,2) AS "average_transaction_value",
    ("sum"(COALESCE("gross_profit_amount", (0)::numeric)))::numeric(12,2) AS "gross_profit_amount",
    "count"(*) FILTER (WHERE "cost_missing") AS "cost_missing_rows",
    "count"(*) AS "sales_rows"
   FROM "public"."vms_sales_clean"
  GROUP BY "product_id", "product_name", "product_sku", "sale_date";


ALTER VIEW "public"."kpi_product_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."kpi_product_monthly" AS
 SELECT "product_id",
    "product_name",
    "product_sku",
    "sales_month",
    ("sum"("gross_sales_amount"))::numeric(12,2) AS "gross_sales_amount",
    ("sum"("net_sales_amount"))::numeric(12,2) AS "net_sales_amount",
    ("sum"("units_sold"))::integer AS "units_sold",
    ("sum"("transaction_count"))::integer AS "transaction_count",
    (("sum"("net_sales_amount") / (NULLIF("sum"("transaction_count"), 0))::numeric))::numeric(12,2) AS "average_transaction_value",
    ("sum"(COALESCE("gross_profit_amount", (0)::numeric)))::numeric(12,2) AS "gross_profit_amount",
    (("sum"("units_sold") / NULLIF("count"(DISTINCT "sale_date"), 0)))::numeric(12,4) AS "stock_velocity_units_per_day",
    "count"(*) FILTER (WHERE "cost_missing") AS "cost_missing_rows",
    "count"(*) AS "sales_rows"
   FROM "public"."vms_sales_clean"
  GROUP BY "product_id", "product_name", "product_sku", "sales_month";


ALTER VIEW "public"."kpi_product_monthly" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_stock_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid",
    "machine_id" "uuid",
    "vms_machine_id" "text",
    "slot_code" "text",
    "vms_product_id" "text",
    "vms_product_name" "text",
    "product_id" "uuid",
    "current_qty" integer DEFAULT 0 NOT NULL,
    "capacity" integer,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "temperature_c" numeric(8,2),
    "cash_balance_lyd" numeric(12,2),
    "tray_status" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "import_row_number" integer,
    "import_row_status" "text" DEFAULT 'imported'::"text" NOT NULL,
    "sync_run_id" "uuid",
    "source_provider" "text",
    "third_party_product_id" "text",
    "locked_inventory_qty" integer,
    "vms_selling_price_lyd" numeric(12,2),
    "product_image_url" "text",
    "production_date" "date",
    "aisle_status" "text",
    CONSTRAINT "vms_current_qty_nonnegative" CHECK (("current_qty" >= 0)),
    CONSTRAINT "vms_stock_snapshots_import_row_status_check" CHECK (("import_row_status" = ANY (ARRAY['imported'::"text", 'reprocessed_stale'::"text"])))
);


ALTER TABLE "public"."vms_stock_snapshots" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."latest_vms_stock_by_slot" AS
 WITH "normalized" AS (
         SELECT "vss"."id",
            "vss"."import_batch_id",
            "vib"."imported_at" AS "batch_imported_at",
            "vib"."uploaded_at" AS "batch_uploaded_at",
            COALESCE("vib"."original_file_name", "vib"."file_name") AS "batch_file_name",
            "vss"."sync_run_id",
            "vss"."source_provider",
            "vss"."machine_id",
            NULLIF("btrim"("vss"."slot_code"), ''::"text") AS "slot_code",
            "vss"."product_id",
            NULLIF("btrim"("vss"."vms_product_id"), ''::"text") AS "vms_product_id",
            NULLIF("btrim"("vss"."vms_product_name"), ''::"text") AS "vms_product_name",
            "vss"."current_qty",
            "vss"."capacity",
            "vss"."captured_at",
            "vss"."created_at",
            NULLIF("btrim"(COALESCE("vss"."aisle_status", "vss"."tray_status")), ''::"text") AS "tray_status",
            COALESCE(NULLIF("btrim"("vss"."slot_code"), ''::"text"), ("vss"."product_id")::"text", NULLIF("btrim"("vss"."vms_product_id"), ''::"text"), NULLIF("btrim"("vss"."vms_product_name"), ''::"text"), ("vss"."id")::"text") AS "stock_item_key"
           FROM ("public"."vms_stock_snapshots" "vss"
             LEFT JOIN "public"."vms_import_batches" "vib" ON (("vib"."id" = "vss"."import_batch_id")))
          WHERE (("vss"."machine_id" IS NOT NULL) AND ("vss"."import_row_status" = 'imported'::"text") AND (("vss"."import_batch_id" IS NULL) OR (("vib"."status" = ANY (ARRAY['imported'::"text", 'imported_with_warnings'::"text", 'partially_imported'::"text"])) AND ("vib"."is_active" = true) AND ("vib"."deleted_at" IS NULL))))
        ), "ranked" AS (
         SELECT "normalized"."id",
            "normalized"."import_batch_id",
            "normalized"."batch_imported_at",
            "normalized"."batch_uploaded_at",
            "normalized"."batch_file_name",
            "normalized"."sync_run_id",
            "normalized"."source_provider",
            "normalized"."machine_id",
            "normalized"."slot_code",
            "normalized"."product_id",
            "normalized"."vms_product_id",
            "normalized"."vms_product_name",
            "normalized"."current_qty",
            "normalized"."capacity",
            "normalized"."captured_at",
            "normalized"."created_at",
            "normalized"."tray_status",
            "normalized"."stock_item_key",
            "dense_rank"() OVER (PARTITION BY "normalized"."machine_id", "normalized"."stock_item_key" ORDER BY "normalized"."captured_at" DESC, "normalized"."batch_imported_at" DESC NULLS LAST, "normalized"."created_at" DESC) AS "recency_rank"
           FROM "normalized"
        ), "latest" AS (
         SELECT "ranked"."id",
            "ranked"."import_batch_id",
            "ranked"."batch_imported_at",
            "ranked"."batch_uploaded_at",
            "ranked"."batch_file_name",
            "ranked"."sync_run_id",
            "ranked"."source_provider",
            "ranked"."machine_id",
            "ranked"."slot_code",
            "ranked"."product_id",
            "ranked"."vms_product_id",
            "ranked"."vms_product_name",
            "ranked"."current_qty",
            "ranked"."capacity",
            "ranked"."captured_at",
            "ranked"."created_at",
            "ranked"."tray_status",
            "ranked"."stock_item_key",
            "ranked"."recency_rank"
           FROM "ranked"
          WHERE ("ranked"."recency_rank" = 1)
        )
 SELECT ("array_agg"("id" ORDER BY "created_at" DESC, "latest"."id" DESC))[1] AS "id",
    "machine_id",
    "max"("slot_code") AS "slot_code",
    ("array_agg"("product_id" ORDER BY ("product_id" IS NOT NULL) DESC, "created_at" DESC, "latest"."id" DESC))[1] AS "product_id",
    ("sum"("current_qty"))::integer AS "current_qty",
    (NULLIF("sum"(COALESCE("capacity", 0)), 0))::integer AS "capacity",
    "max"("captured_at") AS "captured_at",
    ("array_agg"("vms_product_id" ORDER BY ("vms_product_id" IS NOT NULL) DESC, "created_at" DESC, "latest"."id" DESC))[1] AS "vms_product_id",
    ("array_agg"("vms_product_name" ORDER BY ("vms_product_name" IS NOT NULL) DESC, "created_at" DESC, "latest"."id" DESC))[1] AS "vms_product_name",
    NULLIF("string_agg"(DISTINCT "tray_status", ', '::"text"), ''::"text") AS "tray_status",
    "stock_item_key",
    ("array_agg"("import_batch_id" ORDER BY "batch_imported_at" DESC NULLS LAST, "created_at" DESC, "latest"."id" DESC))[1] AS "import_batch_id",
    "max"("batch_imported_at") AS "imported_at",
    "max"("batch_uploaded_at") AS "source_uploaded_at",
    ("array_agg"("batch_file_name" ORDER BY "batch_imported_at" DESC NULLS LAST, "created_at" DESC, "latest"."id" DESC))[1] AS "source_file_name",
    ("array_agg"("sync_run_id" ORDER BY "created_at" DESC, "latest"."id" DESC))[1] AS "sync_run_id",
    ("array_agg"("source_provider" ORDER BY "created_at" DESC, "latest"."id" DESC))[1] AS "source_provider"
   FROM "latest"
  GROUP BY "machine_id", "stock_item_key";


ALTER VIEW "public"."latest_vms_stock_by_slot" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."machine_aliases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "machine_id" "uuid" NOT NULL,
    "alias_name" "text" NOT NULL,
    "source" "text" DEFAULT 'manual'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."machine_aliases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."machine_refill_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "legacy_refill_id" "text" NOT NULL,
    "refill_at" timestamp with time zone NOT NULL,
    "machine_id" "uuid",
    "machine_name" "text" NOT NULL,
    "operator_id" "uuid",
    "operator_email" "text",
    "machine_photo_url" "text",
    "machine_photo_path" "text",
    "fill_status" "text",
    "issues_found" boolean DEFAULT false NOT NULL,
    "issue_notes" "text",
    "linked_issue_id" "uuid",
    "source_file" "text" DEFAULT 'Items - MachineRefills.csv'::"text" NOT NULL,
    "source_row" integer,
    "import_status" "text" DEFAULT 'imported'::"text" NOT NULL,
    "review_reason" "text",
    "raw_record" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "route_id" "uuid",
    "route_stop_id" "uuid",
    CONSTRAINT "machine_refill_history_import_status_check" CHECK (("import_status" = ANY (ARRAY['imported'::"text", 'needs_review'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."machine_refill_history" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."machine_refill_history_metrics" AS
 SELECT "machine_id",
    "machine_name",
    ("count"(*))::integer AS "total_refills",
    ("count"(*) FILTER (WHERE ("lower"(COALESCE("fill_status", ''::"text")) = 'full'::"text")))::integer AS "full_refills",
    ("count"(*) FILTER (WHERE ("lower"(COALESCE("fill_status", ''::"text")) = 'partial'::"text")))::integer AS "partial_refills",
    ("count"(*) FILTER (WHERE "issues_found"))::integer AS "issue_refills",
    "max"("refill_at") AS "last_refill_at",
    ("count"(DISTINCT "operator_id") FILTER (WHERE ("operator_id" IS NOT NULL)))::integer AS "operator_count"
   FROM "public"."machine_refill_history"
  GROUP BY "machine_id", "machine_name";


ALTER VIEW "public"."machine_refill_history_metrics" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."machine_refill_history_monthly" AS
 SELECT ("date_trunc"('month'::"text", "refill_at"))::"date" AS "month_start",
    "machine_id",
    "machine_name",
    ("count"(*))::integer AS "total_refills",
    ("count"(*) FILTER (WHERE ("lower"(COALESCE("fill_status", ''::"text")) = 'full'::"text")))::integer AS "full_refills",
    ("count"(*) FILTER (WHERE ("lower"(COALESCE("fill_status", ''::"text")) = 'partial'::"text")))::integer AS "partial_refills",
    ("count"(*) FILTER (WHERE "issues_found"))::integer AS "issue_refills"
   FROM "public"."machine_refill_history"
  GROUP BY (("date_trunc"('month'::"text", "refill_at"))::"date"), "machine_id", "machine_name";


ALTER VIEW "public"."machine_refill_history_monthly" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."machine_slots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "machine_id" "uuid" NOT NULL,
    "slot_code" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "capacity" integer NOT NULL,
    "min_qty" integer DEFAULT 2 NOT NULL,
    "par_qty" integer NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "min_qty_nonnegative" CHECK (("min_qty" >= 0)),
    CONSTRAINT "par_qty_lte_capacity" CHECK (("par_qty" <= "capacity")),
    CONSTRAINT "par_qty_positive" CHECK (("par_qty" > 0)),
    CONSTRAINT "slot_capacity_positive" CHECK (("capacity" > 0))
);


ALTER TABLE "public"."machine_slots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."product_aliases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "alias_name" "text" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "source" "text" DEFAULT 'receipt'::"text" NOT NULL,
    "confidence" numeric,
    "approved_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."product_aliases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "role" "public"."team_role" DEFAULT 'viewer'::"public"."team_role" NOT NULL,
    "active_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "team_member_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "last_login_at" timestamp with time zone,
    "must_change_password" boolean DEFAULT false NOT NULL,
    "roles" "public"."team_role"[],
    "can_add_products" boolean DEFAULT false NOT NULL,
    CONSTRAINT "profiles_active_status_check" CHECK (("active_status" = ANY (ARRAY['active'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."receipt_scan_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "purchase_id" "uuid",
    "file_url" "text",
    "raw_text" "text",
    "extracted_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'completed'::"text" NOT NULL,
    "error_message" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "receipt_scan_results_status_check" CHECK (("status" = ANY (ARRAY['completed'::"text", 'not_configured'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."receipt_scan_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."refill_order_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "refill_order_id" "uuid" NOT NULL,
    "machine_slot_id" "uuid",
    "product_id" "uuid" NOT NULL,
    "current_qty_vms" integer DEFAULT 0,
    "par_qty" integer NOT NULL,
    "suggested_qty" integer NOT NULL,
    "available_storage_qty" integer DEFAULT 0 NOT NULL,
    "final_qty_to_take" integer DEFAULT 0 NOT NULL,
    "picked_qty" integer DEFAULT 0,
    "filled_qty" integer DEFAULT 0,
    "returned_qty" integer DEFAULT 0,
    "shortage_qty" integer DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source" "text" DEFAULT 'refill_recommendation'::"text" NOT NULL,
    "slot_code" "text",
    "recommended_take_qty" integer DEFAULT 0,
    "final_take_qty" integer DEFAULT 0,
    "slot_allocations" "jsonb" DEFAULT '[]'::"jsonb",
    CONSTRAINT "filled_qty_nonnegative" CHECK (("filled_qty" >= 0)),
    CONSTRAINT "picked_qty_nonnegative" CHECK (("picked_qty" >= 0)),
    CONSTRAINT "refill_order_lines_final_take_qty_nonnegative" CHECK (("final_take_qty" >= 0)),
    CONSTRAINT "refill_order_lines_final_take_qty_nonnegative_nullable" CHECK ((("final_take_qty" IS NULL) OR ("final_take_qty" >= 0))),
    CONSTRAINT "refill_order_lines_recommended_take_qty_nonnegative" CHECK (("recommended_take_qty" >= 0)),
    CONSTRAINT "refill_order_lines_recommended_take_qty_nonnegative_nullable" CHECK ((("recommended_take_qty" IS NULL) OR ("recommended_take_qty" >= 0))),
    CONSTRAINT "refill_order_lines_source_check" CHECK (("source" = ANY (ARRAY['refill_recommendation'::"text", 'manual_admin_assignment'::"text"]))),
    CONSTRAINT "returned_qty_nonnegative" CHECK (("returned_qty" >= 0)),
    CONSTRAINT "shortage_qty_nonnegative" CHECK (("shortage_qty" >= 0)),
    CONSTRAINT "suggested_qty_nonnegative" CHECK (("suggested_qty" >= 0))
);


ALTER TABLE "public"."refill_order_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."refill_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid",
    "machine_id" "uuid" NOT NULL,
    "status" "public"."refill_status" DEFAULT 'draft'::"public"."refill_status" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "notes" "text"
);


ALTER TABLE "public"."refill_orders" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."refill_recommendations" AS
 WITH "storage_stock" AS (
         SELECT "current_inventory_by_location"."product_id",
            ("sum"("current_inventory_by_location"."quantity_on_hand"))::integer AS "available_storage_qty"
           FROM "public"."current_inventory_by_location"
          WHERE ("current_inventory_by_location"."location_type" = 'storage'::"text")
          GROUP BY "current_inventory_by_location"."product_id"
        ), "vms_stock" AS (
         SELECT "latest_vms_stock_by_slot"."id",
            "latest_vms_stock_by_slot"."machine_id",
            "latest_vms_stock_by_slot"."slot_code",
            "latest_vms_stock_by_slot"."product_id",
            "latest_vms_stock_by_slot"."current_qty",
            "latest_vms_stock_by_slot"."capacity",
            "latest_vms_stock_by_slot"."captured_at",
            "latest_vms_stock_by_slot"."vms_product_id",
            "latest_vms_stock_by_slot"."vms_product_name",
            "latest_vms_stock_by_slot"."tray_status",
            "latest_vms_stock_by_slot"."stock_item_key",
            "latest_vms_stock_by_slot"."import_batch_id",
            "latest_vms_stock_by_slot"."imported_at",
            "latest_vms_stock_by_slot"."source_uploaded_at",
            "latest_vms_stock_by_slot"."source_file_name",
            "latest_vms_stock_by_slot"."sync_run_id",
            "latest_vms_stock_by_slot"."source_provider",
            "lower"(COALESCE("latest_vms_stock_by_slot"."tray_status", ''::"text")) AS "normalized_tray_status"
           FROM "public"."latest_vms_stock_by_slot"
          WHERE ("latest_vms_stock_by_slot"."product_id" IS NOT NULL)
        ), "matched_slots" AS (
         SELECT DISTINCT ON ("v_1"."id") "v_1"."id" AS "vms_stock_snapshot_id",
            "ms_1"."id" AS "machine_slot_id",
            "ms_1"."slot_code",
            "ms_1"."min_qty",
            "ms_1"."par_qty"
           FROM ("vms_stock" "v_1"
             LEFT JOIN "public"."machine_slots" "ms_1" ON ((("ms_1"."machine_id" = "v_1"."machine_id") AND ("ms_1"."product_id" = "v_1"."product_id") AND ("ms_1"."active" = true) AND ((("v_1"."slot_code" IS NOT NULL) AND ("ms_1"."slot_code" = "v_1"."slot_code")) OR ("v_1"."slot_code" IS NULL)))))
          ORDER BY "v_1"."id",
                CASE
                    WHEN (("v_1"."slot_code" IS NOT NULL) AND ("ms_1"."slot_code" = "v_1"."slot_code")) THEN 0
                    ELSE 1
                END, "ms_1"."created_at" DESC NULLS LAST
        )
 SELECT "m"."id" AS "machine_id",
    "m"."name" AS "machine_name",
    "m"."machine_code",
    "ms"."machine_slot_id",
    COALESCE("v"."slot_code", "ms"."slot_code", 'VMS'::"text") AS "slot_code",
    "p"."id" AS "product_id",
    "p"."name" AS "product_name",
    "v"."current_qty",
    COALESCE("ms"."min_qty", 0) AS "min_qty",
    COALESCE("ms"."par_qty", "v"."capacity", "v"."current_qty") AS "par_qty",
    GREATEST((COALESCE("ms"."par_qty", "v"."capacity", "v"."current_qty") - "v"."current_qty"), 0) AS "suggested_qty",
    COALESCE("ss"."available_storage_qty", 0) AS "available_storage_qty",
    LEAST(GREATEST((COALESCE("ms"."par_qty", "v"."capacity", "v"."current_qty") - "v"."current_qty"), 0), COALESCE("ss"."available_storage_qty", 0)) AS "final_qty_to_take",
        CASE
            WHEN (("v"."current_qty" <= 0) OR ("v"."normalized_tray_status" = ANY (ARRAY['empty'::"text", 'out'::"text", 'out_of_stock'::"text", 'sold_out'::"text", 'yes'::"text", 'true'::"text", '1'::"text"])) OR ("v"."normalized_tray_status" ~~ '%out of stock%'::"text") OR ("v"."normalized_tray_status" ~~ '%sold out%'::"text")) THEN 'critical'::"text"
            WHEN (("ms"."min_qty" IS NOT NULL) AND ("v"."current_qty" <= "ms"."min_qty")) THEN 'high'::"text"
            WHEN ("v"."current_qty" < COALESCE("ms"."par_qty", "v"."capacity", "v"."current_qty")) THEN 'medium'::"text"
            ELSE 'none'::"text"
        END AS "priority",
    "v"."captured_at" AS "latest_vms_at",
    "v"."imported_at",
    "v"."import_batch_id",
    "v"."source_file_name",
    "v"."source_uploaded_at",
    "md5"("concat_ws"('|'::"text", 'vms_stock', ("v"."machine_id")::"text", "v"."stock_item_key")) AS "recommendation_key",
    "v"."id" AS "vms_stock_snapshot_id",
    'vms_stock'::"text" AS "recommendation_source",
    "v"."capacity",
    "v"."tray_status"
   FROM (((("vms_stock" "v"
     JOIN "public"."machines" "m" ON (("m"."id" = "v"."machine_id")))
     JOIN "public"."products" "p" ON (("p"."id" = "v"."product_id")))
     LEFT JOIN "matched_slots" "ms" ON (("ms"."vms_stock_snapshot_id" = "v"."id")))
     LEFT JOIN "storage_stock" "ss" ON (("ss"."product_id" = "p"."id")))
  WHERE (("m"."status" = 'active'::"public"."machine_status") AND (COALESCE("ms"."par_qty", "v"."capacity") IS NOT NULL) AND (GREATEST((COALESCE("ms"."par_qty", "v"."capacity", "v"."current_qty") - "v"."current_qty"), 0) > 0));


ALTER VIEW "public"."refill_recommendations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_pick_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "planned_qty" integer DEFAULT 0 NOT NULL,
    "picked_qty" integer DEFAULT 0 NOT NULL,
    "difference_qty" integer DEFAULT 0 NOT NULL,
    "reason" "text",
    "notes" "text",
    "needs_review" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "route_pick_adjustments_picked_qty_nonnegative" CHECK (("picked_qty" >= 0)),
    CONSTRAINT "route_pick_adjustments_planned_qty_nonnegative" CHECK (("planned_qty" >= 0))
);


ALTER TABLE "public"."route_pick_adjustments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_pick_list_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "planned_qty" integer DEFAULT 0 NOT NULL,
    "picked_qty" integer DEFAULT 0 NOT NULL,
    "action_type" "text" DEFAULT 'planned_pick'::"text" NOT NULL,
    "substituted_for_product_id" "uuid",
    "reason" "text",
    "notes" "text",
    "needs_review" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "route_stop_id" "uuid",
    "route_stop_item_id" "uuid",
    "machine_id" "uuid",
    "pickup_batch_id" "uuid",
    CONSTRAINT "route_pick_list_items_action_check" CHECK (("action_type" = ANY (ARRAY['planned_pick'::"text", 'extra_product'::"text", 'substitution'::"text"]))),
    CONSTRAINT "route_pick_list_items_picked_qty_nonnegative" CHECK (("picked_qty" >= 0)),
    CONSTRAINT "route_pick_list_items_planned_qty_nonnegative" CHECK (("planned_qty" >= 0))
);


ALTER TABLE "public"."route_pick_list_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_pickup_batch_stops" (
    "pickup_batch_id" "uuid" NOT NULL,
    "route_stop_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."route_pickup_batch_stops" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_pickup_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid" NOT NULL,
    "operator_id" "uuid",
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "selected_stop_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "product_summary" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "storage_deducted" boolean DEFAULT false NOT NULL,
    "confirmed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "route_pickup_batches_product_summary_array" CHECK (("jsonb_typeof"("product_summary") = 'array'::"text")),
    CONSTRAINT "route_pickup_batches_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'confirmed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."route_pickup_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_stock_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "planned_qty" integer DEFAULT 0 NOT NULL,
    "picked_qty" integer DEFAULT 0 NOT NULL,
    "returned_qty" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "route_stock_picked_qty_nonnegative" CHECK (("picked_qty" >= 0)),
    CONSTRAINT "route_stock_planned_qty_nonnegative" CHECK (("planned_qty" >= 0)),
    CONSTRAINT "route_stock_returned_qty_nonnegative" CHECK (("returned_qty" >= 0))
);


ALTER TABLE "public"."route_stock_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_stop_fill_lines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid" NOT NULL,
    "route_stop_id" "uuid" NOT NULL,
    "machine_id" "uuid" NOT NULL,
    "refill_order_line_id" "uuid",
    "assigned_product_id" "uuid",
    "product_id" "uuid",
    "substitute_product_id" "uuid",
    "action_type" "text" DEFAULT 'assigned_fill'::"text" NOT NULL,
    "assigned_qty" integer DEFAULT 0 NOT NULL,
    "actual_qty" integer DEFAULT 0 NOT NULL,
    "difference_qty" integer DEFAULT 0 NOT NULL,
    "reason" "text",
    "notes" "text",
    "missing_product_name" "text",
    "needs_review" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "route_stop_fill_lines_action_check" CHECK (("action_type" = ANY (ARRAY['assigned_fill'::"text", 'extra_product'::"text", 'substitution'::"text", 'missing_product_report'::"text"]))),
    CONSTRAINT "route_stop_fill_lines_actual_qty_nonnegative" CHECK (("actual_qty" >= 0)),
    CONSTRAINT "route_stop_fill_lines_assigned_qty_nonnegative" CHECK (("assigned_qty" >= 0))
);


ALTER TABLE "public"."route_stop_fill_lines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_stop_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid" NOT NULL,
    "route_stop_id" "uuid" NOT NULL,
    "machine_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "machine_slot_id" "uuid",
    "planned_quantity" integer DEFAULT 0 NOT NULL,
    "picked_quantity" integer,
    "filled_quantity" integer,
    "returned_quantity" integer,
    "source" "text" DEFAULT 'manual_admin_assignment'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "slot_code" "text",
    "recommended_take_qty" integer DEFAULT 0,
    "final_take_qty" integer DEFAULT 0,
    "slot_allocations" "jsonb" DEFAULT '[]'::"jsonb",
    CONSTRAINT "route_stop_items_filled_quantity_nonnegative" CHECK ((("filled_quantity" IS NULL) OR ("filled_quantity" >= 0))),
    CONSTRAINT "route_stop_items_final_take_qty_nonnegative" CHECK (("final_take_qty" >= 0)),
    CONSTRAINT "route_stop_items_final_take_qty_nonnegative_nullable" CHECK ((("final_take_qty" IS NULL) OR ("final_take_qty" >= 0))),
    CONSTRAINT "route_stop_items_picked_quantity_nonnegative" CHECK ((("picked_quantity" IS NULL) OR ("picked_quantity" >= 0))),
    CONSTRAINT "route_stop_items_planned_quantity_nonnegative" CHECK (("planned_quantity" >= 0)),
    CONSTRAINT "route_stop_items_recommended_take_qty_nonnegative" CHECK (("recommended_take_qty" >= 0)),
    CONSTRAINT "route_stop_items_recommended_take_qty_nonnegative_nullable" CHECK ((("recommended_take_qty" IS NULL) OR ("recommended_take_qty" >= 0))),
    CONSTRAINT "route_stop_items_returned_quantity_nonnegative" CHECK ((("returned_quantity" IS NULL) OR ("returned_quantity" >= 0))),
    CONSTRAINT "route_stop_items_source_check" CHECK (("source" = ANY (ARRAY['refill_recommendation'::"text", 'manual_admin_assignment'::"text"])))
);


ALTER TABLE "public"."route_stop_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."route_stops" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_id" "uuid" NOT NULL,
    "machine_id" "uuid" NOT NULL,
    "stop_order" integer DEFAULT 1 NOT NULL,
    "status" "public"."route_stop_status" DEFAULT 'pending'::"public"."route_stop_status" NOT NULL,
    "arrived_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "notes" "text"
);


ALTER TABLE "public"."route_stops" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."routes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "route_date" "date" NOT NULL,
    "operator_id" "uuid",
    "status" "public"."route_status" DEFAULT 'draft'::"public"."route_status" NOT NULL,
    "created_by" "uuid",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cancelled_at" timestamp with time zone,
    "cancelled_by" "uuid",
    "cancellation_reason" "text"
);


ALTER TABLE "public"."routes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "contact_name" "text",
    "phone" "text",
    "payment_terms" "text",
    "usual_delivery_days" integer DEFAULT 1,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."system_activity_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_user_id" "uuid",
    "actor_team_member_id" "uuid",
    "actor_name" "text",
    "actor_role" "text",
    "action" "text" NOT NULL,
    "entity_type" "text" NOT NULL,
    "entity_id" "uuid",
    "entity_label" "text",
    "before_data" "jsonb",
    "after_data" "jsonb",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "ip_address" "text",
    "user_agent" "text",
    "summary" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."system_activity_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_header_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_type" "text" NOT NULL,
    "source_signature" "text" NOT NULL,
    "header_names" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "required_field_mapping" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "optional_field_mapping" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_used_mapping" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "use_count" integer DEFAULT 1 NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "source_header" "text",
    "target_field" "text"
);


ALTER TABLE "public"."vms_header_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_import_preview_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "preview_id" "uuid" NOT NULL,
    "sheet_name" "text",
    "row_number" integer NOT NULL,
    "raw_row" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "import_batch_id" "uuid",
    "normalized_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "mapped_product_id" "uuid",
    "mapped_machine_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "review_reason" "text",
    "suggested_mapping" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "duplicate_hash" "text",
    CONSTRAINT "vms_import_preview_rows_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'needs_review'::"text", 'duplicate'::"text", 'imported'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."vms_import_preview_rows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_import_previews" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "file_name" "text" NOT NULL,
    "file_type" "text" NOT NULL,
    "report_type" "text" NOT NULL,
    "sheets" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "uploaded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "file_size_bytes" bigint
);


ALTER TABLE "public"."vms_import_previews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_import_raw_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid" NOT NULL,
    "source_row_number" integer NOT NULL,
    "original_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "mapped_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "row_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "row_reasons" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "vms_machine_identifier" "text",
    "vms_product_id" "text",
    "vms_product_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vms_import_raw_rows_status_check" CHECK (("row_status" = ANY (ARRAY['pending'::"text", 'imported'::"text", 'needs_mapping'::"text", 'unknown_machine'::"text", 'invalid_row'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."vms_import_raw_rows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_import_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid" NOT NULL,
    "row_number" integer NOT NULL,
    "raw_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "normalized_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "validation_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "validation_errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "machine_match_status" "text",
    "product_match_status" "text",
    "matched_machine_id" "uuid",
    "matched_product_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vms_import_rows_validation_status_check" CHECK (("validation_status" = ANY (ARRAY['pending'::"text", 'imported'::"text", 'needs_mapping'::"text", 'unknown_machine'::"text", 'invalid_row'::"text", 'skipped'::"text"])))
);


ALTER TABLE "public"."vms_import_rows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_machine_aliases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "mapping_id" "uuid" NOT NULL,
    "alias" "text" NOT NULL,
    "alias_key" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vms_machine_aliases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_machine_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vms_machine_key" "text" NOT NULL,
    "vms_machine_name" "text",
    "machine_id" "uuid",
    "location_id" "uuid",
    "confidence_score" numeric(5,4) DEFAULT 1 NOT NULL,
    "status" "text" DEFAULT 'needs_review'::"text" NOT NULL,
    "aliases" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "vms_machine_code" "text",
    "snacky_machine_id" "uuid",
    "snacky_machine_name" "text",
    CONSTRAINT "vms_machine_mappings_confidence_check" CHECK ((("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (1)::numeric))),
    CONSTRAINT "vms_machine_mappings_status_check" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'suggested'::"text", 'needs_review'::"text", 'ignored'::"text"])))
);


ALTER TABLE "public"."vms_machine_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_machine_status_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sync_run_id" "uuid",
    "machine_id" "uuid",
    "vms_machine_id" "text",
    "network_status" "text",
    "temperature_raw" "text",
    "humidity_raw" "text",
    "raw_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vms_machine_status_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_product_catalog_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sync_run_id" "uuid",
    "vms_product_id" "text",
    "third_party_product_id" "text",
    "product_id" "uuid",
    "product_name" "text",
    "barcode" "text",
    "selling_price_lyd" numeric(12,2),
    "image_url" "text",
    "detail_images" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "raw_data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "captured_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vms_product_catalog_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_product_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "vms_product_id" "text",
    "vms_product_name" "text" NOT NULL,
    "product_id" "uuid",
    "match_status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "vms_selling_price_lyd" numeric(12,2),
    "vms_cost_price_lyd" numeric(12,4),
    "latest_machine_id" "uuid",
    "latest_vms_machine_id" "text",
    "latest_machine_name" "text",
    "last_seen_at" timestamp with time zone,
    "last_import_batch_id" "uuid",
    "vms_third_party_product_id" "text",
    "vms_barcode" "text",
    "vms_image_url" "text",
    "vms_raw_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "confidence_score" numeric(5,4) DEFAULT 1 NOT NULL,
    "snacky_product_name" "text",
    "vms_product_code" "text",
    "snacky_product_id" "uuid",
    "status" "text" DEFAULT 'confirmed'::"text" NOT NULL,
    "created_by" "uuid",
    CONSTRAINT "vms_product_mappings_confidence_check" CHECK ((("confidence_score" IS NULL) OR (("confidence_score" >= (0)::numeric) AND ("confidence_score" <= (1)::numeric)))),
    CONSTRAINT "vms_product_mappings_match_status_check" CHECK (("match_status" = ANY (ARRAY['confirmed'::"text", 'suggested'::"text", 'needs_review'::"text", 'ignored'::"text"]))),
    CONSTRAINT "vms_product_mappings_status_check" CHECK (("status" = ANY (ARRAY['confirmed'::"text", 'suggested'::"text", 'needs_review'::"text", 'ignored'::"text"])))
);


ALTER TABLE "public"."vms_product_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_sales_raw" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid",
    "row_number" integer,
    "raw_row" "jsonb" NOT NULL,
    "normalized_row" "jsonb",
    "machine_id" "uuid",
    "product_id" "uuid",
    "sale_date" "date",
    "sale_datetime" timestamp with time zone,
    "quantity" numeric DEFAULT 0 NOT NULL,
    "gross_sales_lyd" numeric DEFAULT 0 NOT NULL,
    "net_sales_lyd" numeric,
    "duplicate_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."vms_sales_raw" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_sales_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "import_batch_id" "uuid",
    "machine_id" "uuid",
    "product_id" "uuid",
    "sold_qty" integer DEFAULT 0 NOT NULL,
    "sales_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "cash_sales_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "card_sales_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "period_start" timestamp with time zone NOT NULL,
    "period_end" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "cost_amount" numeric(12,2),
    "profit_amount" numeric(12,2),
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "import_row_number" integer,
    "import_row_status" "text" DEFAULT 'imported'::"text" NOT NULL,
    "machine_code" "text",
    "machine_name" "text",
    "product_number" "text",
    "product_name" "text",
    "commodity_price" numeric(12,2),
    "transaction_count" integer,
    "transaction_amount" numeric(12,2),
    "refund_count" integer,
    "refund_amount" numeric(12,2),
    "total_transaction" numeric(12,2),
    "sales_period_start" "date",
    "sales_period_end" "date",
    "sales_month" "date",
    "source_row_key" "text",
    "vms_transaction_id" "text",
    "gross_sales_amount" numeric(12,2),
    "net_sales_amount" numeric(12,2),
    "cost_method" "text",
    "unit_cost_amount" numeric(12,4),
    "gross_profit_amount" numeric(12,2),
    "duplicate_of" "uuid",
    "duplicate_checked_at" timestamp with time zone,
    CONSTRAINT "sales_amount_nonnegative" CHECK (("sales_amount" >= (0)::numeric)),
    CONSTRAINT "sold_qty_nonnegative" CHECK (("sold_qty" >= 0)),
    CONSTRAINT "vms_sales_snapshots_import_row_status_check" CHECK (("import_row_status" = ANY (ARRAY['imported'::"text", 'reprocessed_stale'::"text"])))
);


ALTER TABLE "public"."vms_sales_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vms_sync_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider" "text" DEFAULT 'xy'::"text" NOT NULL,
    "sync_type" "text" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "endpoint" "text",
    "merchant_id_masked" "text",
    "requested_by" "uuid",
    "row_count" integer DEFAULT 0 NOT NULL,
    "rows_imported" integer DEFAULT 0 NOT NULL,
    "rows_updated" integer DEFAULT 0 NOT NULL,
    "rows_skipped" integer DEFAULT 0 NOT NULL,
    "error_count" integer DEFAULT 0 NOT NULL,
    "message" "text",
    "request_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "response_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "vms_sync_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'completed_with_warnings'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."vms_sync_runs" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vms_transaction_status_daily" AS
 SELECT (COALESCE("tx"."payment_time", "tx"."delivery_time"))::"date" AS "sale_date",
    "tx"."mapped_machine_id" AS "machine_id",
    COALESCE("m"."name", "tx"."machine_name", "tx"."machine_code", 'Unmapped machine'::"text") AS "machine_name",
    "tx"."mapped_product_id" AS "product_id",
    COALESCE("p"."name", "tx"."vms_product_name", "tx"."product_number", 'Unmapped product'::"text") AS "product_name",
    "count"(*) FILTER (WHERE ("tx"."transaction_status" = 'failed_vend'::"text")) AS "failed_vend_count",
    ("sum"(COALESCE("tx"."payment_amount", (0)::numeric)) FILTER (WHERE ("tx"."transaction_status" = 'failed_vend'::"text")))::numeric(12,2) AS "failed_vend_amount",
    "count"(*) FILTER (WHERE ("tx"."transaction_status" = 'refunded'::"text")) AS "refund_count",
    ("sum"(COALESCE("tx"."payment_amount", (0)::numeric)) FILTER (WHERE ("tx"."transaction_status" = 'refunded'::"text")))::numeric(12,2) AS "refund_amount",
    "count"(*) FILTER (WHERE ("tx"."transaction_status" = 'failed_payment'::"text")) AS "failed_payment_count",
    "count"(*) FILTER (WHERE ("tx"."transaction_status" = 'needs_review'::"text")) AS "needs_review_count",
    "count"(*) AS "transaction_rows"
   FROM ((("public"."vms_transactions_raw" "tx"
     JOIN "public"."vms_import_batches" "vib" ON (("vib"."id" = "tx"."import_batch_id")))
     LEFT JOIN "public"."machines" "m" ON (("m"."id" = "tx"."mapped_machine_id")))
     LEFT JOIN "public"."products" "p" ON (("p"."id" = "tx"."mapped_product_id")))
  WHERE ((COALESCE("tx"."payment_time", "tx"."delivery_time") IS NOT NULL) AND ("vib"."status" = ANY (ARRAY['imported'::"text", 'imported_with_warnings'::"text", 'partially_imported'::"text"])) AND ("vib"."is_active" = true) AND ("vib"."deleted_at" IS NULL))
  GROUP BY ((COALESCE("tx"."payment_time", "tx"."delivery_time"))::"date"), "tx"."mapped_machine_id", COALESCE("m"."name", "tx"."machine_name", "tx"."machine_code", 'Unmapped machine'::"text"), "tx"."mapped_product_id", COALESCE("p"."name", "tx"."vms_product_name", "tx"."product_number", 'Unmapped product'::"text");


ALTER VIEW "public"."vms_transaction_status_daily" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."vms_transaction_status_monthly" AS
 SELECT ("date_trunc"('month'::"text", ("sale_date")::timestamp with time zone))::"date" AS "sales_month",
    ("sum"("failed_vend_count"))::integer AS "failed_vend_count",
    ("sum"(COALESCE("failed_vend_amount", (0)::numeric)))::numeric(12,2) AS "failed_vend_amount",
    ("sum"("refund_count"))::integer AS "refund_count",
    ("sum"(COALESCE("refund_amount", (0)::numeric)))::numeric(12,2) AS "refund_amount",
    ("sum"("failed_payment_count"))::integer AS "failed_payment_count",
    ("sum"("needs_review_count"))::integer AS "needs_review_count",
    ("sum"("transaction_rows"))::integer AS "transaction_rows"
   FROM "public"."vms_transaction_status_daily"
  GROUP BY (("date_trunc"('month'::"text", ("sale_date")::timestamp with time zone))::"date");


ALTER VIEW "public"."vms_transaction_status_monthly" OWNER TO "postgres";


ALTER TABLE ONLY "public"."cash_collections"
    ADD CONSTRAINT "cash_collections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."finance_import_batches"
    ADD CONSTRAINT "finance_import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."finance_import_rows"
    ADD CONSTRAINT "finance_import_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."finance_import_rows"
    ADD CONSTRAINT "finance_import_rows_source_file_source_sheet_source_row_key" UNIQUE ("source_file", "source_sheet", "source_row");



ALTER TABLE ONLY "public"."finance_settings"
    ADD CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."historical_route_deduction_batches"
    ADD CONSTRAINT "historical_route_deduction_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."historical_route_deduction_lines"
    ADD CONSTRAINT "historical_route_deduction_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."issues"
    ADD CONSTRAINT "issues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."locations"
    ADD CONSTRAINT "locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."machine_aliases"
    ADD CONSTRAINT "machine_aliases_alias_name_key" UNIQUE ("alias_name");



ALTER TABLE ONLY "public"."machine_aliases"
    ADD CONSTRAINT "machine_aliases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_legacy_refill_id_unique" UNIQUE ("legacy_refill_id");



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_source_row_unique" UNIQUE ("source_file", "source_row");



ALTER TABLE ONLY "public"."machine_slots"
    ADD CONSTRAINT "machine_slots_machine_id_slot_code_key" UNIQUE ("machine_id", "slot_code");



ALTER TABLE ONLY "public"."machine_slots"
    ADD CONSTRAINT "machine_slots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."machines"
    ADD CONSTRAINT "machines_machine_code_key" UNIQUE ("machine_code");



ALTER TABLE ONLY "public"."machines"
    ADD CONSTRAINT "machines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."machines"
    ADD CONSTRAINT "machines_vms_machine_id_key" UNIQUE ("vms_machine_id");



ALTER TABLE ONLY "public"."product_aliases"
    ADD CONSTRAINT "product_aliases_alias_name_product_id_key" UNIQUE ("alias_name", "product_id");



ALTER TABLE ONLY "public"."product_aliases"
    ADD CONSTRAINT "product_aliases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_sku_key" UNIQUE ("sku");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_order_lines"
    ADD CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."receipt_scan_results"
    ADD CONSTRAINT "receipt_scan_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."refill_order_lines"
    ADD CONSTRAINT "refill_order_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."refill_orders"
    ADD CONSTRAINT "refill_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_pick_adjustments"
    ADD CONSTRAINT "route_pick_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_pickup_batch_stops"
    ADD CONSTRAINT "route_pickup_batch_stops_pkey" PRIMARY KEY ("pickup_batch_id", "route_stop_id");



ALTER TABLE ONLY "public"."route_pickup_batches"
    ADD CONSTRAINT "route_pickup_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_stock_lines"
    ADD CONSTRAINT "route_stock_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_stock_lines"
    ADD CONSTRAINT "route_stock_lines_route_id_product_id_key" UNIQUE ("route_id", "product_id");



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_stop_items"
    ADD CONSTRAINT "route_stop_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_stops"
    ADD CONSTRAINT "route_stops_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."route_stops"
    ADD CONSTRAINT "route_stops_route_id_machine_id_key" UNIQUE ("route_id", "machine_id");



ALTER TABLE ONLY "public"."routes"
    ADD CONSTRAINT "routes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."storage_locations"
    ADD CONSTRAINT "storage_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."system_activity_logs"
    ADD CONSTRAINT "system_activity_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_header_mappings"
    ADD CONSTRAINT "vms_header_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_header_mappings"
    ADD CONSTRAINT "vms_header_mappings_report_type_source_signature_key" UNIQUE ("report_type", "source_signature");



ALTER TABLE ONLY "public"."vms_import_batches"
    ADD CONSTRAINT "vms_import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_import_preview_rows"
    ADD CONSTRAINT "vms_import_preview_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_import_preview_rows"
    ADD CONSTRAINT "vms_import_preview_rows_preview_id_sheet_name_row_number_key" UNIQUE ("preview_id", "sheet_name", "row_number");



ALTER TABLE ONLY "public"."vms_import_previews"
    ADD CONSTRAINT "vms_import_previews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_import_raw_rows"
    ADD CONSTRAINT "vms_import_raw_rows_import_batch_id_source_row_number_key" UNIQUE ("import_batch_id", "source_row_number");



ALTER TABLE ONLY "public"."vms_import_raw_rows"
    ADD CONSTRAINT "vms_import_raw_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_import_rows"
    ADD CONSTRAINT "vms_import_rows_import_batch_id_row_number_key" UNIQUE ("import_batch_id", "row_number");



ALTER TABLE ONLY "public"."vms_import_rows"
    ADD CONSTRAINT "vms_import_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_machine_aliases"
    ADD CONSTRAINT "vms_machine_aliases_alias_key_key" UNIQUE ("alias_key");



ALTER TABLE ONLY "public"."vms_machine_aliases"
    ADD CONSTRAINT "vms_machine_aliases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_machine_mappings"
    ADD CONSTRAINT "vms_machine_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_machine_mappings"
    ADD CONSTRAINT "vms_machine_mappings_vms_machine_key_key" UNIQUE ("vms_machine_key");



ALTER TABLE ONLY "public"."vms_machine_status_snapshots"
    ADD CONSTRAINT "vms_machine_status_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_product_catalog_snapshots"
    ADD CONSTRAINT "vms_product_catalog_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_product_mappings"
    ADD CONSTRAINT "vms_product_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_product_mappings"
    ADD CONSTRAINT "vms_product_mappings_vms_product_id_vms_product_name_key" UNIQUE ("vms_product_id", "vms_product_name");



ALTER TABLE ONLY "public"."vms_sales_raw"
    ADD CONSTRAINT "vms_sales_raw_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_sales_snapshots"
    ADD CONSTRAINT "vms_sales_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_stock_snapshots"
    ADD CONSTRAINT "vms_stock_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_sync_runs"
    ADD CONSTRAINT "vms_sync_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vms_transactions_raw"
    ADD CONSTRAINT "vms_transactions_raw_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "financial_transactions_cash_collection_source_uidx" ON "public"."financial_transactions" USING "btree" ("source_type", "source_id") WHERE (("source_type" = 'cash_collection'::"text") AND ("source_id" IS NOT NULL));



CREATE UNIQUE INDEX "financial_transactions_linked_cash_collection_id_uidx" ON "public"."financial_transactions" USING "btree" ("linked_cash_collection_id") WHERE ("linked_cash_collection_id" IS NOT NULL);



CREATE UNIQUE INDEX "financial_transactions_linked_purchase_id_uidx" ON "public"."financial_transactions" USING "btree" ("linked_purchase_id") WHERE ("linked_purchase_id" IS NOT NULL);



CREATE UNIQUE INDEX "financial_transactions_purchase_source_uidx" ON "public"."financial_transactions" USING "btree" ("source_type", "source_id") WHERE (("source_type" = 'purchase'::"text") AND ("source_id" IS NOT NULL));



CREATE INDEX "idx_cash_collections_machine_date" ON "public"."cash_collections" USING "btree" ("machine_id", "collected_at" DESC);



CREATE INDEX "idx_cash_collections_operator_date" ON "public"."cash_collections" USING "btree" ("operator_id", "collected_at" DESC);



CREATE INDEX "idx_cash_collections_status_date" ON "public"."cash_collections" USING "btree" ("review_status", "collected_at" DESC);



CREATE INDEX "idx_finance_import_rows_review_group" ON "public"."finance_import_rows" USING "btree" ("import_status", "review_group_key");



CREATE INDEX "idx_finance_import_rows_status" ON "public"."finance_import_rows" USING "btree" ("import_status", "source_file", "source_sheet", "source_row");



CREATE INDEX "idx_finance_settings_updated_at" ON "public"."finance_settings" USING "btree" ("updated_at" DESC);



CREATE INDEX "idx_financial_transactions_account_currency_date" ON "public"."financial_transactions" USING "btree" ("account_id", "currency", "transaction_date" DESC);



CREATE INDEX "idx_financial_transactions_business_dedupe" ON "public"."financial_transactions" USING "btree" ("transaction_date", "amount", COALESCE("original_description", "description", ''::"text"), "currency", "transaction_effect", COALESCE("account_id", ''::"text"), COALESCE("source_account_id", ''::"text"), COALESCE("destination_account_id", ''::"text")) WHERE (("transaction_status" = 'active'::"text") AND (COALESCE("import_status", ''::"text") <> ALL (ARRAY['ignored'::"text", 'skipped'::"text"])));



CREATE UNIQUE INDEX "idx_financial_transactions_cash_collection" ON "public"."financial_transactions" USING "btree" ("related_cash_collection_id") WHERE (("related_cash_collection_id" IS NOT NULL) AND ("transaction_kind" = 'cash_collection'::"text"));



CREATE INDEX "idx_financial_transactions_date" ON "public"."financial_transactions" USING "btree" ("transaction_date" DESC);



CREATE INDEX "idx_financial_transactions_import_batch" ON "public"."financial_transactions" USING "btree" ("import_batch_id");



CREATE INDEX "idx_financial_transactions_import_status" ON "public"."financial_transactions" USING "btree" ("import_status", "source_file", "source_sheet", "source_row");



CREATE INDEX "idx_financial_transactions_kind" ON "public"."financial_transactions" USING "btree" ("transaction_kind", "transaction_date" DESC);



CREATE UNIQUE INDEX "idx_financial_transactions_purchase" ON "public"."financial_transactions" USING "btree" ("related_purchase_id") WHERE (("related_purchase_id" IS NOT NULL) AND ("transaction_kind" = 'product_purchase'::"text"));



CREATE INDEX "idx_financial_transactions_related_refs" ON "public"."financial_transactions" USING "btree" ("related_purchase_id", "related_route_id", "related_machine_id", "related_location_id");



CREATE INDEX "idx_financial_transactions_review" ON "public"."financial_transactions" USING "btree" ("needs_review", "review_status", "transaction_date" DESC);



CREATE UNIQUE INDEX "idx_financial_transactions_source" ON "public"."financial_transactions" USING "btree" ("source_sheet", "source_row") WHERE (("source_sheet" IS NOT NULL) AND ("source_row" IS NOT NULL));



CREATE UNIQUE INDEX "idx_financial_transactions_source_file_row" ON "public"."financial_transactions" USING "btree" ("source_file", "source_sheet", "source_row") WHERE (("source_file" IS NOT NULL) AND ("source_sheet" IS NOT NULL) AND ("source_row" IS NOT NULL));



CREATE INDEX "idx_financial_transactions_status_date" ON "public"."financial_transactions" USING "btree" ("transaction_status", "transaction_date" DESC);



CREATE INDEX "idx_historical_route_deduction_batches_hash" ON "public"."historical_route_deduction_batches" USING "btree" ("content_hash") WHERE ("content_hash" IS NOT NULL);



CREATE INDEX "idx_historical_route_deduction_batches_status" ON "public"."historical_route_deduction_batches" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_historical_route_deduction_lines_batch" ON "public"."historical_route_deduction_lines" USING "btree" ("import_batch_id", "status");



CREATE INDEX "idx_historical_route_deduction_lines_machine_product" ON "public"."historical_route_deduction_lines" USING "btree" ("machine_id", "product_id");



CREATE INDEX "idx_inventory_movements_created_by" ON "public"."inventory_movements" USING "btree" ("created_by");



CREATE INDEX "idx_inventory_movements_from" ON "public"."inventory_movements" USING "btree" ("from_entity_type", "from_entity_id");



CREATE UNIQUE INDEX "idx_inventory_movements_historical_route_line_once" ON "public"."inventory_movements" USING "btree" ("historical_route_deduction_line_id") WHERE ("historical_route_deduction_line_id" IS NOT NULL);



CREATE INDEX "idx_inventory_movements_import_batch" ON "public"."inventory_movements" USING "btree" ("import_batch_id");



CREATE INDEX "idx_inventory_movements_pickup_batch_id" ON "public"."inventory_movements" USING "btree" ("related_pickup_batch_id");



CREATE INDEX "idx_inventory_movements_product" ON "public"."inventory_movements" USING "btree" ("product_id");



CREATE UNIQUE INDEX "idx_inventory_movements_purchase_line_received" ON "public"."inventory_movements" USING "btree" ("related_purchase_line_id") WHERE (("reason" = 'purchase_received'::"public"."movement_reason") AND ("related_purchase_line_id" IS NOT NULL));



CREATE INDEX "idx_inventory_movements_reason_created" ON "public"."inventory_movements" USING "btree" ("reason", "created_at" DESC);



CREATE INDEX "idx_inventory_movements_related_machine" ON "public"."inventory_movements" USING "btree" ("related_machine_id");



CREATE INDEX "idx_inventory_movements_related_purchase" ON "public"."inventory_movements" USING "btree" ("related_purchase_id");



CREATE INDEX "idx_inventory_movements_related_route" ON "public"."inventory_movements" USING "btree" ("related_route_id");



CREATE INDEX "idx_inventory_movements_related_route_stop" ON "public"."inventory_movements" USING "btree" ("related_route_stop_id");



CREATE INDEX "idx_inventory_movements_reversed_movement" ON "public"."inventory_movements" USING "btree" ("reversed_movement_id");



CREATE INDEX "idx_inventory_movements_to" ON "public"."inventory_movements" USING "btree" ("to_entity_type", "to_entity_id");



CREATE INDEX "idx_issues_machine_status" ON "public"."issues" USING "btree" ("machine_id", "status");



CREATE INDEX "idx_machine_aliases_lookup" ON "public"."machine_aliases" USING "btree" ("lower"("alias_name"));



CREATE INDEX "idx_machine_refill_history_issues" ON "public"."machine_refill_history" USING "btree" ("issues_found", "refill_at" DESC);



CREATE INDEX "idx_machine_refill_history_machine_at" ON "public"."machine_refill_history" USING "btree" ("machine_id", "refill_at" DESC);



CREATE INDEX "idx_machine_refill_history_operator_at" ON "public"."machine_refill_history" USING "btree" ("operator_id", "refill_at" DESC);



CREATE INDEX "idx_machine_refill_history_refill_at" ON "public"."machine_refill_history" USING "btree" ("refill_at" DESC);



CREATE INDEX "idx_machine_refill_history_route_id" ON "public"."machine_refill_history" USING "btree" ("route_id");



CREATE INDEX "idx_machine_refill_history_route_stop_id" ON "public"."machine_refill_history" USING "btree" ("route_stop_id");



CREATE INDEX "idx_machine_slots_machine_id" ON "public"."machine_slots" USING "btree" ("machine_id");



CREATE INDEX "idx_machines_location_id" ON "public"."machines" USING "btree" ("location_id");



CREATE INDEX "idx_product_aliases_alias_name" ON "public"."product_aliases" USING "btree" ("lower"("alias_name"));



CREATE INDEX "idx_product_aliases_product" ON "public"."product_aliases" USING "btree" ("product_id");



CREATE INDEX "idx_products_last_purchase_line_id" ON "public"."products" USING "btree" ("last_purchase_line_id");



CREATE INDEX "idx_products_last_supplier_id" ON "public"."products" USING "btree" ("last_supplier_id");



CREATE INDEX "idx_profiles_active_status" ON "public"."profiles" USING "btree" ("active_status");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_profiles_roles" ON "public"."profiles" USING "gin" ("roles");



CREATE INDEX "idx_profiles_team_member_id" ON "public"."profiles" USING "btree" ("team_member_id");



CREATE INDEX "idx_purchase_order_lines_position" ON "public"."purchase_order_lines" USING "btree" ("purchase_order_id", "line_position");



CREATE INDEX "idx_purchase_order_lines_purchase" ON "public"."purchase_order_lines" USING "btree" ("purchase_order_id");



CREATE INDEX "idx_purchase_orders_payment_status" ON "public"."purchase_orders" USING "btree" ("payment_status", "order_date" DESC);



CREATE INDEX "idx_purchase_orders_receipt_storage_path" ON "public"."purchase_orders" USING "btree" ("receipt_storage_path") WHERE ("receipt_storage_path" IS NOT NULL);



CREATE INDEX "idx_purchase_orders_status_date" ON "public"."purchase_orders" USING "btree" ("status", "order_date" DESC);



CREATE INDEX "idx_receipt_scan_results_created_by" ON "public"."receipt_scan_results" USING "btree" ("created_by", "created_at" DESC);



CREATE INDEX "idx_receipt_scan_results_purchase" ON "public"."receipt_scan_results" USING "btree" ("purchase_id");



CREATE INDEX "idx_receipt_scan_results_status" ON "public"."receipt_scan_results" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_refill_order_lines_slot_allocations" ON "public"."refill_order_lines" USING "gin" ("slot_allocations");



CREATE INDEX "idx_route_pick_adjustments_needs_review" ON "public"."route_pick_adjustments" USING "btree" ("needs_review");



CREATE INDEX "idx_route_pick_adjustments_route_id" ON "public"."route_pick_adjustments" USING "btree" ("route_id");



CREATE INDEX "idx_route_pick_list_items_machine_id" ON "public"."route_pick_list_items" USING "btree" ("machine_id");



CREATE INDEX "idx_route_pick_list_items_needs_review" ON "public"."route_pick_list_items" USING "btree" ("needs_review");



CREATE INDEX "idx_route_pick_list_items_pickup_batch_id" ON "public"."route_pick_list_items" USING "btree" ("pickup_batch_id");



CREATE INDEX "idx_route_pick_list_items_product_id" ON "public"."route_pick_list_items" USING "btree" ("product_id");



CREATE INDEX "idx_route_pick_list_items_route_id" ON "public"."route_pick_list_items" USING "btree" ("route_id");



CREATE INDEX "idx_route_pick_list_items_route_stop_id" ON "public"."route_pick_list_items" USING "btree" ("route_stop_id");



CREATE INDEX "idx_route_pick_list_items_route_stop_item_id" ON "public"."route_pick_list_items" USING "btree" ("route_stop_item_id");



CREATE INDEX "idx_route_pickup_batch_stops_route_stop_id" ON "public"."route_pickup_batch_stops" USING "btree" ("route_stop_id");



CREATE INDEX "idx_route_pickup_batches_operator_id" ON "public"."route_pickup_batches" USING "btree" ("operator_id");



CREATE INDEX "idx_route_pickup_batches_route_id" ON "public"."route_pickup_batches" USING "btree" ("route_id");



CREATE INDEX "idx_route_stock_lines_product_id" ON "public"."route_stock_lines" USING "btree" ("product_id");



CREATE INDEX "idx_route_stock_lines_route_id" ON "public"."route_stock_lines" USING "btree" ("route_id");



CREATE INDEX "idx_route_stop_fill_lines_needs_review" ON "public"."route_stop_fill_lines" USING "btree" ("needs_review");



CREATE INDEX "idx_route_stop_fill_lines_route_id" ON "public"."route_stop_fill_lines" USING "btree" ("route_id");



CREATE INDEX "idx_route_stop_fill_lines_route_stop_id" ON "public"."route_stop_fill_lines" USING "btree" ("route_stop_id");



CREATE INDEX "idx_route_stop_items_product_id" ON "public"."route_stop_items" USING "btree" ("product_id");



CREATE INDEX "idx_route_stop_items_route_id" ON "public"."route_stop_items" USING "btree" ("route_id");



CREATE INDEX "idx_route_stop_items_route_stop_id" ON "public"."route_stop_items" USING "btree" ("route_stop_id");



CREATE INDEX "idx_route_stop_items_slot_allocations" ON "public"."route_stop_items" USING "gin" ("slot_allocations");



CREATE INDEX "idx_routes_cancelled_at" ON "public"."routes" USING "btree" ("cancelled_at" DESC) WHERE ("cancelled_at" IS NOT NULL);



CREATE INDEX "idx_routes_operator_date" ON "public"."routes" USING "btree" ("operator_id", "route_date");



CREATE INDEX "idx_storage_locations_active_type" ON "public"."storage_locations" USING "btree" ("active", "location_type");



CREATE INDEX "idx_storage_locations_location_type" ON "public"."storage_locations" USING "btree" ("location_type");



CREATE INDEX "idx_storage_locations_related_operator" ON "public"."storage_locations" USING "btree" ("related_operator_id");



CREATE INDEX "idx_system_activity_logs_action" ON "public"."system_activity_logs" USING "btree" ("action", "created_at" DESC);



CREATE INDEX "idx_system_activity_logs_actor" ON "public"."system_activity_logs" USING "btree" ("actor_team_member_id", "created_at" DESC);



CREATE INDEX "idx_system_activity_logs_actor_role" ON "public"."system_activity_logs" USING "btree" ("actor_role", "created_at" DESC);



CREATE INDEX "idx_system_activity_logs_actor_team_member" ON "public"."system_activity_logs" USING "btree" ("actor_team_member_id", "created_at" DESC);



CREATE INDEX "idx_system_activity_logs_actor_user" ON "public"."system_activity_logs" USING "btree" ("actor_user_id", "created_at" DESC);



CREATE INDEX "idx_system_activity_logs_created" ON "public"."system_activity_logs" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_system_activity_logs_entity" ON "public"."system_activity_logs" USING "btree" ("entity_type", "entity_id");



CREATE INDEX "idx_team_members_active_status" ON "public"."team_members" USING "btree" ("active_status");



CREATE INDEX "idx_team_members_auth_user_id" ON "public"."team_members" USING "btree" ("auth_user_id");



CREATE INDEX "idx_team_members_can_add_products" ON "public"."team_members" USING "btree" ("can_add_products");



CREATE INDEX "idx_team_members_roles" ON "public"."team_members" USING "gin" ("roles");



CREATE UNIQUE INDEX "idx_vms_header_mappings_report_source_header" ON "public"."vms_header_mappings" USING "btree" ("report_type", "source_header") WHERE ("source_header" IS NOT NULL);



CREATE INDEX "idx_vms_header_mappings_report_type_updated" ON "public"."vms_header_mappings" USING "btree" ("report_type", "updated_at" DESC);



CREATE INDEX "idx_vms_import_batches_status" ON "public"."vms_import_batches" USING "btree" ("status");



CREATE INDEX "idx_vms_import_batches_uploaded_at" ON "public"."vms_import_batches" USING "btree" ("uploaded_at" DESC);



CREATE INDEX "idx_vms_import_preview_rows_batch" ON "public"."vms_import_preview_rows" USING "btree" ("import_batch_id", "row_number");



CREATE INDEX "idx_vms_import_preview_rows_batch_row" ON "public"."vms_import_preview_rows" USING "btree" ("import_batch_id", "row_number");



CREATE INDEX "idx_vms_import_preview_rows_duplicate_hash" ON "public"."vms_import_preview_rows" USING "btree" ("duplicate_hash");



CREATE INDEX "idx_vms_import_preview_rows_preview" ON "public"."vms_import_preview_rows" USING "btree" ("preview_id", "row_number");



CREATE INDEX "idx_vms_import_preview_rows_status" ON "public"."vms_import_preview_rows" USING "btree" ("status");



CREATE INDEX "idx_vms_import_previews_created_at" ON "public"."vms_import_previews" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_vms_import_raw_rows_batch" ON "public"."vms_import_raw_rows" USING "btree" ("import_batch_id", "source_row_number");



CREATE INDEX "idx_vms_import_raw_rows_status" ON "public"."vms_import_raw_rows" USING "btree" ("row_status");



CREATE INDEX "idx_vms_import_rows_batch" ON "public"."vms_import_rows" USING "btree" ("import_batch_id", "row_number");



CREATE INDEX "idx_vms_import_rows_product_match_status" ON "public"."vms_import_rows" USING "btree" ("product_match_status");



CREATE INDEX "idx_vms_import_rows_validation_status" ON "public"."vms_import_rows" USING "btree" ("validation_status");



CREATE INDEX "idx_vms_machine_aliases_mapping" ON "public"."vms_machine_aliases" USING "btree" ("mapping_id");



CREATE INDEX "idx_vms_machine_mappings_machine" ON "public"."vms_machine_mappings" USING "btree" ("machine_id");



CREATE INDEX "idx_vms_machine_mappings_status" ON "public"."vms_machine_mappings" USING "btree" ("status");



CREATE INDEX "idx_vms_machine_status_snapshots_machine" ON "public"."vms_machine_status_snapshots" USING "btree" ("machine_id", "captured_at" DESC);



CREATE INDEX "idx_vms_machine_status_snapshots_sync_run" ON "public"."vms_machine_status_snapshots" USING "btree" ("sync_run_id");



CREATE INDEX "idx_vms_product_catalog_snapshots_product" ON "public"."vms_product_catalog_snapshots" USING "btree" ("vms_product_id", "third_party_product_id", "captured_at" DESC);



CREATE INDEX "idx_vms_product_catalog_snapshots_sync_run" ON "public"."vms_product_catalog_snapshots" USING "btree" ("sync_run_id");



CREATE INDEX "idx_vms_product_mappings_barcode" ON "public"."vms_product_mappings" USING "btree" ("vms_barcode");



CREATE INDEX "idx_vms_product_mappings_last_seen" ON "public"."vms_product_mappings" USING "btree" ("last_seen_at" DESC);



CREATE UNIQUE INDEX "idx_vms_product_mappings_name_code_unique" ON "public"."vms_product_mappings" USING "btree" ("lower"("vms_product_name"), COALESCE("vms_product_code", ''::"text"));



CREATE INDEX "idx_vms_product_mappings_product_id" ON "public"."vms_product_mappings" USING "btree" ("product_id");



CREATE INDEX "idx_vms_product_mappings_snacky_product" ON "public"."vms_product_mappings" USING "btree" ("snacky_product_id");



CREATE INDEX "idx_vms_product_mappings_status_updated" ON "public"."vms_product_mappings" USING "btree" ("status", "updated_at" DESC);



CREATE INDEX "idx_vms_product_mappings_third_party" ON "public"."vms_product_mappings" USING "btree" ("vms_third_party_product_id");



CREATE UNIQUE INDEX "idx_vms_sales_raw_duplicate_hash" ON "public"."vms_sales_raw" USING "btree" ("duplicate_hash");



CREATE UNIQUE INDEX "idx_vms_sales_snapshots_batch_row" ON "public"."vms_sales_snapshots" USING "btree" ("import_batch_id", "import_row_number");



CREATE INDEX "idx_vms_sales_snapshots_import_row_status" ON "public"."vms_sales_snapshots" USING "btree" ("import_row_status");



CREATE INDEX "idx_vms_sales_snapshots_machine_product_month" ON "public"."vms_sales_snapshots" USING "btree" ("machine_code", "product_number", "sales_month");



CREATE INDEX "idx_vms_sales_snapshots_report_range" ON "public"."vms_sales_snapshots" USING "btree" ("sales_period_start", "sales_period_end") WHERE ("import_row_status" = 'imported'::"text");



CREATE INDEX "idx_vms_sales_snapshots_sales_month" ON "public"."vms_sales_snapshots" USING "btree" ("sales_month");



CREATE UNIQUE INDEX "idx_vms_sales_snapshots_source_row_key_imported" ON "public"."vms_sales_snapshots" USING "btree" ("source_row_key") WHERE (("source_row_key" IS NOT NULL) AND ("import_row_status" = 'imported'::"text"));



CREATE INDEX "idx_vms_stock_machine_product_captured" ON "public"."vms_stock_snapshots" USING "btree" ("machine_id", "product_id", "captured_at" DESC);



CREATE INDEX "idx_vms_stock_machine_slot_captured" ON "public"."vms_stock_snapshots" USING "btree" ("machine_id", "slot_code", "captured_at" DESC);



CREATE UNIQUE INDEX "idx_vms_stock_snapshots_batch_row" ON "public"."vms_stock_snapshots" USING "btree" ("import_batch_id", "import_row_number");



CREATE INDEX "idx_vms_stock_snapshots_import_row_status" ON "public"."vms_stock_snapshots" USING "btree" ("import_row_status");



CREATE INDEX "idx_vms_stock_snapshots_provider_captured" ON "public"."vms_stock_snapshots" USING "btree" ("source_provider", "captured_at" DESC);



CREATE INDEX "idx_vms_stock_snapshots_sync_run" ON "public"."vms_stock_snapshots" USING "btree" ("sync_run_id");



CREATE INDEX "idx_vms_sync_runs_provider_type_created" ON "public"."vms_sync_runs" USING "btree" ("provider", "sync_type", "created_at" DESC);



CREATE INDEX "idx_vms_sync_runs_status_created" ON "public"."vms_sync_runs" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_vms_transactions_raw_batch" ON "public"."vms_transactions_raw" USING "btree" ("import_batch_id", "row_number");



CREATE UNIQUE INDEX "idx_vms_transactions_raw_duplicate_hash" ON "public"."vms_transactions_raw" USING "btree" ("duplicate_hash");



CREATE INDEX "idx_vms_transactions_raw_machine_time" ON "public"."vms_transactions_raw" USING "btree" ("mapped_machine_id", COALESCE("payment_time", "delivery_time"));



CREATE INDEX "idx_vms_transactions_raw_product_time" ON "public"."vms_transactions_raw" USING "btree" ("mapped_product_id", COALESCE("payment_time", "delivery_time"));



CREATE INDEX "idx_vms_transactions_raw_status_time" ON "public"."vms_transactions_raw" USING "btree" ("transaction_status", COALESCE("payment_time", "delivery_time"));



CREATE INDEX "products_import_source_idx" ON "public"."products" USING "btree" ("import_source");



CREATE INDEX "products_last_vms_seen_at_idx" ON "public"."products" USING "btree" ("last_vms_seen_at" DESC);



CREATE INDEX "vms_product_mappings_last_seen_at_idx" ON "public"."vms_product_mappings" USING "btree" ("last_seen_at" DESC);



CREATE INDEX "vms_product_mappings_latest_machine_id_idx" ON "public"."vms_product_mappings" USING "btree" ("latest_machine_id");



CREATE OR REPLACE TRIGGER "snacky_sync_vms_product_mapping_aliases_before_write" BEFORE INSERT OR UPDATE ON "public"."vms_product_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."snacky_sync_vms_product_mapping_aliases"();



CREATE OR REPLACE TRIGGER "trg_log_inventory_movement_activity" AFTER INSERT ON "public"."inventory_movements" FOR EACH ROW EXECUTE FUNCTION "public"."log_inventory_movement_activity"();



CREATE OR REPLACE TRIGGER "trg_set_issue_sla_due_at" BEFORE INSERT OR UPDATE OF "priority", "created_at" ON "public"."issues" FOR EACH ROW EXECUTE FUNCTION "public"."set_issue_sla_due_at"();



CREATE OR REPLACE TRIGGER "trg_snacky_cash_collection_finance_sync" AFTER INSERT OR UPDATE ON "public"."cash_collections" FOR EACH ROW EXECUTE FUNCTION "public"."snacky_cash_collection_finance_sync_trigger"();



CREATE OR REPLACE TRIGGER "trg_snacky_purchase_finance_sync" AFTER INSERT OR UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."snacky_purchase_finance_sync_trigger"();



ALTER TABLE ONLY "public"."cash_collections"
    ADD CONSTRAINT "cash_collections_counted_by_fkey" FOREIGN KEY ("counted_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_collections"
    ADD CONSTRAINT "cash_collections_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cash_collections"
    ADD CONSTRAINT "cash_collections_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_collections"
    ADD CONSTRAINT "cash_collections_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cash_collections"
    ADD CONSTRAINT "cash_collections_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."finance_import_batches"
    ADD CONSTRAINT "finance_import_batches_imported_by_fkey" FOREIGN KEY ("imported_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."finance_import_rows"
    ADD CONSTRAINT "finance_import_rows_financial_transaction_id_fkey" FOREIGN KEY ("financial_transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."finance_import_rows"
    ADD CONSTRAINT "finance_import_rows_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."finance_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."finance_import_rows"
    ADD CONSTRAINT "finance_import_rows_suggested_machine_id_fkey" FOREIGN KEY ("suggested_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."finance_settings"
    ADD CONSTRAINT "finance_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."finance_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_related_cash_collection_id_fkey" FOREIGN KEY ("related_cash_collection_id") REFERENCES "public"."cash_collections"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_related_location_id_fkey" FOREIGN KEY ("related_location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_related_machine_id_fkey" FOREIGN KEY ("related_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_related_purchase_id_fkey" FOREIGN KEY ("related_purchase_id") REFERENCES "public"."purchase_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_related_route_id_fkey" FOREIGN KEY ("related_route_id") REFERENCES "public"."routes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."financial_transactions"
    ADD CONSTRAINT "financial_transactions_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."historical_route_deduction_batches"
    ADD CONSTRAINT "historical_route_deduction_batches_applied_by_fkey" FOREIGN KEY ("applied_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."historical_route_deduction_batches"
    ADD CONSTRAINT "historical_route_deduction_batches_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."historical_route_deduction_batches"
    ADD CONSTRAINT "historical_route_deduction_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."historical_route_deduction_lines"
    ADD CONSTRAINT "historical_route_deduction_lines_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."historical_route_deduction_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."historical_route_deduction_lines"
    ADD CONSTRAINT "historical_route_deduction_lines_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."historical_route_deduction_lines"
    ADD CONSTRAINT "historical_route_deduction_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."historical_route_deduction_lines"
    ADD CONSTRAINT "historical_route_deduction_lines_storage_location_id_fkey" FOREIGN KEY ("storage_location_id") REFERENCES "public"."storage_locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_historical_route_deduction_line_id_fkey" FOREIGN KEY ("historical_route_deduction_line_id") REFERENCES "public"."historical_route_deduction_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."historical_route_deduction_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_related_machine_id_fkey" FOREIGN KEY ("related_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_related_pickup_batch_id_fkey" FOREIGN KEY ("related_pickup_batch_id") REFERENCES "public"."route_pickup_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_related_purchase_id_fkey" FOREIGN KEY ("related_purchase_id") REFERENCES "public"."purchase_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_related_purchase_line_id_fkey" FOREIGN KEY ("related_purchase_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_related_route_stop_id_fkey" FOREIGN KEY ("related_route_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."inventory_movements"
    ADD CONSTRAINT "inventory_movements_reversed_movement_id_fkey" FOREIGN KEY ("reversed_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."issues"
    ADD CONSTRAINT "issues_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."issues"
    ADD CONSTRAINT "issues_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."issues"
    ADD CONSTRAINT "issues_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."machine_aliases"
    ADD CONSTRAINT "machine_aliases_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_linked_issue_id_fkey" FOREIGN KEY ("linked_issue_id") REFERENCES "public"."issues"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."machine_refill_history"
    ADD CONSTRAINT "machine_refill_history_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."machine_slots"
    ADD CONSTRAINT "machine_slots_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."machine_slots"
    ADD CONSTRAINT "machine_slots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."machines"
    ADD CONSTRAINT "machines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."product_aliases"
    ADD CONSTRAINT "product_aliases_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."product_aliases"
    ADD CONSTRAINT "product_aliases_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_last_purchase_line_id_fkey" FOREIGN KEY ("last_purchase_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_last_supplier_id_fkey" FOREIGN KEY ("last_supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_last_vms_import_batch_id_fkey" FOREIGN KEY ("last_vms_import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_team_member_id_fkey" FOREIGN KEY ("team_member_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_order_lines"
    ADD CONSTRAINT "purchase_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."purchase_order_lines"
    ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."receipt_scan_results"
    ADD CONSTRAINT "receipt_scan_results_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."receipt_scan_results"
    ADD CONSTRAINT "receipt_scan_results_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "public"."purchase_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."refill_order_lines"
    ADD CONSTRAINT "refill_order_lines_machine_slot_id_fkey" FOREIGN KEY ("machine_slot_id") REFERENCES "public"."machine_slots"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."refill_order_lines"
    ADD CONSTRAINT "refill_order_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."refill_order_lines"
    ADD CONSTRAINT "refill_order_lines_refill_order_id_fkey" FOREIGN KEY ("refill_order_id") REFERENCES "public"."refill_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."refill_orders"
    ADD CONSTRAINT "refill_orders_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."refill_orders"
    ADD CONSTRAINT "refill_orders_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_adjustments"
    ADD CONSTRAINT "route_pick_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_adjustments"
    ADD CONSTRAINT "route_pick_adjustments_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_adjustments"
    ADD CONSTRAINT "route_pick_adjustments_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_pickup_batch_id_fkey" FOREIGN KEY ("pickup_batch_id") REFERENCES "public"."route_pickup_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_route_stop_item_id_fkey" FOREIGN KEY ("route_stop_item_id") REFERENCES "public"."route_stop_items"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pick_list_items"
    ADD CONSTRAINT "route_pick_list_items_substituted_for_product_id_fkey" FOREIGN KEY ("substituted_for_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pickup_batch_stops"
    ADD CONSTRAINT "route_pickup_batch_stops_pickup_batch_id_fkey" FOREIGN KEY ("pickup_batch_id") REFERENCES "public"."route_pickup_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_pickup_batch_stops"
    ADD CONSTRAINT "route_pickup_batch_stops_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_pickup_batches"
    ADD CONSTRAINT "route_pickup_batches_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_pickup_batches"
    ADD CONSTRAINT "route_pickup_batches_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stock_lines"
    ADD CONSTRAINT "route_stock_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."route_stock_lines"
    ADD CONSTRAINT "route_stock_lines_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_assigned_product_id_fkey" FOREIGN KEY ("assigned_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_refill_order_line_id_fkey" FOREIGN KEY ("refill_order_line_id") REFERENCES "public"."refill_order_lines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stop_fill_lines"
    ADD CONSTRAINT "route_stop_fill_lines_substitute_product_id_fkey" FOREIGN KEY ("substitute_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_stop_items"
    ADD CONSTRAINT "route_stop_items_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stop_items"
    ADD CONSTRAINT "route_stop_items_machine_slot_id_fkey" FOREIGN KEY ("machine_slot_id") REFERENCES "public"."machine_slots"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."route_stop_items"
    ADD CONSTRAINT "route_stop_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."route_stop_items"
    ADD CONSTRAINT "route_stop_items_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stop_items"
    ADD CONSTRAINT "route_stop_items_route_stop_id_fkey" FOREIGN KEY ("route_stop_id") REFERENCES "public"."route_stops"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stops"
    ADD CONSTRAINT "route_stops_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."route_stops"
    ADD CONSTRAINT "route_stops_route_id_fkey" FOREIGN KEY ("route_id") REFERENCES "public"."routes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."routes"
    ADD CONSTRAINT "routes_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."routes"
    ADD CONSTRAINT "routes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."routes"
    ADD CONSTRAINT "routes_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."storage_locations"
    ADD CONSTRAINT "storage_locations_related_operator_id_fkey" FOREIGN KEY ("related_operator_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."system_activity_logs"
    ADD CONSTRAINT "system_activity_logs_actor_team_member_id_fkey" FOREIGN KEY ("actor_team_member_id") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."system_activity_logs"
    ADD CONSTRAINT "system_activity_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."team_members"
    ADD CONSTRAINT "team_members_auth_user_id_fkey" FOREIGN KEY ("auth_user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_header_mappings"
    ADD CONSTRAINT "vms_header_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_header_mappings"
    ADD CONSTRAINT "vms_header_mappings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_import_batches"
    ADD CONSTRAINT "vms_import_batches_imported_by_fkey" FOREIGN KEY ("imported_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_import_batches"
    ADD CONSTRAINT "vms_import_batches_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_import_preview_rows"
    ADD CONSTRAINT "vms_import_preview_rows_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_import_preview_rows"
    ADD CONSTRAINT "vms_import_preview_rows_mapped_machine_id_fkey" FOREIGN KEY ("mapped_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_import_preview_rows"
    ADD CONSTRAINT "vms_import_preview_rows_mapped_product_id_fkey" FOREIGN KEY ("mapped_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_import_preview_rows"
    ADD CONSTRAINT "vms_import_preview_rows_preview_id_fkey" FOREIGN KEY ("preview_id") REFERENCES "public"."vms_import_previews"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_import_previews"
    ADD CONSTRAINT "vms_import_previews_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_import_raw_rows"
    ADD CONSTRAINT "vms_import_raw_rows_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_import_rows"
    ADD CONSTRAINT "vms_import_rows_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_import_rows"
    ADD CONSTRAINT "vms_import_rows_matched_machine_id_fkey" FOREIGN KEY ("matched_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_import_rows"
    ADD CONSTRAINT "vms_import_rows_matched_product_id_fkey" FOREIGN KEY ("matched_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_machine_aliases"
    ADD CONSTRAINT "vms_machine_aliases_mapping_id_fkey" FOREIGN KEY ("mapping_id") REFERENCES "public"."vms_machine_mappings"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_machine_mappings"
    ADD CONSTRAINT "vms_machine_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_machine_mappings"
    ADD CONSTRAINT "vms_machine_mappings_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_machine_mappings"
    ADD CONSTRAINT "vms_machine_mappings_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_machine_mappings"
    ADD CONSTRAINT "vms_machine_mappings_snacky_machine_id_fkey" FOREIGN KEY ("snacky_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_machine_mappings"
    ADD CONSTRAINT "vms_machine_mappings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_machine_status_snapshots"
    ADD CONSTRAINT "vms_machine_status_snapshots_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_machine_status_snapshots"
    ADD CONSTRAINT "vms_machine_status_snapshots_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "public"."vms_sync_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_product_catalog_snapshots"
    ADD CONSTRAINT "vms_product_catalog_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_product_catalog_snapshots"
    ADD CONSTRAINT "vms_product_catalog_snapshots_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "public"."vms_sync_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_product_mappings"
    ADD CONSTRAINT "vms_product_mappings_last_import_batch_id_fkey" FOREIGN KEY ("last_import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_product_mappings"
    ADD CONSTRAINT "vms_product_mappings_latest_machine_id_fkey" FOREIGN KEY ("latest_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_product_mappings"
    ADD CONSTRAINT "vms_product_mappings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_product_mappings"
    ADD CONSTRAINT "vms_product_mappings_snacky_product_id_fkey" FOREIGN KEY ("snacky_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_sales_raw"
    ADD CONSTRAINT "vms_sales_raw_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_sales_raw"
    ADD CONSTRAINT "vms_sales_raw_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_sales_raw"
    ADD CONSTRAINT "vms_sales_raw_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_sales_snapshots"
    ADD CONSTRAINT "vms_sales_snapshots_duplicate_of_fkey" FOREIGN KEY ("duplicate_of") REFERENCES "public"."vms_sales_snapshots"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_sales_snapshots"
    ADD CONSTRAINT "vms_sales_snapshots_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_sales_snapshots"
    ADD CONSTRAINT "vms_sales_snapshots_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_sales_snapshots"
    ADD CONSTRAINT "vms_sales_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_stock_snapshots"
    ADD CONSTRAINT "vms_stock_snapshots_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_stock_snapshots"
    ADD CONSTRAINT "vms_stock_snapshots_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vms_stock_snapshots"
    ADD CONSTRAINT "vms_stock_snapshots_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_stock_snapshots"
    ADD CONSTRAINT "vms_stock_snapshots_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "public"."vms_sync_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_sync_runs"
    ADD CONSTRAINT "vms_sync_runs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."team_members"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_transactions_raw"
    ADD CONSTRAINT "vms_transactions_raw_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "public"."vms_import_batches"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_transactions_raw"
    ADD CONSTRAINT "vms_transactions_raw_mapped_machine_id_fkey" FOREIGN KEY ("mapped_machine_id") REFERENCES "public"."machines"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vms_transactions_raw"
    ADD CONSTRAINT "vms_transactions_raw_mapped_product_id_fkey" FOREIGN KEY ("mapped_product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE "public"."financial_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "financial_transactions_insert_finance_roles" ON "public"."financial_transactions" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'finance'::"text"]));



CREATE POLICY "financial_transactions_select_finance_roles" ON "public"."financial_transactions" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'finance'::"text"]));



CREATE POLICY "financial_transactions_select_purchase_cash_sources" ON "public"."financial_transactions" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'finance'::"text"]) AND ("source_type" = ANY (ARRAY['purchase'::"text", 'cash_collection'::"text"]))));



CREATE POLICY "financial_transactions_update_finance_roles" ON "public"."financial_transactions" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'finance'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'finance'::"text"]));



ALTER TABLE "public"."inventory_movements" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchase_order_lines" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."route_pickup_batch_stops" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."route_pickup_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "snacky_inventory_movements_insert_by_effective_role" ON "public"."inventory_movements" FOR INSERT TO "authenticated" WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR ("public"."snacky_current_profile_has_any_role"(ARRAY['warehouse'::"text", 'purchasing'::"text"]) AND (("reason")::"text" = 'purchase_received'::"text") AND (("from_entity_type")::"text" = 'supplier'::"text") AND (("to_entity_type")::"text" = 'storage'::"text")) OR ("public"."snacky_current_profile_has_any_role"(ARRAY['warehouse'::"text"]) AND (("reason")::"text" = ANY (ARRAY['storage_to_operator_bag'::"text", 'operator_bag_to_storage'::"text", 'stock_count_adjustment'::"text", 'manual_correction'::"text", 'damaged'::"text", 'expired'::"text", 'theft_or_missing'::"text", 'product_substitution'::"text"])) AND (("from_entity_type")::"text" = ANY (ARRAY['storage'::"text", 'operator_bag'::"text", 'waste'::"text", 'adjustment'::"text"])) AND (("to_entity_type")::"text" = ANY (ARRAY['storage'::"text", 'operator_bag'::"text", 'waste'::"text", 'adjustment'::"text"]))) OR (("related_route_id" IS NOT NULL) AND "public"."snacky_operator_can_access_route"("related_route_id") AND (("reason")::"text" = ANY (ARRAY['storage_to_operator_bag'::"text", 'operator_bag_to_machine'::"text", 'operator_bag_to_storage'::"text", 'manual_correction'::"text", 'damaged'::"text", 'expired'::"text", 'product_substitution'::"text"])))));



CREATE POLICY "snacky_inventory_movements_select_by_effective_role" ON "public"."inventory_movements" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR (("related_route_id" IS NOT NULL) AND "public"."snacky_operator_can_access_route"("related_route_id"))));



CREATE POLICY "snacky_machines_select_for_vms_import_validation" ON "public"."machines" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_products_delete_by_effective_role" ON "public"."products" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_products_insert_by_effective_role" ON "public"."products" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_add_products"());



CREATE POLICY "snacky_products_select_by_effective_role" ON "public"."products" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text", 'finance'::"text"]) OR "public"."snacky_operator_can_read_product"("id")));



CREATE POLICY "snacky_products_select_for_vms_import_validation" ON "public"."products" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_products_select_for_vms_mapping" ON "public"."products" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_products_update_by_effective_role" ON "public"."products" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'warehouse'::"text", 'purchasing'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'warehouse'::"text", 'purchasing'::"text"]));



CREATE POLICY "snacky_profiles_self_read" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("id" = "auth"."uid"()));



CREATE POLICY "snacky_purchase_order_lines_delete_draft_by_effective_role" ON "public"."purchase_order_lines" FOR DELETE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"]) AND (EXISTS ( SELECT 1
   FROM "public"."purchase_orders" "po"
  WHERE (("po"."id" = "purchase_order_lines"."purchase_order_id") AND ("po"."status" = 'draft'::"text"))))));



CREATE POLICY "snacky_purchase_order_lines_insert_by_effective_role" ON "public"."purchase_order_lines" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"]));



CREATE POLICY "snacky_purchase_order_lines_select_by_effective_role" ON "public"."purchase_order_lines" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text", 'finance'::"text"]));



CREATE POLICY "snacky_purchase_order_lines_update_by_effective_role" ON "public"."purchase_order_lines" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"]));



CREATE POLICY "snacky_purchase_orders_delete_draft_by_effective_role" ON "public"."purchase_orders" FOR DELETE TO "authenticated" USING ((("status" = 'draft'::"text") AND "public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"])));



CREATE POLICY "snacky_purchase_orders_insert_by_effective_role" ON "public"."purchase_orders" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"]));



CREATE POLICY "snacky_purchase_orders_select_by_effective_role" ON "public"."purchase_orders" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text", 'finance'::"text"]));



CREATE POLICY "snacky_purchase_orders_update_by_effective_role" ON "public"."purchase_orders" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text"]));



CREATE POLICY "snacky_refill_order_lines_delete_by_effective_role" ON "public"."refill_order_lines" FOR DELETE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR (EXISTS ( SELECT 1
   FROM "public"."refill_orders" "ro"
  WHERE (("ro"."id" = "refill_order_lines"."refill_order_id") AND "public"."snacky_operator_can_access_route"("ro"."route_id"))))));



CREATE POLICY "snacky_refill_order_lines_insert_by_effective_role" ON "public"."refill_order_lines" FOR INSERT TO "authenticated" WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR (EXISTS ( SELECT 1
   FROM "public"."refill_orders" "ro"
  WHERE (("ro"."id" = "refill_order_lines"."refill_order_id") AND "public"."snacky_operator_can_access_route"("ro"."route_id"))))));



CREATE POLICY "snacky_refill_order_lines_update_by_effective_role" ON "public"."refill_order_lines" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR (EXISTS ( SELECT 1
   FROM "public"."refill_orders" "ro"
  WHERE (("ro"."id" = "refill_order_lines"."refill_order_id") AND "public"."snacky_operator_can_access_route"("ro"."route_id")))))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR (EXISTS ( SELECT 1
   FROM "public"."refill_orders" "ro"
  WHERE (("ro"."id" = "refill_order_lines"."refill_order_id") AND "public"."snacky_operator_can_access_route"("ro"."route_id"))))));



CREATE POLICY "snacky_refill_orders_delete_by_effective_role" ON "public"."refill_orders" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]));



CREATE POLICY "snacky_refill_orders_insert_by_effective_role" ON "public"."refill_orders" FOR INSERT TO "authenticated" WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_refill_orders_update_by_effective_role" ON "public"."refill_orders" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id"))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pick_list_items_delete_by_effective_role" ON "public"."route_pick_list_items" FOR DELETE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pick_list_items_insert_by_effective_role" ON "public"."route_pick_list_items" FOR INSERT TO "authenticated" WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pick_list_items_select_by_route_access" ON "public"."route_pick_list_items" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pick_list_items_update_by_effective_role" ON "public"."route_pick_list_items" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id"))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pickup_batch_stops_delete_by_route_access" ON "public"."route_pickup_batch_stops" FOR DELETE TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."route_pickup_batches" "b"
  WHERE (("b"."id" = "route_pickup_batch_stops"."pickup_batch_id") AND ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("b"."route_id"))))));



CREATE POLICY "snacky_route_pickup_batch_stops_insert_by_route_access" ON "public"."route_pickup_batch_stops" FOR INSERT TO "authenticated" WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."route_pickup_batches" "b"
  WHERE (("b"."id" = "route_pickup_batch_stops"."pickup_batch_id") AND ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("b"."route_id"))))));



CREATE POLICY "snacky_route_pickup_batch_stops_select_by_route_access" ON "public"."route_pickup_batch_stops" FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM "public"."route_pickup_batches" "b"
  WHERE (("b"."id" = "route_pickup_batch_stops"."pickup_batch_id") AND ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("b"."route_id"))))));



CREATE POLICY "snacky_route_pickup_batches_delete_by_route_access" ON "public"."route_pickup_batches" FOR DELETE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pickup_batches_insert_by_route_access" ON "public"."route_pickup_batches" FOR INSERT TO "authenticated" WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pickup_batches_select_by_route_access" ON "public"."route_pickup_batches" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_pickup_batches_update_by_route_access" ON "public"."route_pickup_batches" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id"))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stock_lines_delete_by_effective_role" ON "public"."route_stock_lines" FOR DELETE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stock_lines_insert_by_effective_role" ON "public"."route_stock_lines" FOR INSERT TO "authenticated" WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stock_lines_select_by_route_access" ON "public"."route_stock_lines" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stock_lines_update_by_effective_role" ON "public"."route_stock_lines" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id"))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stop_items_delete_by_effective_role" ON "public"."route_stop_items" FOR DELETE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stop_items_insert_by_effective_role" ON "public"."route_stop_items" FOR INSERT TO "authenticated" WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stop_items_select_by_route_access" ON "public"."route_stop_items" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stop_items_update_by_effective_role" ON "public"."route_stop_items" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id"))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stops_delete_by_effective_role" ON "public"."route_stops" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]));



CREATE POLICY "snacky_route_stops_insert_by_effective_role" ON "public"."route_stops" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]));



CREATE POLICY "snacky_route_stops_select_by_route_access" ON "public"."route_stops" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_route_stops_update_by_effective_role" ON "public"."route_stops" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id"))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("route_id")));



CREATE POLICY "snacky_routes_delete_by_effective_role" ON "public"."routes" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_routes_insert_by_effective_role" ON "public"."routes" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]));



CREATE POLICY "snacky_routes_select_by_effective_role" ON "public"."routes" FOR SELECT TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("id")));



CREATE POLICY "snacky_routes_update_by_effective_role" ON "public"."routes" FOR UPDATE TO "authenticated" USING (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("id"))) WITH CHECK (("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text"]) OR "public"."snacky_operator_can_access_route"("id")));



CREATE POLICY "snacky_storage_locations_delete_by_effective_role" ON "public"."storage_locations" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_storage_locations_insert_by_effective_role" ON "public"."storage_locations" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]));



CREATE POLICY "snacky_storage_locations_select_by_effective_role" ON "public"."storage_locations" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]));



CREATE POLICY "snacky_storage_locations_update_by_effective_role" ON "public"."storage_locations" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text"]));



CREATE POLICY "snacky_suppliers_delete_by_effective_role" ON "public"."suppliers" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_suppliers_insert_by_effective_role" ON "public"."suppliers" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'purchasing'::"text"]));



CREATE POLICY "snacky_suppliers_select_by_effective_role" ON "public"."suppliers" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'warehouse'::"text", 'purchasing'::"text", 'finance'::"text"]));



CREATE POLICY "snacky_suppliers_update_by_effective_role" ON "public"."suppliers" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'purchasing'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text", 'supervisor'::"text", 'purchasing'::"text"]));



CREATE POLICY "snacky_team_members_self_read" ON "public"."team_members" FOR SELECT TO "authenticated" USING (("auth_user_id" = "auth"."uid"()));



CREATE POLICY "snacky_vms_delete" ON "public"."vms_header_mappings" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_delete" ON "public"."vms_import_batches" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_delete" ON "public"."vms_import_preview_rows" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_delete" ON "public"."vms_machine_mappings" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_delete" ON "public"."vms_product_mappings" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_header_mappings_delete_by_vms_import_permission" ON "public"."vms_header_mappings" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_header_mappings_insert_by_vms_import_permission" ON "public"."vms_header_mappings" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_header_mappings_select_by_vms_import_permission" ON "public"."vms_header_mappings" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_header_mappings_update_by_vms_import_permission" ON "public"."vms_header_mappings" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_batches_delete_by_vms_import_permission" ON "public"."vms_import_batches" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_batches_insert_by_vms_import_permission" ON "public"."vms_import_batches" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_batches_select_by_vms_import_permission" ON "public"."vms_import_batches" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_import_batches_update_by_vms_import_permission" ON "public"."vms_import_batches" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_preview_rows_delete_by_vms_import_permission" ON "public"."vms_import_preview_rows" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_preview_rows_insert_by_vms_import_permission" ON "public"."vms_import_preview_rows" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_preview_rows_select_by_vms_import_permission" ON "public"."vms_import_preview_rows" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_import_preview_rows_update_by_vms_import_permission" ON "public"."vms_import_preview_rows" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_previews_delete_by_vms_import_permission" ON "public"."vms_import_previews" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_previews_delete_by_vms_import_role" ON "public"."vms_import_previews" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_previews_insert_by_vms_import_permission" ON "public"."vms_import_previews" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_previews_insert_by_vms_import_role" ON "public"."vms_import_previews" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_previews_select_by_vms_import_permission" ON "public"."vms_import_previews" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_import_previews_select_by_vms_import_role" ON "public"."vms_import_previews" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_previews_update_by_vms_import_permission" ON "public"."vms_import_previews" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_previews_update_by_vms_import_role" ON "public"."vms_import_previews" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_raw_rows_delete_by_vms_import_permission" ON "public"."vms_import_raw_rows" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_raw_rows_delete_by_vms_import_role" ON "public"."vms_import_raw_rows" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_raw_rows_insert_by_vms_import_permission" ON "public"."vms_import_raw_rows" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_raw_rows_insert_by_vms_import_role" ON "public"."vms_import_raw_rows" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_raw_rows_select_by_vms_import_permission" ON "public"."vms_import_raw_rows" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_import_raw_rows_select_by_vms_import_role" ON "public"."vms_import_raw_rows" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_raw_rows_update_by_vms_import_permission" ON "public"."vms_import_raw_rows" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_raw_rows_update_by_vms_import_role" ON "public"."vms_import_raw_rows" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_rows_delete_by_vms_import_permission" ON "public"."vms_import_rows" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_rows_delete_by_vms_import_role" ON "public"."vms_import_rows" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_rows_insert_by_vms_import_permission" ON "public"."vms_import_rows" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_rows_insert_by_vms_import_role" ON "public"."vms_import_rows" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_rows_select_by_vms_import_permission" ON "public"."vms_import_rows" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_import_rows_select_by_vms_import_role" ON "public"."vms_import_rows" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_import_rows_update_by_vms_import_permission" ON "public"."vms_import_rows" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_import_rows_update_by_vms_import_role" ON "public"."vms_import_rows" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_insert" ON "public"."vms_header_mappings" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_insert" ON "public"."vms_import_batches" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_insert" ON "public"."vms_import_preview_rows" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_insert" ON "public"."vms_machine_mappings" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_insert" ON "public"."vms_product_mappings" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_machine_mappings_delete_by_vms_import_permission" ON "public"."vms_machine_mappings" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_machine_mappings_insert_by_vms_import_permission" ON "public"."vms_machine_mappings" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_machine_mappings_select_by_vms_import_permission" ON "public"."vms_machine_mappings" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_machine_mappings_update_by_vms_import_permission" ON "public"."vms_machine_mappings" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_product_mappings_insert_by_vms_import_permission" ON "public"."vms_product_mappings" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_product_mappings_select_by_vms_import_permission" ON "public"."vms_product_mappings" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_product_mappings_update_by_vms_import_permission" ON "public"."vms_product_mappings" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_sales_raw_delete_by_vms_import_permission" ON "public"."vms_sales_raw" FOR DELETE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_sales_raw_insert_by_vms_import_permission" ON "public"."vms_sales_raw" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_sales_raw_insert_by_vms_import_role" ON "public"."vms_sales_raw" FOR INSERT TO "authenticated" WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_sales_raw_select_by_vms_import_permission" ON "public"."vms_sales_raw" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_sales_raw_select_by_vms_import_role" ON "public"."vms_sales_raw" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_sales_raw_update_by_vms_import_permission" ON "public"."vms_sales_raw" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_sales_raw_update_by_vms_import_role" ON "public"."vms_sales_raw" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"])) WITH CHECK ("public"."snacky_current_profile_has_any_role"(ARRAY['owner'::"text", 'admin'::"text"]));



CREATE POLICY "snacky_vms_select" ON "public"."vms_header_mappings" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_select" ON "public"."vms_import_batches" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_select" ON "public"."vms_import_preview_rows" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_select" ON "public"."vms_machine_mappings" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_select" ON "public"."vms_product_mappings" FOR SELECT TO "authenticated" USING ("public"."snacky_current_profile_can_view_vms_import"());



CREATE POLICY "snacky_vms_update" ON "public"."vms_header_mappings" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_update" ON "public"."vms_import_batches" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_update" ON "public"."vms_import_preview_rows" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_update" ON "public"."vms_machine_mappings" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



CREATE POLICY "snacky_vms_update" ON "public"."vms_product_mappings" FOR UPDATE TO "authenticated" USING ("public"."snacky_current_profile_can_manage_vms_mappings"()) WITH CHECK ("public"."snacky_current_profile_can_manage_vms_mappings"());



ALTER TABLE "public"."storage_locations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_header_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_import_batches" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_import_preview_rows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_import_previews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_import_raw_rows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_import_rows" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_machine_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_product_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_sales_raw" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."vms_transactions_raw" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_historical_route_deduction_batch"("target_batch_id" "uuid", "actor_team_member_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_historical_route_deduction_batch"("target_batch_id" "uuid", "actor_team_member_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_historical_route_deduction_batch"("target_batch_id" "uuid", "actor_team_member_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_vms_sales_snapshot_import"("p_batch_id" "uuid", "p_import_mode" "text", "p_report_start_date" "date", "p_report_end_date" "date", "p_sales_rows" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_vms_sales_snapshot_import"("p_batch_id" "uuid", "p_import_mode" "text", "p_report_start_date" "date", "p_report_end_date" "date", "p_sales_rows" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_vms_sales_snapshot_import"("p_batch_id" "uuid", "p_import_mode" "text", "p_report_start_date" "date", "p_report_end_date" "date", "p_sales_rows" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."backfill_missing_finance_transactions"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."backfill_missing_finance_transactions"() TO "anon";
GRANT ALL ON FUNCTION "public"."backfill_missing_finance_transactions"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."backfill_missing_finance_transactions"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."confirm_route_pickup_batch"("p_route_id" "uuid", "p_expected_route_status" "public"."route_status", "p_next_route_status" "public"."route_status", "p_started_at" timestamp with time zone, "p_replace_pick_list" boolean, "p_pickup_batch" "jsonb", "p_batch_stop_ids" "uuid"[], "p_new_stop_item_rows" "jsonb", "p_inventory_movements" "jsonb", "p_pick_list_rows" "jsonb", "p_stock_line_rows" "jsonb", "p_stop_item_picks" "jsonb", "p_refill_line_picks" "jsonb", "p_selected_stop_ids" "uuid"[], "p_selected_machine_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."confirm_route_pickup_batch"("p_route_id" "uuid", "p_expected_route_status" "public"."route_status", "p_next_route_status" "public"."route_status", "p_started_at" timestamp with time zone, "p_replace_pick_list" boolean, "p_pickup_batch" "jsonb", "p_batch_stop_ids" "uuid"[], "p_new_stop_item_rows" "jsonb", "p_inventory_movements" "jsonb", "p_pick_list_rows" "jsonb", "p_stock_line_rows" "jsonb", "p_stop_item_picks" "jsonb", "p_refill_line_picks" "jsonb", "p_selected_stop_ids" "uuid"[], "p_selected_machine_ids" "uuid"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."confirm_route_pickup_batch"("p_route_id" "uuid", "p_expected_route_status" "public"."route_status", "p_next_route_status" "public"."route_status", "p_started_at" timestamp with time zone, "p_replace_pick_list" boolean, "p_pickup_batch" "jsonb", "p_batch_stop_ids" "uuid"[], "p_new_stop_item_rows" "jsonb", "p_inventory_movements" "jsonb", "p_pick_list_rows" "jsonb", "p_stock_line_rows" "jsonb", "p_stop_item_picks" "jsonb", "p_refill_line_picks" "jsonb", "p_selected_stop_ids" "uuid"[], "p_selected_machine_ids" "uuid"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."confirm_route_pickup_batch"("p_route_id" "uuid", "p_expected_route_status" "public"."route_status", "p_next_route_status" "public"."route_status", "p_started_at" timestamp with time zone, "p_replace_pick_list" boolean, "p_pickup_batch" "jsonb", "p_batch_stop_ids" "uuid"[], "p_new_stop_item_rows" "jsonb", "p_inventory_movements" "jsonb", "p_pick_list_rows" "jsonb", "p_stock_line_rows" "jsonb", "p_stop_item_picks" "jsonb", "p_refill_line_picks" "jsonb", "p_selected_stop_ids" "uuid"[], "p_selected_machine_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."ensure_cash_collection_finance_transaction"("p_cash_collection_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_cash_collection_finance_transaction"("p_cash_collection_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_cash_collection_finance_transaction"("p_cash_collection_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_cash_collection_finance_transaction"("p_cash_collection_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."ensure_purchase_finance_transaction"("p_purchase_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ensure_purchase_finance_transaction"("p_purchase_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."ensure_purchase_finance_transaction"("p_purchase_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."ensure_purchase_finance_transaction"("p_purchase_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."cash_collections" TO "anon";
GRANT ALL ON TABLE "public"."cash_collections" TO "authenticated";
GRANT ALL ON TABLE "public"."cash_collections" TO "service_role";



GRANT ALL ON FUNCTION "public"."finance_cash_collection_should_sync"("p_cash" "public"."cash_collections") TO "anon";
GRANT ALL ON FUNCTION "public"."finance_cash_collection_should_sync"("p_cash" "public"."cash_collections") TO "authenticated";
GRANT ALL ON FUNCTION "public"."finance_cash_collection_should_sync"("p_cash" "public"."cash_collections") TO "service_role";



REVOKE ALL ON FUNCTION "public"."finance_health_report"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finance_health_report"() TO "anon";
GRANT ALL ON FUNCTION "public"."finance_health_report"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."finance_health_report"() TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON FUNCTION "public"."finance_purchase_should_sync"("p_purchase" "public"."purchase_orders") TO "anon";
GRANT ALL ON FUNCTION "public"."finance_purchase_should_sync"("p_purchase" "public"."purchase_orders") TO "authenticated";
GRANT ALL ON FUNCTION "public"."finance_purchase_should_sync"("p_purchase" "public"."purchase_orders") TO "service_role";



REVOKE ALL ON FUNCTION "public"."finance_source_sync_diagnosis"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finance_source_sync_diagnosis"() TO "anon";
GRANT ALL ON FUNCTION "public"."finance_source_sync_diagnosis"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."finance_source_sync_diagnosis"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_vms_schema_health"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_vms_schema_health"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_vms_schema_health"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_vms_schema_health"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_inventory_movement_activity"() TO "anon";
GRANT ALL ON FUNCTION "public"."log_inventory_movement_activity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_inventory_movement_activity"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_issue_sla_due_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_issue_sla_due_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_issue_sla_due_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_cash_collection_finance_sync_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_cash_collection_finance_sync_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_cash_collection_finance_sync_trigger"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."snacky_create_purchase_with_lines"("p_supplier_id" "uuid", "p_order_date" "date", "p_receipt_number" "text", "p_payment_method" "text", "p_payment_status" "text", "p_receipt_url" "text", "p_receipt_file_name" "text", "p_receipt_content_type" "text", "p_receipt_storage_path" "text", "p_notes" "text", "p_calculated_total_lyd" numeric, "p_manual_total_lyd" numeric, "p_total_adjustment_lyd" numeric, "p_total_source" "text", "p_total_amount" numeric, "p_created_by" "uuid", "p_submit_action" "text", "p_lines" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."snacky_create_purchase_with_lines"("p_supplier_id" "uuid", "p_order_date" "date", "p_receipt_number" "text", "p_payment_method" "text", "p_payment_status" "text", "p_receipt_url" "text", "p_receipt_file_name" "text", "p_receipt_content_type" "text", "p_receipt_storage_path" "text", "p_notes" "text", "p_calculated_total_lyd" numeric, "p_manual_total_lyd" numeric, "p_total_adjustment_lyd" numeric, "p_total_source" "text", "p_total_amount" numeric, "p_created_by" "uuid", "p_submit_action" "text", "p_lines" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_create_purchase_with_lines"("p_supplier_id" "uuid", "p_order_date" "date", "p_receipt_number" "text", "p_payment_method" "text", "p_payment_status" "text", "p_receipt_url" "text", "p_receipt_file_name" "text", "p_receipt_content_type" "text", "p_receipt_storage_path" "text", "p_notes" "text", "p_calculated_total_lyd" numeric, "p_manual_total_lyd" numeric, "p_total_adjustment_lyd" numeric, "p_total_source" "text", "p_total_amount" numeric, "p_created_by" "uuid", "p_submit_action" "text", "p_lines" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_add_products"() TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_add_products"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_add_products"() TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_manage_vms_mappings"() TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_manage_vms_mappings"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_manage_vms_mappings"() TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_view_vms_import"() TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_view_vms_import"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_can_view_vms_import"() TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_current_profile_has_any_role"("allowed_roles" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_has_any_role"("allowed_roles" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_current_profile_has_any_role"("allowed_roles" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_operator_can_access_route"("target_route_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_operator_can_access_route"("target_route_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_operator_can_access_route"("target_route_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_operator_can_read_product"("target_product_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_operator_can_read_product"("target_product_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_operator_can_read_product"("target_product_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_profile_has_any_role"("profile_roles" "public"."team_role"[], "primary_role" "public"."team_role", "allowed_roles" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_profile_has_any_role"("profile_roles" "public"."team_role"[], "primary_role" "public"."team_role", "allowed_roles" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_profile_has_any_role"("profile_roles" "public"."team_role"[], "primary_role" "public"."team_role", "allowed_roles" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_purchase_finance_sync_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_purchase_finance_sync_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_purchase_finance_sync_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_seed_clean_text"("value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_seed_clean_text"("value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_seed_clean_text"("value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_seed_date"("value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_seed_date"("value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_seed_date"("value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_seed_numeric"("value" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_seed_numeric"("value" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_seed_numeric"("value" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_storage_can_access_route"("route_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_storage_can_access_route"("route_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_storage_can_access_route"("route_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_storage_has_role"("allowed_roles" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_storage_has_role"("allowed_roles" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_storage_has_role"("allowed_roles" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_storage_route_id"("object_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_storage_route_id"("object_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_storage_route_id"("object_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."snacky_sync_vms_product_mapping_aliases"() TO "anon";
GRANT ALL ON FUNCTION "public"."snacky_sync_vms_product_mapping_aliases"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."snacky_sync_vms_product_mapping_aliases"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_cash_collection_to_financial_transaction"("p_cash_collection_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_cash_collection_to_financial_transaction"("p_cash_collection_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."sync_cash_collection_to_financial_transaction"("p_cash_collection_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_cash_collection_to_financial_transaction"("p_cash_collection_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_purchase_to_financial_transaction"("p_purchase_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_purchase_to_financial_transaction"("p_purchase_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."sync_purchase_to_financial_transaction"("p_purchase_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."sync_purchase_to_financial_transaction"("p_purchase_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."validate_route_workflow_schema"("p_route_statuses" "text"[], "p_route_stop_statuses" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."validate_route_workflow_schema"("p_route_statuses" "text"[], "p_route_stop_statuses" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_route_workflow_schema"("p_route_statuses" "text"[], "p_route_stop_statuses" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_route_workflow_schema"("p_route_statuses" "text"[], "p_route_stop_statuses" "text"[]) TO "service_role";



GRANT ALL ON TABLE "public"."inventory_movements" TO "anon";
GRANT ALL ON TABLE "public"."inventory_movements" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_movements" TO "service_role";



GRANT ALL ON TABLE "public"."machines" TO "anon";
GRANT ALL ON TABLE "public"."machines" TO "authenticated";
GRANT ALL ON TABLE "public"."machines" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."storage_locations" TO "anon";
GRANT ALL ON TABLE "public"."storage_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."storage_locations" TO "service_role";



GRANT ALL ON TABLE "public"."team_members" TO "anon";
GRANT ALL ON TABLE "public"."team_members" TO "authenticated";
GRANT ALL ON TABLE "public"."team_members" TO "service_role";



GRANT ALL ON TABLE "public"."current_inventory_by_location" TO "anon";
GRANT ALL ON TABLE "public"."current_inventory_by_location" TO "authenticated";
GRANT ALL ON TABLE "public"."current_inventory_by_location" TO "service_role";



GRANT ALL ON TABLE "public"."financial_transactions" TO "anon";
GRANT ALL ON TABLE "public"."financial_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."financial_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."finance_account_balance_impacts" TO "anon";
GRANT ALL ON TABLE "public"."finance_account_balance_impacts" TO "authenticated";
GRANT ALL ON TABLE "public"."finance_account_balance_impacts" TO "service_role";



GRANT ALL ON TABLE "public"."finance_account_balances" TO "anon";
GRANT ALL ON TABLE "public"."finance_account_balances" TO "authenticated";
GRANT ALL ON TABLE "public"."finance_account_balances" TO "service_role";



GRANT ALL ON TABLE "public"."finance_import_batches" TO "anon";
GRANT ALL ON TABLE "public"."finance_import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."finance_import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."finance_import_rows" TO "anon";
GRANT ALL ON TABLE "public"."finance_import_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."finance_import_rows" TO "service_role";



GRANT ALL ON TABLE "public"."finance_import_clarification_groups" TO "anon";
GRANT ALL ON TABLE "public"."finance_import_clarification_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."finance_import_clarification_groups" TO "service_role";



GRANT ALL ON TABLE "public"."finance_settings" TO "anon";
GRANT ALL ON TABLE "public"."finance_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."finance_settings" TO "service_role";



GRANT ALL ON TABLE "public"."historical_route_deduction_batches" TO "anon";
GRANT ALL ON TABLE "public"."historical_route_deduction_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."historical_route_deduction_batches" TO "service_role";



GRANT ALL ON TABLE "public"."historical_route_deduction_lines" TO "anon";
GRANT ALL ON TABLE "public"."historical_route_deduction_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."historical_route_deduction_lines" TO "service_role";



GRANT ALL ON TABLE "public"."issues" TO "anon";
GRANT ALL ON TABLE "public"."issues" TO "authenticated";
GRANT ALL ON TABLE "public"."issues" TO "service_role";



GRANT ALL ON TABLE "public"."locations" TO "anon";
GRANT ALL ON TABLE "public"."locations" TO "authenticated";
GRANT ALL ON TABLE "public"."locations" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_order_lines" TO "anon";
GRANT ALL ON TABLE "public"."purchase_order_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_order_lines" TO "service_role";



GRANT ALL ON TABLE "public"."product_reporting_costs" TO "anon";
GRANT ALL ON TABLE "public"."product_reporting_costs" TO "authenticated";
GRANT ALL ON TABLE "public"."product_reporting_costs" TO "service_role";



GRANT ALL ON TABLE "public"."vms_import_batches" TO "anon";
GRANT ALL ON TABLE "public"."vms_import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."vms_transactions_raw" TO "anon";
GRANT ALL ON TABLE "public"."vms_transactions_raw" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_transactions_raw" TO "service_role";



GRANT ALL ON TABLE "public"."vms_sales_clean" TO "anon";
GRANT ALL ON TABLE "public"."vms_sales_clean" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_sales_clean" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_location_monthly" TO "anon";
GRANT ALL ON TABLE "public"."kpi_location_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_location_monthly" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_machine_daily" TO "anon";
GRANT ALL ON TABLE "public"."kpi_machine_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_machine_daily" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_machine_monthly" TO "anon";
GRANT ALL ON TABLE "public"."kpi_machine_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_machine_monthly" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_product_daily" TO "anon";
GRANT ALL ON TABLE "public"."kpi_product_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_product_daily" TO "service_role";



GRANT ALL ON TABLE "public"."kpi_product_monthly" TO "anon";
GRANT ALL ON TABLE "public"."kpi_product_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."kpi_product_monthly" TO "service_role";



GRANT ALL ON TABLE "public"."vms_stock_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."vms_stock_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_stock_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."latest_vms_stock_by_slot" TO "anon";
GRANT ALL ON TABLE "public"."latest_vms_stock_by_slot" TO "authenticated";
GRANT ALL ON TABLE "public"."latest_vms_stock_by_slot" TO "service_role";



GRANT ALL ON TABLE "public"."machine_aliases" TO "anon";
GRANT ALL ON TABLE "public"."machine_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."machine_aliases" TO "service_role";



GRANT ALL ON TABLE "public"."machine_refill_history" TO "anon";
GRANT ALL ON TABLE "public"."machine_refill_history" TO "authenticated";
GRANT ALL ON TABLE "public"."machine_refill_history" TO "service_role";



GRANT ALL ON TABLE "public"."machine_refill_history_metrics" TO "anon";
GRANT ALL ON TABLE "public"."machine_refill_history_metrics" TO "authenticated";
GRANT ALL ON TABLE "public"."machine_refill_history_metrics" TO "service_role";



GRANT ALL ON TABLE "public"."machine_refill_history_monthly" TO "anon";
GRANT ALL ON TABLE "public"."machine_refill_history_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."machine_refill_history_monthly" TO "service_role";



GRANT ALL ON TABLE "public"."machine_slots" TO "anon";
GRANT ALL ON TABLE "public"."machine_slots" TO "authenticated";
GRANT ALL ON TABLE "public"."machine_slots" TO "service_role";



GRANT ALL ON TABLE "public"."product_aliases" TO "anon";
GRANT ALL ON TABLE "public"."product_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."product_aliases" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."receipt_scan_results" TO "anon";
GRANT ALL ON TABLE "public"."receipt_scan_results" TO "authenticated";
GRANT ALL ON TABLE "public"."receipt_scan_results" TO "service_role";



GRANT ALL ON TABLE "public"."refill_order_lines" TO "anon";
GRANT ALL ON TABLE "public"."refill_order_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."refill_order_lines" TO "service_role";



GRANT ALL ON TABLE "public"."refill_orders" TO "anon";
GRANT ALL ON TABLE "public"."refill_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."refill_orders" TO "service_role";



GRANT ALL ON TABLE "public"."refill_recommendations" TO "anon";
GRANT ALL ON TABLE "public"."refill_recommendations" TO "authenticated";
GRANT ALL ON TABLE "public"."refill_recommendations" TO "service_role";



GRANT ALL ON TABLE "public"."route_pick_adjustments" TO "anon";
GRANT ALL ON TABLE "public"."route_pick_adjustments" TO "authenticated";
GRANT ALL ON TABLE "public"."route_pick_adjustments" TO "service_role";



GRANT ALL ON TABLE "public"."route_pick_list_items" TO "anon";
GRANT ALL ON TABLE "public"."route_pick_list_items" TO "authenticated";
GRANT ALL ON TABLE "public"."route_pick_list_items" TO "service_role";



GRANT ALL ON TABLE "public"."route_pickup_batch_stops" TO "anon";
GRANT ALL ON TABLE "public"."route_pickup_batch_stops" TO "authenticated";
GRANT ALL ON TABLE "public"."route_pickup_batch_stops" TO "service_role";



GRANT ALL ON TABLE "public"."route_pickup_batches" TO "anon";
GRANT ALL ON TABLE "public"."route_pickup_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."route_pickup_batches" TO "service_role";



GRANT ALL ON TABLE "public"."route_stock_lines" TO "anon";
GRANT ALL ON TABLE "public"."route_stock_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."route_stock_lines" TO "service_role";



GRANT ALL ON TABLE "public"."route_stop_fill_lines" TO "anon";
GRANT ALL ON TABLE "public"."route_stop_fill_lines" TO "authenticated";
GRANT ALL ON TABLE "public"."route_stop_fill_lines" TO "service_role";



GRANT ALL ON TABLE "public"."route_stop_items" TO "anon";
GRANT ALL ON TABLE "public"."route_stop_items" TO "authenticated";
GRANT ALL ON TABLE "public"."route_stop_items" TO "service_role";



GRANT ALL ON TABLE "public"."route_stops" TO "anon";
GRANT ALL ON TABLE "public"."route_stops" TO "authenticated";
GRANT ALL ON TABLE "public"."route_stops" TO "service_role";



GRANT ALL ON TABLE "public"."routes" TO "anon";
GRANT ALL ON TABLE "public"."routes" TO "authenticated";
GRANT ALL ON TABLE "public"."routes" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."system_activity_logs" TO "anon";
GRANT ALL ON TABLE "public"."system_activity_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."system_activity_logs" TO "service_role";



GRANT ALL ON TABLE "public"."vms_header_mappings" TO "anon";
GRANT ALL ON TABLE "public"."vms_header_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_header_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."vms_import_preview_rows" TO "anon";
GRANT ALL ON TABLE "public"."vms_import_preview_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_import_preview_rows" TO "service_role";



GRANT ALL ON TABLE "public"."vms_import_previews" TO "anon";
GRANT ALL ON TABLE "public"."vms_import_previews" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_import_previews" TO "service_role";



GRANT ALL ON TABLE "public"."vms_import_raw_rows" TO "anon";
GRANT ALL ON TABLE "public"."vms_import_raw_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_import_raw_rows" TO "service_role";



GRANT ALL ON TABLE "public"."vms_import_rows" TO "anon";
GRANT ALL ON TABLE "public"."vms_import_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_import_rows" TO "service_role";



GRANT ALL ON TABLE "public"."vms_machine_aliases" TO "anon";
GRANT ALL ON TABLE "public"."vms_machine_aliases" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_machine_aliases" TO "service_role";



GRANT ALL ON TABLE "public"."vms_machine_mappings" TO "anon";
GRANT ALL ON TABLE "public"."vms_machine_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_machine_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."vms_machine_status_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."vms_machine_status_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_machine_status_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."vms_product_catalog_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."vms_product_catalog_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_product_catalog_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."vms_product_mappings" TO "anon";
GRANT ALL ON TABLE "public"."vms_product_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_product_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."vms_sales_raw" TO "anon";
GRANT ALL ON TABLE "public"."vms_sales_raw" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_sales_raw" TO "service_role";



GRANT ALL ON TABLE "public"."vms_sales_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."vms_sales_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_sales_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."vms_sync_runs" TO "anon";
GRANT ALL ON TABLE "public"."vms_sync_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_sync_runs" TO "service_role";



GRANT ALL ON TABLE "public"."vms_transaction_status_daily" TO "anon";
GRANT ALL ON TABLE "public"."vms_transaction_status_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_transaction_status_daily" TO "service_role";



GRANT ALL ON TABLE "public"."vms_transaction_status_monthly" TO "anon";
GRANT ALL ON TABLE "public"."vms_transaction_status_monthly" TO "authenticated";
GRANT ALL ON TABLE "public"."vms_transaction_status_monthly" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







