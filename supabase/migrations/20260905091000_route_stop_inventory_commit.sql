-- Atomically reconcile one route stop's physical refill quantities with the
-- inventory ledger.  This function deliberately does not complete the stop:
-- proof, cash, issues, and the final stop status remain separate concerns.

-- The preceding terminal-inventory migration owns this table.  Keep the
-- create-if-missing definition here so this safety RPC can also be rehearsed
-- independently on an older database without inventing a second review model.
create table if not exists public.route_inventory_discrepancies (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  route_stop_id uuid references public.route_stops(id) on delete restrict,
  machine_id uuid references public.machines(id) on delete restrict,
  operator_id uuid references public.team_members(id) on delete set null,
  product_id uuid not null references public.products(id) on delete restrict,
  discrepancy_type text not null,
  recorded_quantity integer not null,
  actual_quantity integer not null,
  difference_quantity integer not null,
  absolute_quantity integer not null,
  status text not null default 'open',
  source_type text not null,
  source_id uuid not null,
  idempotency_key text not null,
  details jsonb not null default '{}'::jsonb,
  detected_by_user_id uuid references auth.users(id) on delete set null,
  detected_by_team_member_id uuid references public.team_members(id) on delete set null,
  detected_at timestamptz not null default now(),
  resolution_type text,
  resolution_notes text,
  resolved_by_user_id uuid references auth.users(id) on delete set null,
  resolved_by_team_member_id uuid references public.team_members(id) on delete set null,
  resolved_at timestamptz,
  correcting_movement_id uuid references public.inventory_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_inventory_discrepancies_type_check
    check (discrepancy_type in (
      'stop_shortage',
      'stop_overage',
      'terminal_shortage',
      'terminal_overage',
      'negative_bag_balance',
      'unreturned_stock',
      'other'
    )),
  constraint route_inventory_discrepancies_actual_nonnegative
    check (actual_quantity >= 0),
  constraint route_inventory_discrepancies_difference_matches
    check (difference_quantity = actual_quantity - recorded_quantity),
  constraint route_inventory_discrepancies_absolute_matches
    check (absolute_quantity = abs(difference_quantity)),
  constraint route_inventory_discrepancies_status_check
    check (status in ('open', 'investigating', 'resolved', 'accepted_loss', 'voided')),
  constraint route_inventory_discrepancies_source_type_check
    check (btrim(source_type) <> ''),
  constraint route_inventory_discrepancies_idempotency_check
    check (btrim(idempotency_key) <> ''),
  constraint route_inventory_discrepancies_details_object
    check (jsonb_typeof(details) = 'object'),
  constraint route_inventory_discrepancies_idempotency_key unique (idempotency_key)
);

create index if not exists idx_route_inventory_discrepancies_route_status
  on public.route_inventory_discrepancies(route_id, status, detected_at desc);

create index if not exists idx_route_inventory_discrepancies_operator_status
  on public.route_inventory_discrepancies(operator_id, status, detected_at desc)
  where operator_id is not null;

create index if not exists idx_route_inventory_discrepancies_source
  on public.route_inventory_discrepancies(source_type, source_id);

alter table public.route_inventory_discrepancies enable row level security;

revoke all on table public.route_inventory_discrepancies from public, anon, authenticated;
grant select on table public.route_inventory_discrepancies to authenticated;
grant all on table public.route_inventory_discrepancies to service_role;

drop policy if exists "snacky_route_inventory_discrepancies_select" on public.route_inventory_discrepancies;
create policy "snacky_route_inventory_discrepancies_select"
on public.route_inventory_discrepancies
for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
);

-- Every successful inventory commit, including an all-zero physical fill,
-- writes one authoritative receipt in the same transaction. The server-only
-- workflow finalizer must lock and match this receipt before it may mark the
-- stop completed. This prevents status completion from bypassing inventory.
create table if not exists public.route_stop_inventory_commits (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  route_stop_id uuid not null references public.route_stops(id) on delete restrict,
  machine_id uuid not null references public.machines(id) on delete restrict,
  operator_id uuid not null references public.team_members(id) on delete restrict,
  latest_submission_id text not null,
  payload_hash text not null,
  inventory_needs_review boolean not null default false,
  movement_count integer not null default 0,
  result_payload jsonb,
  committed_at timestamptz not null default now(),
  workflow_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_stop_inventory_commits_stop_unique unique (route_stop_id),
  constraint route_stop_inventory_commits_submission_nonempty
    check (btrim(latest_submission_id) <> ''),
  constraint route_stop_inventory_commits_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{32}$'),
  constraint route_stop_inventory_commits_movement_count_nonnegative
    check (movement_count >= 0),
  constraint route_stop_inventory_commits_result_payload_object
    check (result_payload is null or jsonb_typeof(result_payload) = 'object')
);

-- 0900 deliberately creates the receipt table first so its terminal-route
-- guards exist before this writer is installed. CREATE TABLE IF NOT EXISTS
-- does not add later columns, so upgrade that sequential-migration shape
-- explicitly before the RPC reads or writes payload_hash.
alter table public.route_stop_inventory_commits
  add column if not exists payload_hash text;

alter table public.route_stop_inventory_commits
  add column if not exists result_payload jsonb;

update public.route_stop_inventory_commits
set payload_hash = pg_catalog.md5(
  'legacy-route-stop-inventory-receipt:' || id::text || ':' || latest_submission_id
)
where payload_hash is null
  or payload_hash !~ '^[0-9a-f]{32}$';

alter table public.route_stop_inventory_commits
  alter column payload_hash set not null;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_stop_inventory_commits'::pg_catalog.regclass
      and constraint_row.conname = 'route_stop_inventory_commits_payload_hash_check'
  ) then
    alter table public.route_stop_inventory_commits
      add constraint route_stop_inventory_commits_payload_hash_check
      check (payload_hash ~ '^[0-9a-f]{32}$');
  end if;
end;
$migration$;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_stop_inventory_commits'::pg_catalog.regclass
      and constraint_row.conname = 'route_stop_inventory_commits_result_payload_object'
  ) then
    alter table public.route_stop_inventory_commits
      add constraint route_stop_inventory_commits_result_payload_object
      check (result_payload is null or jsonb_typeof(result_payload) = 'object');
  end if;
end;
$migration$;

create index if not exists idx_route_stop_inventory_commits_route
  on public.route_stop_inventory_commits(route_id, committed_at desc);

alter table public.route_stop_inventory_commits enable row level security;
revoke all on table public.route_stop_inventory_commits from public, anon, authenticated;
grant all on table public.route_stop_inventory_commits to service_role;

-- The former six-argument writer ran in the operator's authenticated context.
-- Remove that exposed signature before installing the server-only contract so
-- a crafted Data API call cannot seed or replace a pending completion receipt.
drop function if exists public.snacky_commit_route_stop_inventory_v1(uuid, uuid, uuid, text, jsonb, jsonb);

create or replace function public.snacky_commit_route_stop_inventory_v1(
  p_route_id uuid,
  p_route_stop_id uuid,
  p_machine_id uuid,
  p_actor_user_id uuid,
  p_actor_team_member_id uuid,
  p_submission_id text,
  p_fill_lines jsonb,
  p_machine_storage_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor_user_id uuid := p_actor_user_id;
  v_actor_team_member_id uuid := p_actor_team_member_id;
  v_actor_is_manager boolean := false;
  v_actor_is_operator boolean := false;
  v_route record;
  v_stop record;
  v_submission_id text := nullif(btrim(coalesce(p_submission_id, '')), '');
  v_fill_lines jsonb := coalesce(p_fill_lines, '[]'::jsonb);
  v_machine_storage_lines jsonb := coalesce(p_machine_storage_lines, '[]'::jsonb);
  v_fill_totals jsonb := '{}'::jsonb;
  v_machine_storage_totals jsonb := '{}'::jsonb;
  v_verified_fill_totals jsonb := '{}'::jsonb;
  v_short_fill_totals jsonb := '{}'::jsonb;
  v_verified_machine_storage_totals jsonb := '{}'::jsonb;
  v_short_machine_storage_totals jsonb := '{}'::jsonb;
  v_seen_fill_products uuid[] := '{}'::uuid[];
  v_product_ids uuid[] := '{}'::uuid[];
  v_line jsonb;
  v_product_text text;
  v_quantity_text text;
  v_refill_line_text text;
  v_action_type text;
  v_product_id uuid;
  v_refill_order_line_id uuid;
  v_quantity integer;
  v_total_submitted_quantity bigint := 0;
  v_planned_quantity integer;
  v_picked_quantity integer;
  v_desired_fill integer;
  v_desired_machine_storage integer;
  v_desired_total integer;
  v_current_verified_fill integer;
  v_current_short_fill integer;
  v_current_verified_machine_storage integer;
  v_current_short_machine_storage integer;
  v_current_verified_total integer;
  v_route_bag_before bigint;
  v_operator_bag_before bigint;
  v_route_bag_after bigint;
  v_operator_bag_after bigint;
  v_verifiable_total integer;
  v_target_verified_fill integer;
  v_target_short_fill integer;
  v_target_verified_machine_storage integer;
  v_target_short_machine_storage integer;
  v_target_short_total integer;
  v_generation bigint;
  v_segment record;
  v_delta integer;
  v_forward_from_type public.inventory_entity_type;
  v_forward_from_id uuid;
  v_forward_to_type public.inventory_entity_type;
  v_forward_to_id uuid;
  v_from_type public.inventory_entity_type;
  v_from_id uuid;
  v_to_type public.inventory_entity_type;
  v_to_id uuid;
  v_reason public.movement_reason;
  v_movement_type text;
  v_movement_id uuid;
  v_shortage_movement_id uuid;
  v_reversed_movement_id uuid;
  v_idempotency_key text;
  v_discrepancy_key text;
  v_unavailable boolean;
  v_assigned_quantity integer;
  v_product_movement_ids jsonb;
  v_movement_ids jsonb := '[]'::jsonb;
  v_product_summaries jsonb := '[]'::jsonb;
  v_discrepancy_status text;
  v_needs_review boolean := false;
  v_discrepancy_count integer := 0;
  v_payload_hash text;
  v_existing_receipt_submission_id text;
  v_existing_receipt_payload_hash text;
  v_existing_receipt_workflow_completed_at timestamptz;
  v_existing_receipt_movement_count integer;
  v_existing_receipt_result_payload jsonb;
  v_commit_receipt_id uuid;
  v_receipt_movement_count integer;
  v_inventory_committed_at timestamptz;
  v_result_payload jsonb;
begin
  if v_actor_user_id is null or v_actor_team_member_id is null then
    raise exception 'An authenticated user and linked team member are required.' using errcode = '22023';
  end if;

  if p_route_id is null or p_route_stop_id is null or p_machine_id is null then
    raise exception 'Route, route stop, and machine are required.' using errcode = '22023';
  end if;

  if v_submission_id is null or length(v_submission_id) > 200 then
    raise exception 'A submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  if jsonb_typeof(v_fill_lines) <> 'array'
    or jsonb_typeof(v_machine_storage_lines) <> 'array'
  then
    raise exception 'Stop inventory line payloads must be JSON arrays.' using errcode = '22023';
  end if;

  if jsonb_array_length(v_fill_lines) > 200
    or jsonb_array_length(v_machine_storage_lines) > 200
  then
    raise exception 'A stop inventory submission cannot contain more than 200 lines per destination.' using errcode = '54000';
  end if;

  if pg_column_size(v_fill_lines) + pg_column_size(v_machine_storage_lines) > 1048576 then
    raise exception 'Stop inventory payload is too large.' using errcode = '54000';
  end if;

  v_payload_hash := pg_catalog.md5(
    v_fill_lines::text
    || pg_catalog.chr(31)
    || v_machine_storage_lines::text
  );

  select
    (
      public.snacky_profile_has_any_role(p.roles, p.role, array['owner', 'admin', 'supervisor'])
      or public.snacky_profile_has_any_role(tm.roles, tm.role, array['owner', 'admin', 'supervisor'])
    ),
    (
      public.snacky_profile_has_any_role(p.roles, p.role, array['operator'])
      or public.snacky_profile_has_any_role(tm.roles, tm.role, array['operator'])
    )
  into v_actor_is_manager, v_actor_is_operator
  from public.profiles p
  join public.team_members tm on tm.id = v_actor_team_member_id
  where p.id = v_actor_user_id
    and p.active_status = 'active'
    and tm.active = true
    and tm.active_status = 'active'
    and (
      p.team_member_id = tm.id
      or tm.auth_user_id = p.id
    );

  if not found then
    raise exception 'The completion actor is not linked to an active Snacky profile and team member.'
      using errcode = '42501';
  end if;

  -- All inventory operations for a route use this exact lock namespace.  The
  -- terminal/cancellation RPC takes the same lock before touching route stock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || p_route_id::text, 0)
  );

  select r.id, r.operator_id, r.status
  into v_route
  from public.routes r
  where r.id = p_route_id
  for update;

  if not found then
    raise exception 'Route not found.' using errcode = 'P0002';
  end if;

  if v_route.operator_id is null then
    raise exception 'Route must be assigned to an operator before a stop can post inventory.' using errcode = '23514';
  end if;

  if not (
    v_actor_is_manager
    or (v_actor_is_operator and v_route.operator_id = v_actor_team_member_id)
  ) then
    raise exception 'User is not authorized to post inventory for this route.' using errcode = '42501';
  end if;

  select rs.id, rs.route_id, rs.machine_id, rs.status
  into v_stop
  from public.route_stops rs
  where rs.id = p_route_stop_id
  for update;

  if not found
    or v_stop.route_id is distinct from p_route_id
    or v_stop.machine_id is distinct from p_machine_id
  then
    raise exception 'Route stop does not belong to the selected route and machine.' using errcode = '23514';
  end if;

  select
    receipt.latest_submission_id,
    receipt.payload_hash,
    receipt.workflow_completed_at,
    receipt.movement_count,
    receipt.result_payload
  into
    v_existing_receipt_submission_id,
    v_existing_receipt_payload_hash,
    v_existing_receipt_workflow_completed_at,
    v_existing_receipt_movement_count,
    v_existing_receipt_result_payload
  from public.route_stop_inventory_commits receipt
  where receipt.route_stop_id = p_route_stop_id
  for update;

  if found then
    if v_existing_receipt_submission_id is distinct from v_submission_id
      or v_existing_receipt_payload_hash is distinct from v_payload_hash
    then
      if v_existing_receipt_workflow_completed_at is null then
        raise exception 'Another stop-completion payload already committed inventory. Retry that exact payload before changing this stop.'
          using errcode = '40001';
      end if;

      raise exception 'Completed stop inventory cannot be replaced by another submission.'
        using errcode = '23514';
    end if;

    if v_existing_receipt_result_payload is null then
      raise exception 'The saved stop inventory receipt is missing its immutable result. Reconcile this stop before retrying.'
        using errcode = '23514';
    end if;

    return v_existing_receipt_result_payload;
  end if;

  -- A lost-response retry must remain readable after the workflow has already
  -- made the route/stop terminal.  Only a brand-new payload is subject to the
  -- mutable-status gates below; the exact immutable receipt above is safe to
  -- return without writing anything.
  if v_route.status::text not in (
    'in_progress',
    'pickup_confirmed',
    'started',
    'filling',
    'machine_filling'
  ) then
    raise exception 'Route status does not allow stop inventory changes: %.', v_route.status::text
      using errcode = '23514';
  end if;

  if v_stop.status::text not in (
    'picked',
    'in_progress',
    'arrived',
    'refilling',
    'cash_collected',
    'issue_reported',
    'completed'
  ) then
    raise exception 'Stop status does not allow inventory changes: %.', v_stop.status::text
      using errcode = '23514';
  end if;

  -- Assigned fills are one authoritative product total per stop.  The current
  -- operator UI already groups repeated machine lanes by product; rejecting a
  -- duplicate here prevents ambiguous retry and audit semantics.
  for v_line in
    select value
    from jsonb_array_elements(v_fill_lines)
  loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'Every fill line must be a JSON object.' using errcode = '22023';
    end if;

    v_action_type := lower(nullif(btrim(coalesce(v_line ->> 'action_type', '')), ''));
    if v_action_type = 'missing_product_report' then
      if nullif(btrim(coalesce(v_line ->> 'missing_product_name', '')), '') is null then
        raise exception 'A missing-product report requires the product name.' using errcode = '22023';
      end if;
      if length(btrim(v_line ->> 'missing_product_name')) > 200 then
        raise exception 'A missing-product name cannot exceed 200 characters.' using errcode = '22023';
      end if;
      v_quantity_text := nullif(btrim(coalesce(v_line ->> 'actual_qty', v_line ->> 'quantity', '0')), '');
      if v_quantity_text !~ '^[0-9]+$'
        or length(v_quantity_text) > 6
      then
        raise exception 'A missing-product report must have an actual quantity of zero.' using errcode = '22023';
      end if;
      if v_quantity_text::integer <> 0 then
        raise exception 'A missing-product report must have an actual quantity of zero.' using errcode = '22023';
      end if;
      continue;
    elsif v_action_type is not null and v_action_type <> 'assigned_fill' then
      raise exception 'Unsupported fill-line action type: %.', v_action_type using errcode = '22023';
    end if;

    v_product_text := nullif(btrim(coalesce(v_line ->> 'product_id', '')), '');
    if v_product_text is null
      or v_product_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception 'Every fill line requires a valid product id.' using errcode = '22023';
    end if;
    v_product_id := v_product_text::uuid;

    if v_product_id = any(v_seen_fill_products) then
      raise exception 'A product may appear only once in assigned fill lines: %.', v_product_id
        using errcode = '22023';
    end if;
    v_seen_fill_products := array_append(v_seen_fill_products, v_product_id);

    v_quantity_text := nullif(btrim(coalesce(v_line ->> 'actual_qty', v_line ->> 'quantity', '')), '');
    if v_quantity_text is null or v_quantity_text !~ '^[0-9]+$' then
      raise exception 'Every fill line requires a nonnegative whole-unit quantity.' using errcode = '22023';
    end if;
    if length(v_quantity_text) > 6 then
      raise exception 'A single fill quantity cannot exceed 100000 units.' using errcode = '22023';
    end if;
    v_quantity := v_quantity_text::integer;
    if v_quantity > 100000 then
      raise exception 'A single fill quantity cannot exceed 100000 units.' using errcode = '22023';
    end if;

    if v_line ? 'unavailable' and jsonb_typeof(v_line -> 'unavailable') <> 'boolean' then
      raise exception 'Fill line unavailable must be true or false.' using errcode = '22023';
    end if;

    if not exists (select 1 from public.products p where p.id = v_product_id) then
      raise exception 'Fill product does not exist: %.', v_product_id using errcode = '23503';
    end if;

    if not exists (
      select 1
      from public.route_stop_items rsi
      where rsi.route_id = p_route_id
        and rsi.route_stop_id = p_route_stop_id
        and rsi.machine_id = p_machine_id
        and rsi.product_id = v_product_id
    ) then
      raise exception 'Fill product is not assigned to this route stop: %.', v_product_id
        using errcode = '23514';
    end if;

    v_refill_line_text := nullif(btrim(coalesce(v_line ->> 'refill_order_line_id', '')), '');
    if v_refill_line_text is not null then
      if v_refill_line_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Fill line has an invalid refill order line id.' using errcode = '22023';
      end if;
      v_refill_order_line_id := v_refill_line_text::uuid;
      if not exists (
        select 1
        from public.refill_order_lines rol
        join public.refill_orders ro on ro.id = rol.refill_order_id
        where rol.id = v_refill_order_line_id
          and rol.product_id = v_product_id
          and ro.route_id = p_route_id
          and ro.machine_id = p_machine_id
      ) then
        raise exception 'Refill order line does not belong to this route, machine, and product.'
          using errcode = '23514';
      end if;
    end if;

    v_fill_totals := jsonb_set(
      v_fill_totals,
      array[v_product_id::text],
      to_jsonb(v_quantity),
      true
    );
    v_total_submitted_quantity := v_total_submitted_quantity + v_quantity;
  end loop;

  if exists (
    select 1
    from public.route_stop_items rsi
    where rsi.route_id = p_route_id
      and rsi.route_stop_id = p_route_stop_id
      and rsi.machine_id = p_machine_id
      and greatest(coalesce(rsi.planned_quantity, 0), coalesce(rsi.picked_quantity, 0)) > 0
      and not (rsi.product_id = any(v_seen_fill_products))
  ) then
    raise exception 'Every planned or picked route-stop product requires an explicit assigned fill line, including zero fills.'
      using errcode = '23514';
  end if;

  -- Machine-storage lines may repeat a product because the UI can collect
  -- separate reasons/notes.  Inventory is reconciled on their aggregate.
  for v_line in
    select value
    from jsonb_array_elements(v_machine_storage_lines)
  loop
    if jsonb_typeof(v_line) <> 'object' then
      raise exception 'Every machine-storage line must be a JSON object.' using errcode = '22023';
    end if;

    v_product_text := nullif(btrim(coalesce(v_line ->> 'product_id', '')), '');
    if v_product_text is null
      or v_product_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception 'Every machine-storage line requires a valid product id.' using errcode = '22023';
    end if;
    v_product_id := v_product_text::uuid;

    if exists (
      select 1
      from public.route_stop_items rsi
      where rsi.route_id = p_route_id
        and rsi.route_stop_id = p_route_stop_id
        and rsi.machine_id = p_machine_id
        and rsi.product_id = v_product_id
        and greatest(coalesce(rsi.planned_quantity, 0), coalesce(rsi.picked_quantity, 0)) > 0
    ) then
      raise exception 'Use the assigned fill line instead of adding the same product to machine storage: %.', v_product_id
        using errcode = '22023';
    end if;

    v_quantity_text := nullif(btrim(coalesce(v_line ->> 'actual_qty', v_line ->> 'quantity', '')), '');
    if v_quantity_text is null or v_quantity_text !~ '^[1-9][0-9]*$' then
      raise exception 'Every machine-storage line requires a positive whole-unit quantity.' using errcode = '22023';
    end if;
    if length(v_quantity_text) > 6 then
      raise exception 'A single machine-storage quantity cannot exceed 100000 units.' using errcode = '22023';
    end if;
    v_quantity := v_quantity_text::integer;
    if v_quantity > 100000 then
      raise exception 'A single machine-storage quantity cannot exceed 100000 units.' using errcode = '22023';
    end if;

    if not exists (select 1 from public.products p where p.id = v_product_id) then
      raise exception 'Machine-storage product does not exist: %.', v_product_id using errcode = '23503';
    end if;

    v_machine_storage_totals := jsonb_set(
      v_machine_storage_totals,
      array[v_product_id::text],
      to_jsonb(coalesce((v_machine_storage_totals ->> v_product_id::text)::integer, 0) + v_quantity),
      true
    );
    v_total_submitted_quantity := v_total_submitted_quantity + v_quantity;
  end loop;

  if v_total_submitted_quantity > 200000 then
    raise exception 'A stop inventory submission cannot exceed 200000 units.' using errcode = '54000';
  end if;

  select coalesce(array_agg(products.product_id order by products.product_id), '{}'::uuid[])
  into v_product_ids
  from (
    select product_key::uuid as product_id
    from jsonb_object_keys(v_fill_totals) as fill_keys(product_key)
    union
    select product_key::uuid as product_id
    from jsonb_object_keys(v_machine_storage_totals) as storage_keys(product_key)
    union
    select im.product_id
    from public.inventory_movements im
    where im.related_route_id = p_route_id
      and im.related_route_stop_id = p_route_stop_id
      and coalesce(im.related_machine_id, p_machine_id) = p_machine_id
      and im.source_type in ('route_stop_completion', 'route_stop_inventory_v1')
      and (
        (im.from_entity_type::text in ('operator_bag', 'adjustment') and im.to_entity_type::text in ('machine', 'machine_storage'))
        or (im.from_entity_type::text in ('machine', 'machine_storage') and im.to_entity_type::text in ('operator_bag', 'adjustment'))
      )
    union
    select rid.product_id
    from public.route_inventory_discrepancies rid
    where rid.source_type = 'route_stop_inventory_commit'
      and rid.source_id = p_route_stop_id
  ) products;

  -- All operator custody writers share one lock order: route first, then the
  -- operator's single-route custody lock, then product bag locks in UUID order.
  -- This prevents a second route from claiming the same physical bag and avoids
  -- cross-product deadlocks when a transaction posts more than one movement.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'snacky:operator-custody:' || v_route.operator_id::text,
      0
    )
  );

  foreach v_product_id in array v_product_ids
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_route.operator_id::text || ':' || v_product_id::text,
        0
      )
    );
  end loop;

  select count(*)
  into v_generation
  from public.inventory_movements im
  where im.related_route_id = p_route_id
    and im.related_route_stop_id = p_route_stop_id
    and im.source_type in ('route_stop_completion', 'route_stop_inventory_v1');

  foreach v_product_id in array v_product_ids
  loop
    v_product_movement_ids := '[]'::jsonb;
    v_desired_fill := coalesce((v_fill_totals ->> v_product_id::text)::integer, 0);
    v_desired_machine_storage := coalesce((v_machine_storage_totals ->> v_product_id::text)::integer, 0);
    v_desired_total := v_desired_fill + v_desired_machine_storage;

    select
      coalesce(sum(greatest(coalesce(rsi.planned_quantity, 0), 0)), 0)::integer,
      coalesce(sum(greatest(coalesce(rsi.picked_quantity, 0), 0)), 0)::integer
    into v_planned_quantity, v_picked_quantity
    from public.route_stop_items rsi
    where rsi.route_id = p_route_id
      and rsi.route_stop_id = p_route_stop_id
      and rsi.machine_id = p_machine_id
      and rsi.product_id = v_product_id;

    if exists (
      select 1
      from public.inventory_movements im
      where im.related_route_id = p_route_id
        and im.related_route_stop_id = p_route_stop_id
        and im.source_type in ('route_stop_completion', 'route_stop_inventory_v1')
        and (
          (im.from_entity_type::text = 'operator_bag' and im.from_entity_id is distinct from v_route.operator_id)
          or (im.to_entity_type::text = 'operator_bag' and im.to_entity_id is distinct from v_route.operator_id)
        )
    ) then
      raise exception 'Existing stop inventory belongs to a different operator. Reconcile the route assignment before editing this stop.'
        using errcode = '23514';
    end if;

    select
      coalesce(sum(case
        when im.from_entity_type::text = 'operator_bag' and im.to_entity_type::text = 'machine' then im.quantity
        when im.from_entity_type::text = 'machine' and im.to_entity_type::text = 'operator_bag' then -im.quantity
        else 0
      end), 0)::integer,
      coalesce(sum(case
        when im.from_entity_type::text = 'adjustment' and im.to_entity_type::text = 'machine' then im.quantity
        when im.from_entity_type::text = 'machine' and im.to_entity_type::text = 'adjustment' then -im.quantity
        else 0
      end), 0)::integer,
      coalesce(sum(case
        when im.from_entity_type::text = 'operator_bag' and im.to_entity_type::text = 'machine_storage' then im.quantity
        when im.from_entity_type::text = 'machine_storage' and im.to_entity_type::text = 'operator_bag' then -im.quantity
        else 0
      end), 0)::integer,
      coalesce(sum(case
        when im.from_entity_type::text = 'adjustment' and im.to_entity_type::text = 'machine_storage' then im.quantity
        when im.from_entity_type::text = 'machine_storage' and im.to_entity_type::text = 'adjustment' then -im.quantity
        else 0
      end), 0)::integer
    into
      v_current_verified_fill,
      v_current_short_fill,
      v_current_verified_machine_storage,
      v_current_short_machine_storage
    from public.inventory_movements im
    where im.related_route_id = p_route_id
      and im.related_route_stop_id = p_route_stop_id
      and im.product_id = v_product_id
      and coalesce(im.related_machine_id, p_machine_id) = p_machine_id
      and im.source_type in ('route_stop_completion', 'route_stop_inventory_v1');

    if v_current_verified_fill < 0
      or v_current_short_fill < 0
      or v_current_verified_machine_storage < 0
      or v_current_short_machine_storage < 0
    then
      raise exception 'Existing stop inventory has more reversals than postings for product %. Reconcile it before editing.', v_product_id
        using errcode = '23514';
    end if;

    v_current_verified_total := v_current_verified_fill + v_current_verified_machine_storage;

    select coalesce(sum(
      case
        when im.to_entity_type::text = 'operator_bag'
          and im.to_entity_id = v_route.operator_id
          then im.quantity::bigint
        else 0::bigint
      end
      + case
        when im.from_entity_type::text = 'operator_bag'
          and im.from_entity_id = v_route.operator_id
          then -im.quantity::bigint
        else 0::bigint
      end
    ), 0)::bigint
    into v_operator_bag_before
    from public.inventory_movements im
    where im.product_id = v_product_id;

    select coalesce(max(balances.signed_quantity), 0)::bigint
    into v_route_bag_before
    from public._snacky_route_bag_balances(p_route_id) balances
    where balances.bag_owner_id = v_route.operator_id
      and balances.product_id = v_product_id;

    -- Existing verified units can be pulled back from this stop before the new
    -- desired state is posted.  Cap against both the route-specific and global
    -- operator bag so one route cannot spend another route's stock.
    v_verifiable_total := least(
      greatest(
        least(
          v_operator_bag_before + v_current_verified_total,
          v_route_bag_before + v_current_verified_total
        ),
        0
      ),
      v_desired_total
    );

    -- Filling sellable lanes takes priority over leaving optional spare stock
    -- in machine storage when the recorded bag is short.
    v_target_verified_fill := least(v_desired_fill, v_verifiable_total);
    v_target_short_fill := v_desired_fill - v_target_verified_fill;
    v_target_verified_machine_storage := least(
      v_desired_machine_storage,
      greatest(v_verifiable_total - v_target_verified_fill, 0)
    );
    v_target_short_machine_storage := v_desired_machine_storage - v_target_verified_machine_storage;
    v_target_short_total := v_target_short_fill + v_target_short_machine_storage;

    v_verified_fill_totals := jsonb_set(v_verified_fill_totals, array[v_product_id::text], to_jsonb(v_target_verified_fill), true);
    v_short_fill_totals := jsonb_set(v_short_fill_totals, array[v_product_id::text], to_jsonb(v_target_short_fill), true);
    v_verified_machine_storage_totals := jsonb_set(v_verified_machine_storage_totals, array[v_product_id::text], to_jsonb(v_target_verified_machine_storage), true);
    v_short_machine_storage_totals := jsonb_set(v_short_machine_storage_totals, array[v_product_id::text], to_jsonb(v_target_short_machine_storage), true);

    for v_segment in
      select *
      from (values
        ('machine'::text, 'verified'::text, v_current_verified_fill, v_target_verified_fill),
        ('machine'::text, 'shortage_adjustment'::text, v_current_short_fill, v_target_short_fill),
        ('machine_storage'::text, 'verified'::text, v_current_verified_machine_storage, v_target_verified_machine_storage),
        ('machine_storage'::text, 'shortage_adjustment'::text, v_current_short_machine_storage, v_target_short_machine_storage)
      ) as segments(endpoint_name, provenance_name, current_quantity, target_quantity)
    loop
      v_delta := v_segment.target_quantity - v_segment.current_quantity;
      if v_delta = 0 then
        continue;
      end if;

      if v_segment.provenance_name = 'verified' then
        v_forward_from_type := 'operator_bag'::public.inventory_entity_type;
        v_forward_from_id := v_route.operator_id;
      else
        v_forward_from_type := 'adjustment'::public.inventory_entity_type;
        v_forward_from_id := null;
      end if;

      if v_segment.endpoint_name = 'machine' then
        v_forward_to_type := 'machine'::public.inventory_entity_type;
      else
        v_forward_to_type := 'machine_storage'::public.inventory_entity_type;
      end if;
      v_forward_to_id := p_machine_id;

      if v_delta > 0 then
        v_from_type := v_forward_from_type;
        v_from_id := v_forward_from_id;
        v_to_type := v_forward_to_type;
        v_to_id := v_forward_to_id;
        v_reversed_movement_id := null;
        if v_segment.provenance_name = 'verified' and v_segment.endpoint_name = 'machine' then
          v_reason := 'operator_bag_to_machine'::public.movement_reason;
        elsif v_segment.provenance_name = 'verified' and v_segment.endpoint_name = 'machine_storage' then
          v_reason := 'extra_stock_left_at_machine'::public.movement_reason;
        else
          v_reason := 'manual_correction'::public.movement_reason;
        end if;
      else
        v_from_type := v_forward_to_type;
        v_from_id := v_forward_to_id;
        v_to_type := v_forward_from_type;
        v_to_id := v_forward_from_id;
        v_reason := 'manual_correction'::public.movement_reason;
        v_reversed_movement_id := null;

        -- Link an exact reversal when the prior posting was made by this RPC.
        -- Aggregate legacy corrections remain auditable through the stable
        -- source/idempotency metadata even when no one-to-one row exists.
        select im.id
        into v_reversed_movement_id
        from public.inventory_movements im
        where im.related_route_id = p_route_id
          and im.related_route_stop_id = p_route_stop_id
          and im.related_machine_id = p_machine_id
          and im.product_id = v_product_id
          and im.source_type = 'route_stop_inventory_v1'
          and im.quantity = abs(v_delta)
          and im.from_entity_type = v_forward_from_type
          and im.from_entity_id is not distinct from v_forward_from_id
          and im.to_entity_type = v_forward_to_type
          and im.to_entity_id is not distinct from v_forward_to_id
          and not exists (
            select 1
            from public.inventory_movements reversal
            where reversal.reversed_movement_id = im.id
          )
        order by im.created_at desc, im.id desc
        limit 1
        for update;
      end if;

      v_movement_type := format(
        'route_stop_%s_%s%s',
        v_segment.endpoint_name,
        v_segment.provenance_name,
        case when v_delta < 0 then '_reversal' else '' end
      );
      v_idempotency_key := format(
        'route-stop-inventory:v1:%s:%s:%s:%s:%s:g%s:%s:%s:%s',
        p_route_stop_id,
        v_product_id,
        v_segment.endpoint_name,
        v_segment.provenance_name,
        case when v_delta > 0 then 'post' else 'reverse' end,
        v_generation,
        v_segment.current_quantity,
        v_segment.target_quantity,
        md5(v_submission_id)
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
        created_by,
        notes,
        reversed_movement_id,
        correction_reason,
        source_type,
        source_id,
        idempotency_key,
        movement_type
      )
      values (
        v_product_id,
        abs(v_delta),
        v_from_type,
        v_from_id,
        v_to_type,
        v_to_id,
        v_reason,
        p_route_id,
        p_route_stop_id,
        p_machine_id,
        v_actor_team_member_id,
        format(
          'Atomic route-stop inventory reconciliation: %s %s (%s to %s).',
          v_segment.endpoint_name,
          v_segment.provenance_name,
          v_segment.current_quantity,
          v_segment.target_quantity
        ),
        v_reversed_movement_id,
        case when v_delta < 0 then 'Route stop quantity edited; appended exact ledger reversal.' else null end,
        'route_stop_inventory_v1',
        p_route_stop_id,
        v_idempotency_key,
        v_movement_type
      )
      on conflict (idempotency_key) where idempotency_key is not null
      do nothing
      returning id into v_movement_id;

      if v_movement_id is not null then
        v_movement_ids := v_movement_ids || jsonb_build_array(v_movement_id);
        v_product_movement_ids := v_product_movement_ids || jsonb_build_array(v_movement_id);
      end if;
      v_movement_id := null;
    end loop;

    -- The database has an older trigger that suppresses duplicate movement
    -- keys.  Re-read the endpoint state so an unexpected key collision cannot
    -- make the RPC report success without applying the requested transition.
    select
      coalesce(sum(case
        when im.from_entity_type::text = 'operator_bag' and im.to_entity_type::text = 'machine' then im.quantity
        when im.from_entity_type::text = 'machine' and im.to_entity_type::text = 'operator_bag' then -im.quantity
        else 0
      end), 0)::integer,
      coalesce(sum(case
        when im.from_entity_type::text = 'adjustment' and im.to_entity_type::text = 'machine' then im.quantity
        when im.from_entity_type::text = 'machine' and im.to_entity_type::text = 'adjustment' then -im.quantity
        else 0
      end), 0)::integer,
      coalesce(sum(case
        when im.from_entity_type::text = 'operator_bag' and im.to_entity_type::text = 'machine_storage' then im.quantity
        when im.from_entity_type::text = 'machine_storage' and im.to_entity_type::text = 'operator_bag' then -im.quantity
        else 0
      end), 0)::integer,
      coalesce(sum(case
        when im.from_entity_type::text = 'adjustment' and im.to_entity_type::text = 'machine_storage' then im.quantity
        when im.from_entity_type::text = 'machine_storage' and im.to_entity_type::text = 'adjustment' then -im.quantity
        else 0
      end), 0)::integer
    into
      v_current_verified_fill,
      v_current_short_fill,
      v_current_verified_machine_storage,
      v_current_short_machine_storage
    from public.inventory_movements im
    where im.related_route_id = p_route_id
      and im.related_route_stop_id = p_route_stop_id
      and im.product_id = v_product_id
      and coalesce(im.related_machine_id, p_machine_id) = p_machine_id
      and im.source_type in ('route_stop_completion', 'route_stop_inventory_v1');

    if v_current_verified_fill <> v_target_verified_fill
      or v_current_short_fill <> v_target_short_fill
      or v_current_verified_machine_storage <> v_target_verified_machine_storage
      or v_current_short_machine_storage <> v_target_short_machine_storage
    then
      raise exception 'Stop inventory idempotency conflict for product %. No partial stop inventory was saved.', v_product_id
        using errcode = '23505';
    end if;

    select coalesce(sum(
      case
        when im.to_entity_type::text = 'operator_bag'
          and im.to_entity_id = v_route.operator_id
          then im.quantity::bigint
        else 0::bigint
      end
      + case
        when im.from_entity_type::text = 'operator_bag'
          and im.from_entity_id = v_route.operator_id
          then -im.quantity::bigint
        else 0::bigint
      end
    ), 0)::bigint
    into v_operator_bag_after
    from public.inventory_movements im
    where im.product_id = v_product_id;

    select coalesce(max(balances.signed_quantity), 0)::bigint
    into v_route_bag_after
    from public._snacky_route_bag_balances(p_route_id) balances
    where balances.bag_owner_id = v_route.operator_id
      and balances.product_id = v_product_id;

    if v_operator_bag_after < least(v_operator_bag_before, 0)
      or v_route_bag_after < least(v_route_bag_before, 0)
    then
      raise exception 'Stop inventory reconciliation would worsen a negative recorded operator bag balance for product %.', v_product_id
        using errcode = '23514';
    end if;

    v_discrepancy_key := format(
      'route-stop-inventory:stop-shortage:%s:%s',
      p_route_stop_id,
      v_product_id
    );

    if v_target_short_total > 0 then
      select im.id
      into v_shortage_movement_id
      from public.inventory_movements im
      where im.related_route_id = p_route_id
        and im.related_route_stop_id = p_route_stop_id
        and im.related_machine_id = p_machine_id
        and im.product_id = v_product_id
        and im.source_type = 'route_stop_inventory_v1'
        and im.from_entity_type::text = 'adjustment'
        and im.to_entity_type::text in ('machine', 'machine_storage')
        and not exists (
          select 1
          from public.inventory_movements reversal
          where reversal.reversed_movement_id = im.id
        )
      order by im.created_at desc, im.id desc
      limit 1;

      insert into public.route_inventory_discrepancies as current_case (
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
        detected_by_team_member_id,
        detected_at,
        correcting_movement_id,
        created_at,
        updated_at
      )
      values (
        p_route_id,
        p_route_stop_id,
        p_machine_id,
        v_route.operator_id,
        v_product_id,
        'stop_shortage',
        v_desired_total - v_target_short_total,
        v_desired_total,
        v_target_short_total,
        v_target_short_total,
        'open',
        'route_stop_inventory_commit',
        p_route_stop_id,
        v_discrepancy_key,
        jsonb_build_object(
          'contract_version', 1,
          'submission_id', v_submission_id,
          'planned_quantity', v_planned_quantity,
          'picked_quantity', v_picked_quantity,
          'requested_fill_quantity', v_desired_fill,
          'verified_fill_quantity', v_target_verified_fill,
          'shortage_fill_quantity', v_target_short_fill,
          'requested_machine_storage_quantity', v_desired_machine_storage,
          'verified_machine_storage_quantity', v_target_verified_machine_storage,
          'shortage_machine_storage_quantity', v_target_short_machine_storage,
          'operator_bag_before', v_operator_bag_before,
          'operator_bag_after', v_operator_bag_after,
          'route_bag_before', v_route_bag_before,
          'route_bag_after', v_route_bag_after,
          'movement_ids', v_product_movement_ids
        ),
        v_actor_user_id,
        v_actor_team_member_id,
        now(),
        v_shortage_movement_id,
        now(),
        now()
      )
      on conflict (idempotency_key)
      do update set
        route_id = excluded.route_id,
        route_stop_id = excluded.route_stop_id,
        machine_id = excluded.machine_id,
        operator_id = excluded.operator_id,
        recorded_quantity = excluded.recorded_quantity,
        actual_quantity = excluded.actual_quantity,
        difference_quantity = excluded.difference_quantity,
        absolute_quantity = excluded.absolute_quantity,
        status = case
          when current_case.recorded_quantity = excluded.recorded_quantity
            and current_case.actual_quantity = excluded.actual_quantity
            and current_case.details ->> 'submission_id' = v_submission_id
            then current_case.status
          else 'open'
        end,
        details = excluded.details,
        resolution_type = case
          when current_case.recorded_quantity = excluded.recorded_quantity
            and current_case.actual_quantity = excluded.actual_quantity
            and current_case.details ->> 'submission_id' = v_submission_id
            then current_case.resolution_type
          else null
        end,
        resolution_notes = case
          when current_case.recorded_quantity = excluded.recorded_quantity
            and current_case.actual_quantity = excluded.actual_quantity
            and current_case.details ->> 'submission_id' = v_submission_id
            then current_case.resolution_notes
          else null
        end,
        resolved_by_user_id = case
          when current_case.recorded_quantity = excluded.recorded_quantity
            and current_case.actual_quantity = excluded.actual_quantity
            and current_case.details ->> 'submission_id' = v_submission_id
            then current_case.resolved_by_user_id
          else null
        end,
        resolved_by_team_member_id = case
          when current_case.recorded_quantity = excluded.recorded_quantity
            and current_case.actual_quantity = excluded.actual_quantity
            and current_case.details ->> 'submission_id' = v_submission_id
            then current_case.resolved_by_team_member_id
          else null
        end,
        resolved_at = case
          when current_case.recorded_quantity = excluded.recorded_quantity
            and current_case.actual_quantity = excluded.actual_quantity
            and current_case.details ->> 'submission_id' = v_submission_id
            then current_case.resolved_at
          else null
        end,
        correcting_movement_id = excluded.correcting_movement_id,
        updated_at = now()
      returning status into v_discrepancy_status;

      if v_discrepancy_status in ('open', 'investigating') then
        v_needs_review := true;
        v_discrepancy_count := v_discrepancy_count + 1;
      end if;
    else
      update public.route_inventory_discrepancies rid
      set
        recorded_quantity = v_desired_total,
        actual_quantity = v_desired_total,
        difference_quantity = 0,
        absolute_quantity = 0,
        status = 'resolved',
        details = coalesce(rid.details, '{}'::jsonb) || jsonb_build_object(
          'contract_version', 1,
          'resolved_submission_id', v_submission_id,
          'requested_fill_quantity', v_desired_fill,
          'verified_fill_quantity', v_target_verified_fill,
          'requested_machine_storage_quantity', v_desired_machine_storage,
          'verified_machine_storage_quantity', v_target_verified_machine_storage,
          'operator_bag_after', v_operator_bag_after,
          'route_bag_after', v_route_bag_after,
          'resolution_movement_ids', v_product_movement_ids
        ),
        resolution_type = 'quantity_reconciled',
        resolution_notes = 'Resolved automatically by an authoritative route-stop inventory edit.',
        resolved_by_user_id = v_actor_user_id,
        resolved_by_team_member_id = v_actor_team_member_id,
        resolved_at = now(),
        correcting_movement_id = null,
        updated_at = now()
      where rid.idempotency_key = v_discrepancy_key
        and rid.status <> 'voided';
    end if;

    v_product_summaries := v_product_summaries || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id,
      'planned_quantity', v_planned_quantity,
      'picked_quantity', v_picked_quantity,
      'requested_fill_quantity', v_desired_fill,
      'verified_fill_quantity', v_target_verified_fill,
      'shortage_fill_quantity', v_target_short_fill,
      'requested_machine_storage_quantity', v_desired_machine_storage,
      'verified_machine_storage_quantity', v_target_verified_machine_storage,
      'shortage_machine_storage_quantity', v_target_short_machine_storage,
      'operator_bag_before', v_operator_bag_before,
      'operator_bag_after', v_operator_bag_after,
      'route_bag_before', v_route_bag_before,
      'route_bag_after', v_route_bag_after,
      'needs_review', v_target_short_total > 0,
      'movement_ids', v_product_movement_ids
    ));
  end loop;

  -- The payload is the complete desired state for this stop.  Replace the
  -- audit rows only after every ledger movement and discrepancy has succeeded.
  delete from public.route_stop_fill_lines rfl
  where rfl.route_stop_id = p_route_stop_id;

  for v_line in
    select value
    from jsonb_array_elements(v_fill_lines)
  loop
    v_action_type := lower(nullif(btrim(coalesce(v_line ->> 'action_type', '')), ''));
    if v_action_type = 'missing_product_report' then
      insert into public.route_stop_fill_lines (
        route_id,
        route_stop_id,
        machine_id,
        refill_order_line_id,
        assigned_product_id,
        product_id,
        substitute_product_id,
        action_type,
        assigned_qty,
        actual_qty,
        difference_qty,
        reason,
        notes,
        missing_product_name,
        needs_review,
        created_by,
        created_at
      ) values (
        p_route_id,
        p_route_stop_id,
        p_machine_id,
        null,
        null,
        null,
        null,
        'missing_product_report',
        0,
        0,
        0,
        nullif(left(btrim(coalesce(v_line ->> 'reason', 'Other')), 500), ''),
        nullif(left(btrim(coalesce(v_line ->> 'notes', '')), 2000), ''),
        left(btrim(v_line ->> 'missing_product_name'), 200),
        true,
        v_actor_team_member_id,
        now()
      );
      v_needs_review := true;
      continue;
    end if;

    v_product_id := (v_line ->> 'product_id')::uuid;
    v_quantity := coalesce(v_line ->> 'actual_qty', v_line ->> 'quantity')::integer;
    v_refill_line_text := nullif(btrim(coalesce(v_line ->> 'refill_order_line_id', '')), '');
    v_refill_order_line_id := case when v_refill_line_text is null then null else v_refill_line_text::uuid end;
    v_unavailable := coalesce((v_line ->> 'unavailable')::boolean, false);

    select coalesce(sum(greatest(coalesce(rsi.planned_quantity, 0), 0)), 0)::integer
    into v_assigned_quantity
    from public.route_stop_items rsi
    where rsi.route_id = p_route_id
      and rsi.route_stop_id = p_route_stop_id
      and rsi.machine_id = p_machine_id
      and rsi.product_id = v_product_id;

    insert into public.route_stop_fill_lines (
      route_id,
      route_stop_id,
      machine_id,
      refill_order_line_id,
      assigned_product_id,
      product_id,
      substitute_product_id,
      action_type,
      assigned_qty,
      actual_qty,
      difference_qty,
      reason,
      notes,
      missing_product_name,
      needs_review,
      created_by,
      created_at
    ) values (
      p_route_id,
      p_route_stop_id,
      p_machine_id,
      v_refill_order_line_id,
      v_product_id,
      v_product_id,
      null,
      'assigned_fill',
      v_assigned_quantity,
      v_quantity,
      v_quantity - v_assigned_quantity,
      nullif(btrim(coalesce(v_line ->> 'reason', case when v_unavailable then 'Product not in operator bag' else '' end)), ''),
      nullif(left(btrim(coalesce(v_line ->> 'notes', '')), 2000), ''),
      null,
      v_unavailable
        or v_quantity <> v_assigned_quantity
        or coalesce((v_short_fill_totals ->> v_product_id::text)::integer, 0) > 0,
      v_actor_team_member_id,
      now()
    );

    if v_unavailable or v_quantity <> v_assigned_quantity then
      v_needs_review := true;
    end if;
  end loop;

  for v_line in
    select value
    from jsonb_array_elements(v_machine_storage_lines)
  loop
    v_product_id := (v_line ->> 'product_id')::uuid;
    v_quantity := coalesce(v_line ->> 'actual_qty', v_line ->> 'quantity')::integer;

    insert into public.route_stop_fill_lines (
      route_id,
      route_stop_id,
      machine_id,
      refill_order_line_id,
      assigned_product_id,
      product_id,
      substitute_product_id,
      action_type,
      assigned_qty,
      actual_qty,
      difference_qty,
      reason,
      notes,
      missing_product_name,
      needs_review,
      created_by,
      created_at
    ) values (
      p_route_id,
      p_route_stop_id,
      p_machine_id,
      null,
      null,
      v_product_id,
      null,
      'extra_product',
      0,
      v_quantity,
      v_quantity,
      nullif(left(btrim(coalesce(v_line ->> 'reason', 'Extra stock left at machine')), 500), ''),
      nullif(left(btrim(coalesce(v_line ->> 'notes', '')), 2000), ''),
      null,
      true,
      v_actor_team_member_id,
      now()
    );
    v_needs_review := true;
  end loop;

  -- Replace authoritative filled quantities without mutating the plan/pick.
  update public.route_stop_items rsi
  set filled_quantity = 0,
      updated_at = now()
  where rsi.route_id = p_route_id
    and rsi.route_stop_id = p_route_stop_id
    and rsi.machine_id = p_machine_id;

  foreach v_product_id in array v_product_ids
  loop
    v_desired_fill := coalesce((v_fill_totals ->> v_product_id::text)::integer, 0);
    if v_desired_fill <= 0 then
      continue;
    end if;

    with ranked as (
      select
        rsi.id,
        greatest(coalesce(rsi.picked_quantity, rsi.planned_quantity, 0), 0)::integer as capacity,
        coalesce(sum(greatest(coalesce(rsi.picked_quantity, rsi.planned_quantity, 0), 0)) over (
          order by rsi.id
          rows between unbounded preceding and 1 preceding
        ), 0)::integer as prior_capacity,
        row_number() over (order by rsi.id desc) as reverse_rank
      from public.route_stop_items rsi
      where rsi.route_id = p_route_id
        and rsi.route_stop_id = p_route_stop_id
        and rsi.machine_id = p_machine_id
        and rsi.product_id = v_product_id
    ), allocations as (
      select
        ranked.id,
        case
          when ranked.reverse_rank = 1 then greatest(v_desired_fill - ranked.prior_capacity, 0)
          else least(ranked.capacity, greatest(v_desired_fill - ranked.prior_capacity, 0))
        end::integer as allocated_quantity
      from ranked
    )
    update public.route_stop_items rsi
    set filled_quantity = allocations.allocated_quantity,
        updated_at = now()
    from allocations
    where rsi.id = allocations.id;
  end loop;

  -- Refill-order lines are a compatibility projection.  Keep their quantities
  -- synchronized, but do not complete the refill order or route stop here.
  update public.refill_order_lines rol
  set filled_qty = 0,
      shortage_qty = greatest(coalesce(rol.picked_qty, rol.final_qty_to_take, rol.suggested_qty, 0), 0)
  from public.refill_orders ro
  where ro.id = rol.refill_order_id
    and ro.route_id = p_route_id
    and ro.machine_id = p_machine_id;

  foreach v_product_id in array v_product_ids
  loop
    v_desired_fill := coalesce((v_fill_totals ->> v_product_id::text)::integer, 0);
    if v_desired_fill <= 0 then
      continue;
    end if;

    with ranked as (
      select
        rol.id,
        greatest(coalesce(rol.picked_qty, rol.final_qty_to_take, rol.suggested_qty, 0), 0)::integer as capacity,
        coalesce(sum(greatest(coalesce(rol.picked_qty, rol.final_qty_to_take, rol.suggested_qty, 0), 0)) over (
          order by rol.id
          rows between unbounded preceding and 1 preceding
        ), 0)::integer as prior_capacity,
        row_number() over (order by rol.id desc) as reverse_rank
      from public.refill_order_lines rol
      join public.refill_orders ro on ro.id = rol.refill_order_id
      where ro.route_id = p_route_id
        and ro.machine_id = p_machine_id
        and rol.product_id = v_product_id
    ), allocations as (
      select
        ranked.id,
        ranked.capacity,
        case
          when ranked.reverse_rank = 1 then greatest(v_desired_fill - ranked.prior_capacity, 0)
          else least(ranked.capacity, greatest(v_desired_fill - ranked.prior_capacity, 0))
        end::integer as allocated_quantity
      from ranked
    )
    update public.refill_order_lines rol
    set filled_qty = allocations.allocated_quantity,
        shortage_qty = greatest(allocations.capacity - allocations.allocated_quantity, 0)
    from allocations
    where rol.id = allocations.id;
  end loop;

  insert into public.route_stop_inventory_commits as current_receipt (
    route_id,
    route_stop_id,
    machine_id,
    operator_id,
    latest_submission_id,
    payload_hash,
    inventory_needs_review,
    movement_count,
    result_payload,
    committed_at,
    workflow_completed_at,
    created_at,
    updated_at
  ) values (
    p_route_id,
    p_route_stop_id,
    p_machine_id,
    v_route.operator_id,
    v_submission_id,
    v_payload_hash,
    v_needs_review,
    pg_catalog.jsonb_array_length(v_movement_ids),
    null,
    pg_catalog.now(),
    null,
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (route_stop_id)
  do update set
    route_id = excluded.route_id,
    machine_id = excluded.machine_id,
    operator_id = excluded.operator_id,
    latest_submission_id = excluded.latest_submission_id,
    payload_hash = excluded.payload_hash,
    inventory_needs_review = excluded.inventory_needs_review,
    movement_count = case
      when current_receipt.latest_submission_id = excluded.latest_submission_id
        and current_receipt.payload_hash = excluded.payload_hash
        then current_receipt.movement_count
      else excluded.movement_count
    end,
    result_payload = current_receipt.result_payload,
    committed_at = case
      when current_receipt.latest_submission_id = excluded.latest_submission_id
        and current_receipt.payload_hash = excluded.payload_hash
        then current_receipt.committed_at
      else excluded.committed_at
    end,
    workflow_completed_at = case
      when current_receipt.latest_submission_id = excluded.latest_submission_id
        and current_receipt.payload_hash = excluded.payload_hash
        then current_receipt.workflow_completed_at
      else null
    end,
    updated_at = pg_catalog.now()
  returning id, committed_at, movement_count
  into v_commit_receipt_id, v_inventory_committed_at, v_receipt_movement_count;

  v_result_payload := jsonb_build_object(
    'contract_version', 1,
    'route_id', p_route_id,
    'route_stop_id', p_route_stop_id,
    'machine_id', p_machine_id,
    'operator_id', v_route.operator_id,
    'submission_id', v_submission_id,
    'commit_receipt_id', v_commit_receipt_id,
    'payload_hash', v_payload_hash,
    'inventory_committed_at', v_inventory_committed_at,
    'stop_status', v_stop.status::text,
    'inventory_committed', true,
    'stop_completed', false,
    'needs_review', v_needs_review,
    'open_shortage_count', v_discrepancy_count,
    'movement_count', v_receipt_movement_count,
    'movement_ids', v_movement_ids,
    'products', v_product_summaries
  );

  update public.route_stop_inventory_commits receipt
  set result_payload = v_result_payload,
      updated_at = pg_catalog.now()
  where receipt.id = v_commit_receipt_id
    and receipt.result_payload is null;

  return v_result_payload;
end;
$function$;

comment on function public.snacky_commit_route_stop_inventory_v1(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb)
is 'Server-only, route-serialized, idempotent stop inventory reconciliation. It validates the explicit authenticated actor linkage and route authorization, records actual physical destinations without allowing the operator bag to become negative, and does not complete the stop.';

revoke all on function public.snacky_commit_route_stop_inventory_v1(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.snacky_commit_route_stop_inventory_v1(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb)
  to service_role;

select pg_notify('pgrst', 'reload schema');
