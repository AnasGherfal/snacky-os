alter table public.vms_import_batches
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.vms_import_preview_rows (
  id uuid primary key default gen_random_uuid(),
  preview_id uuid references public.vms_import_previews(id) on delete cascade,
  import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  sheet_name text,
  row_number integer not null,
  raw_row jsonb not null default '[]'::jsonb,
  normalized_row jsonb not null default '{}'::jsonb,
  mapped_product_id uuid references public.products(id) on delete set null,
  mapped_machine_id uuid references public.machines(id) on delete set null,
  status text not null default 'pending',
  review_reason text,
  suggested_mapping jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.vms_import_preview_rows
  add column if not exists preview_id uuid references public.vms_import_previews(id) on delete cascade,
  add column if not exists import_batch_id uuid references public.vms_import_batches(id) on delete cascade,
  add column if not exists sheet_name text,
  add column if not exists raw_row jsonb not null default '[]'::jsonb,
  add column if not exists normalized_row jsonb not null default '{}'::jsonb,
  add column if not exists mapped_product_id uuid references public.products(id) on delete set null,
  add column if not exists mapped_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists status text not null default 'pending',
  add column if not exists review_reason text,
  add column if not exists suggested_mapping jsonb not null default '{}'::jsonb;

create index if not exists idx_vms_import_preview_rows_batch
  on public.vms_import_preview_rows(import_batch_id, row_number);

create index if not exists idx_vms_import_preview_rows_status
  on public.vms_import_preview_rows(status);

do $$ begin
  alter table public.vms_import_preview_rows
    add constraint vms_import_preview_rows_status_check
    check (status in ('pending', 'ready', 'needs_review', 'invalid_row', 'duplicate', 'imported', 'skipped'));
exception when duplicate_object then null; end $$;

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
    'vms_product_mappings',
    'vms_machine_mappings'
  ] loop
    if to_regclass('public.' || table_name) is not null then
      execute format('alter table public.%I enable row level security', table_name);
      execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);

      execute format('drop policy if exists "snacky_%s_select_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_insert_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_update_by_vms_import_role" on public.%I', table_name, table_name);
      execute format('drop policy if exists "snacky_%s_delete_by_vms_import_role" on public.%I', table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_select_by_vms_import_role"
        on public.%I for select
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_insert_by_vms_import_role"
        on public.%I for insert
        to authenticated
        with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_update_by_vms_import_role"
        on public.%I for update
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
        with check (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);

      execute format($policy$
        create policy "snacky_%s_delete_by_vms_import_role"
        on public.%I for delete
        to authenticated
        using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
      $policy$, table_name, table_name);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.products') is not null then
    execute 'grant select on public.products to authenticated';
    execute 'drop policy if exists "snacky_products_select_for_vms_import_validation" on public.products';
    execute $policy$
      create policy "snacky_products_select_for_vms_import_validation"
      on public.products for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $policy$;
  end if;

  if to_regclass('public.machines') is not null then
    execute 'grant select on public.machines to authenticated';
    execute 'drop policy if exists "snacky_machines_select_for_vms_import_validation" on public.machines';
    execute $policy$
      create policy "snacky_machines_select_for_vms_import_validation"
      on public.machines for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $policy$;
  end if;
end $$;

insert into public.vms_machine_mappings (
  vms_machine_key,
  vms_machine_name,
  machine_id,
  location_id,
  confidence_score,
  status,
  aliases
)
select
  'KhalijUniversity',
  'Khalij University',
  m.id,
  m.location_id,
  1,
  'confirmed',
  array['KhalijUniversity', 'Khalij University', '@الخليج', '@خليج']::text[]
from public.machines m
where trim(m.name) = 'جامعة طرابلس الاهلية'
on conflict (vms_machine_key) do update
set
  vms_machine_name = excluded.vms_machine_name,
  machine_id = excluded.machine_id,
  location_id = excluded.location_id,
  confidence_score = excluded.confidence_score,
  status = excluded.status,
  aliases = excluded.aliases,
  updated_at = now();

select pg_notify('pgrst', 'reload schema');
