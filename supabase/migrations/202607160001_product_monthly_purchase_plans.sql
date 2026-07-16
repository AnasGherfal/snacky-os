-- Monthly product purchase planning.
-- Additive only: no product, inventory, purchase, route, finance, or VMS rows are deleted.

create table if not exists public.product_monthly_purchase_plans (
  id uuid primary key default gen_random_uuid(),
  planning_month date not null,
  product_id uuid not null references public.products(id) on delete restrict,
  planned_units integer not null default 0,
  planned_budget_lyd numeric(14,2) not null default 0,
  plan_status text not null default 'draft',
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_monthly_purchase_plans_month_start_check
    check (planning_month = date_trunc('month', planning_month)::date),
  constraint product_monthly_purchase_plans_units_check
    check (planned_units >= 0),
  constraint product_monthly_purchase_plans_budget_check
    check (planned_budget_lyd >= 0),
  constraint product_monthly_purchase_plans_status_check
    check (plan_status in ('draft', 'approved', 'ordered', 'closed')),
  constraint product_monthly_purchase_plans_month_product_key
    unique (planning_month, product_id)
);

alter table public.product_monthly_purchase_plans
  add column if not exists planning_month date,
  add column if not exists product_id uuid,
  add column if not exists planned_units integer not null default 0,
  add column if not exists planned_budget_lyd numeric(14,2) not null default 0,
  add column if not exists plan_status text not null default 'draft',
  add column if not exists notes text,
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists idx_product_monthly_purchase_plans_month_product
  on public.product_monthly_purchase_plans(planning_month, product_id);

create index if not exists idx_product_monthly_purchase_plans_month
  on public.product_monthly_purchase_plans(planning_month);

create index if not exists idx_product_monthly_purchase_plans_product
  on public.product_monthly_purchase_plans(product_id, planning_month desc);

alter table public.product_monthly_purchase_plans enable row level security;

grant select, insert, update, delete on public.product_monthly_purchase_plans to authenticated;

-- Policies are recreated idempotently because production may receive this migration manually.
drop policy if exists "product plans readable by operations roles" on public.product_monthly_purchase_plans;
create policy "product plans readable by operations roles"
on public.product_monthly_purchase_plans
for select
to authenticated
using (
  public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']
  )
);

drop policy if exists "product plans manageable by purchasing roles" on public.product_monthly_purchase_plans;
create policy "product plans manageable by purchasing roles"
on public.product_monthly_purchase_plans
for all
to authenticated
using (
  public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']
  )
)
with check (
  public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']
  )
);

select pg_notify('pgrst', 'reload schema');
