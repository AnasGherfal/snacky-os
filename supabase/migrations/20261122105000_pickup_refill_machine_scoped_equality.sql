-- Prevent a partial route pickup for one machine from being compared to
-- a refill-order line that belongs to a DIFFERENT machine on the same route.
--
-- Example, verified in the live 2026-11-22 Noury route:
-- Khalij picked 8 Spuds prime ribs, but only Istiklal has an original
-- refill_order_line for that product. The same 8 units can be a valid
-- machine-specific manually planned pickup; it must not be counted as
-- Istiklal's original refill line or block Khalij with SQLSTATE 23514.
--
-- Preserve the original strict aggregate matching for every selected product
-- that DOES have a refill-order line for its selected machine. Legacy rows
-- whose machine_id is null retain the original product-level fallback.
--
-- The existing v3 function is large and was previously created by migrations;
-- patch only these two exact snippets of its EXISTING definition. Abort
-- atomically if the live function differs, rather than replacing it blindly.
do $snacky_refill_machine_match$
declare
  v_oid oid;
  v_definition text;
  v_updated text;
  v_old_recordset text := $old_recordset$row_value(
            product_id uuid,
            picked_qty integer,
            action_type text
          )
          where row_value.action_type <> 'extra_product'$old_recordset$;
  v_new_recordset text := $new_recordset$row_value(
            machine_id uuid,
            product_id uuid,
            picked_qty integer,
            action_type text
          )
          where row_value.action_type <> 'extra_product'$new_recordset$;
  v_old_match text := $old_match$where refill.route_id = p_route_id
                and line.product_id = row_value.product_id$old_match$;
  v_new_match text := $new_match$where refill.route_id = p_route_id
                and line.product_id = row_value.product_id
                and (row_value.machine_id is null
                  or refill.machine_id = row_value.machine_id)$new_match$;
begin
  select p.oid into v_oid
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='snacky_confirm_route_pickup_batch_v3'
    and p.prokind='f';
  if v_oid is null then
    raise exception 'Cannot patch missing pickup-v3 confirmation function';
  end if;

  select pg_get_functiondef(v_oid) into v_definition;

  -- Safe reapplication when this migration was first applied manually to the
  -- connected live database and then later replayed through the migration tool.
  if position(v_new_recordset in v_definition)>0
     and position(v_new_match in v_definition)>0 then return; end if;

  if (length(v_definition)-length(replace(v_definition,v_old_recordset,'')))
       <> length(v_old_recordset)
     or (length(v_definition)-length(replace(v_definition,v_old_match,'')))
       <> length(v_old_match)
  then
    raise exception 'Pickup-v3 changed since preflight. Refusing automatic SQL patch.';
  end if;

  v_updated := replace(replace(v_definition,v_old_recordset,v_new_recordset),
                       v_old_match,v_new_match);
  if v_updated=v_definition then
    raise exception 'Refill machine matching patch made no change.';
  end if;

  execute v_updated;

  if not exists (
    select 1 from pg_proc p
    where p.oid=v_oid
      and position(v_new_recordset in pg_get_functiondef(p.oid))>0
      and position(v_new_match in pg_get_functiondef(p.oid))>0
  ) then
    raise exception 'Pickup-v3 machine-specific refill check was not installed.';
  end if;
end
$snacky_refill_machine_match$;