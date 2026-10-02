do $$
begin
  if to_regclass('public.suppliers') is not null then
    execute 'drop policy if exists "snacky_suppliers_select_by_effective_role" on public.suppliers';

    execute $sql$
      create policy "snacky_suppliers_select_by_effective_role"
      on public.suppliers for select
      to authenticated
      using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']))
    $sql$;
  end if;
end $$;

grant select on table public.suppliers to authenticated;

select pg_notify('pgrst', 'reload schema');
