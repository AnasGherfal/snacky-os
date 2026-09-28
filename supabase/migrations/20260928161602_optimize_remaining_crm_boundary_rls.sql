do $$
declare
  policy_row record;
begin
  for policy_row in
    select tablename, policyname
    from pg_policies
    where schemaname='public'
      and policyname in ('crm_raw_record_boundary','crm_legacy_noncrm_access')
      and qual='(NOT snacky_crm_is_limited())'
      and with_check='(NOT snacky_crm_is_limited())'
  loop
    execute format(
      'alter policy %I on public.%I using ((select (not public.snacky_crm_is_limited()))) with check ((select (not public.snacky_crm_is_limited())))',
      policy_row.policyname,
      policy_row.tablename
    );
  end loop;
end
$$;

select pg_notify('pgrst','reload schema');
