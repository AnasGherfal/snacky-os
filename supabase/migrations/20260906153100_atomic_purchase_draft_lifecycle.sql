-- Close the remaining purchase lifecycle bypasses. Draft edits and cancellation
-- are serialized database commands; received/voided state belongs exclusively
-- to the inventory RPCs installed immediately before this migration.

create table if not exists public.purchase_draft_operations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  client_submission_id text not null unique,
  purchase_id uuid not null references public.purchase_orders(id) on delete restrict,
  action text not null check (action in ('update', 'cancel')),
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  request_payload jsonb not null check (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  result_payload jsonb not null check (pg_catalog.jsonb_typeof(result_payload) = 'object'),
  created_at timestamptz not null default pg_catalog.now()
);

create unique index if not exists purchase_draft_operations_one_cancel
  on public.purchase_draft_operations(purchase_id)
  where action = 'cancel';

alter table public.purchase_draft_operations enable row level security;
revoke all on table public.purchase_draft_operations
  from public, anon, authenticated, service_role;

create or replace function public.snacky_guard_purchase_draft_operation_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  raise exception 'Completed purchase draft command receipts are immutable.'
    using errcode = '23514';
end;
$function$;

revoke all on function public.snacky_guard_purchase_draft_operation_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_purchase_draft_operations_immutable
  on public.purchase_draft_operations;
create trigger snacky_purchase_draft_operations_immutable
before update or delete on public.purchase_draft_operations
for each row
execute function public.snacky_guard_purchase_draft_operation_immutable();

create or replace function public.snacky_update_draft_purchase_v1(
  p_purchase_id uuid,
  p_client_submission_id text,
  p_expected_updated_at timestamptz,
  p_supplier_id uuid,
  p_order_date date,
  p_receiving_storage_location_id uuid,
  p_receipt_number text,
  p_payment_method text,
  p_receipt_url text,
  p_receipt_file_name text,
  p_receipt_content_type text,
  p_receipt_storage_path text,
  p_notes text,
  p_manual_total_lyd numeric,
  p_lines jsonb
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
  v_receipt_number text := nullif(pg_catalog.btrim(coalesce(p_receipt_number, '')), '');
  v_payment_method text := coalesce(nullif(pg_catalog.btrim(coalesce(p_payment_method, '')), ''), 'cash');
  v_receipt_url text := nullif(pg_catalog.btrim(coalesce(p_receipt_url, '')), '');
  v_receipt_file_name text := nullif(pg_catalog.btrim(coalesce(p_receipt_file_name, '')), '');
  v_receipt_content_type text := nullif(pg_catalog.btrim(coalesce(p_receipt_content_type, '')), '');
  v_receipt_storage_path text := nullif(pg_catalog.btrim(coalesce(p_receipt_storage_path, '')), '');
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_manual_total numeric;
  v_calculated_total numeric;
  v_total_amount numeric;
  v_total_source text;
  v_total_adjustment numeric;
  v_request_payload jsonb;
  v_result_payload jsonb;
  v_operation public.purchase_draft_operations%rowtype;
  v_purchase public.purchase_orders%rowtype;
  v_line_lock record;
  v_product_lock record;
  v_line_count integer;
  v_invalid_line_count integer;
  v_distinct_position_count integer;
  v_requested_product_count integer;
  v_locked_product_count integer := 0;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to edit a purchase.' using errcode = '42501';
  end if;
  if not public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']
  ) then
    raise exception 'You do not have permission to edit purchases.' using errcode = '42501';
  end if;
  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  if p_purchase_id is null then
    raise exception 'Purchase is required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable draft edit submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;
  if p_expected_updated_at is null then
    raise exception 'The draft revision is required. Reload the purchase before editing.' using errcode = '22023';
  end if;
  if p_supplier_id is null then
    raise exception 'Select a valid supplier.' using errcode = '22023';
  end if;
  if p_order_date is null then
    raise exception 'Purchase date is required.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_lines) <> 'array'
    or pg_catalog.jsonb_array_length(v_lines) = 0
  then
    raise exception 'Purchase must include at least one line item.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(v_lines) > 500
    or pg_catalog.pg_column_size(v_lines) > 1048576
  then
    raise exception 'Purchase line payload is too large.' using errcode = '54000';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (
      where line.product_id is null
        or line.line_position is null
        or line.line_position < 0
        or line.boxes_qty is null
        or line.boxes_qty < 0
        or line.units_per_box is null
        or line.units_per_box <= 0
        or line.loose_units_qty is null
        or line.loose_units_qty < 0
        or line.total_units is null
        or line.total_units <= 0
        or line.total_units <> line.boxes_qty * line.units_per_box + line.loose_units_qty
        or line.ordered_qty is distinct from line.total_units
        or coalesce(line.received_qty, 0) <> 0
        or coalesce(line.unit_cost_lyd, line.unit_cost, 0) < 0
        or coalesce(line.line_total_lyd, line.line_total, 0) < 0
    )::integer,
    pg_catalog.count(distinct line.line_position)::integer
  into v_line_count, v_invalid_line_count, v_distinct_position_count
  from pg_catalog.jsonb_to_recordset(v_lines) as line(
    product_id uuid,
    line_position integer,
    boxes_qty integer,
    units_per_box integer,
    loose_units_qty integer,
    total_units integer,
    ordered_qty integer,
    received_qty integer,
    unit_cost numeric,
    unit_cost_lyd numeric,
    line_total numeric,
    line_total_lyd numeric
  );

  if v_line_count <> pg_catalog.jsonb_array_length(v_lines)
    or v_invalid_line_count > 0
    or v_distinct_position_count <> v_line_count
  then
    raise exception 'Every purchase line must have one unique position, a valid product, and a positive exact quantity.'
      using errcode = '22023';
  end if;

  -- Canonicalize money inside the database. A positive explicit line total is
  -- authoritative and derives its unit cost; otherwise the line total is
  -- derived from unit cost * exact units. Never trust two independent client
  -- money fields or a client-supplied purchase aggregate.
  with parsed_lines as (
    select
      line.product_id,
      line.line_position,
      line.boxes_qty,
      line.units_per_box,
      line.loose_units_qty,
      line.total_units,
      greatest(coalesce(line.unit_cost_lyd, line.unit_cost, 0), 0) as raw_unit_cost,
      greatest(coalesce(line.line_total_lyd, line.line_total, 0), 0) as raw_line_total
    from pg_catalog.jsonb_to_recordset(v_lines) as line(
      product_id uuid,
      line_position integer,
      boxes_qty integer,
      units_per_box integer,
      loose_units_qty integer,
      total_units integer,
      unit_cost numeric,
      unit_cost_lyd numeric,
      line_total numeric,
      line_total_lyd numeric
    )
  ),
  priced_lines as (
    select
      parsed_lines.*,
      pg_catalog.round(case
        when parsed_lines.raw_line_total > 0
          then parsed_lines.raw_line_total / parsed_lines.total_units
        else parsed_lines.raw_unit_cost
      end, 4) as canonical_unit_cost
    from parsed_lines
  ),
  canonical_lines as (
    select
      priced_lines.*,
      pg_catalog.round(
        priced_lines.canonical_unit_cost * priced_lines.total_units,
        2
      ) as canonical_line_total
    from priced_lines
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'product_id', canonical_lines.product_id,
        'line_position', canonical_lines.line_position,
        'boxes_qty', canonical_lines.boxes_qty,
        'units_per_box', canonical_lines.units_per_box,
        'loose_units_qty', canonical_lines.loose_units_qty,
        'total_units', canonical_lines.total_units,
        'ordered_qty', canonical_lines.total_units,
        'received_qty', 0,
        'unit_cost', canonical_lines.canonical_unit_cost,
        'unit_cost_lyd', canonical_lines.canonical_unit_cost,
        'line_total', canonical_lines.canonical_line_total,
        'line_total_lyd', canonical_lines.canonical_line_total
      )
      order by canonical_lines.line_position, canonical_lines.product_id
    ),
    '[]'::jsonb
  )
  into v_lines
  from canonical_lines;

  select pg_catalog.round(coalesce(pg_catalog.sum(
    line.line_total_lyd
  ), 0), 2)
  into v_calculated_total
  from pg_catalog.jsonb_to_recordset(v_lines) as line(
    line_total_lyd numeric
  );

  if p_manual_total_lyd is not null and p_manual_total_lyd < 0 then
    raise exception 'Receipt total cannot be negative.' using errcode = '22023';
  end if;
  v_manual_total := case
    when p_manual_total_lyd is null then null
    else pg_catalog.round(p_manual_total_lyd, 2)
  end;
  v_total_amount := coalesce(v_manual_total, v_calculated_total);
  v_total_source := case when v_manual_total is null then 'calculated' else 'manual' end;
  v_total_adjustment := case
    when v_manual_total is null then null
    else pg_catalog.round(v_total_amount - v_calculated_total, 2)
  end;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'action', 'update',
    'purchase_id', p_purchase_id,
    'expected_updated_at', p_expected_updated_at,
    'supplier_id', p_supplier_id,
    'order_date', p_order_date,
    'receiving_storage_location_id', p_receiving_storage_location_id,
    'receipt_number', v_receipt_number,
    'payment_method', v_payment_method,
    'receipt_url', v_receipt_url,
    'receipt_file_name', v_receipt_file_name,
    'receipt_content_type', v_receipt_content_type,
    'receipt_storage_path', v_receipt_storage_path,
    'notes', v_notes,
    'calculated_total_lyd', v_calculated_total,
    'manual_total_lyd', v_manual_total,
    'total_adjustment_lyd', v_total_adjustment,
    'total_source', v_total_source,
    'total_amount', v_total_amount,
    'lines', v_lines
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:purchase-draft-submission:' || v_submission_id, 0)
  );

  select operation.*
  into v_operation
  from public.purchase_draft_operations operation
  where operation.client_submission_id = v_submission_id;
  if found then
    if v_operation.purchase_id is distinct from p_purchase_id
      or v_operation.action is distinct from 'update'
      or v_operation.actor_user_id is distinct from v_actor_user_id
      or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
      or v_operation.request_payload is distinct from v_request_payload
    then
      raise exception 'This draft edit submission id belongs to another actor or immutable request.'
        using errcode = '23505';
    end if;
    return v_operation.result_payload;
  end if;

  select purchase.*
  into v_purchase
  from public.purchase_orders purchase
  where purchase.id = p_purchase_id
  for update;
  if not found then
    raise exception 'Purchase was not found.' using errcode = '23503';
  end if;
  if v_purchase.status <> 'draft' then
    raise exception 'Only a draft purchase can be edited.' using errcode = '23514';
  end if;
  if v_purchase.updated_at is distinct from p_expected_updated_at then
    raise exception 'This draft changed after you opened it. Reload before saving; nothing was changed.'
      using errcode = '40001';
  end if;
  if coalesce(v_purchase.payment_status, 'unpaid') <> 'unpaid' then
    raise exception 'This draft has noncanonical payment state and must be reviewed before editing.' using errcode = '23514';
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

  -- Repeat every mutable catalog check while holding a row lock. The earlier
  -- validation only improves the error path and is not an authorization or
  -- integrity boundary.
  perform 1
  from public.suppliers supplier
  where supplier.id = p_supplier_id
  for share;
  if not found then
    raise exception 'The supplier changed while this draft was being saved. Reload and try again.'
      using errcode = '40001';
  end if;

  if p_receiving_storage_location_id is not null then
    perform 1
    from public.storage_locations storage
    where storage.id = p_receiving_storage_location_id
      and storage.active = true
      and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
    for share;
    if not found then
      raise exception 'The receiving storage changed while this draft was being saved. Reload and choose it again.'
        using errcode = '40001';
    end if;
  end if;

  select pg_catalog.count(distinct line.product_id)::integer
  into v_requested_product_count
  from pg_catalog.jsonb_to_recordset(v_lines) as line(product_id uuid);

  for v_product_lock in
    select product.id, product.active
    from public.products product
    join (
      select distinct line.product_id
      from pg_catalog.jsonb_to_recordset(v_lines) as line(product_id uuid)
    ) requested on requested.product_id = product.id
    order by product.id
    for share of product
  loop
    v_locked_product_count := v_locked_product_count + 1;
    if v_product_lock.active is not true then
      raise exception 'A purchase product became inactive while this draft was being saved. Reload and replace it.'
        using errcode = '40001';
    end if;
  end loop;

  if v_locked_product_count <> v_requested_product_count then
    raise exception 'A purchase product changed while this draft was being saved. Reload and replace it.'
      using errcode = '40001';
  end if;

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.related_purchase_id = p_purchase_id
      or movement.related_purchase_line_id in (
        select line.id
        from public.purchase_order_lines line
        where line.purchase_order_id = p_purchase_id
      )
  ) or exists (
    select 1 from public.purchase_payments payment where payment.purchase_order_id = p_purchase_id
  ) or exists (
    select 1
    from public.financial_transactions finance
    where finance.related_purchase_id = p_purchase_id
      or finance.linked_purchase_id = p_purchase_id
      or (finance.source_type = 'purchase' and finance.source_id = p_purchase_id)
  ) then
    raise exception 'This draft has inventory or payment history and cannot be edited automatically. Review it first.'
      using errcode = '23514';
  end if;

  delete from public.purchase_order_lines line
  where line.purchase_order_id = p_purchase_id;

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
    p_purchase_id,
    line.product_id,
    line.line_position,
    line.boxes_qty,
    line.units_per_box,
    line.loose_units_qty,
    line.total_units,
    line.total_units,
    0,
    line.unit_cost_lyd,
    line.unit_cost_lyd,
    line.line_total_lyd,
    line.line_total_lyd
  from pg_catalog.jsonb_to_recordset(v_lines) as line(
    product_id uuid,
    line_position integer,
    boxes_qty integer,
    units_per_box integer,
    loose_units_qty integer,
    total_units integer,
    unit_cost_lyd numeric,
    line_total_lyd numeric
  )
  order by line.line_position, line.product_id;

  update public.purchase_orders purchase
  set supplier_id = p_supplier_id,
      order_date = p_order_date,
      receiving_storage_location_id = p_receiving_storage_location_id,
      receipt_number = v_receipt_number,
      payment_method = v_payment_method,
      receipt_url = v_receipt_url,
      receipt_file_name = v_receipt_file_name,
      receipt_content_type = v_receipt_content_type,
      receipt_storage_path = v_receipt_storage_path,
      notes = v_notes,
      calculated_total_lyd = v_calculated_total,
      manual_total_lyd = v_manual_total,
      total_adjustment_lyd = v_total_adjustment,
      total_source = v_total_source,
      total_amount = v_total_amount,
      updated_at = pg_catalog.now()
  where purchase.id = p_purchase_id
    and purchase.status = 'draft'
  returning purchase.* into v_purchase;
  if not found then
    raise exception 'Purchase changed while the draft was being edited. Nothing was changed.' using errcode = '40001';
  end if;

  v_result_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'purchase_id', p_purchase_id,
    'status', 'draft',
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'line_count', v_line_count
  );

  insert into public.purchase_draft_operations (
    client_submission_id,
    purchase_id,
    action,
    actor_user_id,
    actor_team_member_id,
    request_payload,
    result_payload
  ) values (
    v_submission_id,
    p_purchase_id,
    'update',
    v_actor_user_id,
    v_actor_team_member_id,
    v_request_payload,
    v_result_payload
  );

  return v_result_payload;
end;
$function$;

revoke all on function public.snacky_update_draft_purchase_v1(
  uuid, text, timestamptz, uuid, date, uuid, text, text, text, text, text, text, text, numeric, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.snacky_update_draft_purchase_v1(
  uuid, text, timestamptz, uuid, date, uuid, text, text, text, text, text, text, text, numeric, jsonb
) to authenticated;

create or replace function public.snacky_cancel_draft_purchase_v1(
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
  v_result_payload jsonb;
  v_operation public.purchase_draft_operations%rowtype;
  v_purchase public.purchase_orders%rowtype;
  v_line_lock record;
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to cancel a purchase.' using errcode = '42501';
  end if;
  if not public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']
  ) then
    raise exception 'You do not have permission to cancel draft purchases.' using errcode = '42501';
  end if;
  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'Your account is not linked to an active team member.' using errcode = '42501';
  end if;
  if p_purchase_id is null then
    raise exception 'Purchase is required.' using errcode = '22023';
  end if;
  if v_reason is null or pg_catalog.length(v_reason) > 2000 then
    raise exception 'A cancellation reason between 1 and 2000 characters is required.' using errcode = '22023';
  end if;
  if v_submission_id is null or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A stable cancellation submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'action', 'cancel',
    'purchase_id', p_purchase_id,
    'reason', v_reason
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:purchase-draft-submission:' || v_submission_id, 0)
  );

  select operation.*
  into v_operation
  from public.purchase_draft_operations operation
  where operation.client_submission_id = v_submission_id;
  if found then
    if v_operation.purchase_id is distinct from p_purchase_id
      or v_operation.action is distinct from 'cancel'
      or v_operation.actor_user_id is distinct from v_actor_user_id
      or v_operation.actor_team_member_id is distinct from v_actor_team_member_id
      or v_operation.request_payload is distinct from v_request_payload
    then
      raise exception 'This cancellation submission id belongs to another actor or immutable request.'
        using errcode = '23505';
    end if;
    return v_operation.result_payload;
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
    order by line.id
    for update
  loop
    null;
  end loop;

  select operation.*
  into v_operation
  from public.purchase_draft_operations operation
  where operation.purchase_id = p_purchase_id
    and operation.action = 'cancel';
  if found then
    raise exception 'This purchase was already cancelled by a different immutable request.' using errcode = '23505';
  end if;

  if v_purchase.status <> 'draft' then
    raise exception 'Only a draft purchase can be cancelled.' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.inventory_movements movement
    where movement.related_purchase_id = p_purchase_id
      or movement.related_purchase_line_id in (
        select line.id
        from public.purchase_order_lines line
        where line.purchase_order_id = p_purchase_id
      )
  ) or exists (
    select 1 from public.purchase_payments payment where payment.purchase_order_id = p_purchase_id
  ) or exists (
    select 1
    from public.financial_transactions finance
    where finance.related_purchase_id = p_purchase_id
      or finance.linked_purchase_id = p_purchase_id
      or (finance.source_type = 'purchase' and finance.source_id = p_purchase_id)
  ) then
    raise exception 'This draft has inventory or payment history and cannot be cancelled automatically. Review it first.'
      using errcode = '23514';
  end if;

  update public.purchase_orders purchase
  set status = 'cancelled',
      voided_at = pg_catalog.now(),
      voided_by = v_actor_team_member_id,
      void_reason = v_reason,
      updated_at = pg_catalog.now()
  where purchase.id = p_purchase_id
    and purchase.status = 'draft'
  returning purchase.* into v_purchase;
  if not found then
    raise exception 'Purchase changed while it was being cancelled. Nothing was changed.' using errcode = '40001';
  end if;

  v_result_payload := pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'purchase_id', p_purchase_id,
    'status', 'cancelled',
    'purchase', pg_catalog.to_jsonb(v_purchase),
    'reason', v_reason
  );

  insert into public.purchase_draft_operations (
    client_submission_id,
    purchase_id,
    action,
    actor_user_id,
    actor_team_member_id,
    request_payload,
    result_payload
  ) values (
    v_submission_id,
    p_purchase_id,
    'cancel',
    v_actor_user_id,
    v_actor_team_member_id,
    v_request_payload,
    v_result_payload
  );

  return v_result_payload;
end;
$function$;

revoke all on function public.snacky_cancel_draft_purchase_v1(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.snacky_cancel_draft_purchase_v1(uuid, text, text)
  to authenticated;

-- The old create function is a SECURITY DEFINER lifecycle bypass without the
-- V2 immutable command receipt. Keep it for migration history, but make it
-- unreachable through the Data API.
revoke all on function public.snacky_create_purchase_with_lines(
  uuid, date, text, text, text, text, text, text, text, text,
  numeric, numeric, numeric, text, numeric, uuid, text, jsonb
) from public, anon, authenticated, service_role;

drop policy if exists "snacky_purchase_orders_insert_by_effective_role"
  on public.purchase_orders;
drop policy if exists "snacky_purchase_orders_update_by_effective_role"
  on public.purchase_orders;
drop policy if exists "snacky_purchase_orders_delete_draft_by_effective_role"
  on public.purchase_orders;
drop policy if exists "snacky_purchase_order_lines_insert_by_effective_role"
  on public.purchase_order_lines;
drop policy if exists "snacky_purchase_order_lines_update_by_effective_role"
  on public.purchase_order_lines;
drop policy if exists "snacky_purchase_order_lines_delete_draft_by_effective_role"
  on public.purchase_order_lines;

revoke insert, update, delete on table public.purchase_orders from authenticated;
revoke insert, update, delete on table public.purchase_order_lines from authenticated;
grant select on table public.purchase_orders to authenticated;
grant select on table public.purchase_order_lines to authenticated;

comment on function public.snacky_update_draft_purchase_v1(
  uuid, text, timestamptz, uuid, date, uuid, text, text, text, text, text, text, text, numeric, jsonb
) is 'Authenticated exactly-once draft purchase replacement. It refuses any draft with inventory or money history.';

comment on function public.snacky_cancel_draft_purchase_v1(uuid, text, text)
is 'Authenticated exactly-once draft cancellation. Permanent purchase deletion is intentionally unsupported.';

select pg_notify('pgrst', 'reload schema');
