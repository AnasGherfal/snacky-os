begin;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  action_url text,
  related_route_id uuid references public.routes(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notifications add column if not exists user_id uuid;
alter table public.notifications add column if not exists type text;
alter table public.notifications add column if not exists title text;
alter table public.notifications add column if not exists message text;
alter table public.notifications add column if not exists action_url text;
alter table public.notifications add column if not exists related_route_id uuid;
alter table public.notifications add column if not exists read_at timestamptz;
alter table public.notifications add column if not exists created_at timestamptz not null default now();
alter table public.notifications add column if not exists updated_at timestamptz not null default now();

create unique index if not exists notifications_route_user_unique
  on public.notifications(type, user_id, related_route_id)
  where related_route_id is not null;
create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications(user_id, created_at desc)
  where read_at is null;

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  device_label text,
  is_active boolean not null default true,
  last_used_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions add column if not exists user_id uuid;
alter table public.push_subscriptions add column if not exists endpoint text;
alter table public.push_subscriptions add column if not exists p256dh text;
alter table public.push_subscriptions add column if not exists auth text;
alter table public.push_subscriptions add column if not exists user_agent text;
alter table public.push_subscriptions add column if not exists device_label text;
alter table public.push_subscriptions add column if not exists is_active boolean not null default true;
alter table public.push_subscriptions add column if not exists last_used_at timestamptz;
alter table public.push_subscriptions add column if not exists failed_at timestamptz;
alter table public.push_subscriptions add column if not exists failure_reason text;
alter table public.push_subscriptions add column if not exists created_at timestamptz not null default now();
alter table public.push_subscriptions add column if not exists updated_at timestamptz not null default now();

create unique index if not exists push_subscriptions_endpoint_unique
  on public.push_subscriptions(endpoint);
create index if not exists push_subscriptions_user_active_idx
  on public.push_subscriptions(user_id, is_active, created_at desc);

create table if not exists public.push_notification_config (
  singleton boolean primary key default true check (singleton = true),
  public_key text not null,
  private_key text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.push_notification_config enable row level security;

drop policy if exists notifications_authenticated_select_own on public.notifications;
create policy notifications_authenticated_select_own
  on public.notifications
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists notifications_authenticated_update_own on public.notifications;
create policy notifications_authenticated_update_own
  on public.notifications
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists push_subscriptions_authenticated_own on public.push_subscriptions;
create policy push_subscriptions_authenticated_own
  on public.push_subscriptions
  for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, update on public.notifications to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
grant all on public.notifications to service_role;
grant all on public.push_subscriptions to service_role;
grant all on public.push_notification_config to service_role;
revoke all on public.push_notification_config from anon, authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
