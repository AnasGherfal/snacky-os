-- Compatibility bridge for production databases that already have an older
-- public.operator_pay_profiles table.
--
-- 202606130002 uses CREATE TABLE IF NOT EXISTS. When the table already exists,
-- PostgreSQL does not add the newer columns from that CREATE TABLE statement,
-- and the later seed INSERT fails on columns such as car_allowance_lyd.
--
-- Add only the missing columns needed by the payroll-engine migration. This is
-- additive and idempotent; no rows or historical payroll data are removed.

do $$
begin
  create type public.operator_role_level as enum (
    'junior_operator',
    'senior_operator',
    'backup_operator'
  );
exception when duplicate_object then null;
end $$;

alter table if exists public.operator_pay_profiles
  add column if not exists team_member_id uuid references public.team_members(id) on delete cascade,
  add column if not exists role_level public.operator_role_level not null default 'junior_operator',
  add column if not exists base_salary_lyd numeric(12,2) not null default 0,
  add column if not exists car_allowance_lyd numeric(12,2) not null default 0,
  add column if not exists phone_allowance_lyd numeric(12,2) not null default 0,
  add column if not exists default_route_base_lyd numeric(12,2) not null default 0,
  add column if not exists default_stop_rate_lyd numeric(12,2) not null default 0,
  add column if not exists default_km_rate_lyd numeric(12,2) not null default 0,
  add column if not exists can_collect_cash boolean not null default false,
  add column if not exists can_buy_stock boolean not null default false,
  add column if not exists active boolean not null default true,
  add column if not exists notes text,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

-- Backfill only blank compatibility fields. Existing configured values remain.
update public.operator_pay_profiles
set
  base_salary_lyd = coalesce(base_salary_lyd, 0),
  car_allowance_lyd = coalesce(car_allowance_lyd, 0),
  phone_allowance_lyd = coalesce(phone_allowance_lyd, 0),
  default_route_base_lyd = coalesce(default_route_base_lyd, 0),
  default_stop_rate_lyd = coalesce(default_stop_rate_lyd, 0),
  default_km_rate_lyd = coalesce(default_km_rate_lyd, 0),
  can_collect_cash = coalesce(can_collect_cash, false),
  can_buy_stock = coalesce(can_buy_stock, false),
  active = coalesce(active, true),
  updated_at = coalesce(updated_at, now());

select pg_notify('pgrst', 'reload schema');
