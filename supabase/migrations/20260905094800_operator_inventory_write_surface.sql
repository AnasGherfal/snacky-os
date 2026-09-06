-- Operators post route inventory only through the locked pickup, stop, sale,
-- compensation, and terminal RPCs. Direct INSERT previously let an assigned
-- operator forge arbitrary route movement endpoints and bypass those contracts.

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'public.inventory_movements'::pg_catalog.regclass
      and constraint_row.conname = 'inventory_movements_operator_bag_endpoint_ids'
  ) then
    alter table public.inventory_movements
      add constraint inventory_movements_operator_bag_endpoint_ids
      check (
        (from_entity_type::text <> 'operator_bag' or from_entity_id is not null)
        and (to_entity_type::text <> 'operator_bag' or to_entity_id is not null)
      ) not valid;
  end if;
end;
$migration$;

drop policy if exists "snacky_inventory_movements_insert_by_effective_role"
  on public.inventory_movements;

-- Start from least privilege. Production historically granted ALL directly to
-- both anon and authenticated, including TRUNCATE (which bypasses RLS),
-- TRIGGER, REFERENCES, and MAINTAIN. Every business write now goes through a
-- locked SECURITY DEFINER command; signed-in clients only read the immutable
-- ledger and cannot append, replace, delete, or truncate it directly.
revoke all on table public.inventory_movements from public, anon, authenticated;
grant select on table public.inventory_movements to authenticated;
grant all on table public.inventory_movements to service_role;

select pg_notify('pgrst', 'reload schema');
