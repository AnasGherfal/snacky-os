\set ON_ERROR_STOP on
create table public.smart_route_slot_product_rules (id integer primary key, rule text not null);
insert into public.smart_route_slot_product_rules values (1,'allowed');
\i supabase/feature-sql/smart_work_product_capacity.sql
\i supabase/feature-sql/smart_work_product_capacity.sql
do $$ begin
  if (select verified_capacity from public.smart_route_slot_product_rules where id=1) is not null then raise exception 'Historical capacity was invented';end if;
  update public.smart_route_slot_product_rules set verified_capacity=12 where id=1;
  if (select verified_capacity from public.smart_route_slot_product_rules where id=1)<>12 then raise exception 'Capacity did not persist';end if;
  begin update public.smart_route_slot_product_rules set verified_capacity=0 where id=1;raise exception 'Zero accepted';exception when check_violation then null;end;
  begin update public.smart_route_slot_product_rules set verified_capacity=1001 where id=1;raise exception 'Oversized accepted';exception when check_violation then null;end;
end $$;
