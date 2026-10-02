-- Finalizes the non-inventory projections of a route stop in one transaction.
-- Inventory is committed first by snacky_commit_route_stop_inventory_v1. Cash,
-- issue, and photo records are then saved idempotently by the server action.
-- This function is the final commit marker: a stop cannot become completed
-- while its route/refill-order status updates are only partially saved.

alter table public.route_stop_inventory_commits
  add column if not exists workflow_payload_hash text;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.route_stop_inventory_commits'::pg_catalog.regclass
      and constraint_row.conname = 'route_stop_inventory_commits_workflow_payload_hash_check'
  ) then
    alter table public.route_stop_inventory_commits
      add constraint route_stop_inventory_commits_workflow_payload_hash_check
      check (workflow_payload_hash is null or workflow_payload_hash ~ '^[0-9a-f]{32}$');
  end if;
end;
$migration$;

-- Skipping is a separate operator action, so it cannot share the RPC's
-- transaction. Enforce the invariant at the table boundary: after any atomic
-- inventory commit (including a zero-fill receipt), the stop must be recovered
-- through completion or supervisor reconciliation, never hidden as skipped.
create or replace function public.snacky_guard_route_stop_skip_after_inventory_commit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status::text in ('skipped', 'canceled', 'cancelled')
    and old.status::text not in ('completed', 'skipped', 'canceled', 'cancelled')
    and exists (
      select 1
      from public.route_stop_inventory_commits receipt
      where receipt.route_stop_id = new.id
    )
  then
    raise exception 'This stop already posted inventory and cannot be skipped. Retry completion or reconcile it.'
      using errcode = '23514';
  end if;

  return new;
end;
$function$;

revoke all on function public.snacky_guard_route_stop_skip_after_inventory_commit()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_guard_route_stop_skip_after_inventory_commit
  on public.route_stops;
create trigger snacky_guard_route_stop_skip_after_inventory_commit
before update of status on public.route_stops
for each row
when (old.status is distinct from new.status)
execute function public.snacky_guard_route_stop_skip_after_inventory_commit();

-- A route-stop write through the authenticated Data API must not be able to
-- bypass cash/issue/photo persistence by setting status = completed directly.
-- The finalizer sets a transaction-local receipt marker only after it has
-- locked and verified the authoritative inventory receipt. Historical rows
-- that are already completed are unaffected.
create or replace function public.snacky_guard_route_stop_completion_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_receipt record;
  v_expected_marker text;
  v_actual_marker text := pg_catalog.current_setting('snacky.route_stop_completion_marker', true);
begin
  if new.status::text = 'completed'
    and old.status::text is distinct from 'completed'
  then
    select
      receipt.id,
      receipt.route_id,
      receipt.machine_id,
      receipt.latest_submission_id
    into v_receipt
    from public.route_stop_inventory_commits receipt
    where receipt.route_stop_id = new.id;

    if not found
      or v_receipt.route_id is distinct from new.route_id
      or v_receipt.machine_id is distinct from new.machine_id
    then
      raise exception 'Stop inventory must be committed before the stop can be completed.'
        using errcode = '23514';
    end if;

    v_expected_marker := v_receipt.id::text || ':' || v_receipt.latest_submission_id;
    if v_actual_marker is distinct from v_expected_marker then
      raise exception 'Route stops must be completed through the protected completion workflow.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.snacky_guard_route_stop_completion_receipt()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_guard_route_stop_completion_receipt
  on public.route_stops;
create trigger snacky_guard_route_stop_completion_receipt
before update of status on public.route_stops
for each row
when (old.status is distinct from new.status)
execute function public.snacky_guard_route_stop_completion_receipt();

-- Completed, skipped, and canceled stops are immutable audit outcomes. A
-- correction is a new ledger/review event; it must never rewrite or delete the
-- historical stop that produced it.
create or replace function public.snacky_guard_terminal_route_stop_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.status::text in ('completed', 'skipped', 'canceled', 'cancelled') then
    if tg_op = 'DELETE' then
      raise exception 'Completed, skipped, or canceled route stops cannot be deleted.'
        using errcode = '23514';
    end if;

    if new is distinct from old then
      raise exception 'Completed, skipped, or canceled route stops are immutable.'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function public.snacky_guard_terminal_route_stop_immutable()
  from public, anon, authenticated, service_role;

drop trigger if exists snacky_guard_00_terminal_route_stop_immutable
  on public.route_stops;
create trigger snacky_guard_00_terminal_route_stop_immutable
before update or delete on public.route_stops
for each row
execute function public.snacky_guard_terminal_route_stop_immutable();

create or replace function public.snacky_finalize_route_stop_workflow_v1(
  p_route_id uuid,
  p_route_stop_id uuid,
  p_machine_id uuid,
  p_completed_at timestamptz,
  p_notes text,
  p_client_submission_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_submission_id text := nullif(pg_catalog.btrim(coalesce(p_client_submission_id, '')), '');
  v_completed_at timestamptz;
  v_route record;
  v_stop record;
  v_inventory_receipt record;
  v_refill_order_count integer := 0;
  v_already_completed boolean := false;
  v_workflow_payload_hash text;
begin
  if p_route_id is null or p_route_stop_id is null or p_machine_id is null then
    raise exception 'Route, route stop, and machine are required.' using errcode = '22023';
  end if;

  if v_submission_id is null or length(v_submission_id) > 200 then
    raise exception 'A submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  v_workflow_payload_hash := pg_catalog.md5(
    p_route_id::text
    || pg_catalog.chr(31) || p_route_stop_id::text
    || pg_catalog.chr(31) || p_machine_id::text
    || pg_catalog.chr(31) || coalesce(extract(epoch from p_completed_at)::text, '')
    || pg_catalog.chr(31) || coalesce(p_notes, '')
    || pg_catalog.chr(31) || v_submission_id
  );

  -- Share the same lock namespace as stop inventory and terminal route
  -- reconciliation so completion cannot race cancellation or bag finalization.
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

  select
    receipt.id,
    receipt.route_id,
    receipt.route_stop_id,
    receipt.machine_id,
    receipt.operator_id,
    receipt.latest_submission_id,
    receipt.committed_at,
    receipt.workflow_completed_at,
    receipt.workflow_payload_hash
  into v_inventory_receipt
  from public.route_stop_inventory_commits receipt
  where receipt.route_stop_id = p_route_stop_id
  for update;

  if not found then
    raise exception 'Stop inventory must be committed before the stop workflow can complete.'
      using errcode = '23514';
  end if;

  if v_inventory_receipt.route_id is distinct from p_route_id
    or v_inventory_receipt.route_stop_id is distinct from p_route_stop_id
    or v_inventory_receipt.machine_id is distinct from p_machine_id
    or v_inventory_receipt.operator_id is distinct from v_route.operator_id
  then
    raise exception 'The latest stop inventory receipt does not match this route, stop, machine, and operator.'
      using errcode = '23514';
  end if;

  if v_inventory_receipt.latest_submission_id is distinct from v_submission_id then
    raise exception 'The latest stop inventory receipt belongs to another submission. Reload and retry.'
      using errcode = '40001';
  end if;

  select rs.id, rs.route_id, rs.machine_id, rs.status, rs.completed_at
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

  -- Lost-response replays are checked before terminal-route rejection. They
  -- are read-only and succeed only for the exact immutable workflow payload.
  if v_inventory_receipt.workflow_completed_at is not null
    or v_stop.status::text = 'completed'
  then
    if v_inventory_receipt.workflow_completed_at is null
      or v_stop.status::text <> 'completed'
    then
      raise exception 'Stop completion state is inconsistent. Reconcile this stop before retrying.'
        using errcode = '23514';
    end if;

    if v_inventory_receipt.latest_submission_id is distinct from v_submission_id
      or v_inventory_receipt.workflow_payload_hash is distinct from v_workflow_payload_hash
    then
      raise exception 'Completed stop workflow cannot be replaced by a different payload.'
        using errcode = '23514';
    end if;

    return pg_catalog.jsonb_build_object(
      'contract_version', 1,
      'route_id', p_route_id,
      'route_stop_id', p_route_stop_id,
      'machine_id', p_machine_id,
      'submission_id', v_submission_id,
      'inventory_commit_receipt_id', v_inventory_receipt.id,
      'inventory_committed_at', v_inventory_receipt.committed_at,
      'completed_at', v_stop.completed_at,
      'stop_status', 'completed',
      'route_status', v_route.status::text,
      'refill_orders_updated', 0,
      'already_completed', true
    );
  end if;

  if v_inventory_receipt.workflow_payload_hash is not null then
    raise exception 'An unfinished stop receipt already contains another workflow payload.'
      using errcode = '40001';
  end if;

  if v_route.status::text not in (
    'in_progress',
    'pickup_confirmed',
    'started',
    'filling',
    'machine_filling'
  ) then
    raise exception 'Route status does not allow stop completion: %.', v_route.status::text
      using errcode = '23514';
  end if;

  if v_stop.status::text not in (
    'picked',
    'in_progress',
    'arrived',
    'refilling',
    'cash_collected',
    'issue_reported'
  ) then
    raise exception 'Stop status does not allow completion: %.', v_stop.status::text
      using errcode = '23514';
  end if;

  v_already_completed := v_stop.status::text = 'completed';
  v_completed_at := coalesce(
    v_stop.completed_at,
    v_inventory_receipt.committed_at,
    p_completed_at,
    pg_catalog.now()
  );

  update public.refill_orders ro
  set
    status = 'completed'::public.refill_status,
    completed_at = coalesce(ro.completed_at, v_completed_at)
  where ro.route_id = p_route_id
    and ro.machine_id = p_machine_id
    and ro.status::text not in ('completed', 'cancelled');
  get diagnostics v_refill_order_count = row_count;

  update public.routes r
  set status = 'in_progress'::public.route_status
  where r.id = p_route_id
    and r.status::text <> 'in_progress';

  perform pg_catalog.set_config(
    'snacky.route_stop_completion_marker',
    v_inventory_receipt.id::text || ':' || v_submission_id,
    true
  );

  update public.route_stops rs
  set
    status = 'completed'::public.route_stop_status,
    completed_at = v_completed_at,
    notes = p_notes
  where rs.id = p_route_stop_id;

  perform pg_catalog.set_config('snacky.route_stop_completion_marker', '', true);

  update public.route_stop_inventory_commits receipt
  set
    workflow_payload_hash = v_workflow_payload_hash,
    workflow_completed_at = coalesce(receipt.workflow_completed_at, pg_catalog.now()),
    updated_at = pg_catalog.now()
  where receipt.id = v_inventory_receipt.id;

  return pg_catalog.jsonb_build_object(
    'contract_version', 1,
    'route_id', p_route_id,
    'route_stop_id', p_route_stop_id,
    'machine_id', p_machine_id,
    'submission_id', v_submission_id,
    'inventory_commit_receipt_id', v_inventory_receipt.id,
    'inventory_committed_at', v_inventory_receipt.committed_at,
    'completed_at', v_completed_at,
    'stop_status', 'completed',
    'route_status', 'in_progress',
    'refill_orders_updated', v_refill_order_count,
    'already_completed', v_already_completed
  );
end;
$function$;

comment on function public.snacky_finalize_route_stop_workflow_v1(uuid, uuid, uuid, timestamptz, text, text)
is 'Server-internal final commit marker for route-stop status projections. Atomically completes the stop and its refill orders after idempotent side effects have saved.';

revoke all on function public.snacky_finalize_route_stop_workflow_v1(uuid, uuid, uuid, timestamptz, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.snacky_finalize_route_stop_workflow_v1(uuid, uuid, uuid, timestamptz, text, text)
  to service_role;

select pg_notify('pgrst', 'reload schema');
