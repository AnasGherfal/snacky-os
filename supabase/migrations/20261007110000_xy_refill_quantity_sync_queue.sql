begin;

-- Direct Snacky OS -> XY refill synchronization.
-- Keep the existing confirmation table as the durable queue instead of adding
-- a second competing refill workflow.

alter table public.route_stop_quantity_confirmations
  add column if not exists sync_attempt_count integer not null default 0,
  add column if not exists last_sync_attempt_at timestamptz,
  add column if not exists last_sync_error text,
  add column if not exists auto_sync_eligible boolean not null default false;

alter table public.route_stop_quantity_confirmations
  drop constraint if exists route_stop_quantity_confirmations_status_valid;

alter table public.route_stop_quantity_confirmations
  add constraint route_stop_quantity_confirmations_status_valid check (
    verification_status in (
      'legacy_confirmed',
      'xy_screenshot_saved',
      'offline_pending',
      'owner_completed',
      'xy_api_verified',
      'xy_sync_pending'
    )
  );

alter table public.route_stop_quantity_confirmations
  drop constraint if exists route_stop_quantity_confirmations_evidence_state;

alter table public.route_stop_quantity_confirmations
  add constraint route_stop_quantity_confirmations_evidence_state check (
    verification_status in ('legacy_confirmed', 'xy_api_verified', 'xy_sync_pending')
    or (verification_status = 'offline_pending' and nullif(btrim(coalesce(offline_reason, '')), '') is not null)
    or (verification_status in ('xy_screenshot_saved', 'owner_completed') and jsonb_array_length(evidence_files) >= 1)
  );

create index if not exists idx_route_stop_quantity_confirmations_xy_sync_pending
  on public.route_stop_quantity_confirmations(last_sync_attempt_at asc nulls first, submitted_at asc)
  where auto_sync_eligible = true
    and verification_status in ('offline_pending', 'xy_sync_pending');

select pg_notify('pgrst', 'reload schema');

commit;
