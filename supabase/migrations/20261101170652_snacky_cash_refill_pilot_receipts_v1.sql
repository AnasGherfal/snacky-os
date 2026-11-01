-- Mirrors the additive Snacky Supabase migration 20261101170652.
-- Off by default: existing refill stops remain unchanged until owner enables pilot.
create table if not exists public.cash_refill_policy (
  id smallint primary key default 1 check (id=1),
  enabled boolean not null default false,
  pilot_machine_ids uuid[] not null default '{}',
  safe_label text not null default 'Safe A',
  updated_at timestamptz not null default now()
);
alter table public.cash_refill_policy enable row level security;
revoke all on table public.cash_refill_policy from public, anon, authenticated;
insert into public.cash_refill_policy (id,enabled,pilot_machine_ids,safe_label)
values (1,false,'{}','Safe A') on conflict (id) do nothing;

create table if not exists public.route_stop_cash_receipts (
  route_stop_id uuid primary key references public.route_stops(id) on delete restrict,
  route_id uuid not null references public.routes(id) on delete restrict,
  machine_id uuid not null references public.machines(id) on delete restrict,
  operator_id uuid not null references public.team_members(id) on delete restrict,
  request_id uuid not null unique,
  state text not null check (state in ('pending','collected','exception')),
  bag_id text,
  collection_id uuid unique references public.cash_collections(id) on delete restrict,
  exception_reason text,
  exception_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_stop_cash_valid_state check (
    (state='pending' and collection_id is null and exception_reason is null)
    or (state='collected' and collection_id is not null and nullif(trim(bag_id),'') is not null and exception_reason is null)
    or (state='exception' and collection_id is null and nullif(trim(exception_reason),'') is not null)
  )
);
create index if not exists route_stop_cash_receipts_route_idx
  on public.route_stop_cash_receipts (route_id,created_at desc);
alter table public.route_stop_cash_receipts enable row level security;
revoke all on table public.route_stop_cash_receipts from public, anon, authenticated;

create or replace function public.snacky_cash_refill_completion_guard()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public
as $$
declare v_policy record;
begin
  if new.status::text='completed' and old.status::text is distinct from 'completed' then
    select enabled,pilot_machine_ids into v_policy from public.cash_refill_policy where id=1;
    if coalesce(v_policy.enabled,false)
      and (coalesce(cardinality(v_policy.pilot_machine_ids),0)=0 or new.machine_id=any(v_policy.pilot_machine_ids))
      and not exists (
        select 1 from public.route_stop_cash_receipts x
        where x.route_stop_id=new.id and x.route_id=new.route_id
          and x.machine_id=new.machine_id and x.state in ('collected','exception')
      )
    then
      raise exception 'Record a cash collection or cash exception before completing this stop.'
        using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.snacky_cash_refill_completion_guard() from public, anon, authenticated;
drop trigger if exists snacky_cash_refill_completion_guard_trigger on public.route_stops;
create trigger snacky_cash_refill_completion_guard_trigger
before update of status on public.route_stops
for each row execute function public.snacky_cash_refill_completion_guard();
