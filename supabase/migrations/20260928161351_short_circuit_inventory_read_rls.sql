alter policy snacky_inventory_movements_select_by_effective_role
on public.inventory_movements
using (
  case
    when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']::text[]))
      then true
    when related_route_id is not null
      then public.snacky_operator_can_access_route(related_route_id)
    else false
  end
);

alter policy snacky_products_select_by_effective_role
on public.products
using (
  case
    when (select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing','finance']::text[]))
      then true
    else public.snacky_operator_can_read_product(id)
  end
);

select pg_notify('pgrst','reload schema');
