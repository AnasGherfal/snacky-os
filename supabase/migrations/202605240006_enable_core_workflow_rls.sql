do $$
begin
  if to_regclass('public.products') is not null then
    execute 'alter table public.products enable row level security';
  end if;

  if to_regclass('public.storage_locations') is not null then
    execute 'alter table public.storage_locations enable row level security';
  end if;

  if to_regclass('public.inventory_movements') is not null then
    execute 'alter table public.inventory_movements enable row level security';
  end if;

  if to_regclass('public.purchase_orders') is not null then
    execute 'alter table public.purchase_orders enable row level security';
  end if;

  if to_regclass('public.purchase_order_lines') is not null then
    execute 'alter table public.purchase_order_lines enable row level security';
  end if;

  if to_regclass('public.suppliers') is not null then
    execute 'alter table public.suppliers enable row level security';

    execute 'drop policy if exists "snacky_suppliers_insert_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_update_by_effective_role" on public.suppliers';
    execute 'drop policy if exists "snacky_suppliers_delete_by_effective_role" on public.suppliers';

    execute $sql$
      create policy "snacky_suppliers_insert_by_effective_role"
      on public.suppliers for insert
      to authenticated
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_update_by_effective_role"
      on public.suppliers for update
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
      with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'purchasing']))
    $sql$;

    execute $sql$
      create policy "snacky_suppliers_delete_by_effective_role"
      on public.suppliers for delete
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin']))
    $sql$;
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');
