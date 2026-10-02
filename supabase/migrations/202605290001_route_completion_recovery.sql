-- Adds audit and idempotency metadata for route completion recovery.
-- The application keeps these columns best-effort so older databases can still
-- complete routes, but production should run this migration.

alter table public.routes
  add column if not exists completed_by uuid references public.team_members(id) on delete set null,
  add column if not exists completion_attempts integer not null default 0,
  add column if not exists last_completion_error text,
  add column if not exists repaired_at timestamptz,
  add column if not exists repaired_by uuid references public.team_members(id) on delete set null;

create index if not exists idx_routes_completed_by
  on public.routes(completed_by)
  where completed_by is not null;

alter table public.inventory_movements
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists idempotency_key text;

create unique index if not exists idx_inventory_movements_idempotency_key
  on public.inventory_movements(idempotency_key)
  where idempotency_key is not null;

create index if not exists idx_inventory_movements_source
  on public.inventory_movements(source_type, source_id)
  where source_type is not null and source_id is not null;
