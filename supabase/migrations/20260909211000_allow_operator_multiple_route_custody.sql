-- One operator may carry stock for multiple active routes at the same time.
-- Custody remains isolated by the exact (operator_id, route_id) pair, while the
-- route_id uniqueness constraint continues to prevent two operators from
-- claiming the same route.

lock table public.operator_route_custody_leases in access exclusive mode;

do $custody_key$
declare
  v_primary_key_columns text[];
begin
  select pg_catalog.array_agg(attribute.attname order by key_column.ordinality)
  into v_primary_key_columns
  from pg_catalog.pg_constraint constraint_row
  cross join lateral pg_catalog.unnest(constraint_row.conkey)
    with ordinality as key_column(attribute_number, ordinality)
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid = constraint_row.conrelid
   and attribute.attnum = key_column.attribute_number
  where constraint_row.conrelid = 'public.operator_route_custody_leases'::pg_catalog.regclass
    and constraint_row.contype = 'p'
  group by constraint_row.oid;

  if v_primary_key_columns = array['operator_id']::text[] then
    alter table public.operator_route_custody_leases
      drop constraint operator_route_custody_leases_pkey;
    alter table public.operator_route_custody_leases
      add constraint operator_route_custody_leases_pkey
      primary key (operator_id, route_id);
  elsif v_primary_key_columns is distinct from array['operator_id', 'route_id']::text[] then
    raise exception 'Unexpected operator route custody primary key: %', v_primary_key_columns
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.operator_route_custody_leases'::pg_catalog.regclass
      and constraint_row.contype = 'u'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid) = 'UNIQUE (route_id)'
  ) then
    raise exception 'The route-unique custody constraint is missing.' using errcode = '23514';
  end if;
end;
$custody_key$;

do $rewrite_custody_helpers$
declare
  v_definition text;
  v_before text;
begin
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public._snacky_assert_operator_route_custody_touches(jsonb)')
  ) into v_definition;

  if v_definition is null then
    raise exception 'Missing operator route custody assertion function.' using errcode = '42883';
  end if;

  v_before := v_definition;
  v_definition := pg_catalog.replace(
    v_definition,
    $old_statement_guard$
  if exists (
    select 1
    from pg_catalog.jsonb_to_recordset(p_touches) as touch(
      operator_id uuid,
      route_id uuid,
      product_id uuid,
      delta_quantity bigint
    )
    group by touch.operator_id
    having pg_catalog.count(distinct touch.route_id) > 1
  ) then
    raise exception 'One inventory statement cannot bind an operator bag to multiple routes.' using errcode = '23514';
  end if;

$old_statement_guard$,
    ''
  );
  if v_definition = v_before then
    raise exception 'Could not remove the one-route-per-statement custody guard.' using errcode = '23514';
  end if;

  v_before := v_definition;
  v_definition := pg_catalog.replace(
    v_definition,
    '  v_existing_route_id uuid;',
    '  v_has_existing_lease boolean;'
  );
  if v_definition = v_before then
    raise exception 'Could not update the custody assertion lease variable.' using errcode = '23514';
  end if;

  v_before := v_definition;
  v_definition := pg_catalog.replace(
    v_definition,
    $old_claim_lookup$
    v_existing_route_id := null;
    select lease.route_id
    into v_existing_route_id
    from public.operator_route_custody_leases lease
    where lease.operator_id = v_touch.operator_id
    for update;

    if found and v_existing_route_id is distinct from v_touch.route_id then
      raise exception 'This operator already carries inventory for another route. Reconcile that route before picking another.'
        using errcode = '23514';
    end if;
$old_claim_lookup$,
    $new_claim_lookup$
    v_has_existing_lease := false;
    select true
    into v_has_existing_lease
    from public.operator_route_custody_leases lease
    where lease.operator_id = v_touch.operator_id
      and lease.route_id = v_touch.route_id
    for update;
$new_claim_lookup$
  );
  if v_definition = v_before then
    raise exception 'Could not make the custody assertion route-specific.' using errcode = '23514';
  end if;

  v_before := v_definition;
  v_definition := pg_catalog.replace(
    v_definition,
    '    if v_existing_route_id is not null then',
    '    if v_has_existing_lease then'
  );
  if v_definition = v_before then
    raise exception 'Could not update the route-specific custody branch.' using errcode = '23514';
  end if;

  execute v_definition;

  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public._snacky_release_operator_route_custody(uuid,uuid,text,uuid)')
  ) into v_definition;

  if v_definition is null then
    raise exception 'Missing operator route custody release function.' using errcode = '42883';
  end if;

  v_before := v_definition;
  v_definition := pg_catalog.replace(
    v_definition,
    $old_release_lookup$
  from public.operator_route_custody_leases lease
  where lease.operator_id = p_operator_id
  for update;
$old_release_lookup$,
    $new_release_lookup$
  from public.operator_route_custody_leases lease
  where lease.operator_id = p_operator_id
    and lease.route_id = p_route_id
  for update;
$new_release_lookup$
  );
  if v_definition = v_before then
    raise exception 'Could not make custody release route-specific.' using errcode = '23514';
  end if;

  execute v_definition;
end;
$rewrite_custody_helpers$;

revoke all on function public._snacky_assert_operator_route_custody_touches(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public._snacky_release_operator_route_custody(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

comment on table public.operator_route_custody_leases is
  'Private route-scoped operator custody claims. One operator may hold multiple routes; each route has one assigned operator.';

do $verify_multi_route_custody$
declare
  v_assert_definition text;
  v_release_definition text;
  v_primary_key_definition text;
begin
  select pg_catalog.pg_get_constraintdef(constraint_row.oid)
  into v_primary_key_definition
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'public.operator_route_custody_leases'::pg_catalog.regclass
    and constraint_row.contype = 'p';

  if v_primary_key_definition <> 'PRIMARY KEY (operator_id, route_id)' then
    raise exception 'Operator route custody did not commit the composite primary key.' using errcode = '23514';
  end if;

  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public._snacky_assert_operator_route_custody_touches(jsonb)')
  ) into v_assert_definition;
  select pg_catalog.pg_get_functiondef(
    pg_catalog.to_regprocedure('public._snacky_release_operator_route_custody(uuid,uuid,text,uuid)')
  ) into v_release_definition;

  if pg_catalog.strpos(v_assert_definition, 'already carries inventory for another route') > 0
    or pg_catalog.strpos(v_assert_definition, 'One inventory statement cannot bind an operator bag to multiple routes') > 0
    or pg_catalog.strpos(v_assert_definition, 'and lease.route_id = v_touch.route_id') = 0
  then
    raise exception 'Operator custody assertion still contains a single-route restriction.' using errcode = '23514';
  end if;

  if pg_catalog.strpos(v_release_definition, 'and lease.route_id = p_route_id') = 0 then
    raise exception 'Operator custody release is not isolated to one route.' using errcode = '23514';
  end if;
end;
$verify_multi_route_custody$;

select pg_catalog.pg_notify('pgrst', 'reload schema');
