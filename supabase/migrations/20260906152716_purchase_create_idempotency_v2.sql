-- Make purchase creation an exactly-once ledger command.
--
-- The browser owns one UUID for the lifetime of a purchase draft.  This table
-- binds that UUID to the authenticated actor, the normalized immutable request,
-- the created purchase, and the exact result returned to the caller.  A retry
-- after a lost HTTP/RPC response therefore replays the saved result without
-- inserting another purchase, purchase line, or inventory receipt movement.

create table if not exists public.purchase_create_submissions (
  client_submission_id uuid primary key,
  actor_user_id uuid not null,
  actor_team_member_id uuid not null references public.team_members(id) on delete restrict,
  request_payload jsonb not null,
  result_payload jsonb,
  purchase_id uuid unique references public.purchase_orders(id) on delete restrict,
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,
  constraint purchase_create_submissions_request_payload_object
    check (pg_catalog.jsonb_typeof(request_payload) = 'object'),
  constraint purchase_create_submissions_result_payload_object
    check (result_payload is null or pg_catalog.jsonb_typeof(result_payload) = 'object'),
  constraint purchase_create_submissions_completion_pair
    check (
      (purchase_id is null and result_payload is null and completed_at is null)
      or
      (purchase_id is not null and result_payload is not null and completed_at is not null)
    )
);

comment on table public.purchase_create_submissions is
  'Private exactly-once command receipts for snacky_create_purchase_with_lines_v2. Request and result payloads are immutable after completion.';

alter table public.purchase_create_submissions enable row level security;

revoke all on table public.purchase_create_submissions
  from public, anon, authenticated, service_role;

-- The physical destination is part of the purchase command, not a server-side
-- guess. Drafts retain it so a later receipt uses the destination the purchaser
-- reviewed, while received purchases provide durable inventory provenance.
alter table public.purchase_orders
  add column if not exists receiving_storage_location_id uuid
    references public.storage_locations(id) on delete restrict;

create index if not exists idx_purchase_orders_receiving_storage_location
  on public.purchase_orders(receiving_storage_location_id)
  where receiving_storage_location_id is not null;

comment on column public.purchase_orders.receiving_storage_location_id is
  'Explicit physical storage destination selected for this purchase receipt. Drafts retain the intended destination.';

create or replace function public.snacky_guard_purchase_create_submission_immutable()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'Completed purchase creation receipts cannot be deleted.'
      using errcode = '23514';
  end if;

  if old.client_submission_id is distinct from new.client_submission_id
    or old.actor_user_id is distinct from new.actor_user_id
    or old.actor_team_member_id is distinct from new.actor_team_member_id
    or old.request_payload is distinct from new.request_payload
    or old.created_at is distinct from new.created_at
  then
    raise exception 'Purchase creation request receipts are immutable.'
      using errcode = '23514';
  end if;

  if old.result_payload is not null
    or old.purchase_id is not null
    or old.completed_at is not null
  then
    raise exception 'Completed purchase creation results are immutable.'
      using errcode = '23514';
  end if;

  if new.result_payload is null
    or new.purchase_id is null
    or new.completed_at is null
  then
    raise exception 'A purchase creation receipt must complete atomically.'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.snacky_guard_purchase_create_submission_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_purchase_create_submissions_immutable
  on public.purchase_create_submissions;
create trigger snacky_purchase_create_submissions_immutable
before update or delete on public.purchase_create_submissions
for each row
execute function public.snacky_guard_purchase_create_submission_immutable();

create or replace function public.snacky_create_purchase_with_lines_v2(
  p_client_submission_id uuid,
  p_supplier_id uuid,
  p_order_date date,
  p_receipt_number text,
  p_payment_method text,
  p_payment_status text,
  p_receipt_url text,
  p_receipt_file_name text,
  p_receipt_content_type text,
  p_receipt_storage_path text,
  p_notes text,
  p_calculated_total_lyd numeric,
  p_manual_total_lyd numeric,
  p_total_adjustment_lyd numeric,
  p_total_source text,
  p_total_amount numeric,
  p_payment_account_id text,
  p_receiving_storage_location_id uuid,
  p_submit_action text,
  p_lines jsonb
)
returns table (
  id uuid,
  receipt_number text,
  status text,
  total_amount numeric,
  payment_status text,
  movement_count integer,
  receiving_storage_location_id uuid
)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_existing public.purchase_create_submissions%rowtype;
  v_request_payload jsonb;
  v_result_payload jsonb;
  v_purchase_id uuid;
  v_storage_id uuid;
  v_submit_action text;
  v_payment_status text;
  v_total_source text;
  v_payment_account_id text;
  v_order_date date;
  v_receipt_number text;
  v_payment_method text;
  v_receipt_url text;
  v_receipt_file_name text;
  v_receipt_content_type text;
  v_receipt_storage_path text;
  v_notes text;
  v_calculated_total_lyd numeric;
  v_manual_total_lyd numeric;
  v_total_adjustment_lyd numeric;
  v_total_amount numeric;
  v_input_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_lines jsonb := '[]'::jsonb;
  v_input_line_count integer := 0;
  v_canonical_line_count integer := 0;
  v_distinct_line_position_count integer := 0;
  v_movement_count integer := 0;
  v_storage_lock record;
begin
  if v_actor_user_id is null then
    raise exception 'An authenticated user is required to create a purchase.'
      using errcode = '42501';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  if v_actor_team_member_id is null then
    raise exception 'The authenticated user must be linked to an active team member.'
      using errcode = '42501';
  end if;

  if not public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']
  ) then
    raise exception 'Permission denied for purchase save.'
      using errcode = '42501';
  end if;

  if p_client_submission_id is null then
    raise exception 'A client submission id is required.'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_typeof(v_input_lines) <> 'array'
    or pg_catalog.jsonb_array_length(v_input_lines) = 0
  then
    raise exception 'Purchase must include at least one line item.'
      using errcode = '22023';
  end if;

  if pg_catalog.jsonb_array_length(v_input_lines) > 500
    or pg_catalog.pg_column_size(v_input_lines) > 1048576
  then
    raise exception 'Purchase line payload is too large.'
      using errcode = '54000';
  end if;
  v_input_line_count := pg_catalog.jsonb_array_length(v_input_lines);

  v_submit_action := case
    when pg_catalog.lower(pg_catalog.btrim(coalesce(p_submit_action, ''))) in (
      'received', 'receive', 'submitted', 'submit'
    ) then 'received'
    else 'draft'
  end;

  v_payment_status := pg_catalog.lower(
    pg_catalog.btrim(coalesce(p_payment_status, 'unpaid'))
  );
  if v_payment_status = 'partial' then
    v_payment_status := 'partially_paid';
  end if;
  if v_payment_status <> 'unpaid' then
    raise exception 'New purchases start unpaid. Record actual supplier payments after saving the purchase.'
      using errcode = '22023';
  end if;

  v_payment_account_id := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_payment_account_id, '')), ''),
    'snacky_lyd'
  );
  if v_payment_account_id not in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd') then
    raise exception 'Invalid purchase payment account.'
      using errcode = '22023';
  end if;

  v_order_date := coalesce(p_order_date, current_date);
  v_receipt_number := nullif(
    pg_catalog.btrim(coalesce(p_receipt_number, '')),
    ''
  );
  v_payment_method := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_payment_method, '')), ''),
    'cash'
  );
  v_receipt_url := nullif(
    pg_catalog.btrim(coalesce(p_receipt_url, '')),
    ''
  );
  v_receipt_file_name := nullif(
    pg_catalog.btrim(coalesce(p_receipt_file_name, '')),
    ''
  );
  v_receipt_content_type := nullif(
    pg_catalog.btrim(coalesce(p_receipt_content_type, '')),
    ''
  );
  v_receipt_storage_path := nullif(
    pg_catalog.btrim(coalesce(p_receipt_storage_path, '')),
    ''
  );
  v_notes := nullif(
    pg_catalog.btrim(coalesce(p_notes, '')),
    ''
  );

  -- Canonicalize quantities and money once before creating the immutable
  -- command receipt. A positive explicit line total is authoritative and its
  -- unit cost is derived; otherwise the line total is derived from unit cost.
  -- Caller-computed header totals are deliberately ignored.
  with parsed_lines as (
    select
      line.product_id,
      greatest(coalesce(line.line_position, 0), 0)::integer as line_position,
      pg_catalog.floor(greatest(coalesce(line.boxes_qty, line.box_qty, line.box_quantity, 0), 0))::integer as boxes_qty,
      pg_catalog.floor(greatest(coalesce(line.units_per_box, line.pieces_per_box, 1), 1))::integer as units_per_box,
      pg_catalog.floor(greatest(coalesce(line.loose_units_qty, line.loose_units, 0), 0))::integer as loose_units_qty,
      greatest(coalesce(line.unit_cost, line.unit_cost_lyd, 0), 0) as raw_unit_cost,
      greatest(coalesce(line.line_total, line.line_total_lyd, 0), 0) as raw_line_total
    from pg_catalog.jsonb_to_recordset(v_input_lines) as line(
      product_id uuid,
      line_position integer,
      boxes_qty numeric,
      box_qty numeric,
      box_quantity numeric,
      units_per_box numeric,
      pieces_per_box numeric,
      loose_units_qty numeric,
      loose_units numeric,
      unit_cost numeric,
      unit_cost_lyd numeric,
      line_total numeric,
      line_total_lyd numeric
    )
  ),
  normalized_lines as (
    select
      parsed_lines.product_id,
      parsed_lines.line_position,
      parsed_lines.boxes_qty,
      parsed_lines.units_per_box,
      parsed_lines.loose_units_qty,
      (
        parsed_lines.boxes_qty * parsed_lines.units_per_box
        + parsed_lines.loose_units_qty
      )::integer as total_units,
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
      normalized_lines.total_units as ordered_qty,
      0::integer as received_qty,
      pg_catalog.round(case
        when normalized_lines.raw_line_total > 0 and normalized_lines.total_units > 0
          then normalized_lines.raw_line_total / normalized_lines.total_units
        else normalized_lines.raw_unit_cost
      end, 4) as unit_cost
    from normalized_lines
    where normalized_lines.product_id is not null
      and normalized_lines.total_units > 0
  ),
  canonical_lines as (
    select
      priced_lines.*,
      pg_catalog.round(priced_lines.unit_cost * priced_lines.total_units, 2) as line_total
    from priced_lines
  )
  select
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'product_id', canonical_lines.product_id,
          'line_position', canonical_lines.line_position,
          'boxes_qty', canonical_lines.boxes_qty,
          'units_per_box', canonical_lines.units_per_box,
          'loose_units_qty', canonical_lines.loose_units_qty,
          'total_units', canonical_lines.total_units,
          'ordered_qty', canonical_lines.ordered_qty,
          'received_qty', canonical_lines.received_qty,
          'unit_cost', canonical_lines.unit_cost,
          'unit_cost_lyd', canonical_lines.unit_cost,
          'line_total', canonical_lines.line_total,
          'line_total_lyd', canonical_lines.line_total
        ) order by canonical_lines.line_position, canonical_lines.product_id
      ),
      '[]'::jsonb
    ),
    pg_catalog.count(*)::integer,
    pg_catalog.count(distinct canonical_lines.line_position)::integer,
    pg_catalog.round(coalesce(pg_catalog.sum(canonical_lines.line_total), 0), 2)
  into
    v_lines,
    v_canonical_line_count,
    v_distinct_line_position_count,
    v_calculated_total_lyd
  from canonical_lines;

  if v_canonical_line_count <> v_input_line_count
    or v_distinct_line_position_count <> v_input_line_count
  then
    raise exception 'Every purchase line must have one unique position, a valid product, and a positive exact quantity.'
      using errcode = '22023';
  end if;

  if p_manual_total_lyd is not null and p_manual_total_lyd < 0 then
    raise exception 'Receipt total cannot be negative.'
      using errcode = '22023';
  end if;
  v_manual_total_lyd := case
    when p_manual_total_lyd is null then null
    else pg_catalog.round(p_manual_total_lyd, 2)
  end;
  v_total_source := case when v_manual_total_lyd is null then 'calculated' else 'manual' end;
  v_total_adjustment_lyd := case
    when v_manual_total_lyd is null then null
    else pg_catalog.round(v_manual_total_lyd - v_calculated_total_lyd, 2)
  end;
  v_total_amount := coalesce(v_manual_total_lyd, v_calculated_total_lyd);
  if v_submit_action = 'received' and v_total_amount <= 0 then
    raise exception 'A received purchase must have a positive reconciled total. Save it as a draft until line costs are complete.'
      using errcode = '23514';
  end if;
  v_storage_id := p_receiving_storage_location_id;

  v_request_payload := pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'supplier_id', p_supplier_id,
    'order_date', v_order_date,
    'receipt_number', v_receipt_number,
    'payment_method', v_payment_method,
    'payment_status', v_payment_status,
    'payment_account_id', v_payment_account_id,
    'receipt_url', v_receipt_url,
    'receipt_file_name', v_receipt_file_name,
    'receipt_content_type', v_receipt_content_type,
    'receipt_storage_path', v_receipt_storage_path,
    'notes', v_notes,
    'calculated_total_lyd', v_calculated_total_lyd,
    'manual_total_lyd', v_manual_total_lyd,
    'total_adjustment_lyd', v_total_adjustment_lyd,
    'total_source', v_total_source,
    'total_amount', v_total_amount,
    'receiving_storage_location_id', v_storage_id,
    'submit_action', v_submit_action,
    'lines', v_lines
  );

  -- The unique insert is the command mutex. A concurrent duplicate waits for
  -- the first transaction, then reads its immutable result below.
  insert into public.purchase_create_submissions (
    client_submission_id,
    actor_user_id,
    actor_team_member_id,
    request_payload
  ) values (
    p_client_submission_id,
    v_actor_user_id,
    v_actor_team_member_id,
    v_request_payload
  )
  on conflict (client_submission_id) do nothing;

  select submission.*
  into v_existing
  from public.purchase_create_submissions submission
  where submission.client_submission_id = p_client_submission_id
  for update;

  if not found then
    raise exception 'Purchase creation command receipt could not be locked.'
      using errcode = '40001';
  end if;

  if v_existing.actor_user_id is distinct from v_actor_user_id
    or v_existing.actor_team_member_id is distinct from v_actor_team_member_id
  then
    raise exception 'This purchase submission id belongs to another actor.'
      using errcode = '42501';
  end if;

  if v_existing.request_payload is distinct from v_request_payload then
    raise exception 'This purchase submission id was already used with a different payload.'
      using errcode = '22023';
  end if;

  if v_existing.result_payload is not null then
    if v_existing.purchase_id is null
      or (v_existing.result_payload ->> 'id')::uuid is distinct from v_existing.purchase_id
    then
      raise exception 'The saved purchase creation receipt is incomplete.'
        using errcode = '23514';
    end if;

    return query
    select
      (v_existing.result_payload ->> 'id')::uuid,
      v_existing.result_payload ->> 'receipt_number',
      v_existing.result_payload ->> 'status',
      (v_existing.result_payload ->> 'total_amount')::numeric,
      v_existing.result_payload ->> 'payment_status',
      (v_existing.result_payload ->> 'movement_count')::integer,
      (v_existing.result_payload ->> 'receiving_storage_location_id')::uuid;
    return;
  end if;

  if v_existing.purchase_id is not null
    or v_existing.completed_at is not null
  then
    raise exception 'The saved purchase creation receipt is incomplete.'
      using errcode = '23514';
  end if;

  if v_submit_action = 'received' and p_supplier_id is null then
    raise exception 'A supplier is required before receiving stock.'
      using errcode = '22023';
  end if;

  if p_supplier_id is not null then
    perform supplier.id
    from public.suppliers supplier
    where supplier.id = p_supplier_id
    for share;

    if not found then
      raise exception 'Purchase supplier was not found.'
        using errcode = '23503';
    end if;
  end if;

  if v_submit_action = 'received' and v_storage_id is null then
    raise exception 'Select a receiving storage location before receiving stock.'
      using errcode = '22023';
  end if;

  if v_storage_id is not null then
    perform storage.id
    from public.storage_locations storage
    where storage.id = v_storage_id
      and storage.active = true
      and storage.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
    for share;

    if not found then
      raise exception 'The selected receiving storage location is missing, inactive, or unsupported.'
        using errcode = '23514';
    end if;
  end if;

  -- Every storage balance writer uses the same advisory key pair. Lock keys in
  -- canonical storage/product order before product rows so create-and-receive
  -- serializes with route pickup, purchase receive/void, and stock corrections.
  if v_submit_action = 'received' then
    for v_storage_lock in
      select distinct
        v_storage_id as storage_location_id,
        line.product_id
      from pg_catalog.jsonb_to_recordset(v_lines) as line(product_id uuid)
      where line.product_id is not null
      order by storage_location_id, line.product_id
    loop
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext(v_storage_lock.product_id::text),
        pg_catalog.hashtext(v_storage_lock.storage_location_id::text)
      );
    end loop;
  end if;

  -- Lock every referenced product in one deterministic order before any line,
  -- inventory, or cost-memory write. This avoids product-order deadlocks when
  -- two receipts contain the same products in a different UI order.
  perform product.id
  from public.products product
  join (
    select distinct line.product_id
    from pg_catalog.jsonb_to_recordset(v_lines) as line(product_id uuid)
    where line.product_id is not null
  ) requested_product on requested_product.product_id = product.id
  order by product.id
  for update of product;

  if exists (
    select 1
    from (
      select distinct line.product_id
      from pg_catalog.jsonb_to_recordset(v_lines) as line(product_id uuid)
      where line.product_id is not null
    ) requested_product
    left join public.products product
      on product.id = requested_product.product_id
    where product.id is null
      or product.active is distinct from true
  ) then
    raise exception 'Every purchase line must reference an active product.'
      using errcode = '23503';
  end if;

  insert into public.purchase_orders (
    supplier_id,
    status,
    order_date,
    receipt_number,
    payment_method,
    payment_status,
    payment_account_id,
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
    receiving_storage_location_id,
    created_by
  ) values (
    p_supplier_id,
    'draft',
    v_order_date,
    v_receipt_number,
    v_payment_method,
    v_payment_status,
    v_payment_account_id,
    v_receipt_url,
    v_receipt_file_name,
    v_receipt_content_type,
    v_receipt_storage_path,
    v_notes,
    v_calculated_total_lyd,
    v_manual_total_lyd,
    v_total_adjustment_lyd,
    v_total_source,
    v_total_amount,
    v_storage_id,
    v_actor_team_member_id
  )
  returning purchase_orders.id into v_purchase_id;

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
    line.product_id,
    line.line_position,
    line.boxes_qty,
    line.units_per_box,
    line.loose_units_qty,
    line.total_units,
    line.ordered_qty,
    case
      when v_submit_action = 'received' then line.total_units
      else 0
    end,
    line.unit_cost,
    line.unit_cost_lyd,
    line.line_total,
    line.line_total_lyd
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
  )
  order by line.line_position, line.product_id;

  if not exists (
    select 1
    from public.purchase_order_lines line
    where line.purchase_order_id = v_purchase_id
  ) then
    raise exception 'Purchase must include at least one valid line item.'
      using errcode = '22023';
  end if;

  if (
    select pg_catalog.count(*)
    from public.purchase_order_lines line
    where line.purchase_order_id = v_purchase_id
  ) is distinct from pg_catalog.jsonb_array_length(v_lines)::bigint then
    raise exception 'Every purchase line must have a valid product and positive quantity.'
      using errcode = '22023';
  end if;

  if v_submit_action = 'received' then
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
      source_type,
      source_id,
      idempotency_key,
      idempotency_payload,
      unit_cost_lyd,
      line_total_lyd,
      created_by,
      notes
    )
    select
      line.product_id,
      line.total_units,
      'supplier',
      p_supplier_id,
      'storage',
      v_storage_id,
      'purchase_received',
      v_purchase_id,
      line.id,
      'purchase_receipt',
      v_purchase_id,
      'purchase-receipt:v1:' || v_purchase_id::text || ':' || line.id::text,
      pg_catalog.jsonb_build_object(
        'contract_version', 1,
        'purchase_id', v_purchase_id,
        'purchase_line_id', line.id,
        'product_id', line.product_id,
        'storage_location_id', v_storage_id,
        'quantity', line.total_units,
        'creation_submission_id', p_client_submission_id
      ),
      coalesce(line.unit_cost_lyd, line.unit_cost, 0),
      coalesce(line.line_total_lyd, line.line_total, 0),
      v_actor_team_member_id,
      'Purchase received'
    from public.purchase_order_lines line
    where line.purchase_order_id = v_purchase_id
      and line.total_units > 0
    order by line.product_id, line.id;

    get diagnostics v_movement_count = row_count;

    if v_movement_count = 0 then
      raise exception 'Purchase receipt created no inventory movements.'
        using errcode = '23514';
    end if;

    with latest_line as (
      select distinct on (line.product_id)
        line.product_id,
        line.id as purchase_line_id,
        pg_catalog.round(
          coalesce(line.unit_cost_lyd, line.unit_cost, 0)::numeric,
          4
        ) as latest_cost
      from public.purchase_order_lines line
      where line.purchase_order_id = v_purchase_id
        and coalesce(line.unit_cost_lyd, line.unit_cost, 0) > 0
      order by line.product_id, line.line_position desc, line.id desc
    )
    update public.products product
    set
      cost_price = pg_catalog.round(latest_line.latest_cost, 2),
      current_cost_price_lyd = latest_line.latest_cost,
      last_purchase_cost_lyd = latest_line.latest_cost,
      last_purchase_date = v_order_date,
      last_supplier_id = p_supplier_id,
      last_purchase_line_id = latest_line.purchase_line_id,
      cost_price_source = 'latest_purchase',
      price_updated_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
    from latest_line
    where product.id = latest_line.product_id;

    update public.purchase_orders purchase
    set
      status = 'received',
      received_at = pg_catalog.now(),
      received_date = current_date,
      received_by = v_actor_team_member_id,
      updated_at = pg_catalog.now()
    where purchase.id = v_purchase_id;
  end if;

  select pg_catalog.jsonb_build_object(
    'contract_version', 2,
    'client_submission_id', p_client_submission_id,
    'id', purchase.id,
    'receipt_number', purchase.receipt_number,
    'status', purchase.status,
    'total_amount', purchase.total_amount,
    'calculated_total_lyd', purchase.calculated_total_lyd,
    'manual_total_lyd', purchase.manual_total_lyd,
    'total_adjustment_lyd', purchase.total_adjustment_lyd,
    'total_source', purchase.total_source,
    'payment_status', purchase.payment_status,
    'movement_count', v_movement_count,
    'receiving_storage_location_id', purchase.receiving_storage_location_id,
    'canonical_lines', v_lines
  )
  into v_result_payload
  from public.purchase_orders purchase
  where purchase.id = v_purchase_id;

  if v_result_payload is null then
    raise exception 'Purchase creation result could not be saved.'
      using errcode = '23514';
  end if;

  update public.purchase_create_submissions submission
  set
    purchase_id = v_purchase_id,
    result_payload = v_result_payload,
    completed_at = pg_catalog.now()
  where submission.client_submission_id = p_client_submission_id
    and submission.result_payload is null;

  if not found then
    raise exception 'Purchase creation result was not recorded exactly once.'
      using errcode = '40001';
  end if;

  return query
  select
    (v_result_payload ->> 'id')::uuid,
    v_result_payload ->> 'receipt_number',
    v_result_payload ->> 'status',
    (v_result_payload ->> 'total_amount')::numeric,
    v_result_payload ->> 'payment_status',
    (v_result_payload ->> 'movement_count')::integer,
    (v_result_payload ->> 'receiving_storage_location_id')::uuid;
end;
$function$;

comment on function public.snacky_create_purchase_with_lines_v2(
  uuid, uuid, date, text, text, text, text, text, text, text, text,
  numeric, numeric, numeric, text, numeric, text, uuid, text, jsonb
) is
  'Authenticated exactly-once purchase creation. The client UUID is bound to one immutable normalized request and exact result; retries never duplicate the purchase or stock receipt.';

-- Once this migration and its matching application version are deployed, the
-- legacy signature must not remain an authenticated non-idempotent write path.
revoke all on function public.snacky_create_purchase_with_lines(
  uuid, date, text, text, text, text, text, text, text, text,
  numeric, numeric, numeric, text, numeric, uuid, text, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.snacky_create_purchase_with_lines_v2(
  uuid, uuid, date, text, text, text, text, text, text, text, text,
  numeric, numeric, numeric, text, numeric, text, uuid, text, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.snacky_create_purchase_with_lines_v2(
  uuid, uuid, date, text, text, text, text, text, text, text, text,
  numeric, numeric, numeric, text, numeric, text, uuid, text, jsonb
) to authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');
