-- Allow owner/admin to backfill or record an operator's personal purchases without deleting audit history.
-- Historical entries may already have been removed from storage before Snacky OS tracked operator purchases,
-- so they deliberately do not create a second inventory deduction.

alter table public.operator_personal_purchases
  alter column storage_location_id drop not null;

alter table public.operator_personal_purchases
  add column if not exists entry_source text not null default 'operator';

alter table public.operator_personal_purchases
  drop constraint if exists operator_personal_purchases_entry_source_check;

alter table public.operator_personal_purchases
  add constraint operator_personal_purchases_entry_source_check
  check (entry_source in ('operator','admin_current','admin_historical'));

create or replace function public.create_admin_operator_personal_purchase(
  p_person_id uuid,
  p_product_id uuid,
  p_storage_location_id uuid,
  p_quantity integer,
  p_unit_price_lyd numeric,
  p_purchased_at timestamptz,
  p_note text,
  p_inventory_already_removed boolean,
  p_client_submission_id text
) returns public.operator_personal_purchases
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  actor uuid := public.snacky_current_team_member_id();
  on_hand integer;
  reserved integer;
  price numeric;
  row public.operator_personal_purchases;
  movement uuid;
  movement_note text;
begin
  if actor is null then
    raise exception 'Not authenticated' using errcode='28000';
  end if;
  if not public.snacky_operator_money_is_manager() then
    raise exception 'Only owner/admin can add a purchase for an operator' using errcode='42501';
  end if;
  if p_person_id is null then raise exception 'Operator is required'; end if;
  if p_product_id is null then raise exception 'Product is required'; end if;
  if coalesce(p_quantity,0) <= 0 then raise exception 'Quantity must be greater than zero'; end if;

  select * into row
  from public.operator_personal_purchases
  where client_submission_id=p_client_submission_id;
  if found then return row; end if;

  select coalesce(p_unit_price_lyd,current_selling_price_lyd,selling_price,0)
    into price
  from public.products
  where id=p_product_id and active=true;
  if not found then raise exception 'Product not found'; end if;

  if coalesce(p_inventory_already_removed,false) then
    -- Historical/backfill record. Stock physically left storage before this record existed,
    -- therefore creating another movement now would double-deduct inventory.
    insert into public.operator_personal_purchases(
      person_id,product_id,storage_location_id,quantity,unit_price_lyd,note,
      inventory_movement_id,client_submission_id,created_by,purchased_at,entry_source
    ) values (
      p_person_id,p_product_id,null,p_quantity,price,
      nullif(trim(coalesce(p_note,'')),''),null,p_client_submission_id,actor,
      coalesce(p_purchased_at,now()),'admin_historical'
    ) returning * into row;
    return row;
  end if;

  if p_storage_location_id is null then raise exception 'Storage location is required for a current purchase'; end if;

  select coalesce(quantity_on_hand,0)::integer into on_hand
  from public.current_inventory_by_location
  where location_type='storage'
    and location_id=p_storage_location_id
    and product_id=p_product_id;

  reserved := public.operator_money_reserved_qty(p_product_id);
  if greatest(coalesce(on_hand,0)-reserved,0) < p_quantity then
    raise exception 'Not enough genuinely available storage stock after route reservations' using errcode='23514';
  end if;

  movement_note := coalesce(nullif(trim(coalesce(p_note,'')),''),'Admin-recorded operator personal purchase');
  insert into public.inventory_movements(
    product_id,quantity,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    reason,idempotency_key,source_type,created_by,notes
  ) values (
    p_product_id,p_quantity,'storage',p_storage_location_id,'operator_personal_purchase',p_person_id,
    'operator_personal_purchase',p_client_submission_id,'operator_personal_purchase',actor,movement_note
  ) returning id into movement;

  insert into public.operator_personal_purchases(
    person_id,product_id,storage_location_id,quantity,unit_price_lyd,note,
    inventory_movement_id,client_submission_id,created_by,purchased_at,entry_source
  ) values (
    p_person_id,p_product_id,p_storage_location_id,p_quantity,price,
    nullif(trim(coalesce(p_note,'')),''),movement,p_client_submission_id,actor,
    coalesce(p_purchased_at,now()),'admin_current'
  ) returning * into row;
  return row;
end
$$;

grant execute on function public.create_admin_operator_personal_purchase(uuid,uuid,uuid,integer,numeric,timestamptz,text,boolean,text) to authenticated;

notify pgrst, 'reload schema';
