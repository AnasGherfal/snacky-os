begin;

create table if not exists public.push_notification_config (
  singleton boolean primary key default true check (singleton = true),
  public_key text not null,
  private_key text not null,
  subject text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_notification_config enable row level security;

grant all on public.push_notification_config to service_role;
revoke all on public.push_notification_config from anon, authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
