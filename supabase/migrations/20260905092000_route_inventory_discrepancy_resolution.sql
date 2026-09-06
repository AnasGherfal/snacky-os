-- Audited manager review for route inventory discrepancies.
--
-- This migration intentionally does not create inventory movements. A manager
-- may accept a variance only after an existing, route-scoped correcting
-- movement has already reconciled the ledger. Physical inventory corrections
-- stay inside their dedicated atomic inventory RPCs.

create unique index if not exists idx_route_inventory_discrepancies_id_route
  on public.route_inventory_discrepancies(id, route_id);

create table if not exists public.route_inventory_discrepancy_resolution_events (
  id uuid primary key default gen_random_uuid(),
  discrepancy_id uuid not null,
  route_id uuid not null,
  action text not null,
  previous_status text not null,
  next_status text not null,
  notes text,
  client_submission_id text not null,
  evidence_movement_id uuid references public.inventory_movements(id) on delete set null,
  previous_resolution_type text,
  previous_resolved_at timestamptz,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_team_member_id uuid references public.team_members(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint route_inventory_discrepancy_resolution_events_action_check
    check (action in (
      'start_investigation',
      'accept_reconciled_variance',
      'reopen',
      'system_reconciled',
      'system_reopened',
      'system_transition'
    )),
  constraint route_inventory_discrepancy_resolution_events_previous_status_check
    check (previous_status in ('open', 'investigating', 'resolved', 'accepted_loss', 'voided')),
  constraint route_inventory_discrepancy_resolution_events_next_status_check
    check (next_status in ('open', 'investigating', 'resolved', 'accepted_loss', 'voided')),
  constraint route_inventory_discrepancy_resolution_events_submission_check
    check (btrim(client_submission_id) <> '' and length(client_submission_id) <= 200),
  constraint route_inventory_discrepancy_resolution_events_notes_length_check
    check (notes is null or length(notes) <= 2000),
  constraint route_inventory_discrepancy_resolution_events_notes_check
    check (
      action = 'start_investigation'
      or nullif(btrim(coalesce(notes, '')), '') is not null
    ),
  constraint route_inventory_discrepancy_resolution_events_submission_key
    unique (client_submission_id),
  constraint route_inventory_discrepancy_resolution_events_case_route_fkey
    foreign key (discrepancy_id, route_id)
    references public.route_inventory_discrepancies(id, route_id)
    on delete restrict
);

create index if not exists idx_route_inventory_discrepancies_review_queue
  on public.route_inventory_discrepancies(status, detected_at desc);

create index if not exists idx_route_inventory_discrepancy_resolution_events_case
  on public.route_inventory_discrepancy_resolution_events(discrepancy_id, created_at desc);

create index if not exists idx_route_inventory_discrepancy_resolution_events_route
  on public.route_inventory_discrepancy_resolution_events(route_id, created_at desc);

alter table public.route_inventory_discrepancy_resolution_events enable row level security;

revoke all on table public.route_inventory_discrepancy_resolution_events from public, anon, authenticated;
grant select on table public.route_inventory_discrepancy_resolution_events to authenticated;
grant select, insert on table public.route_inventory_discrepancy_resolution_events to service_role;

drop policy if exists "snacky_route_inventory_discrepancy_resolution_events_select"
  on public.route_inventory_discrepancy_resolution_events;
create policy "snacky_route_inventory_discrepancy_resolution_events_select"
on public.route_inventory_discrepancy_resolution_events
for select
to authenticated
using (
  (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']))
);

create or replace function public._snacky_reject_route_inventory_resolution_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'Route inventory discrepancy resolution history is append-only.' using errcode = '42501';
end;
$$;

revoke all on function public._snacky_reject_route_inventory_resolution_event_mutation()
  from public, anon, authenticated;

drop trigger if exists trg_snacky_route_inventory_resolution_events_append_only
  on public.route_inventory_discrepancy_resolution_events;
create trigger trg_snacky_route_inventory_resolution_events_append_only
before update or delete on public.route_inventory_discrepancy_resolution_events
for each row execute function public._snacky_reject_route_inventory_resolution_event_mutation();

-- Stop inventory edits can automatically reopen or reconcile a case. Preserve
-- those changes in the same append-only history as manager decisions. The
-- manager RPC sets a transaction-local discrepancy id so its explicit event is
-- not duplicated by this trigger.
create or replace function public._snacky_audit_route_inventory_discrepancy_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_notes text;
begin
  if pg_catalog.current_setting('snacky.route_inventory_review_discrepancy_id', true) = new.id::text then
    return new;
  end if;

  v_action := case
    when new.status = 'resolved' then 'system_reconciled'
    when new.status = 'open' then 'system_reopened'
    else 'system_transition'
  end;
  v_notes := coalesce(
    nullif(pg_catalog.btrim(coalesce(new.resolution_notes, '')), ''),
    pg_catalog.format('Authoritative inventory workflow changed the review status from %s to %s.', old.status, new.status)
  );

  insert into public.route_inventory_discrepancy_resolution_events (
    discrepancy_id,
    route_id,
    action,
    previous_status,
    next_status,
    notes,
    client_submission_id,
    evidence_movement_id,
    previous_resolution_type,
    previous_resolved_at,
    actor_user_id,
    actor_team_member_id,
    created_at
  ) values (
    new.id,
    new.route_id,
    v_action,
    old.status,
    new.status,
    pg_catalog.left(v_notes, 2000),
    'route-discrepancy-system:' || new.id::text || ':' || pg_catalog.gen_random_uuid()::text,
    new.correcting_movement_id,
    old.resolution_type,
    old.resolved_at,
    auth.uid(),
    public.snacky_current_team_member_id(),
    pg_catalog.clock_timestamp()
  );

  return new;
end;
$$;

revoke all on function public._snacky_audit_route_inventory_discrepancy_status_change()
  from public, anon, authenticated;

drop trigger if exists trg_snacky_route_inventory_discrepancy_status_audit
  on public.route_inventory_discrepancies;
create trigger trg_snacky_route_inventory_discrepancy_status_audit
after update of status on public.route_inventory_discrepancies
for each row
when (old.status is distinct from new.status)
execute function public._snacky_audit_route_inventory_discrepancy_status_change();

create or replace function public.snacky_resolve_route_inventory_discrepancy_v1(
  p_discrepancy_id uuid,
  p_action text,
  p_notes text default null,
  p_client_submission_id text default null,
  p_expected_updated_at timestamptz default null
)
returns table (
  reviewed_discrepancy_id uuid,
  discrepancy_status text,
  review_action text,
  already_applied boolean,
  reviewed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := auth.uid();
  v_actor_team_member_id uuid;
  v_action text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_action, '')));
  v_notes text := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_submission_id text := pg_catalog.btrim(coalesce(p_client_submission_id, ''));
  v_discrepancy public.route_inventory_discrepancies%rowtype;
  v_route_id uuid;
  v_existing public.route_inventory_discrepancy_resolution_events%rowtype;
  v_previous_status text;
  v_next_status text;
  v_line_id uuid;
  v_reconciliation_id uuid;
  v_line_adjustment_movement_id uuid;
  v_evidence_movement_id uuid;
  v_evidence_quantity bigint := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if v_actor_user_id is null then
    raise exception 'You must be signed in to review route inventory discrepancies.' using errcode = '42501';
  end if;

  if not (select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor'])) then
    raise exception 'Only an owner, admin, or supervisor can review route inventory discrepancies.' using errcode = '42501';
  end if;

  if p_discrepancy_id is null then
    raise exception 'Discrepancy id is required.' using errcode = 'P0001';
  end if;

  if v_action not in ('start_investigation', 'accept_reconciled_variance', 'reopen') then
    raise exception 'Unsupported discrepancy review action.' using errcode = '22023';
  end if;

  if v_submission_id = '' or pg_catalog.length(v_submission_id) > 200 then
    raise exception 'A client submission id between 1 and 200 characters is required.' using errcode = '22023';
  end if;

  if pg_catalog.length(coalesce(v_notes, '')) > 2000 then
    raise exception 'Review notes cannot exceed 2000 characters.' using errcode = '22023';
  end if;

  if v_action in ('accept_reconciled_variance', 'reopen') and v_notes is null then
    raise exception 'Review notes are required for this action.' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_submission_id, 0));

  select event_row.*
  into v_existing
  from public.route_inventory_discrepancy_resolution_events event_row
  where event_row.client_submission_id = v_submission_id;

  if found then
    if v_existing.discrepancy_id <> p_discrepancy_id
       or v_existing.action <> v_action
       or coalesce(v_existing.notes, '') <> coalesce(v_notes, '') then
      raise exception 'This submission id was already used for a different discrepancy review.' using errcode = '23505';
    end if;

    v_route_id := v_existing.route_id;
  else
    select discrepancy_row.route_id
    into v_route_id
    from public.route_inventory_discrepancies discrepancy_row
    where discrepancy_row.id = p_discrepancy_id;

    if not found then
      raise exception 'Route inventory discrepancy was not found.' using errcode = 'P0002';
    end if;
  end if;

  -- Use the same route lock namespace as stop posting and terminal
  -- reconciliation. This prevents a resolution racing route finalization and
  -- leaving the reconciliation header stale.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('snacky:route-inventory:' || v_route_id::text, 0)
  );

  select discrepancy_row.*
  into v_discrepancy
  from public.route_inventory_discrepancies discrepancy_row
  where discrepancy_row.id = p_discrepancy_id
  for update;

  if not found then
    raise exception 'Route inventory discrepancy was not found.' using errcode = 'P0002';
  end if;

  if v_discrepancy.route_id is distinct from v_route_id then
    raise exception 'The discrepancy review event and current route disagree.' using errcode = '23514';
  end if;

  if v_existing.id is not null then
    if v_discrepancy.status is distinct from v_existing.next_status then
      raise exception 'This review was applied before the discrepancy changed again. Refresh and review the current state.' using errcode = '40001';
    end if;

    return query
    select
      v_existing.discrepancy_id,
      v_discrepancy.status,
      v_existing.action,
      true,
      v_existing.created_at;
    return;
  end if;

  if p_expected_updated_at is not null
     and v_discrepancy.updated_at is distinct from p_expected_updated_at then
    raise exception 'This discrepancy changed after the page loaded. Refresh and review the latest state.' using errcode = '40001';
  end if;

  v_actor_team_member_id := public.snacky_current_team_member_id();
  v_previous_status := v_discrepancy.status;

  select
    reconciliation_line.id,
    reconciliation_line.reconciliation_id,
    reconciliation_line.adjustment_movement_id
  into
    v_line_id,
    v_reconciliation_id,
    v_line_adjustment_movement_id
  from public.route_inventory_reconciliation_lines reconciliation_line
  where reconciliation_line.discrepancy_id = v_discrepancy.id
  for update;

  if v_reconciliation_id is null then
    select reconciliation.id
    into v_reconciliation_id
    from public.route_inventory_reconciliations reconciliation
    where reconciliation.route_id = v_discrepancy.route_id
    for update;
  end if;

  perform pg_catalog.set_config(
    'snacky.route_inventory_review_discrepancy_id',
    v_discrepancy.id::text,
    true
  );

  if v_action = 'start_investigation' then
    if v_discrepancy.status <> 'open' then
      raise exception 'Only an open discrepancy can be moved into investigation.' using errcode = 'P0001';
    end if;

    v_next_status := 'investigating';

    update public.route_inventory_discrepancies
    set status = v_next_status,
        updated_at = v_now
    where id = v_discrepancy.id;

    if v_line_id is not null then
      update public.route_inventory_reconciliation_lines
      set review_status = 'investigating',
          updated_at = v_now
      where id = v_line_id;

      update public.route_inventory_reconciliations
      set status = 'needs_review',
          updated_at = v_now
      where id = v_reconciliation_id;
    end if;

  elsif v_action = 'accept_reconciled_variance' then
    if v_discrepancy.status not in ('open', 'investigating') then
      raise exception 'Only an open or investigating discrepancy can be accepted.' using errcode = 'P0001';
    end if;

    -- A linked movement id by itself is not evidence: it must belong to the
    -- authoritative workflow that created this exact discrepancy, have the
    -- expected endpoints and quantity, and still be effective in the ledger.
    if v_discrepancy.source_type = 'route_terminal_reconciliation_line' then
      if v_line_id is null
         or v_discrepancy.source_id is distinct from v_line_id
         or v_discrepancy.operator_id is null
         or v_discrepancy.difference_quantity = 0
         or v_discrepancy.absolute_quantity <= 0 then
        raise exception 'Terminal discrepancy provenance is incomplete. Reconcile inventory before accepting this variance.' using errcode = '23514';
      end if;

      if v_line_adjustment_movement_id is not null
         and v_discrepancy.correcting_movement_id is not null
         and v_line_adjustment_movement_id is distinct from v_discrepancy.correcting_movement_id then
        raise exception 'Terminal discrepancy evidence pointers disagree. Reconcile inventory before accepting this variance.' using errcode = '23514';
      end if;

      v_evidence_movement_id := coalesce(
        v_line_adjustment_movement_id,
        v_discrepancy.correcting_movement_id
      );

      -- Freeze both the forward evidence and any existing reversal. A new
      -- reversal must take a foreign-key key lock on the forward row, which
      -- conflicts with this FOR UPDATE lock until the review commits.
      perform movement.id
      from public.inventory_movements movement
      where movement.id = v_evidence_movement_id
      for update;

      perform reversal.id
      from public.inventory_movements reversal
      where reversal.reversed_movement_id = v_evidence_movement_id
      order by reversal.id
      for update;

      if v_evidence_movement_id is null
         or not exists (
           select 1
           from public.inventory_movements movement
           where movement.id = v_evidence_movement_id
             and movement.related_route_id = v_discrepancy.route_id
             and movement.related_route_stop_id is null
             and movement.related_machine_id is null
             and movement.product_id = v_discrepancy.product_id
             and movement.source_type = 'route_terminal_reconciliation'
             and movement.source_id = v_line_id
             and movement.quantity::bigint = v_discrepancy.absolute_quantity::bigint
             and (
               (
                 v_discrepancy.difference_quantity > 0
                 and movement.from_entity_type::text = 'adjustment'
                 and movement.from_entity_id is null
                 and movement.to_entity_type::text = 'operator_bag'
                 and movement.to_entity_id = v_discrepancy.operator_id
               )
               or (
                 v_discrepancy.difference_quantity < 0
                 and movement.from_entity_type::text = 'operator_bag'
                 and movement.from_entity_id = v_discrepancy.operator_id
                 and movement.to_entity_type::text = 'adjustment'
                 and movement.to_entity_id is null
               )
             )
             and not exists (
               select 1
               from public.inventory_movements reversal
               where reversal.reversed_movement_id = movement.id
             )
         ) then
        raise exception 'The ledger has no exact terminal correcting movement. Reconcile inventory before accepting this variance.' using errcode = '23514';
      end if;

    elsif v_discrepancy.source_type = 'route_terminal_global_bag_alignment' then
      v_evidence_movement_id := v_discrepancy.correcting_movement_id;

      if v_discrepancy.operator_id is null
         or v_discrepancy.route_stop_id is not null
         or v_discrepancy.machine_id is not null
         or v_discrepancy.discrepancy_type <> 'negative_bag_balance'
         or v_discrepancy.recorded_quantity >= 0
         or v_discrepancy.actual_quantity <> 0
         or v_discrepancy.difference_quantity <= 0
         or v_discrepancy.absolute_quantity <= 0
         or not exists (
           select 1
           from public.route_inventory_reconciliation_lines source_line
           where source_line.id = v_discrepancy.source_id
             and source_line.route_id = v_discrepancy.route_id
             and source_line.bag_owner_id = v_discrepancy.operator_id
             and source_line.product_id = v_discrepancy.product_id
         ) then
        raise exception 'Global operator-bag alignment provenance is incomplete. Reconcile inventory before accepting this variance.' using errcode = '23514';
      end if;

      perform movement.id
      from public.inventory_movements movement
      where movement.id = v_evidence_movement_id
      for update;

      perform reversal.id
      from public.inventory_movements reversal
      where reversal.reversed_movement_id = v_evidence_movement_id
      order by reversal.id
      for update;

      if v_evidence_movement_id is null
         or not exists (
           select 1
           from public.inventory_movements movement
           where movement.id = v_evidence_movement_id
             and movement.related_route_id is null
             and movement.related_route_stop_id is null
             and movement.related_machine_id is null
             and movement.product_id = v_discrepancy.product_id
             and movement.source_type = 'route_terminal_global_bag_alignment'
             and movement.source_id = v_discrepancy.source_id
             and movement.quantity::bigint = v_discrepancy.absolute_quantity::bigint
             and movement.from_entity_type::text = 'adjustment'
             and movement.from_entity_id is null
             and movement.to_entity_type::text = 'operator_bag'
             and movement.to_entity_id = v_discrepancy.operator_id
             and not exists (
               select 1
               from public.inventory_movements reversal
               where reversal.reversed_movement_id = movement.id
             )
         ) then
        raise exception 'The ledger has no exact global operator-bag alignment movement. Reconcile inventory before accepting this variance.' using errcode = '23514';
      end if;

    elsif v_discrepancy.source_type = 'route_pickup_global_bag_alignment' then
      v_evidence_movement_id := v_discrepancy.correcting_movement_id;

      if v_discrepancy.operator_id is null
         or v_discrepancy.route_stop_id is not null
         or v_discrepancy.machine_id is not null
         or v_discrepancy.discrepancy_type <> 'negative_bag_balance'
         or v_discrepancy.recorded_quantity >= 0
         or v_discrepancy.actual_quantity <> 0
         or v_discrepancy.difference_quantity <= 0
         or v_discrepancy.absolute_quantity <= 0 then
        raise exception 'Pristine-return bag alignment provenance is incomplete. Repair the pickup return before accepting this variance.' using errcode = '23514';
      end if;

      -- Freeze the pickup proof as well as the unscoped alignment and every
      -- reversal that could make either movement ineffective. The route
      -- advisory lock serializes canonical route workflows; these row locks
      -- also serialize direct reviewed corrections that use reversal FKs.
      perform batch_row.id
      from public.route_pickup_batches batch_row
      where batch_row.id = v_discrepancy.source_id
      for share;

      perform movement.id
      from public.inventory_movements movement
      where movement.id = v_evidence_movement_id
      for update;

      perform reversal.id
      from public.inventory_movements reversal
      where reversal.reversed_movement_id = v_evidence_movement_id
      order by reversal.id
      for update;

      perform pickup.id
      from public.inventory_movements pickup
      where pickup.related_route_id = v_discrepancy.route_id
        and pickup.related_pickup_batch_id = v_discrepancy.source_id
        and pickup.product_id = v_discrepancy.product_id
        and pickup.reason::text = 'storage_to_operator_bag'
        and pickup.from_entity_type::text = 'storage'
        and pickup.to_entity_type::text = 'operator_bag'
        and pickup.to_entity_id = v_discrepancy.operator_id
      order by pickup.id
      for update;

      perform return_movement.id
      from public.inventory_movements return_movement
      where return_movement.related_route_id = v_discrepancy.route_id
        and return_movement.related_pickup_batch_id = v_discrepancy.source_id
        and return_movement.product_id = v_discrepancy.product_id
        and return_movement.from_entity_type::text = 'operator_bag'
        and return_movement.from_entity_id = v_discrepancy.operator_id
        and return_movement.to_entity_type::text = 'storage'
        and return_movement.reason::text = 'operator_bag_to_storage'
        and return_movement.source_type = 'route_pickup_return'
        and return_movement.source_id = v_discrepancy.source_id
      order by return_movement.id
      for update;

      perform reversal.id
      from public.inventory_movements reversal
      where reversal.reversed_movement_id in (
        select return_movement.id
        from public.inventory_movements return_movement
        where return_movement.related_route_id = v_discrepancy.route_id
          and return_movement.related_pickup_batch_id = v_discrepancy.source_id
          and return_movement.product_id = v_discrepancy.product_id
          and return_movement.from_entity_type::text = 'operator_bag'
          and return_movement.from_entity_id = v_discrepancy.operator_id
          and return_movement.to_entity_type::text = 'storage'
          and return_movement.reason::text = 'operator_bag_to_storage'
          and return_movement.source_type = 'route_pickup_return'
          and return_movement.source_id = v_discrepancy.source_id
      )
      order by reversal.id
      for update;

      if v_evidence_movement_id is null
         or not exists (
           select 1
           from public.route_pickup_batches batch_row
           where batch_row.id = v_discrepancy.source_id
             and batch_row.route_id = v_discrepancy.route_id
             and batch_row.operator_id = v_discrepancy.operator_id
             and batch_row.status = 'cancelled'
             and batch_row.returned_to_assigned_at is not null
             and not coalesce(batch_row.storage_deducted, false)
         )
         or not exists (
           select 1
           from public.inventory_movements movement
           where movement.id = v_evidence_movement_id
             and movement.related_route_id is null
             and movement.related_route_stop_id is null
             and movement.related_machine_id is null
             and movement.product_id = v_discrepancy.product_id
             and movement.source_type = 'route_pickup_global_bag_alignment'
             and movement.source_id = v_discrepancy.source_id
             and movement.quantity::bigint = v_discrepancy.absolute_quantity::bigint
             and movement.from_entity_type::text = 'adjustment'
             and movement.from_entity_id is null
             and movement.to_entity_type::text = 'operator_bag'
             and movement.to_entity_id = v_discrepancy.operator_id
             and not exists (
               select 1
               from public.inventory_movements reversal
               where reversal.reversed_movement_id = movement.id
             )
         )
         or not exists (
           select 1
           from public.inventory_movements pickup
           where pickup.related_route_id = v_discrepancy.route_id
             and pickup.related_pickup_batch_id = v_discrepancy.source_id
             and pickup.product_id = v_discrepancy.product_id
             and pickup.reason::text = 'storage_to_operator_bag'
             and pickup.from_entity_type::text = 'storage'
             and pickup.to_entity_type::text = 'operator_bag'
             and pickup.to_entity_id = v_discrepancy.operator_id
         )
         or exists (
           select 1
           from public.inventory_movements pickup
           where pickup.related_route_id = v_discrepancy.route_id
             and pickup.related_pickup_batch_id = v_discrepancy.source_id
             and pickup.product_id = v_discrepancy.product_id
             and pickup.reason::text = 'storage_to_operator_bag'
             and pickup.from_entity_type::text = 'storage'
             and pickup.to_entity_type::text = 'operator_bag'
             and pickup.to_entity_id = v_discrepancy.operator_id
             and not exists (
               select 1
               from public.inventory_movements return_movement
               where return_movement.reversed_movement_id = pickup.id
                 and return_movement.product_id = pickup.product_id
                 and return_movement.quantity = pickup.quantity
                 and return_movement.from_entity_type::text = 'operator_bag'
                 and return_movement.from_entity_id = pickup.to_entity_id
                 and return_movement.to_entity_type::text = 'storage'
                 and return_movement.to_entity_id = pickup.from_entity_id
                 and return_movement.reason::text = 'operator_bag_to_storage'
                 and return_movement.related_route_id = v_discrepancy.route_id
                 and return_movement.related_pickup_batch_id = v_discrepancy.source_id
                 and return_movement.source_type = 'route_pickup_return'
                 and return_movement.source_id = v_discrepancy.source_id
                 and not exists (
                   select 1
                   from public.inventory_movements return_reversal
                   where return_reversal.reversed_movement_id = return_movement.id
                 )
             )
         )
         or exists (
           select 1
           from public.inventory_movements return_movement
           where return_movement.related_route_id = v_discrepancy.route_id
             and return_movement.related_pickup_batch_id = v_discrepancy.source_id
             and return_movement.product_id = v_discrepancy.product_id
             and return_movement.from_entity_type::text = 'operator_bag'
             and return_movement.from_entity_id = v_discrepancy.operator_id
             and return_movement.to_entity_type::text = 'storage'
             and return_movement.reason::text = 'operator_bag_to_storage'
             and return_movement.source_type = 'route_pickup_return'
             and return_movement.source_id = v_discrepancy.source_id
             and not exists (
               select 1
               from public.inventory_movements pickup
               where pickup.id = return_movement.reversed_movement_id
                 and pickup.related_route_id = v_discrepancy.route_id
                 and pickup.related_pickup_batch_id = v_discrepancy.source_id
                 and pickup.product_id = return_movement.product_id
                 and pickup.quantity = return_movement.quantity
                 and pickup.reason::text = 'storage_to_operator_bag'
                 and pickup.from_entity_type::text = 'storage'
                 and pickup.from_entity_id = return_movement.to_entity_id
                 and pickup.to_entity_type::text = 'operator_bag'
                 and pickup.to_entity_id = return_movement.from_entity_id
             )
         ) then
        raise exception 'The ledger has no active, exact pristine-return alignment proof. Repair the pickup return before accepting this variance.' using errcode = '23514';
      end if;

    elsif v_discrepancy.source_type = 'route_stop_inventory_commit' then
      if v_discrepancy.route_stop_id is null
         or v_discrepancy.source_id is distinct from v_discrepancy.route_stop_id
         or v_discrepancy.machine_id is null
         or v_discrepancy.operator_id is null
         or v_discrepancy.discrepancy_type <> 'stop_shortage'
         or v_discrepancy.difference_quantity <= 0
         or v_discrepancy.absolute_quantity <= 0 then
        raise exception 'Stop discrepancy provenance is incomplete. Reconcile inventory before accepting this variance.' using errcode = '23514';
      end if;

      v_evidence_movement_id := v_discrepancy.correcting_movement_id;

      -- Lock every canonical shortage leg before checking the aggregate, then
      -- lock current reversals. The forward-row locks also make a concurrent
      -- correction wait at its reversal foreign key until this review ends.
      perform movement.id
      from public.inventory_movements movement
      where movement.related_route_id = v_discrepancy.route_id
        and movement.related_route_stop_id = v_discrepancy.route_stop_id
        and movement.related_machine_id = v_discrepancy.machine_id
        and movement.product_id = v_discrepancy.product_id
        and movement.source_type = 'route_stop_inventory_v1'
        and movement.source_id = v_discrepancy.route_stop_id
        and movement.reversed_movement_id is null
        and (
          (
            movement.from_entity_type::text = 'adjustment'
            and movement.from_entity_id is null
            and movement.to_entity_type::text in ('machine', 'machine_storage')
            and movement.to_entity_id = v_discrepancy.machine_id
          )
          or
          (
            movement.from_entity_type::text in ('machine', 'machine_storage')
            and movement.from_entity_id = v_discrepancy.machine_id
            and movement.to_entity_type::text = 'adjustment'
            and movement.to_entity_id is null
          )
        )
      order by movement.id
      for update;

      perform reversal.id
      from public.inventory_movements reversal
      where reversal.reversed_movement_id in (
        select movement.id
        from public.inventory_movements movement
        where movement.related_route_id = v_discrepancy.route_id
          and movement.related_route_stop_id = v_discrepancy.route_stop_id
          and movement.related_machine_id = v_discrepancy.machine_id
          and movement.product_id = v_discrepancy.product_id
          and movement.source_type = 'route_stop_inventory_v1'
          and movement.source_id = v_discrepancy.route_stop_id
          and movement.reversed_movement_id is null
          and (
            (
              movement.from_entity_type::text = 'adjustment'
              and movement.from_entity_id is null
              and movement.to_entity_type::text in ('machine', 'machine_storage')
              and movement.to_entity_id = v_discrepancy.machine_id
            )
            or
            (
              movement.from_entity_type::text in ('machine', 'machine_storage')
              and movement.from_entity_id = v_discrepancy.machine_id
              and movement.to_entity_type::text = 'adjustment'
              and movement.to_entity_id is null
            )
          )
      )
      order by reversal.id
      for update;

      -- The stop writer may split a shortage between sellable lanes and
      -- machine storage. Keep one active movement as the human-facing
      -- exemplar, but prove the full discrepancy from the net immutable
      -- adjustment legs rather than trusting that one pointer's quantity.
      if v_evidence_movement_id is null
         or not exists (
           select 1
           from public.inventory_movements movement
           where movement.id = v_evidence_movement_id
             and movement.related_route_id = v_discrepancy.route_id
             and movement.related_route_stop_id = v_discrepancy.route_stop_id
             and movement.related_machine_id = v_discrepancy.machine_id
             and movement.product_id = v_discrepancy.product_id
             and movement.source_type = 'route_stop_inventory_v1'
             and movement.source_id = v_discrepancy.route_stop_id
             and movement.reversed_movement_id is null
             and movement.from_entity_type::text = 'adjustment'
             and movement.from_entity_id is null
             and movement.to_entity_type::text in ('machine', 'machine_storage')
             and movement.to_entity_id = v_discrepancy.machine_id
             and not exists (
               select 1
               from public.inventory_movements reversal
               where reversal.reversed_movement_id = movement.id
             )
         ) then
        raise exception 'The ledger has no active stop-shortage correcting movement. Reconcile inventory before accepting this variance.' using errcode = '23514';
      end if;

      select coalesce(sum(
        case
          when movement.from_entity_type::text = 'adjustment'
            and movement.from_entity_id is null
            and movement.to_entity_type::text in ('machine', 'machine_storage')
            and movement.to_entity_id = v_discrepancy.machine_id
            then movement.quantity::bigint
          when movement.from_entity_type::text in ('machine', 'machine_storage')
            and movement.from_entity_id = v_discrepancy.machine_id
            and movement.to_entity_type::text = 'adjustment'
            and movement.to_entity_id is null
            then -movement.quantity::bigint
          else 0::bigint
        end
      ), 0::bigint)
      into v_evidence_quantity
      from public.inventory_movements movement
      where movement.related_route_id = v_discrepancy.route_id
        and movement.related_route_stop_id = v_discrepancy.route_stop_id
        and movement.related_machine_id = v_discrepancy.machine_id
        and movement.product_id = v_discrepancy.product_id
        and movement.source_type = 'route_stop_inventory_v1'
        and movement.source_id = v_discrepancy.route_stop_id
        and movement.reversed_movement_id is null
        and not exists (
          select 1
          from public.inventory_movements reversal
          where reversal.reversed_movement_id = movement.id
        );

      if v_evidence_quantity is distinct from v_discrepancy.absolute_quantity::bigint then
        raise exception 'The net stop-shortage ledger quantity (%) does not match this discrepancy (%). Reconcile inventory before accepting it.',
          v_evidence_quantity,
          v_discrepancy.absolute_quantity
          using errcode = '23514';
      end if;

    else
      raise exception 'This discrepancy does not have a supported authoritative inventory source.' using errcode = '23514';
    end if;

    v_next_status := 'resolved';

    update public.route_inventory_discrepancies
    set status = v_next_status,
        resolution_type = v_action,
        resolution_notes = v_notes,
        resolved_by_user_id = v_actor_user_id,
        resolved_by_team_member_id = v_actor_team_member_id,
        resolved_at = v_now,
        correcting_movement_id = coalesce(correcting_movement_id, v_evidence_movement_id),
        updated_at = v_now
    where id = v_discrepancy.id;

    if v_line_id is not null then
      update public.route_inventory_reconciliation_lines
      set review_status = 'resolved',
          resolved_by_user_id = v_actor_user_id,
          resolved_by_team_member_id = v_actor_team_member_id,
          resolution_note = v_notes,
          resolved_at = v_now,
          updated_at = v_now
      where id = v_line_id;

      update public.route_inventory_reconciliations reconciliation
      set status = case
            when exists (
              select 1
              from public.route_inventory_reconciliation_lines unresolved_line
              join public.route_inventory_discrepancies unresolved_discrepancy
                on unresolved_discrepancy.id = unresolved_line.discrepancy_id
              where unresolved_line.reconciliation_id = reconciliation.id
                and unresolved_discrepancy.status in ('open', 'investigating')
            ) then 'needs_review'
            else 'resolved'
          end,
          updated_at = v_now
      where reconciliation.id = v_reconciliation_id;
    end if;

  else
    if v_discrepancy.status not in ('resolved', 'accepted_loss', 'voided') then
      raise exception 'Only a closed discrepancy can be reopened.' using errcode = 'P0001';
    end if;

    v_next_status := 'open';

    update public.route_inventory_discrepancies
    set status = v_next_status,
        resolution_type = null,
        resolution_notes = null,
        resolved_by_user_id = null,
        resolved_by_team_member_id = null,
        resolved_at = null,
        updated_at = v_now
    where id = v_discrepancy.id;

    if v_line_id is not null then
      update public.route_inventory_reconciliation_lines
      set review_status = 'open',
          resolved_by_user_id = null,
          resolved_by_team_member_id = null,
          resolution_note = null,
          resolved_at = null,
          updated_at = v_now
      where id = v_line_id;

      update public.route_inventory_reconciliations
      set status = 'needs_review',
          updated_at = v_now
      where id = v_reconciliation_id;
    end if;
  end if;

  if v_reconciliation_id is not null then
    update public.route_inventory_reconciliations reconciliation
    set
      status = case
        when exists (
          select 1
          from public.route_inventory_discrepancies unresolved
          where unresolved.route_id = v_discrepancy.route_id
            and unresolved.status in ('open', 'investigating')
        ) then 'needs_review'
        else 'resolved'
      end,
      discrepancy_units = coalesce((
        select sum(unresolved.absolute_quantity)::integer
        from public.route_inventory_discrepancies unresolved
        where unresolved.route_id = v_discrepancy.route_id
          and unresolved.status in ('open', 'investigating')
      ), 0),
      updated_at = v_now
    where reconciliation.id = v_reconciliation_id;
  end if;

  insert into public.route_inventory_discrepancy_resolution_events (
    discrepancy_id,
    route_id,
    action,
    previous_status,
    next_status,
    notes,
    client_submission_id,
    evidence_movement_id,
    previous_resolution_type,
    previous_resolved_at,
    actor_user_id,
    actor_team_member_id,
    created_at
  )
  values (
    v_discrepancy.id,
    v_discrepancy.route_id,
    v_action,
    v_previous_status,
    v_next_status,
    v_notes,
    v_submission_id,
    v_evidence_movement_id,
    v_discrepancy.resolution_type,
    v_discrepancy.resolved_at,
    v_actor_user_id,
    v_actor_team_member_id,
    v_now
  );

  -- The explicit manager event above now owns this transition. Clearing the
  -- transaction-local marker avoids suppressing an unrelated later status
  -- change if a caller performs more work in the same transaction.
  perform pg_catalog.set_config(
    'snacky.route_inventory_review_discrepancy_id',
    '',
    true
  );

  return query
  select
    v_discrepancy.id,
    v_next_status,
    v_action,
    false,
    v_now;
end;
$$;

revoke all on function public.snacky_resolve_route_inventory_discrepancy_v1(uuid, text, text, text, timestamptz)
  from public, anon;
grant execute on function public.snacky_resolve_route_inventory_discrepancy_v1(uuid, text, text, text, timestamptz)
  to authenticated;

select pg_notify('pgrst', 'reload schema');
