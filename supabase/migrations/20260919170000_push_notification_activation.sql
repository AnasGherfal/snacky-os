-- Additive repair: production may have skipped the original push migration.
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  device_label text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  unique(endpoint)
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  action_url text,
  related_route_id uuid references public.routes(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user_active_created_at
  on public.push_subscriptions(user_id, is_active, created_at desc);
create index if not exists idx_push_subscriptions_user_endpoint
  on public.push_subscriptions(user_id, endpoint);
create index if not exists idx_notifications_user_created_at
  on public.notifications(user_id, created_at desc);
create index if not exists idx_notifications_user_read_created_at
  on public.notifications(user_id, read_at, created_at desc);
create unique index if not exists idx_notifications_route_dedupe
  on public.notifications(type, user_id, related_route_id);

create or replace function public.snacky_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end;
$$;

alter table public.push_subscriptions enable row level security;
alter table public.notifications enable row level security;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
drop trigger if exists snacky_push_subscriptions_touch_updated_at on public.push_subscriptions;
create trigger snacky_push_subscriptions_touch_updated_at before update on public.push_subscriptions
for each row execute function public.snacky_touch_updated_at();

drop policy if exists snacky_push_subscriptions_select_own on public.push_subscriptions;
create policy snacky_push_subscriptions_select_own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists snacky_push_subscriptions_insert_own on public.push_subscriptions;
create policy snacky_push_subscriptions_insert_own on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
drop policy if exists snacky_push_subscriptions_update_own on public.push_subscriptions;
create policy snacky_push_subscriptions_update_own on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists snacky_push_subscriptions_delete_own on public.push_subscriptions;
create policy snacky_push_subscriptions_delete_own on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
drop policy if exists snacky_notifications_select_own on public.notifications;
create policy snacky_notifications_select_own on public.notifications for select to authenticated using (user_id = auth.uid());
drop policy if exists snacky_notifications_update_own on public.notifications;
create policy snacky_notifications_update_own on public.notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists snacky_notifications_delete_own on public.notifications;
create policy snacky_notifications_delete_own on public.notifications for delete to authenticated using (user_id = auth.uid());

-- Only server-side writers may create or change notification content.
revoke all on public.push_subscriptions, public.notifications from public, anon;
grant all on public.push_subscriptions, public.notifications to service_role;
revoke all on public.notifications from authenticated;
grant select, delete on public.notifications to authenticated;
grant update(read_at) on public.notifications to authenticated;
revoke all on function public.snacky_touch_updated_at() from public, anon, authenticated;
grant execute on function public.snacky_touch_updated_at() to service_role;

create table if not exists public.push_test_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null
);
alter table public.push_test_limits enable row level security;
revoke all on public.push_test_limits from public, anon, authenticated;
grant all on public.push_test_limits to service_role;
create or replace function public.reserve_push_test_v1()
returns boolean language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); reserved uuid;
begin
  if caller is null or not exists (select 1 from public.profiles where id = caller and active_status = 'active') then
    raise exception 'Active account required' using errcode = '42501';
  end if;
  insert into public.push_test_limits(user_id, requested_at) values (caller, clock_timestamp())
  on conflict (user_id) do update set requested_at = excluded.requested_at
  where public.push_test_limits.requested_at < clock_timestamp() - interval '30 seconds'
  returning user_id into reserved;
  return reserved is not null;
end;
$$;
revoke all on function public.reserve_push_test_v1() from public, anon;
grant execute on function public.reserve_push_test_v1() to authenticated;
select pg_notify('pgrst', 'reload schema');
