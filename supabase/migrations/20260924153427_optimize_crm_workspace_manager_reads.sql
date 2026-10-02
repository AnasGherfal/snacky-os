do $$
declare
  ddl text;
begin
  select pg_get_functiondef('public.snacky_crm_workspace_v1(text,uuid,jsonb)'::regprocedure)
  into ddl;

  if ddl is null then
    raise exception 'snacky_crm_workspace_v1 not found';
  end if;

  if position('where (manager or public.snacky_crm_allowed(r.kind,r.id))' in ddl) > 0 then
    return;
  end if;

  if position('where public.snacky_crm_allowed(r.kind,r.id)' in ddl) = 0 then
    raise exception 'expected CRM workspace authorization clause not found';
  end if;

  ddl := replace(
    ddl,
    'where public.snacky_crm_allowed(r.kind,r.id)',
    'where (manager or public.snacky_crm_allowed(r.kind,r.id))'
  );

  execute ddl;
end $$;
