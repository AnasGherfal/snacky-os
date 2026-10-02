begin;

alter table public.route_stop_quantity_confirmations
  add column if not exists verification_status text not null default 'legacy_confirmed',
  add column if not exists evidence_files jsonb not null default '[]'::jsonb,
  add column if not exists offline_reason text,
  add column if not exists submitted_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by_user_id uuid;

do $$ begin
  alter table public.route_stop_quantity_confirmations
    add constraint route_stop_quantity_confirmations_status_valid check (
      verification_status in ('legacy_confirmed', 'xy_screenshot_saved', 'offline_pending', 'owner_completed')
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.route_stop_quantity_confirmations
    add constraint route_stop_quantity_confirmations_evidence_array check (
      jsonb_typeof(evidence_files) = 'array'
      and jsonb_array_length(evidence_files) <= 4
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.route_stop_quantity_confirmations
    add constraint route_stop_quantity_confirmations_evidence_state check (
      verification_status = 'legacy_confirmed'
      or (verification_status = 'offline_pending' and nullif(btrim(coalesce(offline_reason, '')), '') is not null)
      or (verification_status in ('xy_screenshot_saved', 'owner_completed') and jsonb_array_length(evidence_files) >= 1)
    );
exception when duplicate_object then null; end $$;

create index if not exists idx_route_stop_quantity_confirmations_offline_pending
  on public.route_stop_quantity_confirmations(submitted_at desc)
  where verification_status = 'offline_pending';

alter table public.route_stop_quantity_confirmations enable row level security;
revoke all on public.route_stop_quantity_confirmations from public, anon, authenticated;
grant all on public.route_stop_quantity_confirmations to service_role;

select pg_notify('pgrst', 'reload schema');

commit;
