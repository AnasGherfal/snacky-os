-- Machine-specific physical selection visibility, separate from historical XY import data.
-- XY may keep nonphysical/disabled channels in its API results.
create table if not exists public.xy_hidden_machine_selections (
  machine_id uuid not null references public.machines(id) on delete cascade,
  slot_code text not null,
  reason text not null default 'Physical selection not present',
  updated_by_user_id uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  primary key (machine_id,slot_code)
);
alter table public.xy_hidden_machine_selections enable row level security;
revoke all on table public.xy_hidden_machine_selections from public,anon,authenticated;
grant select,insert,update,delete on table public.xy_hidden_machine_selections to service_role;

-- These Elite School channels were reported physically absent by operations.
-- Hiding is reversible and does NOT delete XY history or physical stock.
insert into public.xy_hidden_machine_selections (machine_id,slot_code,reason)
values
  ('448a321b-efb9-4463-9364-c211a5c3e9ad'::uuid,'002','Elite School: absent from physical/XY operator layout'),
  ('448a321b-efb9-4463-9364-c211a5c3e9ad'::uuid,'036','Elite School: absent from physical/XY operator layout'),
  ('448a321b-efb9-4463-9364-c211a5c3e9ad'::uuid,'040','Elite School: absent from physical/XY operator layout')
on conflict (machine_id,slot_code) do nothing;

-- A lane price edit can be sent without changing physical stock.
alter table public.xy_stop_quantity_syncs
  add column if not exists expected_price_lyd numeric(12,2),
  add column if not exists target_price_lyd numeric(12,2),
  add column if not exists update_stock boolean not null default true;

alter table public.xy_stop_quantity_syncs
  drop constraint if exists xy_stop_quantity_syncs_price_positive;
alter table public.xy_stop_quantity_syncs
  add constraint xy_stop_quantity_syncs_price_positive check (
    (expected_price_lyd is null or expected_price_lyd > 0)
    and (target_price_lyd is null or target_price_lyd > 0)
    and (update_stock or target_price_lyd is not null)
  );

select pg_notify('pgrst','reload schema');
