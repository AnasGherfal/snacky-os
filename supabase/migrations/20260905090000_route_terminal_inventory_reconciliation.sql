-- Route terminal inventory integrity.
--
-- This migration deliberately performs no historical inventory data backfill.
-- Existing terminal routes are left unchanged; an upgrade-only request-hash
-- marker is the sole metadata backfill. New terminal transitions must go
-- through snacky_finalize_route_inventory so physical counts, ledger
-- corrections, and returns are committed in one transaction.

create table if not exists public.route_inventory_reconciliations (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete restrict,
  action text not null,
  client_submission_id text not null,
  payload_hash text not null,
  operator_id uuid references public.team_members(id) on delete set null,
  storage_location_id uuid references public.storage_locations(id) on delete restrict,
  route_status_before public.route_status not null,
  route_status_after public.route_status not null,
  status text not null default 'balanced',
  reason text,
  discrepancy_units integer not null default 0,
  returned_units integer not null default 0,
  details jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_by_team_member_id uuid references public.team_members(id) on delete set null,
  finalized_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_inventory_reconciliations_action_check
    check (action in ('complete', 'cancel')),
  constraint route_inventory_reconciliations_submission_check
    check (btrim(client_submission_id) <> ''),
  constraint route_inventory_reconciliations_payload_hash_check
    check (payload_hash ~ '^[0-9a-f]{32}$'),
  constraint route_inventory_reconciliations_status_check
    check (status in ('balanced', 'needs_review', 'resolved')),
  constraint route_inventory_reconciliations_discrepancy_nonnegative
    check (discrepancy_units >= 0),
  constraint route_inventory_reconciliations_returned_nonnegative
    check (returned_units >= 0),
  constraint route_inventory_reconciliations_details_object
    check (jsonb_typeof(details) = 'object'),
  constraint route_inventory_reconciliations_cancel_reason
    check (action <> 'cancel' or nullif(btrim(reason), '') is not null),
  constraint route_inventory_reconciliations_route_key unique (route_id),
  constraint route_inventory_reconciliations_submission_key unique (client_submission_id),
  constraint route_inventory_reconciliations_id_route_key unique (id, route_id)
);

-- CREATE TABLE IF NOT EXISTS does not upgrade a table created by an earlier
-- rehearsal. Backfill those rows with an intentionally non-replayable legacy
-- marker: the pre-finalization ledger token cannot be reconstructed safely, so
-- an old row must never impersonate a newly canonicalized request.
alter table public.route_inventory_reconciliations
  add column if not exists payload_hash text;

update public.route_inventory_reconciliations reconciliation
set payload_hash = pg_catalog.md5(
  'legacy-route-terminal-reconciliation:'
  || reconciliation.id::text
  || ':'
  || reconciliation.client_submission_id
)
where reconciliation.payload_hash is null
   or reconciliation.payload_hash !~ '^[0-9a-f]{32}$';

alter table public.route_inventory_reconciliations
  alter column payload_hash set not null;

do $route_terminal_payload_hash$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_inventory_reconciliations'::pg_catalog.regclass
      and constraint_row.conname = 'route_inventory_reconciliations_payload_hash_check'
  ) then
    alter table public.route_inventory_reconciliations
      add constraint route_inventory_reconciliations_payload_hash_check
      check (payload_hash ~ '^[0-9a-f]{32}$');
  end if;
end;
$route_terminal_payload_hash$;

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

create table if not exists public.route_inventory_reconciliation_lines (
  id uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null,
  route_id uuid not null,
  bag_owner_id uuid not null references public.team_members(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  ledger_quantity integer not null,
  counted_quantity integer not null,
  variance_quantity integer not null,
  variance_type text not null,
  returned_quantity integer not null default 0,
  discrepancy_reason text,
  review_status text not null default 'balanced',
  discrepancy_id uuid references public.route_inventory_discrepancies(id) on delete set null,
  adjustment_movement_id uuid references public.inventory_movements(id) on delete set null,
  return_movement_id uuid references public.inventory_movements(id) on delete set null,
  resolved_by_user_id uuid references auth.users(id) on delete set null,
  resolved_by_team_member_id uuid references public.team_members(id) on delete set null,
  resolution_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_inventory_reconciliation_lines_parent_fkey
    foreign key (reconciliation_id, route_id)
    references public.route_inventory_reconciliations(id, route_id)
    on delete cascade,
  constraint route_inventory_reconciliation_lines_counted_nonnegative
    check (counted_quantity >= 0),
  constraint route_inventory_reconciliation_lines_variance_matches
    check (variance_quantity = counted_quantity - ledger_quantity),
  constraint route_inventory_reconciliation_lines_variance_type_check
    check (variance_type in ('balanced', 'shortage', 'overage', 'negative_ledger')),
  constraint route_inventory_reconciliation_lines_returned_nonnegative
    check (returned_quantity >= 0),
  constraint route_inventory_reconciliation_lines_review_status_check
    check (review_status in ('balanced', 'open', 'investigating', 'resolved', 'accepted_loss', 'voided')),
  constraint route_inventory_reconciliation_lines_variance_review_check
    check (
      (variance_quantity = 0 and variance_type = 'balanced' and review_status = 'balanced')
      or
      (variance_quantity <> 0 and variance_type <> 'balanced' and review_status <> 'balanced')
    ),
  constraint route_inventory_reconciliation_lines_owner_product_key
    unique (reconciliation_id, bag_owner_id, product_id),
  constraint route_inventory_reconciliation_lines_discrepancy_key
    unique (discrepancy_id)
);

-- Declared in the terminal migration as well as the stop-commit migration so
-- route cancellation/reassignment guards are active before the stop writer is
-- installed. The stop RPC owns the receipt contents.
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

create index if not exists idx_route_inventory_reconciliations_status_time
  on public.route_inventory_reconciliations(status, finalized_at desc);

create index if not exists idx_route_inventory_discrepancies_route_status
  on public.route_inventory_discrepancies(route_id, status, detected_at desc);

create index if not exists idx_route_inventory_discrepancies_operator_status
  on public.route_inventory_discrepancies(operator_id, status, detected_at desc)
  where operator_id is not null;

create index if not exists idx_route_inventory_discrepancies_source
  on public.route_inventory_discrepancies(source_type, source_id);

create index if not exists idx_route_inventory_reconciliation_lines_route
  on public.route_inventory_reconciliation_lines(route_id, product_id);

create index if not exists idx_route_stop_inventory_commits_route
  on public.route_stop_inventory_commits(route_id, committed_at desc);

alter table public.route_inventory_reconciliations enable row level security;
alter table public.route_inventory_discrepancies enable row level security;
alter table public.route_inventory_reconciliation_lines enable row level security;
alter table public.route_stop_inventory_commits enable row level security;

revoke all on table public.route_inventory_reconciliations from public, anon, authenticated;
revoke all on table public.route_inventory_discrepancies from public, anon, authenticated;
revoke all on table public.route_inventory_reconciliation_lines from public, anon, authenticated;
revoke all on table public.route_stop_inventory_commits from public, anon, authenticated;

grant select on table public.route_inventory_reconciliations to authenticated;
grant select on table public.route_inventory_discrepancies to authenticated;
grant select on table public.route_inventory_reconciliation_lines to authenticated;

grant all on table public.route_inventory_reconciliations to service_role;
grant all on table public.route_inventory_discrepancies to service_role;
grant all on table public.route_inventory_reconciliation_lines to service_role;
grant all on table public.route_stop_inventory_commits to service_role;

drop policy if exists "snacky_route_inventory_reconciliations_select" on public.route_inventory_reconciliations;
create policy "snacky_route_inventory_reconciliations_select"
on public.route_inventory_reconciliations
for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
);

drop policy if exists "snacky_route_inventory_discrepancies_select" on public.route_inventory_discrepancies;
create policy "snacky_route_inventory_discrepancies_select"
on public.route_inventory_discrepancies
for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
);

drop policy if exists "snacky_route_inventory_reconciliation_lines_select" on public.route_inventory_reconciliation_lines;
create policy "snacky_route_inventory_reconciliation_lines_select"
on public.route_inventory_reconciliation_lines
for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
  or public.snacky_operator_can_access_route(route_id)
);

-- Preserve every route-scoped bag owner/product key, including a net-zero key.
-- Terminal physical counts must explicitly confirm these historical keys instead
-- of making a zero ledger balance indistinguishable from no custody history.
create or replace function public._snacky_route_bag_history_balances(p_route_id uuid)
returns table (
  bag_owner_id uuid,
  product_id uuid,
  signed_quantity bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with bag_legs as (
    select
      im.to_entity_id as bag_owner_id,
      im.product_id,
      im.quantity::bigint as quantity_delta
    from public.inventory_movements im
    where im.related_route_id = p_route_id
      and im.to_entity_type::text = 'operator_bag'

    union all

    select
      im.from_entity_id as bag_owner_id,
      im.product_id,
      -im.quantity::bigint as quantity_delta
    from public.inventory_movements im
    where im.related_route_id = p_route_id
      and im.from_entity_type::text = 'operator_bag'
  )
  select
    bl.bag_owner_id,
    bl.product_id,
    sum(bl.quantity_delta)::bigint as signed_quantity
  from bag_legs bl
  group by bl.bag_owner_id, bl.product_id
  order by bl.bag_owner_id nulls first, bl.product_id;
$$;

revoke all on function public._snacky_route_bag_history_balances(uuid) from public, anon, authenticated;

-- This private helper remains the single source of truth for outstanding
-- route-scoped operator custody. It deliberately uses movement endpoints rather
-- than movement reasons or denormalized route_stock_lines counters.
create or replace function public._snacky_route_bag_balances(p_route_id uuid)
returns table (
  bag_owner_id uuid,
  product_id uuid,
  signed_quantity bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select history.bag_owner_id, history.product_id, history.signed_quantity
  from public._snacky_route_bag_history_balances(p_route_id) history
  where history.signed_quantity <> 0
  order by history.bag_owner_id nulls first, history.product_id;
$$;

revoke all on function public._snacky_route_bag_balances(uuid) from public, anon, authenticated;

-- A stable version for the physical-count screen. It represents the route
-- operator and every historical canonical bag key, so a count loaded before
-- another stop/sale/adjustment cannot be submitted as if it were current.
create or replace function public._snacky_route_bag_ledger_token(p_route_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.md5(
    'operator:' || coalesce((
      select r.operator_id::text
      from public.routes r
      where r.id = p_route_id
    ), '')
    || '|balances:' || coalesce((
      select pg_catalog.string_agg(
        coalesce(b.bag_owner_id::text, '') || ':' || b.product_id::text || ':' || b.signed_quantity::text,
        '|' order by b.bag_owner_id nulls first, b.product_id
      )
      from public._snacky_route_bag_history_balances(p_route_id) b
    ), '')
  );
$$;

revoke all on function public._snacky_route_bag_ledger_token(uuid) from public, anon, authenticated;

-- Authenticated, route-scoped read helper for the operator UI. Aggregation is
-- performed entirely in Postgres, so callers do not need a raw-row LIMIT.
create or replace function public.snacky_route_bag_balances(p_route_id uuid)
returns table (bag_owner_id uuid,
  product_id uuid,
  signed_quantity bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view route bag inventory.' using errcode = '42501';
  end if;

  if p_route_id is null then
    raise exception 'Route id is required.' using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'You do not have permission to view this route inventory.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.routes r where r.id = p_route_id) then
    raise exception 'Route was not found.' using errcode = 'P0001';
  end if;

  return query
  select b.bag_owner_id, b.product_id, b.signed_quantity
  from public._snacky_route_bag_balances(p_route_id) b;
end;
$$;

revoke all on function public.snacky_route_bag_balances(uuid) from public, anon;
grant execute on function public.snacky_route_bag_balances(uuid) to authenticated;

-- Return balances and their concurrency token in one database snapshot. The
-- client must send ledger_token back to the terminal reconciliation RPC.
create or replace function public.snacky_route_bag_snapshot(p_route_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_snapshot jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view route bag inventory.' using errcode = '42501';
  end if;

  if p_route_id is null then
    raise exception 'Route id is required.' using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'You do not have permission to view this route inventory.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.routes r where r.id = p_route_id) then
    raise exception 'Route was not found.' using errcode = 'P0001';
  end if;

  select pg_catalog.jsonb_build_object(
    'ledger_token', public._snacky_route_bag_ledger_token(p_route_id),
    'balances', coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'bag_owner_id', b.bag_owner_id,
          'product_id', b.product_id,
          'signed_quantity', b.signed_quantity
        ) order by b.bag_owner_id nulls first, b.product_id
      ),
      '[]'::jsonb
    )
  )
  into v_snapshot
  from public._snacky_route_bag_history_balances(p_route_id) b;

  return v_snapshot;
end;
$$;

revoke all on function public.snacky_route_bag_snapshot(uuid) from public, anon;
grant execute on function public.snacky_route_bag_snapshot(uuid) to authenticated;

-- RLS intentionally keeps the raw product and storage tables narrow. Expose
-- only the safe fields needed by the physical-count UI after checking that the
-- caller may access this route.
create or replace function public.snacky_route_inventory_count_options(p_route_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_options jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to view route inventory options.' using errcode = '42501';
  end if;

  if p_route_id is null then
    raise exception 'Route id is required.' using errcode = 'P0001';
  end if;

  if not (
    public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse'])
    or public.snacky_operator_can_access_route(p_route_id)
  ) then
    raise exception 'You do not have permission to view this route inventory.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.routes r where r.id = p_route_id) then
    raise exception 'Route was not found.' using errcode = 'P0001';
  end if;

  select pg_catalog.jsonb_build_object(
    'active_product_options', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', product_row.id,
          'name', product_row.name,
          'sku', product_row.sku
        ) order by product_row.name, product_row.id
      )
      from public.products product_row
      where product_row.active = true
    ), '[]'::jsonb),
    'return_storage_options', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', storage_row.id,
          'name', storage_row.name,
          'location_type', storage_row.location_type
        ) order by storage_row.name, storage_row.id
      )
      from public.storage_locations storage_row
      where storage_row.active = true
        and storage_row.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
    ), '[]'::jsonb)
  ) into v_options;

  return v_options;
end;
$$;

revoke all on function public.snacky_route_inventory_count_options(uuid) from public, anon;
grant execute on function public.snacky_route_inventory_count_options(uuid) to authenticated;

-- Keep the legacy route_stock_lines cache derived from endpoint arithmetic.
-- The ledger remains authoritative; this function exists only for old screens.
create or replace function public._snacky_sync_route_stock_lines(p_route_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stock_line record;
begin
  for v_stock_line in
    with movement_totals as (
      select
        im.product_id,
        coalesce(sum(im.quantity) filter (
          where im.from_entity_type::text = 'storage'
            and im.to_entity_type::text = 'operator_bag'
        ), 0)::integer as picked_quantity,
        coalesce(sum(im.quantity) filter (
          where im.from_entity_type::text = 'operator_bag'
            and im.to_entity_type::text = 'storage'
        ), 0)::integer as returned_quantity
      from public.inventory_movements im
      where im.related_route_id = p_route_id
      group by im.product_id
    ),
    all_products as (
      select rsl.product_id
      from public.route_stock_lines rsl
      where rsl.route_id = p_route_id
      union
      select mt.product_id
      from movement_totals mt
    )
    select
      ap.product_id,
      coalesce(mt.picked_quantity, 0) as picked_quantity,
      coalesce(mt.returned_quantity, 0) as returned_quantity
    from all_products ap
    left join movement_totals mt on mt.product_id = ap.product_id
    order by ap.product_id
  loop
    -- The deployed BEFORE INSERT guard implements its own update-or-insert
    -- behavior and returns NULL whenever a row already exists.  Acquire the
    -- same product lock and update first so returned_qty cannot be swallowed
    -- before PostgreSQL reaches an ON CONFLICT clause.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:route-stock-line:' || p_route_id::text || ':' || v_stock_line.product_id::text,
        0
      )
    );

    update public.route_stock_lines rsl
    set planned_qty = greatest(coalesce(rsl.planned_qty, 0), v_stock_line.picked_quantity),
        picked_qty = v_stock_line.picked_quantity,
        returned_qty = v_stock_line.returned_quantity,
        updated_at = pg_catalog.now()
    where rsl.route_id = p_route_id
      and rsl.product_id = v_stock_line.product_id;

    if not found then
      insert into public.route_stock_lines (
        route_id,
        product_id,
        planned_qty,
        picked_qty,
        returned_qty,
        updated_at
      )
      values (
        p_route_id,
        v_stock_line.product_id,
        greatest(v_stock_line.picked_quantity, v_stock_line.returned_quantity),
        v_stock_line.picked_quantity,
        v_stock_line.returned_quantity,
        pg_catalog.now()
      );
    end if;
  end loop;
end;
$$;

revoke all on function public._snacky_sync_route_stock_lines(uuid) from public, anon, authenticated;

create or replace function public.snacky_finalize_route_inventory(p_route_id uuid,
  p_action text,
  p_storage_location_id uuid default null,
  p_counts jsonb default '[]'::jsonb,
  p_reason text default null,
  p_client_submission_id text default null,
  p_expected_ledger_token text default null
)
returns table (reconciliation_id uuid,
  route_id uuid,
  route_status public.route_status,
  reconciliation_status text,
  returned_quantity integer,
  discrepancy_quantity integer,
  already_finalized boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_counts jsonb := coalesce(p_counts, '[]'::jsonb);
  v_canonical_counts jsonb := '[]'::jsonb;
  v_submission_id text;
  v_payload_hash text;
  v_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_is_manager boolean := false;
  v_route public.routes%rowtype;
  v_existing public.route_inventory_reconciliations%rowtype;
  v_target_status public.route_status;
  v_reconciliation_id uuid := pg_catalog.gen_random_uuid();
  v_storage_location_id uuid := p_storage_location_id;
  v_now timestamptz := pg_catalog.now();
  v_invalid_count integer := 0;
  v_count_row_count integer := 0;
  v_origin_count integer := 0;
  v_eligible_storage_count integer := 0;
  v_return_total bigint := 0;
  v_discrepancy_total bigint := 0;
  v_line public.route_inventory_reconciliation_lines%rowtype;
  v_movement_id uuid;
  v_discrepancy_id uuid;
  v_idempotency_key text;
  v_current_ledger_token text;
  v_custody_lock record;
  v_bag_lock record;
  v_global_bag_balance bigint;
  v_global_projected_balance bigint;
  v_global_alignment_quantity bigint;
  v_global_alignment_movement_id uuid;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to finalize route inventory.' using errcode = '42501';
  end if;

  if p_route_id is null then
    raise exception 'Route id is required.' using errcode = 'P0001';
  end if;

  if v_action not in ('complete', 'cancel') then
    raise exception 'Route inventory action must be complete or cancel.' using errcode = 'P0001';
  end if;

  if v_action = 'cancel' and nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'A cancellation reason is required.' using errcode = 'P0001';
  end if;

  v_target_status := case
    when v_action = 'complete' then 'completed'::public.route_status
    else 'cancelled'::public.route_status
  end;

  if pg_catalog.jsonb_typeof(v_counts) <> 'array' then
    raise exception 'Physical bag counts must be a JSON array.' using errcode = 'P0001';
  end if;

  if pg_catalog.jsonb_array_length(v_counts) > 500
    or pg_catalog.pg_column_size(v_counts) > 1048576
  then
    raise exception 'Physical bag count payload is too large.' using errcode = '54000';
  end if;

  select count(*)::integer
  into v_invalid_count
  from pg_catalog.jsonb_array_elements(v_counts) as element(value)
  where pg_catalog.jsonb_typeof(element.value) <> 'object';

  if v_invalid_count > 0 then
    raise exception 'Every physical bag count must be a JSON object.' using errcode = 'P0001';
  end if;

  if pg_catalog.length(coalesce(p_reason, '')) > 2000 then
    raise exception 'Route inventory reason cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  v_submission_id := coalesce(
    nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), ''),
    'route-terminal:' || p_route_id::text || ':' || v_action
  );

  if pg_catalog.length(v_submission_id) > 200 then
    raise exception 'Route inventory submission id cannot exceed 200 characters.' using errcode = '22023';
  end if;

  -- Bind retries to the semantic request, not the client's JSON row order.
  -- Typed values remove harmless JSON string/number representation changes;
  -- ignored object fields are deliberately excluded from the contract.
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'bag_owner_id', count_row.bag_owner_id,
        'product_id', count_row.product_id,
        'counted_quantity', count_row.counted_quantity,
        'discrepancy_reason', nullif(pg_catalog.btrim(coalesce(count_row.discrepancy_reason, '')), '')
      )
      order by
        count_row.bag_owner_id nulls first,
        count_row.product_id nulls first,
        count_row.counted_quantity nulls first,
        nullif(pg_catalog.btrim(coalesce(count_row.discrepancy_reason, '')), '') nulls first
    ),
    '[]'::jsonb
  )
  into v_canonical_counts
  from pg_catalog.jsonb_to_recordset(v_counts) as count_row(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  );

  v_payload_hash := pg_catalog.md5(
    pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'route_id', p_route_id,
      'action', v_action,
      'storage_location_id', p_storage_location_id,
      'counts', v_canonical_counts,
      'reason', nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''),
      'expected_ledger_token', nullif(pg_catalog.btrim(coalesce(p_expected_ledger_token, '')), '')
    )::text
  );

  -- All route inventory writers use this exact lock namespace before locking
  -- the route row. It serializes stop commits, terminal reconciliation, and a
  -- pristine pickup rollback for the same route.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || p_route_id::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory-submission:' || v_submission_id, 0)
  );

  select r.*
  into v_route
  from public.routes r
  where r.id = p_route_id
  for update;

  if not found then
    raise exception 'Route was not found.' using errcode = 'P0001';
  end if;

  select coalesce(
    (
      select p.team_member_id
      from public.profiles p
      where p.id = v_user_id
      limit 1
    ),
    (
      select tm.id
      from public.team_members tm
      where tm.auth_user_id = v_user_id
      order by tm.created_at, tm.id
      limit 1
    )
  )
  into v_actor_team_member_id;

  if v_actor_team_member_id is null then
    raise exception 'Your signed-in account is not linked to a team member.' using errcode = '42501';
  end if;

  v_is_manager := public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);

  if v_action = 'cancel' and not v_is_manager then
    raise exception 'Only an owner, admin, or supervisor can cancel a route.' using errcode = '42501';
  end if;

  if v_action = 'complete'
    and not v_is_manager
    and (
      v_route.operator_id is distinct from v_actor_team_member_id
      or not public.snacky_operator_can_access_route(p_route_id)
    )
  then
    raise exception 'You do not have permission to complete this route.' using errcode = '42501';
  end if;

  select rec.*
  into v_existing
  from public.route_inventory_reconciliations rec
  where rec.client_submission_id = v_submission_id;

  if found then
    if v_existing.route_id <> p_route_id or v_existing.action <> v_action then
      raise exception 'This submission id was already used for a different route finalization.' using errcode = 'P0001';
    end if;

    if v_existing.payload_hash is distinct from v_payload_hash then
      raise exception 'This submission id was already used with a different immutable route-finalization payload.' using errcode = '23505';
    end if;

    if (v_action = 'complete' and v_route.status::text not in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed'))
      or (v_action = 'cancel' and v_route.status::text not in ('cancelled', 'canceled'))
      or exists (select 1 from public._snacky_route_bag_balances(p_route_id))
    then
      raise exception 'The saved route reconciliation and current route ledger disagree. Repair them explicitly before retrying.' using errcode = 'P0001';
    end if;

    return query
    select
      v_existing.id,
      v_existing.route_id,
      v_route.status,
      v_existing.status,
      v_existing.returned_units,
      v_existing.discrepancy_units,
      true;
    return;
  end if;

  select rec.*
  into v_existing
  from public.route_inventory_reconciliations rec
  where rec.route_id = p_route_id;

  if found then
    if v_existing.action <> v_action then
      raise exception 'This route was already finalized with a different terminal action.' using errcode = 'P0001';
    end if;

    if v_existing.payload_hash is distinct from v_payload_hash then
      raise exception 'This route was already finalized with a different immutable payload. Review the saved reconciliation instead of resubmitting edited counts.' using errcode = '23505';
    end if;

    if (v_action = 'complete' and v_route.status::text not in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed'))
      or (v_action = 'cancel' and v_route.status::text not in ('cancelled', 'canceled'))
      or exists (select 1 from public._snacky_route_bag_balances(p_route_id))
    then
      raise exception 'The saved route reconciliation and current route ledger disagree. Repair them explicitly before retrying.' using errcode = 'P0001';
    end if;

    return query
    select
      v_existing.id,
      v_existing.route_id,
      v_route.status,
      v_existing.status,
      v_existing.returned_units,
      v_existing.discrepancy_units,
      true;
    return;
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled') then
    raise exception 'This historical route is already terminal and has no inventory reconciliation. Repair it explicitly; it cannot be silently backfilled.' using errcode = 'P0001';
  end if;

  -- Readiness applies only to a new transition. Exact lost-response retries
  -- above must remain replayable after their successful call made the route
  -- terminal.
  if v_action = 'complete' then
    if v_route.operator_id is null then
      raise exception 'A route must be assigned to an operator before it can be completed.' using errcode = '23514';
    end if;

    if v_route.status::text not in ('in_progress', 'pickup_confirmed', 'started', 'filling', 'machine_filling') then
      raise exception 'Route status does not allow inventory completion: %.', v_route.status::text using errcode = '23514';
    end if;

    if not exists (
      select 1
      from public.route_stops rs
      where rs.route_id = p_route_id
    ) then
      raise exception 'A route without machine stops cannot be completed.' using errcode = '23514';
    end if;
  end if;

  if coalesce(p_expected_ledger_token, '') !~ '^[0-9a-f]{32}$' then
    raise exception 'A valid route bag ledger token is required. Refresh the physical count screen.' using errcode = '40001';
  end if;

  v_current_ledger_token := public._snacky_route_bag_ledger_token(p_route_id);
  if v_current_ledger_token is distinct from p_expected_ledger_token then
    raise exception 'Route bag stock changed after this count screen loaded. Refresh and count the physical bag again.' using errcode = '40001';
  end if;

  if exists (
    select 1
    from public.route_stop_inventory_commits receipt
    where receipt.route_id = p_route_id
      and receipt.workflow_completed_at is null
  ) then
    raise exception 'A machine stop inventory commit is still awaiting workflow completion. Retry that stop before completing or cancelling the route.' using errcode = '40001';
  end if;

  if v_action = 'complete' then
    select count(*)::integer
    into v_invalid_count
    from public.route_stops rs
    where rs.route_id = p_route_id
      and rs.status::text not in ('completed', 'skipped', 'canceled');

    if v_invalid_count > 0 then
      raise exception 'Every route stop must be completed, skipped, or canceled before route completion.' using errcode = 'P0001';
    end if;
  end if;

  select count(*)::integer
  into v_invalid_count
  from public._snacky_route_bag_history_balances(p_route_id) b
  where b.bag_owner_id is null
     or b.signed_quantity > 2147483647
     or b.signed_quantity < -2147483648;

  if v_invalid_count > 0 then
    raise exception 'Route bag custody contains an invalid owner or an unsupported quantity. Repair the ledger before finalization.' using errcode = 'P0001';
  end if;

  -- A terminal action never assumes that a zero ledger means an empty physical
  -- bag. Once any bag leg exists, the user must explicitly confirm counts,
  -- including zero counts for products whose ledger balance returned to zero.
  if pg_catalog.jsonb_array_length(v_counts) = 0
    and exists (
      select 1
      from public.inventory_movements im
      where im.related_route_id = p_route_id
        and (
          im.from_entity_type::text = 'operator_bag'
          or im.to_entity_type::text = 'operator_bag'
        )
    )
  then
    raise exception 'This route has operator-bag history. Enter explicit physical counts before finalizing it.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_count_row_count
  from pg_catalog.jsonb_to_recordset(v_counts) as c(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  );

  select count(*)::integer
  into v_invalid_count
  from pg_catalog.jsonb_to_recordset(v_counts) as c(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  )
  where c.bag_owner_id is null
     or c.product_id is null
     or c.counted_quantity is null
     or c.counted_quantity < 0;

  if v_invalid_count > 0 then
    raise exception 'Each physical count requires a bag owner, product, and nonnegative quantity.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_invalid_count
  from pg_catalog.jsonb_to_recordset(v_counts) as c(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  )
  where pg_catalog.length(coalesce(c.discrepancy_reason, '')) > 2000;

  if v_invalid_count > 0 then
    raise exception 'A physical count reason cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  select count(*)::integer
  into v_invalid_count
  from (
    select c.bag_owner_id, c.product_id
    from pg_catalog.jsonb_to_recordset(v_counts) as c(
      bag_owner_id uuid,
      product_id uuid,
      counted_quantity integer,
      discrepancy_reason text
    )
    group by c.bag_owner_id, c.product_id
    having count(*) > 1
  ) duplicate_counts;

  if v_invalid_count > 0 then
    raise exception 'Physical counts contain a duplicate bag owner and product.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_invalid_count
  from pg_catalog.jsonb_to_recordset(v_counts) as c(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  )
  left join public.team_members tm on tm.id = c.bag_owner_id
  left join public.products p on p.id = c.product_id
  where tm.id is null or p.id is null;

  if v_invalid_count > 0 then
    raise exception 'A physical count references an unknown bag owner or product.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_invalid_count
  from public._snacky_route_bag_history_balances(p_route_id) b
  left join pg_catalog.jsonb_to_recordset(v_counts) as c(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  )
    on c.bag_owner_id = b.bag_owner_id
   and c.product_id = b.product_id
  where c.product_id is null;

  if v_invalid_count > 0 then
    raise exception 'A physical count is required for every operator-bag product in this route''s custody history, including a zero balance.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_invalid_count
  from pg_catalog.jsonb_to_recordset(v_counts) as c(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  )
  where c.bag_owner_id is distinct from v_route.operator_id
    and not exists (
      select 1
      from public.inventory_movements im
      where im.related_route_id = p_route_id
        and (
          (im.from_entity_type::text = 'operator_bag' and im.from_entity_id = c.bag_owner_id)
          or
          (im.to_entity_type::text = 'operator_bag' and im.to_entity_id = c.bag_owner_id)
        )
    );

  if v_invalid_count > 0 then
    raise exception 'A physical count references a bag owner who has no custody history on this route.' using errcode = 'P0001';
  end if;

  if not v_is_manager then
    select count(*)::integer
    into v_invalid_count
    from pg_catalog.jsonb_to_recordset(v_counts) as c(
      bag_owner_id uuid,
      product_id uuid,
      counted_quantity integer,
      discrepancy_reason text
    )
    where c.bag_owner_id is distinct from v_route.operator_id;

    if v_invalid_count > 0 then
      raise exception 'An operator may count only the bag assigned to this route.' using errcode = '42501';
    end if;

    select count(*)::integer
    into v_invalid_count
    from public._snacky_route_bag_history_balances(p_route_id) b
    where b.bag_owner_id is distinct from v_route.operator_id;

    if v_invalid_count > 0 then
      raise exception 'This route contains another operator bag. A manager must reconcile it.' using errcode = '42501';
    end if;
  end if;

  select coalesce(sum(c.counted_quantity::bigint), 0)
  into v_return_total
  from pg_catalog.jsonb_to_recordset(v_counts) as c(
    bag_owner_id uuid,
    product_id uuid,
    counted_quantity integer,
    discrepancy_reason text
  );

  if v_return_total > 2147483647 then
    raise exception 'Total returned route quantity exceeds the supported inventory range.' using errcode = 'P0001';
  end if;

  with ledger as (
    select b.bag_owner_id, b.product_id, b.signed_quantity
    from public._snacky_route_bag_history_balances(p_route_id) b
  ),
  physical_counts as (
    select c.bag_owner_id, c.product_id, c.counted_quantity
    from pg_catalog.jsonb_to_recordset(v_counts) as c(
      bag_owner_id uuid,
      product_id uuid,
      counted_quantity integer,
      discrepancy_reason text
    )
  )
  select count(*)::integer
  into v_invalid_count
  from ledger l
  full join physical_counts c
    on c.bag_owner_id = l.bag_owner_id
   and c.product_id = l.product_id
  where coalesce(c.counted_quantity, 0)::bigint - coalesce(l.signed_quantity, 0) > 2147483647
     or coalesce(c.counted_quantity, 0)::bigint - coalesce(l.signed_quantity, 0) < -2147483648;

  if v_invalid_count > 0 then
    raise exception 'A route inventory variance exceeds the supported inventory range.' using errcode = 'P0001';
  end if;

  with ledger as (
    select b.bag_owner_id, b.product_id, b.signed_quantity
    from public._snacky_route_bag_history_balances(p_route_id) b
  ),
  physical_counts as (
    select
      c.bag_owner_id,
      c.product_id,
      c.counted_quantity,
      nullif(pg_catalog.btrim(coalesce(c.discrepancy_reason, '')), '') as discrepancy_reason
    from pg_catalog.jsonb_to_recordset(v_counts) as c(
      bag_owner_id uuid,
      product_id uuid,
      counted_quantity integer,
      discrepancy_reason text
    )
  )
  select count(*)::integer
  into v_invalid_count
  from ledger l
  full join physical_counts c
    on c.bag_owner_id = l.bag_owner_id
   and c.product_id = l.product_id
  where coalesce(c.counted_quantity, 0)::bigint <> coalesce(l.signed_quantity, 0)
    and coalesce(
      c.discrepancy_reason,
      nullif(pg_catalog.btrim(coalesce(p_reason, '')), '')
    ) is null;

  if v_invalid_count > 0 then
    raise exception 'Explain every physical count that differs from the route ledger.' using errcode = 'P0001';
  end if;

  if v_storage_location_id is not null then
    if not exists (
      select 1
      from public.storage_locations sl
      where sl.id = v_storage_location_id
        and sl.active = true
        and sl.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
    ) then
      raise exception 'The selected return storage location is inactive or cannot receive sellable leftovers.' using errcode = 'P0001';
    end if;
  elsif v_return_total > 0 then
    select
      count(*)::integer,
      (pg_catalog.array_agg(origins.storage_location_id order by origins.storage_location_id))[1]
    into v_origin_count, v_storage_location_id
    from (
      select distinct im.from_entity_id as storage_location_id
      from public.inventory_movements im
      where im.related_route_id = p_route_id
        and im.from_entity_type::text = 'storage'
        and im.to_entity_type::text = 'operator_bag'
        and im.from_entity_id is not null
    ) origins;

    if v_origin_count > 1 then
      raise exception 'This route was picked from multiple storage locations. Select the physical return destination explicitly.' using errcode = 'P0001';
    elsif v_origin_count = 1 then
      if not exists (
        select 1
        from public.storage_locations sl
        where sl.id = v_storage_location_id
          and sl.active = true
          and sl.location_type in ('main_storage', 'vehicle', 'temporary', 'other')
      ) then
        raise exception 'The route pickup-origin storage cannot receive sellable leftovers. Select an active return destination explicitly.' using errcode = 'P0001';
      end if;
    else
      select
        count(*)::integer,
        (pg_catalog.array_agg(sl.id order by sl.id))[1]
      into v_eligible_storage_count, v_storage_location_id
      from public.storage_locations sl
      where sl.active = true
        and sl.location_type in ('main_storage', 'vehicle', 'temporary', 'other');

      if v_eligible_storage_count = 0 then
        raise exception 'No active storage location can receive physical route leftovers.' using errcode = 'P0001';
      elsif v_eligible_storage_count > 1 then
        raise exception 'This route has no pickup-origin storage and more than one return destination is available. Select one explicitly.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- Canonical inventory lock order is route, every distinct custody owner,
  -- then every owner/product bag key. Owner locks serialize route claims and
  -- cross-product terminal work; product locks protect exact balances.
  for v_custody_lock in
    select distinct involved.bag_owner_id
    from (
      select history.bag_owner_id
      from public._snacky_route_bag_history_balances(p_route_id) history
      union
      select count_row.bag_owner_id
      from pg_catalog.jsonb_to_recordset(v_counts) as count_row(
        bag_owner_id uuid,
        product_id uuid,
        counted_quantity integer,
        discrepancy_reason text
      )
    ) involved
    where involved.bag_owner_id is not null
    order by involved.bag_owner_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-custody:' || v_custody_lock.bag_owner_id::text,
        0
      )
    );
  end loop;

  for v_bag_lock in
    select involved.bag_owner_id, involved.product_id
    from (
      select history.bag_owner_id, history.product_id
      from public._snacky_route_bag_history_balances(p_route_id) history
      union
      select count_row.bag_owner_id, count_row.product_id
      from pg_catalog.jsonb_to_recordset(v_counts) as count_row(
        bag_owner_id uuid,
        product_id uuid,
        counted_quantity integer,
        discrepancy_reason text
      )
    ) involved
    where involved.bag_owner_id is not null
      and involved.product_id is not null
    order by involved.bag_owner_id, involved.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_bag_lock.bag_owner_id::text || ':' || v_bag_lock.product_id::text,
        0
      )
    );
  end loop;

  insert into public.route_inventory_reconciliations (
    id,
    route_id,
    action,
    client_submission_id,
    payload_hash,
    operator_id,
    storage_location_id,
    route_status_before,
    route_status_after,
    status,
    reason,
    discrepancy_units,
    returned_units,
    details,
    created_by_user_id,
    created_by_team_member_id,
    finalized_at,
    created_at,
    updated_at
  ) values (
    v_reconciliation_id,
    p_route_id,
    v_action,
    v_submission_id,
    v_payload_hash,
    v_route.operator_id,
    v_storage_location_id,
    v_route.status,
    v_target_status,
    'balanced',
    nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''),
    0,
    v_return_total::integer,
    pg_catalog.jsonb_build_object(
      'count_payload_line_count', v_count_row_count,
      'ledger_source', 'inventory_movement_endpoints'
    ),
    v_user_id,
    v_actor_team_member_id,
    v_now,
    v_now,
    v_now
  );

  with ledger as (
    select b.bag_owner_id, b.product_id, b.signed_quantity::integer as ledger_quantity
    from public._snacky_route_bag_history_balances(p_route_id) b
  ),
  physical_counts as (
    select
      c.bag_owner_id,
      c.product_id,
      c.counted_quantity,
      nullif(pg_catalog.btrim(coalesce(c.discrepancy_reason, '')), '') as discrepancy_reason
    from pg_catalog.jsonb_to_recordset(v_counts) as c(
      bag_owner_id uuid,
      product_id uuid,
      counted_quantity integer,
      discrepancy_reason text
    )
  ),
  joined as (
    select
      coalesce(l.bag_owner_id, c.bag_owner_id) as bag_owner_id,
      coalesce(l.product_id, c.product_id) as product_id,
      coalesce(l.ledger_quantity, 0) as ledger_quantity,
      coalesce(c.counted_quantity, 0) as counted_quantity,
      c.discrepancy_reason
    from ledger l
    full join physical_counts c
      on c.bag_owner_id = l.bag_owner_id
     and c.product_id = l.product_id
  )
  insert into public.route_inventory_reconciliation_lines (
    reconciliation_id,
    route_id,
    bag_owner_id,
    product_id,
    ledger_quantity,
    counted_quantity,
    variance_quantity,
    variance_type,
    returned_quantity,
    discrepancy_reason,
    review_status,
    created_at,
    updated_at
  )
  select
    v_reconciliation_id,
    p_route_id,
    j.bag_owner_id,
    j.product_id,
    j.ledger_quantity,
    j.counted_quantity,
    j.counted_quantity - j.ledger_quantity,
    case
      when j.counted_quantity = j.ledger_quantity then 'balanced'
      when j.ledger_quantity < 0 then 'negative_ledger'
      when j.counted_quantity > j.ledger_quantity then 'overage'
      else 'shortage'
    end,
    j.counted_quantity,
    case
      when j.counted_quantity = j.ledger_quantity then null
      else coalesce(
        j.discrepancy_reason,
        nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''),
        'Physical bag count differs from the route ledger.'
      )
    end,
    case when j.counted_quantity = j.ledger_quantity then 'balanced' else 'open' end,
    v_now,
    v_now
  from joined j;

  for v_line in
    select line_row.*
    from public.route_inventory_reconciliation_lines line_row
    where line_row.reconciliation_id = v_reconciliation_id
    order by line_row.bag_owner_id, line_row.product_id
  loop
    -- The route ledger is only one slice of an operator's global bag. Legacy
    -- data can leave the global balance below this route's recorded slice,
    -- which would make the globally enforced debit invariant reject a valid
    -- field count. Under the already-held owner/product lock, repair only that
    -- impossible lower-bound deficit before any route-scoped debit. Keep this
    -- movement outside the route ledger and expose it as a separate open case.
    select coalesce(sum(
      case
        when movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_line.bag_owner_id
          then movement.quantity::bigint
        else 0::bigint
      end
      + case
        when movement.from_entity_type::text = 'operator_bag'
          and movement.from_entity_id = v_line.bag_owner_id
          then -movement.quantity::bigint
        else 0::bigint
      end
    ), 0::bigint)
    into v_global_bag_balance
    from public.inventory_movements movement
    where movement.product_id = v_line.product_id
      and (
        (
          movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_line.bag_owner_id
        )
        or (
          movement.from_entity_type::text = 'operator_bag'
          and movement.from_entity_id = v_line.bag_owner_id
        )
      );

    v_global_projected_balance := v_global_bag_balance - v_line.ledger_quantity::bigint;
    v_global_alignment_quantity := greatest(-v_global_projected_balance, 0::bigint);

    if v_global_alignment_quantity > 2147483647 then
      raise exception 'Global operator-bag alignment exceeds the supported inventory range for owner % and product %.',
        v_line.bag_owner_id,
        v_line.product_id
        using errcode = '22003';
    end if;

    if v_global_alignment_quantity > 0 then
      v_idempotency_key := 'route-terminal:global-bag-alignment:' || v_reconciliation_id::text || ':' || v_line.id::text;
      v_global_alignment_movement_id := null;

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
        v_line.product_id,
        v_global_alignment_quantity::integer,
        'adjustment'::public.inventory_entity_type,
        null,
        'operator_bag'::public.inventory_entity_type,
        v_line.bag_owner_id,
        'stock_count_adjustment'::public.movement_reason,
        null,
        'route_terminal_global_bag_alignment',
        v_line.id,
        v_idempotency_key,
        v_actor_team_member_id,
        'Audited global operator-bag lower-bound alignment before route finalization'
      )
      on conflict do nothing
      returning id into v_global_alignment_movement_id;

      if v_global_alignment_movement_id is null then
        select movement.id
        into v_global_alignment_movement_id
        from public.inventory_movements movement
        where movement.idempotency_key = v_idempotency_key
          and movement.product_id = v_line.product_id
          and movement.quantity::bigint = v_global_alignment_quantity
          and movement.from_entity_type::text = 'adjustment'
          and movement.from_entity_id is null
          and movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_line.bag_owner_id
          and movement.related_route_id is null
          and movement.source_type = 'route_terminal_global_bag_alignment'
          and movement.source_id = v_line.id;

        if not found then
          raise exception 'Inventory idempotency conflict while aligning the global operator bag.' using errcode = '23505';
        end if;
      end if;

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
      ) values (
        p_route_id,
        null,
        null,
        v_line.bag_owner_id,
        v_line.product_id,
        'negative_bag_balance',
        v_global_projected_balance::integer,
        0,
        v_global_alignment_quantity::integer,
        v_global_alignment_quantity::integer,
        'open',
        'route_terminal_global_bag_alignment',
        v_line.id,
        'route-terminal-global-bag-discrepancy:' || p_route_id::text || ':' || v_line.bag_owner_id::text || ':' || v_line.product_id::text,
        pg_catalog.jsonb_build_object(
          'reconciliation_id', v_reconciliation_id,
          'reconciliation_line_id', v_line.id,
          'global_bag_balance_before', v_global_bag_balance,
          'route_ledger_quantity', v_line.ledger_quantity,
          'projected_global_balance_without_alignment', v_global_projected_balance,
          'alignment_quantity', v_global_alignment_quantity,
          'ledger_source', 'all_inventory_movement_endpoints'
        ),
        v_user_id,
        v_actor_team_member_id,
        v_now,
        v_global_alignment_movement_id,
        v_now,
        v_now
      )
      on conflict (idempotency_key) do update
        set recorded_quantity = excluded.recorded_quantity,
            actual_quantity = excluded.actual_quantity,
            difference_quantity = excluded.difference_quantity,
            absolute_quantity = excluded.absolute_quantity,
            status = 'open',
            details = excluded.details,
            resolution_type = null,
            resolution_notes = null,
            resolved_by_user_id = null,
            resolved_by_team_member_id = null,
            resolved_at = null,
            correcting_movement_id = excluded.correcting_movement_id,
            updated_at = excluded.updated_at;
    end if;

    v_movement_id := null;

    if v_line.variance_quantity > 0 then
      v_idempotency_key := 'route-terminal:variance:' || v_reconciliation_id::text || ':' || v_line.id::text;

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
        v_line.product_id,
        v_line.variance_quantity,
        'adjustment'::public.inventory_entity_type,
        null,
        'operator_bag'::public.inventory_entity_type,
        v_line.bag_owner_id,
        'stock_count_adjustment'::public.movement_reason,
        p_route_id,
        'route_terminal_reconciliation',
        v_line.id,
        v_idempotency_key,
        v_actor_team_member_id,
        v_line.discrepancy_reason
      )
      on conflict do nothing
      returning id into v_movement_id;

      if v_movement_id is null then
        select im.id
        into v_movement_id
        from public.inventory_movements im
        where im.idempotency_key = v_idempotency_key
          and im.product_id = v_line.product_id
          and im.quantity = v_line.variance_quantity
          and im.from_entity_type::text = 'adjustment'
          and im.from_entity_id is null
          and im.to_entity_type::text = 'operator_bag'
          and im.to_entity_id = v_line.bag_owner_id
          and im.related_route_id = p_route_id;

        if not found then
          raise exception 'Inventory idempotency conflict while recording a route overage.' using errcode = 'P0001';
        end if;
      end if;
    elsif v_line.variance_quantity < 0 then
      v_idempotency_key := 'route-terminal:variance:' || v_reconciliation_id::text || ':' || v_line.id::text;

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
        v_line.product_id,
        -v_line.variance_quantity,
        'operator_bag'::public.inventory_entity_type,
        v_line.bag_owner_id,
        'adjustment'::public.inventory_entity_type,
        null,
        'theft_or_missing'::public.movement_reason,
        p_route_id,
        'route_terminal_reconciliation',
        v_line.id,
        v_idempotency_key,
        v_actor_team_member_id,
        v_line.discrepancy_reason
      )
      on conflict do nothing
      returning id into v_movement_id;

      if v_movement_id is null then
        select im.id
        into v_movement_id
        from public.inventory_movements im
        where im.idempotency_key = v_idempotency_key
          and im.product_id = v_line.product_id
          and im.quantity = -v_line.variance_quantity
          and im.from_entity_type::text = 'operator_bag'
          and im.from_entity_id = v_line.bag_owner_id
          and im.to_entity_type::text = 'adjustment'
          and im.to_entity_id is null
          and im.related_route_id = p_route_id;

        if not found then
          raise exception 'Inventory idempotency conflict while recording a route shortage.' using errcode = 'P0001';
        end if;
      end if;
    end if;

    if v_line.variance_quantity <> 0 then
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
        detected_by_team_member_id,
        detected_at,
        correcting_movement_id,
        created_at,
        updated_at
      ) values (
        p_route_id,
        null,
        null,
        v_line.bag_owner_id,
        v_line.product_id,
        case
          when v_line.ledger_quantity < 0 then 'negative_bag_balance'
          when v_line.variance_quantity > 0 then 'terminal_overage'
          else 'terminal_shortage'
        end,
        v_line.ledger_quantity,
        v_line.counted_quantity,
        v_line.variance_quantity,
        pg_catalog.abs(v_line.variance_quantity),
        'open',
        'route_terminal_reconciliation_line',
        v_line.id,
        'route-terminal-discrepancy:' || p_route_id::text || ':' || v_line.bag_owner_id::text || ':' || v_line.product_id::text,
        pg_catalog.jsonb_build_object(
          'reconciliation_id', v_reconciliation_id,
          'variance_type', v_line.variance_type,
          'discrepancy_reason', v_line.discrepancy_reason,
          'ledger_source', 'inventory_movement_endpoints'
        ),
        v_user_id,
        v_actor_team_member_id,
        v_now,
        v_movement_id,
        v_now,
        v_now
      )
      on conflict (idempotency_key) do update
        set recorded_quantity = excluded.recorded_quantity,
            actual_quantity = excluded.actual_quantity,
            difference_quantity = excluded.difference_quantity,
            absolute_quantity = excluded.absolute_quantity,
            details = excluded.details,
            correcting_movement_id = excluded.correcting_movement_id,
            updated_at = excluded.updated_at
      returning id into v_discrepancy_id;
    else
      v_discrepancy_id := null;
    end if;

    update public.route_inventory_reconciliation_lines line_row
    set adjustment_movement_id = v_movement_id,
        discrepancy_id = v_discrepancy_id,
        updated_at = v_now
    where line_row.id = v_line.id;

    if v_line.counted_quantity > 0 then
      v_idempotency_key := 'route-terminal:return:' || v_reconciliation_id::text || ':' || v_line.id::text;
      v_movement_id := null;

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
        v_line.product_id,
        v_line.counted_quantity,
        'operator_bag'::public.inventory_entity_type,
        v_line.bag_owner_id,
        'storage'::public.inventory_entity_type,
        v_storage_location_id,
        'operator_bag_to_storage'::public.movement_reason,
        p_route_id,
        'route_terminal_reconciliation',
        v_line.id,
        v_idempotency_key,
        v_actor_team_member_id,
        coalesce(nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''), 'Physical leftovers returned at route finalization')
      )
      on conflict do nothing
      returning id into v_movement_id;

      if v_movement_id is null then
        select im.id
        into v_movement_id
        from public.inventory_movements im
        where im.idempotency_key = v_idempotency_key
          and im.product_id = v_line.product_id
          and im.quantity = v_line.counted_quantity
          and im.from_entity_type::text = 'operator_bag'
          and im.from_entity_id = v_line.bag_owner_id
          and im.to_entity_type::text = 'storage'
          and im.to_entity_id = v_storage_location_id
          and im.related_route_id = p_route_id;

        if not found then
          raise exception 'Inventory idempotency conflict while returning route leftovers.' using errcode = 'P0001';
        end if;
      end if;

      update public.route_inventory_reconciliation_lines line_row
      set return_movement_id = v_movement_id,
          updated_at = v_now
      where line_row.id = v_line.id;
    end if;
  end loop;

  -- Include both terminal-count variances and any unresolved stop-level
  -- shortages. Route closure remains available, but it can never appear
  -- balanced while an inventory review case is still open.
  select coalesce(sum(discrepancy.absolute_quantity::bigint), 0)
  into v_discrepancy_total
  from public.route_inventory_discrepancies discrepancy
  where discrepancy.route_id = p_route_id
    and discrepancy.status in ('open', 'investigating');

  if v_discrepancy_total > 2147483647 then
    raise exception 'Total route discrepancy exceeds the supported inventory range.' using errcode = 'P0001';
  end if;

  update public.route_inventory_reconciliations rec
  set status = case when v_discrepancy_total = 0 then 'balanced' else 'needs_review' end,
      discrepancy_units = v_discrepancy_total::integer,
      returned_units = v_return_total::integer,
      updated_at = v_now
  where rec.id = v_reconciliation_id;

  if exists (
    select 1
    from public._snacky_route_bag_balances(p_route_id) remaining
    where remaining.signed_quantity <> 0
  ) then
    raise exception 'Route bag inventory did not reconcile to zero. No terminal changes were saved.' using errcode = 'P0001';
  end if;

  perform public._snacky_sync_route_stock_lines(p_route_id);

  if v_action = 'cancel' then
    update public.route_stops rs
    set status = 'canceled'::public.route_stop_status
    where rs.route_id = p_route_id
      and rs.status::text not in ('completed', 'skipped', 'canceled');

    update public.refill_orders ro
    set status = 'cancelled'::public.refill_status
    where ro.route_id = p_route_id
      and ro.status::text not in ('completed', 'cancelled');

    -- The custody hardening migration installs a fail-closed batch audit
    -- trigger. Mark this reviewed terminal transition without weakening direct
    -- authenticated UPDATE access to finalized pickup evidence.
    perform pg_catalog.set_config(
      'snacky.route_pickup_batch_write_mode',
      'route_cancel',
      true
    );

    update public.route_pickup_batches batch_row
    set status = 'cancelled',
        updated_at = v_now
    where batch_row.route_id = p_route_id
      and batch_row.status <> 'cancelled';

    perform pg_catalog.set_config(
      'snacky.route_pickup_batch_write_mode',
      '',
      true
    );

    update public.routes r
    set status = 'cancelled'::public.route_status,
        cancelled_at = v_now,
        cancelled_by = v_actor_team_member_id,
        cancellation_reason = pg_catalog.btrim(p_reason)
    where r.id = p_route_id;
  else
    update public.routes r
    set status = 'completed'::public.route_status,
        completed_at = coalesce(r.completed_at, v_now),
        completed_by = v_actor_team_member_id,
        completion_attempts = coalesce(r.completion_attempts, 0) + 1,
        last_completion_error = null
    where r.id = p_route_id;
  end if;

  return query
  select
    v_reconciliation_id,
    p_route_id,
    v_target_status,
    case when v_discrepancy_total = 0 then 'balanced' else 'needs_review' end,
    v_return_total::integer,
    v_discrepancy_total::integer,
    false;
end;
$$;

revoke all on function public.snacky_finalize_route_inventory(uuid, text, uuid, jsonb, text, text, text) from public, anon;
grant execute on function public.snacky_finalize_route_inventory(uuid, text, uuid, jsonb, text, text, text) to authenticated;

-- Prevent reassignment after route-scoped bag custody exists, and require a
-- successful reconciliation before a route first enters a terminal state.
create or replace function public.snacky_guard_route_inventory_integrity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_completion_terminal boolean := old.status::text in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed');
  v_new_completion_terminal boolean := new.status::text in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed');
  v_old_cancel_terminal boolean := old.status::text in ('cancelled', 'canceled');
  v_new_cancel_terminal boolean := new.status::text in ('cancelled', 'canceled');
  v_old_terminal boolean := v_old_completion_terminal or v_old_cancel_terminal;
  v_new_terminal boolean := v_new_completion_terminal or v_new_cancel_terminal;
  v_has_custody_lease boolean := false;
begin
  if new.operator_id is distinct from old.operator_id then
    -- This migration can be installed before the custody-lease migration. Use
    -- a runtime lookup so the guard becomes lease-aware as soon as that table
    -- exists without creating an unsafe deployment-order dependency.
    if pg_catalog.to_regclass('public.operator_route_custody_leases') is not null then
      execute 'select exists (
        select 1
        from public.operator_route_custody_leases lease
        where lease.route_id = $1
      )'
      into v_has_custody_lease
      using old.id;
    end if;

    if v_has_custody_lease
      or exists (
        select 1
        from public._snacky_route_bag_balances(old.id) balance
        where balance.signed_quantity <> 0
      )
    then
      raise exception 'Route operator cannot be changed or cleared while route bag inventory or its custody lease remains active. Return or reconcile the operator bag stock first.' using errcode = 'P0001';
    end if;
  end if;

  if new.operator_id is distinct from old.operator_id
    and exists (
      select 1
      from public.route_stop_inventory_commits receipt
      where receipt.route_id = old.id
        and receipt.workflow_completed_at is null
    )
  then
    raise exception 'Route operator cannot change while a machine stop inventory commit is awaiting completion. Retry that stop first.' using errcode = '40001';
  end if;

  if v_old_terminal and new.status is distinct from old.status then
    if not (
      (v_old_completion_terminal and v_new_completion_terminal)
      or (v_old_cancel_terminal and v_new_cancel_terminal)
    ) then
      raise exception 'A terminal route cannot be reopened or changed to a different terminal outcome.' using errcode = 'P0001';
    end if;
  end if;

  if v_new_terminal and not v_old_terminal then
    if exists (
      select 1
      from public._snacky_route_bag_balances(old.id) b
      where b.signed_quantity <> 0
    ) then
      raise exception 'Route bag inventory must reconcile to zero before the route can become terminal.' using errcode = 'P0001';
    end if;

    if not exists (
      select 1
      from public.route_inventory_reconciliations rec
      where rec.route_id = old.id
        and (
          (v_new_completion_terminal
            and rec.action = 'complete'
            and rec.route_status_after::text = 'completed')
          or
          (new.status::text in ('cancelled', 'canceled')
            and rec.action = 'cancel'
            and rec.route_status_after::text in ('cancelled', 'canceled'))
        )
    ) then
      raise exception 'Use snacky_finalize_route_inventory before moving a route to a terminal status.' using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.snacky_guard_route_inventory_integrity() from public, anon, authenticated;

drop trigger if exists trg_snacky_route_inventory_integrity on public.routes;
create trigger trg_snacky_route_inventory_integrity
before update of status, operator_id on public.routes
for each row
execute function public.snacky_guard_route_inventory_integrity();

-- Once a route is terminal, its route-scoped operator-bag ledger is immutable.
-- Non-bag financial or machine corrections remain possible without violating
-- the zero-custody invariant.
create or replace function public.snacky_guard_terminal_route_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_route_status text;
  v_new_route_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    if old.related_route_id is not null
      and (
        old.from_entity_type::text = 'operator_bag'
        or old.to_entity_type::text = 'operator_bag'
      )
    then
      -- Lock by id before inspecting status. This prevents a concurrent route
      -- finalizer from changing the route after this trigger sees it as active.
      select r.status::text
      into v_old_route_status
      from public.routes r
      where r.id = old.related_route_id
      for share;

      if v_old_route_status in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled')
        and exists (
          select 1
          from public.route_inventory_reconciliations rec
          where rec.route_id = old.related_route_id
        )
      then
        raise exception 'Terminal route bag movements are immutable. Record a separate reviewed correction without changing terminal bag custody.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    if new.related_route_id is not null
      and (
        new.from_entity_type::text = 'operator_bag'
        or new.to_entity_type::text = 'operator_bag'
      )
    then
      select r.status::text
      into v_new_route_status
      from public.routes r
      where r.id = new.related_route_id
      for share;

      if v_new_route_status in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled')
        and exists (
          select 1
          from public.route_inventory_reconciliations rec
          where rec.route_id = new.related_route_id
        )
      then
        raise exception 'Inventory cannot enter or leave an operator bag after its route is terminal.' using errcode = 'P0001';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

revoke all on function public.snacky_guard_terminal_route_inventory_movement() from public, anon, authenticated;

drop trigger if exists trg_snacky_terminal_route_inventory_movement on public.inventory_movements;
create trigger trg_snacky_terminal_route_inventory_movement
before insert or update or delete on public.inventory_movements
for each row
execute function public.snacky_guard_terminal_route_inventory_movement();

-- Preserve the existing RPC signature and result shape, but only allow an
-- exact reversal while the pickup batch is still pristine. Once any stop,
-- sale, damage, compensation, cash, or unrelated route movement exists, the
-- caller must use terminal reconciliation instead of guessing what remains.
create or replace function public.return_pickup_batch_to_assigned(
  p_route_id uuid,
  p_pickup_batch_id uuid,
  p_reason text default null
)
returns table (
  pickup_batch_id uuid,
  route_id uuid,
  route_status public.route_status,
  compensating_movement_count integer,
  restored_quantity integer,
  already_returned boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_route public.routes%rowtype;
  v_batch public.route_pickup_batches%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_route_stop_ids uuid[] := '{}'::uuid[];
  v_selected_machine_ids uuid[] := '{}'::uuid[];
  v_blocked_count integer := 0;
  v_pickup_movement_count integer := 0;
  v_reversal_count integer := 0;
  v_return_source_count integer := 0;
  v_reversal_quantity bigint := 0;
  v_custody_lock record;
  v_bag_lock record;
  v_return_group record;
  v_global_bag_balance bigint;
  v_global_projected_balance bigint;
  v_global_alignment_quantity bigint;
  v_global_alignment_movement_id uuid;
  v_alignment_idempotency_key text;
  v_custody_released boolean := false;
begin
  if v_user_id is null then
    raise exception 'You must be signed in to return this pickup batch.' using errcode = '42501';
  end if;

  if p_route_id is null or p_pickup_batch_id is null then
    raise exception 'Route and pickup batch are required.' using errcode = 'P0001';
  end if;

  if not public.snacky_current_profile_has_any_role(array['owner', 'admin']) then
    raise exception 'User does not have permission to return this pickup batch.' using errcode = '42501';
  end if;

  select coalesce(
    (
      select p.team_member_id
      from public.profiles p
      where p.id = v_user_id
      limit 1
    ),
    (
      select tm.id
      from public.team_members tm
      where tm.auth_user_id = v_user_id
      order by tm.created_at, tm.id
      limit 1
    )
  )
  into v_actor_team_member_id;

  if v_actor_team_member_id is null then
    raise exception 'Your signed-in account is not linked to a team member.' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || p_route_id::text, 0)
  );

  select r.*
  into v_route
  from public.routes r
  where r.id = p_route_id
  for update;

  if not found then
    raise exception 'Route was not found.' using errcode = 'P0001';
  end if;

  select b.*
  into v_batch
  from public.route_pickup_batches b
  where b.id = p_pickup_batch_id
    and b.route_id = p_route_id
  for update;

  if not found then
    raise exception 'Pickup batch was not found for this route.' using errcode = 'P0001';
  end if;

  if v_batch.returned_to_assigned_at is not null then
    select count(*)::integer
    into v_pickup_movement_count
    from public.inventory_movements pickup_movement
    where pickup_movement.related_route_id = p_route_id
      and pickup_movement.related_pickup_batch_id = p_pickup_batch_id
      and pickup_movement.reason::text = 'storage_to_operator_bag'
      and pickup_movement.from_entity_type::text = 'storage'
      and pickup_movement.to_entity_type::text = 'operator_bag';

    select
      count(*)::integer,
      coalesce(sum(reverse_movement.quantity::bigint), 0)
    into v_reversal_count, v_reversal_quantity
    from public.inventory_movements pickup_movement
    join public.inventory_movements reverse_movement
      on reverse_movement.reversed_movement_id = pickup_movement.id
     and reverse_movement.product_id = pickup_movement.product_id
     and reverse_movement.quantity = pickup_movement.quantity
     and reverse_movement.from_entity_type::text = 'operator_bag'
     and reverse_movement.from_entity_id = pickup_movement.to_entity_id
     and reverse_movement.to_entity_type::text = 'storage'
     and reverse_movement.to_entity_id = pickup_movement.from_entity_id
     and reverse_movement.reason::text = 'operator_bag_to_storage'
     and reverse_movement.related_route_id = p_route_id
     and reverse_movement.related_pickup_batch_id = p_pickup_batch_id
     and reverse_movement.source_type = 'route_pickup_return'
     and reverse_movement.source_id = p_pickup_batch_id
    where pickup_movement.related_route_id = p_route_id
      and pickup_movement.related_pickup_batch_id = p_pickup_batch_id
      and pickup_movement.reason::text = 'storage_to_operator_bag'
      and pickup_movement.from_entity_type::text = 'storage'
      and pickup_movement.to_entity_type::text = 'operator_bag';

    select count(*)::integer
    into v_return_source_count
    from public.inventory_movements return_movement
    where return_movement.source_type = 'route_pickup_return'
      and return_movement.source_id = p_pickup_batch_id;

    if v_route.status::text <> 'assigned'
      or v_batch.status <> 'cancelled'
      or coalesce(v_batch.storage_deducted, false)
      or v_reversal_count <> v_pickup_movement_count
      or v_return_source_count <> v_reversal_count
      or v_reversal_count <> coalesce(v_batch.returned_to_assigned_movement_count, 0)
      or v_reversal_quantity <> coalesce(v_batch.returned_to_assigned_quantity, 0)::bigint
      or exists (
        select 1
        from public._snacky_route_bag_balances(p_route_id) remaining
        where remaining.signed_quantity <> 0
      )
    then
      raise exception 'The saved pickup return and current route ledger disagree. Repair them explicitly before retrying.' using errcode = 'P0001';
    end if;

    return query
    select
      v_batch.id,
      v_batch.route_id,
      v_route.status,
      v_batch.returned_to_assigned_movement_count,
      v_batch.returned_to_assigned_quantity,
      true;
    return;
  end if;

  if v_route.status::text in ('completed', 'reviewed', 'verified', 'payroll_pending', 'paid', 'disputed', 'cancelled', 'canceled') then
    raise exception 'Completed or cancelled routes cannot be returned to Assigned.' using errcode = 'P0001';
  end if;

  if v_batch.status <> 'confirmed' then
    raise exception 'Only a confirmed, unreturned pickup batch can be returned to Assigned.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_blocked_count
  from public.route_pickup_batches other_batch
  where other_batch.route_id = p_route_id
    and other_batch.status = 'confirmed'
    and other_batch.returned_to_assigned_at is null;

  if v_blocked_count <> 1 then
    raise exception 'This route has multiple active pickup batches. Reconcile them before returning to Assigned.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_blocked_count
  from public.inventory_movements im
  where im.related_route_id = p_route_id
    and not coalesce((
      im.related_pickup_batch_id = p_pickup_batch_id
      and im.reason::text = 'storage_to_operator_bag'
      and im.from_entity_type::text = 'storage'
      and im.to_entity_type::text = 'operator_bag'
    ), false);

  if v_blocked_count > 0 then
    raise exception 'Route inventory activity exists after or outside this pickup. Use route reconciliation instead of returning to Assigned.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_blocked_count
  from public.route_stops rs
  where rs.route_id = p_route_id
    and rs.status::text not in ('pending', 'picked');

  if v_blocked_count > 0 then
    raise exception 'Route stop activity already exists, so this pickup cannot be returned to Assigned.' using errcode = 'P0001';
  end if;

  select
    (select count(*) from public.route_stop_fill_lines fill_line where fill_line.route_id = p_route_id)
    + (select count(*) from public.cash_collections cash_row where cash_row.route_id = p_route_id)
    + (select count(*) from public.route_manual_sales sale where sale.route_id = p_route_id and sale.status <> 'cancelled')
    + (select count(*) from public.route_customer_compensations compensation where compensation.route_id = p_route_id)
    + (select count(*) from public.inventory_adjustments adjustment where adjustment.route_id = p_route_id and adjustment.status <> 'cancelled')
    + (select count(*) from public.machine_refill_history history_row where history_row.route_id = p_route_id)
  into v_blocked_count;

  if v_blocked_count > 0 then
    raise exception 'Field, cash, sale, damage, compensation, or refill history exists. This pickup is no longer pristine.' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_pickup_movement_count
  from public.inventory_movements im
  where im.related_route_id = p_route_id
    and im.related_pickup_batch_id = p_pickup_batch_id
    and im.reason::text = 'storage_to_operator_bag'
    and im.from_entity_type::text = 'storage'
    and im.to_entity_type::text = 'operator_bag';

  if v_batch.storage_deducted and v_pickup_movement_count = 0 then
    raise exception 'Pickup batch says storage was deducted, but no pickup movements exist. Repair the batch before retrying.' using errcode = 'P0001';
  end if;

  if v_pickup_movement_count > 0 then
    select count(*)::integer
    into v_blocked_count
    from public.inventory_movements im
    where im.related_route_id = p_route_id
      and im.related_pickup_batch_id = p_pickup_batch_id
      and im.reason::text = 'storage_to_operator_bag'
      and im.from_entity_type::text = 'storage'
      and im.to_entity_type::text = 'operator_bag'
      and (
        im.from_entity_id is null
        or im.to_entity_id is null
        or im.to_entity_id is distinct from v_batch.operator_id
        or v_batch.operator_id is distinct from v_route.operator_id
      );

    if v_blocked_count > 0 then
      raise exception 'Pickup custody does not match the route operator or source storage. Transfer or reconcile it explicitly.' using errcode = 'P0001';
    end if;
  end if;

  -- Match the canonical route → custody owner → owner/product lock order.
  for v_custody_lock in
    select distinct pickup_movement.to_entity_id as bag_owner_id
    from public.inventory_movements pickup_movement
    where pickup_movement.related_route_id = p_route_id
      and pickup_movement.related_pickup_batch_id = p_pickup_batch_id
      and pickup_movement.reason::text = 'storage_to_operator_bag'
      and pickup_movement.from_entity_type::text = 'storage'
      and pickup_movement.to_entity_type::text = 'operator_bag'
      and pickup_movement.to_entity_id is not null
    order by pickup_movement.to_entity_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-custody:' || v_custody_lock.bag_owner_id::text,
        0
      )
    );
  end loop;

  for v_bag_lock in
    select distinct
      pickup_movement.to_entity_id as bag_owner_id,
      pickup_movement.product_id
    from public.inventory_movements pickup_movement
    where pickup_movement.related_route_id = p_route_id
      and pickup_movement.related_pickup_batch_id = p_pickup_batch_id
      and pickup_movement.reason::text = 'storage_to_operator_bag'
      and pickup_movement.from_entity_type::text = 'storage'
      and pickup_movement.to_entity_type::text = 'operator_bag'
    order by pickup_movement.to_entity_id, pickup_movement.product_id
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'snacky:operator-bag:' || v_bag_lock.bag_owner_id::text || ':' || v_bag_lock.product_id::text,
        0
      )
    );
  end loop;

  -- A pristine route slice can be positive while older unscoped history makes
  -- the operator's global bag balance lower. Removing the exact route pickup
  -- would then either cross below zero or worsen an existing negative balance,
  -- which the global bag invariant correctly rejects. Under the already-held
  -- custody and owner/product locks, align only that impossible lower bound.
  -- Keep the movement outside the route ledger so the exact pickup reversal
  -- still clears route custody, and expose every alignment as an open audited
  -- discrepancy instead of silently rewriting historical rows.
  for v_return_group in
    select
      pickup_movement.to_entity_id as bag_owner_id,
      pickup_movement.product_id,
      pg_catalog.sum(pickup_movement.quantity::bigint)::bigint as route_return_quantity
    from public.inventory_movements pickup_movement
    where pickup_movement.related_route_id = p_route_id
      and pickup_movement.related_pickup_batch_id = p_pickup_batch_id
      and pickup_movement.reason::text = 'storage_to_operator_bag'
      and pickup_movement.from_entity_type::text = 'storage'
      and pickup_movement.to_entity_type::text = 'operator_bag'
    group by pickup_movement.to_entity_id, pickup_movement.product_id
    order by pickup_movement.to_entity_id, pickup_movement.product_id
  loop
    select coalesce(pg_catalog.sum(
      case
        when movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_return_group.bag_owner_id
          then movement.quantity::bigint
        else 0::bigint
      end
      + case
        when movement.from_entity_type::text = 'operator_bag'
          and movement.from_entity_id = v_return_group.bag_owner_id
          then -movement.quantity::bigint
        else 0::bigint
      end
    ), 0::bigint)
    into v_global_bag_balance
    from public.inventory_movements movement
    where movement.product_id = v_return_group.product_id
      and (
        (movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_return_group.bag_owner_id)
        or
        (movement.from_entity_type::text = 'operator_bag'
          and movement.from_entity_id = v_return_group.bag_owner_id)
      );

    v_global_projected_balance := v_global_bag_balance - v_return_group.route_return_quantity;
    v_global_alignment_quantity := greatest(-v_global_projected_balance, 0::bigint);

    if v_global_alignment_quantity > 2147483647 then
      raise exception 'Global operator-bag alignment exceeds the supported inventory range for owner % and product %.',
        v_return_group.bag_owner_id,
        v_return_group.product_id
        using errcode = '22003';
    end if;

    if v_global_alignment_quantity > 0 then
      v_alignment_idempotency_key := 'route-pickup:global-bag-alignment:'
        || p_pickup_batch_id::text
        || ':'
        || v_return_group.bag_owner_id::text
        || ':'
        || v_return_group.product_id::text;
      v_global_alignment_movement_id := null;

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
        v_return_group.product_id,
        v_global_alignment_quantity::integer,
        'adjustment'::public.inventory_entity_type,
        null,
        'operator_bag'::public.inventory_entity_type,
        v_return_group.bag_owner_id,
        'stock_count_adjustment'::public.movement_reason,
        null,
        'route_pickup_global_bag_alignment',
        p_pickup_batch_id,
        v_alignment_idempotency_key,
        v_actor_team_member_id,
        'Audited global operator-bag lower-bound alignment before pristine pickup return'
      )
      on conflict do nothing
      returning id into v_global_alignment_movement_id;

      if v_global_alignment_movement_id is null then
        select movement.id
        into v_global_alignment_movement_id
        from public.inventory_movements movement
        where movement.idempotency_key = v_alignment_idempotency_key
          and movement.product_id = v_return_group.product_id
          and movement.quantity::bigint = v_global_alignment_quantity
          and movement.from_entity_type::text = 'adjustment'
          and movement.from_entity_id is null
          and movement.to_entity_type::text = 'operator_bag'
          and movement.to_entity_id = v_return_group.bag_owner_id
          and movement.related_route_id is null
          and movement.source_type = 'route_pickup_global_bag_alignment'
          and movement.source_id = p_pickup_batch_id
        for update;

        if not found then
          raise exception 'Inventory idempotency conflict while aligning the global operator bag for pickup return.' using errcode = '23505';
        end if;
      end if;

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
      ) values (
        p_route_id,
        null,
        null,
        v_return_group.bag_owner_id,
        v_return_group.product_id,
        'negative_bag_balance',
        v_global_projected_balance::integer,
        0,
        v_global_alignment_quantity::integer,
        v_global_alignment_quantity::integer,
        'open',
        'route_pickup_global_bag_alignment',
        p_pickup_batch_id,
        'route-pickup-global-bag-discrepancy:'
          || p_pickup_batch_id::text
          || ':'
          || v_return_group.bag_owner_id::text
          || ':'
          || v_return_group.product_id::text,
        pg_catalog.jsonb_build_object(
          'pickup_batch_id', p_pickup_batch_id,
          'global_bag_balance_before', v_global_bag_balance,
          'route_return_quantity', v_return_group.route_return_quantity,
          'projected_global_balance_without_alignment', v_global_projected_balance,
          'alignment_quantity', v_global_alignment_quantity,
          'ledger_source', 'all_inventory_movement_endpoints'
        ),
        v_user_id,
        v_actor_team_member_id,
        v_now,
        v_global_alignment_movement_id,
        v_now,
        v_now
      )
      on conflict (idempotency_key) do update
        set recorded_quantity = excluded.recorded_quantity,
            actual_quantity = excluded.actual_quantity,
            difference_quantity = excluded.difference_quantity,
            absolute_quantity = excluded.absolute_quantity,
            status = 'open',
            details = excluded.details,
            resolution_type = null,
            resolution_notes = null,
            resolved_by_user_id = null,
            resolved_by_team_member_id = null,
            resolved_at = null,
            correcting_movement_id = excluded.correcting_movement_id,
            updated_at = excluded.updated_at;
    end if;
  end loop;

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
    reversed_movement_id,
    source_type,
    source_id,
    idempotency_key,
    created_by,
    notes
  )
  select
    pickup_movement.product_id,
    pickup_movement.quantity,
    'operator_bag'::public.inventory_entity_type,
    pickup_movement.to_entity_id,
    'storage'::public.inventory_entity_type,
    pickup_movement.from_entity_id,
    'operator_bag_to_storage'::public.movement_reason,
    p_route_id,
    p_pickup_batch_id,
    pickup_movement.id,
    'route_pickup_return',
    p_pickup_batch_id,
    'route-pickup-return:' || p_pickup_batch_id::text || ':' || pickup_movement.id::text,
    v_actor_team_member_id,
    coalesce(nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''), 'Returned pristine pickup batch to Assigned')
  from public.inventory_movements pickup_movement
  where pickup_movement.related_route_id = p_route_id
    and pickup_movement.related_pickup_batch_id = p_pickup_batch_id
    and pickup_movement.reason::text = 'storage_to_operator_bag'
    and pickup_movement.from_entity_type::text = 'storage'
    and pickup_movement.to_entity_type::text = 'operator_bag'
  order by pickup_movement.created_at, pickup_movement.id
  on conflict do nothing;

  select
    count(*)::integer,
    coalesce(sum(reverse_movement.quantity::bigint), 0)
  into v_reversal_count, v_reversal_quantity
  from public.inventory_movements pickup_movement
  join public.inventory_movements reverse_movement
    on reverse_movement.reversed_movement_id = pickup_movement.id
   and reverse_movement.product_id = pickup_movement.product_id
   and reverse_movement.quantity = pickup_movement.quantity
   and reverse_movement.from_entity_type::text = 'operator_bag'
   and reverse_movement.from_entity_id = pickup_movement.to_entity_id
   and reverse_movement.to_entity_type::text = 'storage'
   and reverse_movement.to_entity_id = pickup_movement.from_entity_id
   and reverse_movement.reason::text = 'operator_bag_to_storage'
   and reverse_movement.related_route_id = p_route_id
   and reverse_movement.related_pickup_batch_id = p_pickup_batch_id
   and reverse_movement.source_type = 'route_pickup_return'
   and reverse_movement.source_id = p_pickup_batch_id
  where pickup_movement.related_route_id = p_route_id
    and pickup_movement.related_pickup_batch_id = p_pickup_batch_id
    and pickup_movement.reason::text = 'storage_to_operator_bag'
    and pickup_movement.from_entity_type::text = 'storage'
    and pickup_movement.to_entity_type::text = 'operator_bag';

  select count(*)::integer
  into v_return_source_count
  from public.inventory_movements return_movement
  where return_movement.source_type = 'route_pickup_return'
    and return_movement.source_id = p_pickup_batch_id;

  if v_reversal_count <> v_pickup_movement_count
    or v_return_source_count <> v_reversal_count
  then
    raise exception 'The pickup batch could not be reversed one-for-one. No return changes were saved.' using errcode = 'P0001';
  end if;

  if v_reversal_quantity > 2147483647 then
    raise exception 'Returned pickup quantity exceeds the supported inventory range.' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public._snacky_route_bag_balances(p_route_id) remaining
    where remaining.signed_quantity <> 0
  ) then
    raise exception 'Pickup reversal did not clear route bag custody. Use route reconciliation instead.' using errcode = 'P0001';
  end if;

  perform public._snacky_sync_route_stock_lines(p_route_id);

  v_route_stop_ids := coalesce(v_batch.selected_stop_ids, '{}'::uuid[]);

  if coalesce(pg_catalog.array_length(v_route_stop_ids, 1), 0) = 0 then
    select coalesce(pg_catalog.array_agg(batch_stop.route_stop_id order by batch_stop.route_stop_id), '{}'::uuid[])
    into v_route_stop_ids
    from public.route_pickup_batch_stops batch_stop
    where batch_stop.pickup_batch_id = p_pickup_batch_id;
  end if;

  if coalesce(pg_catalog.array_length(v_route_stop_ids, 1), 0) = 0 then
    select coalesce(pg_catalog.array_agg(rs.id order by rs.stop_order, rs.id), '{}'::uuid[])
    into v_route_stop_ids
    from public.route_stops rs
    where rs.route_id = p_route_id
      and rs.status::text = 'picked';
  end if;

  select coalesce(pg_catalog.array_agg(distinct rs.machine_id order by rs.machine_id), '{}'::uuid[])
  into v_selected_machine_ids
  from public.route_stops rs
  where rs.route_id = p_route_id
    and rs.id = any(v_route_stop_ids);

  update public.route_stops rs
  set status = 'pending'::public.route_stop_status
  where rs.route_id = p_route_id
    and rs.id = any(v_route_stop_ids)
    and rs.status::text = 'picked';

  update public.route_stop_items stop_item
  set picked_quantity = 0,
      updated_at = v_now
  where stop_item.route_id = p_route_id
    and stop_item.route_stop_id = any(v_route_stop_ids)
    and coalesce(stop_item.picked_quantity, 0) <> 0;

  update public.refill_order_lines refill_line
  set picked_qty = 0
  from public.refill_orders refill_order
  where refill_line.refill_order_id = refill_order.id
    and refill_order.route_id = p_route_id
    and (
      coalesce(pg_catalog.array_length(v_selected_machine_ids, 1), 0) = 0
      or refill_order.machine_id = any(v_selected_machine_ids)
    )
    and coalesce(refill_line.picked_qty, 0) <> 0;

  update public.route_pick_list_items pick_item
  set is_checked = false,
      checked_at = null,
      checked_by = null,
      is_active = true,
      superseded_at = null,
      superseded_reason = null,
      updated_at = v_now
  where pick_item.route_id = p_route_id
    and pick_item.pickup_batch_id = p_pickup_batch_id;

  -- Finalized pickup-batch audit fields may move only through this canonical
  -- return RPC once the exact reversal proof above has been written.
  perform pg_catalog.set_config(
    'snacky.route_pickup_batch_write_mode',
    'pristine_return',
    true
  );

  update public.route_pickup_batches batch_row
  set status = 'cancelled',
      storage_deducted = false,
      returned_to_assigned_at = v_now,
      returned_to_assigned_by = v_actor_team_member_id,
      returned_to_assigned_reason = coalesce(nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''), 'Returned pristine pickup batch to Assigned'),
      returned_to_assigned_movement_count = v_reversal_count,
      returned_to_assigned_quantity = v_reversal_quantity::integer,
      updated_at = v_now
  where batch_row.id = p_pickup_batch_id;

  perform pg_catalog.set_config(
    'snacky.route_pickup_batch_write_mode',
    '',
    true
  );

  -- Release inside the canonical route -> pickup-batch transaction. A batch
  -- AFTER trigger would start from a batch row lock and then acquire the route
  -- lock, inverting this RPC's order and creating a deadlock path. Keep the
  -- lookup dynamic so this earlier migration remains deployable before the
  -- custody-lease migration is installed.
  if pg_catalog.to_regprocedure(
    'public._snacky_release_operator_route_custody(uuid,uuid,text,uuid)'
  ) is not null and v_route.operator_id is not null then
    execute 'select public._snacky_release_operator_route_custody($1, $2, $3, $4)'
    into v_custody_released
    using v_route.operator_id, p_route_id, 'pristine_pickup_return', p_pickup_batch_id;

    if v_pickup_movement_count > 0 and not coalesce(v_custody_released, false) then
      raise exception 'Pristine pickup returned, but its operator custody lease was missing.' using errcode = '23514';
    end if;
  end if;

  update public.routes r
  set status = 'assigned'::public.route_status,
      started_at = null
  where r.id = p_route_id;

  return query
  select
    p_pickup_batch_id,
    p_route_id,
    'assigned'::public.route_status,
    v_reversal_count,
    v_reversal_quantity::integer,
    false;
end;
$$;

revoke all on function public.return_pickup_batch_to_assigned(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.return_pickup_batch_to_assigned(uuid, uuid, text) to authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');
