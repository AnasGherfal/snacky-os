-- Production compatibility for Snacky pickup v2.
--
-- The application submits inventory movement source_id values as UUID strings,
-- but the v2 RPC currently parses source_id as text and inserts it directly into
-- public.inventory_movements.source_id. Production defines that column as uuid,
-- which causes SQLSTATE 42804 before the atomic pickup transaction can complete.
--
-- Patch only the exact single-signature v2 function body. No route, pickup,
-- checklist, inventory, VMS, finance, or payroll rows are modified by this
-- migration.

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

  -- Idempotent re-run: the deployed function is already patched.
  if position('nullif(x.source_id, '''')::uuid' in lower(v_definition)) > 0 then
    return;
  end if;

  v_patched_definition := replace(
    v_definition,
    E'      x.source_type,\n      x.source_id,\n      x.idempotency_key,',
    E'      x.source_type,\n      nullif(x.source_id, '''')::uuid,\n      x.idempotency_key,'
  );

  if v_patched_definition = v_definition then
    raise exception 'Could not locate the pickup v2 inventory source_id insertion expression; function was not changed.'
      using errcode = 'P0001';
  end if;

  execute v_patched_definition;

  select pg_get_functiondef(v_proc::oid)
  into v_definition;

  if position('nullif(x.source_id, '''')::uuid' in lower(v_definition)) = 0 then
    raise exception 'Pickup v2 source_id UUID patch verification failed.'
      using errcode = 'P0001';
  end if;
end
$migration$;

select pg_notify('pgrst', 'reload schema');
