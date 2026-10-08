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

select pg_notify('pgrst','reload schema');
