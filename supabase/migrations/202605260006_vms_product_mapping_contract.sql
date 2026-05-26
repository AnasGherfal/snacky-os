-- Makes VMS product mapping memory a stable first-class contract.
-- Keeps the newer Snacky column names and the legacy import column names in
-- sync so existing import code can continue to run while the UI uses the
-- safer canonical fields.

create table if not exists public.vms_product_mappings (
  id uuid primary key default gen_random_uuid(),
  vms_product_code text,
  vms_product_name text not null,
  snacky_product_id uuid references public.products(id) on delete set null,
  snacky_product_name text,
  confidence_score numeric,
  status text not null default 'confirmed',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.vms_product_mappings
  add column if not exists vms_product_code text,
  add column if not exists vms_product_id text,
  add column if not exists vms_product_name text,
  add column if not exists snacky_product_id uuid references public.products(id) on delete set null,
  add column if not exists product_id uuid references public.products(id) on delete set null,
  add column if not exists snacky_product_name text,
  add column if not exists confidence_score numeric,
  add column if not exists status text not null default 'confirmed',
  add column if not exists match_status text not null default 'confirmed',
  add column if not exists created_by uuid,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists vms_selling_price_lyd numeric(12,2),
  add column if not exists vms_cost_price_lyd numeric(12,4),
  add column if not exists latest_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists latest_vms_machine_id text,
  add column if not exists latest_machine_name text,
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_import_batch_id uuid references public.vms_import_batches(id) on delete set null,
  add column if not exists vms_third_party_product_id text,
  add column if not exists vms_barcode text,
  add column if not exists vms_image_url text,
  add column if not exists vms_raw_metadata jsonb not null default '{}'::jsonb;

update public.vms_product_mappings vpm
set
  vms_product_code = nullif(coalesce(vpm.vms_product_code, vpm.vms_product_id), ''),
  vms_product_id = nullif(coalesce(vpm.vms_product_id, vpm.vms_product_code), ''),
  snacky_product_id = coalesce(vpm.snacky_product_id, vpm.product_id),
  product_id = coalesce(vpm.product_id, vpm.snacky_product_id),
  snacky_product_name = coalesce(vpm.snacky_product_name, p.name),
  status = coalesce(nullif(vpm.status, ''), nullif(vpm.match_status, ''), 'confirmed'),
  match_status = coalesce(nullif(vpm.match_status, ''), nullif(vpm.status, ''), 'confirmed'),
  confidence_score = coalesce(vpm.confidence_score, case when coalesce(vpm.product_id, vpm.snacky_product_id) is null then 0 else 1 end),
  updated_at = coalesce(vpm.updated_at, now())
from public.products p
where p.id = coalesce(vpm.snacky_product_id, vpm.product_id);

update public.vms_product_mappings
set
  vms_product_name = coalesce(nullif(vms_product_name, ''), nullif(vms_product_code, ''), nullif(vms_product_id, ''), 'Unnamed VMS product'),
  vms_product_code = nullif(coalesce(vms_product_code, vms_product_id), ''),
  vms_product_id = nullif(coalesce(vms_product_id, vms_product_code), ''),
  snacky_product_id = coalesce(snacky_product_id, product_id),
  product_id = coalesce(product_id, snacky_product_id),
  status = coalesce(nullif(status, ''), nullif(match_status, ''), 'confirmed'),
  match_status = coalesce(nullif(match_status, ''), nullif(status, ''), 'confirmed'),
  confidence_score = coalesce(confidence_score, case when coalesce(product_id, snacky_product_id) is null then 0 else 1 end),
  updated_at = coalesce(updated_at, now())
where vms_product_name is null
   or vms_product_name = ''
   or vms_product_code is null
   or vms_product_id is null
   or (snacky_product_id is null and product_id is not null)
   or (product_id is null and snacky_product_id is not null)
   or status is null
   or match_status is null
   or confidence_score is null
   or updated_at is null;

alter table public.vms_product_mappings
  alter column vms_product_name set not null,
  alter column status set default 'confirmed',
  alter column status set not null,
  alter column match_status set default 'confirmed',
  alter column match_status set not null,
  alter column created_at set default now(),
  alter column created_at set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table public.vms_product_mappings
  drop constraint if exists vms_product_mappings_status_check,
  drop constraint if exists vms_product_mappings_match_status_check,
  drop constraint if exists vms_product_mappings_confidence_check;

alter table public.vms_product_mappings
  add constraint vms_product_mappings_status_check
    check (status in ('confirmed', 'suggested', 'needs_review', 'ignored')),
  add constraint vms_product_mappings_match_status_check
    check (match_status in ('confirmed', 'suggested', 'needs_review', 'ignored')),
  add constraint vms_product_mappings_confidence_check
    check (confidence_score is null or (confidence_score >= 0 and confidence_score <= 1));

create index if not exists idx_vms_product_mappings_status_updated
  on public.vms_product_mappings(status, updated_at desc);

create index if not exists idx_vms_product_mappings_snacky_product
  on public.vms_product_mappings(snacky_product_id);

create index if not exists idx_vms_product_mappings_product_id
  on public.vms_product_mappings(product_id);

create index if not exists idx_vms_product_mappings_last_seen
  on public.vms_product_mappings(last_seen_at desc);

create or replace function public.snacky_sync_vms_product_mapping_aliases()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved_product_name text;
begin
  new.vms_product_code = nullif(coalesce(new.vms_product_code, new.vms_product_id), '');
  new.vms_product_id = nullif(coalesce(new.vms_product_id, new.vms_product_code), '');
  new.snacky_product_id = coalesce(new.snacky_product_id, new.product_id);
  new.product_id = coalesce(new.product_id, new.snacky_product_id);
  new.status = coalesce(nullif(new.status, ''), nullif(new.match_status, ''), 'confirmed');
  new.match_status = coalesce(nullif(new.match_status, ''), new.status);
  new.confidence_score = coalesce(new.confidence_score, case when new.product_id is null then 0 else 1 end);

  if new.product_id is null then
    new.snacky_product_name = null;
  elsif nullif(new.snacky_product_name, '') is null then
    select p.name into resolved_product_name
    from public.products p
    where p.id = new.product_id;
    new.snacky_product_name = resolved_product_name;
  end if;

  new.created_at = coalesce(new.created_at, now());
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists snacky_sync_vms_product_mapping_aliases_before_write
  on public.vms_product_mappings;

create trigger snacky_sync_vms_product_mapping_aliases_before_write
before insert or update on public.vms_product_mappings
for each row execute function public.snacky_sync_vms_product_mapping_aliases();

create or replace function public.snacky_current_profile_can_view_vms_import()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

create or replace function public.snacky_current_profile_can_manage_vms_mappings()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor']);
$$;

grant execute on function public.snacky_current_profile_can_view_vms_import() to authenticated;
grant execute on function public.snacky_current_profile_can_manage_vms_mappings() to authenticated;

alter table public.vms_product_mappings enable row level security;
grant select, insert, update on public.vms_product_mappings to authenticated;

drop policy if exists "snacky_vms_product_mappings_select_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_insert_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_update_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_delete_by_vms_import_role" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_select_by_vms_import_permission" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_insert_by_vms_import_permission" on public.vms_product_mappings;
drop policy if exists "snacky_vms_product_mappings_update_by_vms_import_permission" on public.vms_product_mappings;

create policy "snacky_vms_product_mappings_select_by_vms_import_permission"
on public.vms_product_mappings for select
to authenticated
using (public.snacky_current_profile_can_view_vms_import());

create policy "snacky_vms_product_mappings_insert_by_vms_import_permission"
on public.vms_product_mappings for insert
to authenticated
with check (public.snacky_current_profile_can_manage_vms_mappings());

create policy "snacky_vms_product_mappings_update_by_vms_import_permission"
on public.vms_product_mappings for update
to authenticated
using (public.snacky_current_profile_can_manage_vms_mappings())
with check (public.snacky_current_profile_can_manage_vms_mappings());

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'vms_import_batches',
    'vms_import_previews',
    'vms_import_preview_rows',
    'vms_import_rows',
    'vms_import_raw_rows',
    'vms_header_mappings',
    'vms_machine_mappings',
    'vms_sales_raw'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
      execute format('drop policy if exists "snacky_%s_select_by_vms_import_permission" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_insert_by_vms_import_permission" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_update_by_vms_import_permission" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_delete_by_vms_import_permission" on public.%I', table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_select_by_vms_import_permission"
        on public.%I for select
        to authenticated
        using (public.snacky_current_profile_can_view_vms_import())
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_insert_by_vms_import_permission"
        on public.%I for insert
        to authenticated
        with check (public.snacky_current_profile_can_manage_vms_mappings())
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_update_by_vms_import_permission"
        on public.%I for update
        to authenticated
        using (public.snacky_current_profile_can_manage_vms_mappings())
        with check (public.snacky_current_profile_can_manage_vms_mappings())
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_delete_by_vms_import_permission"
        on public.%I for delete
        to authenticated
        using (public.snacky_current_profile_can_manage_vms_mappings())
      $policy$, table_name, table_name);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'grant select on public.products to authenticated';
    execute 'drop policy if exists "snacky_products_select_for_vms_mapping" on public.products';
    execute $policy$
      create policy "snacky_products_select_for_vms_mapping"
      on public.products for select
      to authenticated
      using (public.snacky_current_profile_can_view_vms_import())
    $policy$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
