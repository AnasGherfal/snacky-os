-- Make route pickup batch confirmation idempotent when the already-prepared
-- pickup batch is submitted to the single-signature v2 confirmation RPC.
--
-- The v2 RPC intentionally reuses the prepared batch id, but its atomic body
-- currently issues a plain INSERT into route_pickup_batches. Production therefore
-- raises SQLSTATE 23505 before any route or inventory change can complete.
--
-- This narrowly scoped BEFORE INSERT guard converts only a duplicate batch id
-- belonging to the same route and operator into an update of that existing batch.
-- A duplicate id belonging to a different route/operator remains a hard error.
-- No route, pickup, checklist, inventory, finance, VMS, or payroll rows are deleted.

create or replace function public.snacky_route_pickup_batch_insert_idempotency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $function$
declare
  v_existing public.route_pickup_batches%rowtype;
  v_existing_json jsonb;
begin
  select b.*
  into v_existing
  from public.route_pickup_batches b
  where b.id = new.id
  for update;

  if not found then
    return new;
  end if;

  if v_existing.route_id is distinct from new.route_id
     or v_existing.operator_id is distinct from new.operator_id then
    raise exception 'Pickup batch id already belongs to another route or operator.'
      using errcode = '23505';
  end if;

  v_existing_json := to_jsonb(v_existing);
  if nullif(v_existing_json->>'returned_to_assigned_at', '') is not null then
    raise exception 'Returned pickup batches cannot be confirmed.'
      using errcode = 'P0001';
  end if;

  update public.route_pickup_batches
  set
    status = case
      when new.status::text = 'confirmed' then new.status
      else public.route_pickup_batches.status
    end,
    selected_stop_ids = coalesce(new.selected_stop_ids, public.route_pickup_batches.selected_stop_ids),
    product_summary = coalesce(new.product_summary, public.route_pickup_batches.product_summary),
    storage_deducted = coalesce(new.storage_deducted, public.route_pickup_batches.storage_deducted),
    confirmed_at = coalesce(new.confirmed_at, public.route_pickup_batches.confirmed_at),
    updated_at = now()
  where id = new.id;

  -- The matching existing row is now the canonical batch. Suppress the duplicate
  -- insert and allow the surrounding atomic pickup transaction to continue.
  return null;
end;
$function$;

do $migration$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'route_pickup_batches'
      and t.tgname = 'snacky_route_pickup_batch_insert_idempotency'
      and not t.tgisinternal
  ) then
    create trigger snacky_route_pickup_batch_insert_idempotency
      before insert on public.route_pickup_batches
      for each row
      execute function public.snacky_route_pickup_batch_insert_idempotency();
  end if;
end
$migration$;

revoke all on function public.snacky_route_pickup_batch_insert_idempotency() from public;

select pg_notify('pgrst', 'reload schema');
