alter table public.products
  add column if not exists restock_priority text not null default 'normal',
  add column if not exists min_storage_qty integer not null default 0,
  add column if not exists target_storage_qty integer not null default 0,
  add column if not exists reorder_point integer not null default 0,
  add column if not exists reorder_qty integer not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_restock_priority_check'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_restock_priority_check
      check (restock_priority in ('high', 'normal', 'low'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_min_storage_qty_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_min_storage_qty_nonnegative
      check (min_storage_qty >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_target_storage_qty_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_target_storage_qty_nonnegative
      check (target_storage_qty >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_reorder_point_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_reorder_point_nonnegative
      check (reorder_point >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_reorder_qty_nonnegative'
      and conrelid = 'public.products'::regclass
  ) then
    alter table public.products
      add constraint products_reorder_qty_nonnegative
      check (reorder_qty >= 0);
  end if;
end $$;

create index if not exists idx_products_restock_priority
  on public.products(restock_priority, active, name);

create index if not exists idx_products_storage_thresholds
  on public.products(min_storage_qty, reorder_point, target_storage_qty)
  where active = true;

update public.products
set restock_priority = 'high'
where restock_priority = 'normal'
  and (
    lower(name) like '%mr crunch%'
    or name like '%طربوش%'
    or lower(name) like '%doritos%'
  );
