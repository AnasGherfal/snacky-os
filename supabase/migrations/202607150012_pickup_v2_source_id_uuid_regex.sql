-- Robust production patch for Snacky pickup v2 inventory movement source_id.
--
-- The prior patch used an exact whitespace-sensitive string replacement against
-- pg_get_functiondef(). PostgreSQL reformatted the deployed function body, so the
-- exact text was not found. This version uses a whitespace-insensitive regular
-- expression anchored to the source_type/source_id/idempotency_key select sequence.
--
-- No route, pickup, checklist, inventory, VMS, finance, or payroll rows are
-- modified by this migration.

do $migration$
declare
  v_proc regprocedure := to_regprocedure(
    'public.snacky_confirm_route_pickup_batch_v2(uuid,public.route_status,public.route_status,timestamp with time zone,boolean,jsonb,uuid[],jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,uuid[],uuid[],uuid[])'
  );
  v_definition text;
  v_patched_definition text;
  v_source_id_type text;
begin
  if v_proc is null then
    raise exception 'Required pickup function public.snacky_confirm_route_pickup_batch_v2 was not found.'
      using errcode = '42883';
  end if;

  select format_type(a.atttypid, a.atttypmod)
  into v_source_id_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'inventory_movements'
    and a.attname = 'source_id'
    and a.attnum > 0
    and not a.attisdropped;

  if v_source_id_type is null then
    raise exception 'Required column public.inventory_movements.source_id was not found.'
      using errcode = '42703';
  end if;

  if v_source_id_type <> 'uuid' then
    raise exception 'Expected public.inventory_movements.source_id to be uuid, found %.', v_source_id_type
      using errcode = '42804';
  end if;

  select pg_get_functiondef(v_proc::oid)
  into v_definition;

  -- Idempotent re-run when the deployed body is already patched.
  if v_definition ~* 'nullif\([[:space:]]*x\.source_id[[:space:]]*,[[:space:]]*''''[[:space:]]*\)::uuid' then
    return;
  end if;

  v_patched_definition := regexp_replace(
    v_definition,
    '(x\.source_type[[:space:]]*,[[:space:]]*)x\.source_id([[:space:]]*,[[:space:]]*x\.idempotency_key)',
    E'\\1nullif(x.source_id, '''')::uuid\\2',
    'i'
  );

  if v_patched_definition = v_definition then
    raise exception 'Could not locate the pickup v2 source_id select expression using the flexible matcher; function was not changed.'
      using errcode = 'P0001';
  end if;

  execute v_patched_definition;

  select pg_get_functiondef(v_proc::oid)
  into v_definition;

  if not (v_definition ~* 'nullif\([[:space:]]*x\.source_id[[:space:]]*,[[:space:]]*''''[[:space:]]*\)::uuid') then
    raise exception 'Pickup v2 source_id UUID patch verification failed.'
      using errcode = 'P0001';
  end if;
end
$migration$;

select pg_notify('pgrst', 'reload schema');
