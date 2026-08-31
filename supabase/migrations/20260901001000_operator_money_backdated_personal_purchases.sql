-- Allow an owner/admin to record a personal storage item in a specifically selected
-- reopened operator-money period while preserving the actual inventory deduction time.

create or replace function public.create_operator_personal_purchase_for_period(
  p_person_id uuid,
  p_period_id uuid,
  p_product_id uuid,
  p_storage_location_id uuid,
  p_quantity integer,
  p_purchased_at timestamptz,
  p_note text,
  p_client_submission_id text
) returns public.operator_personal_purchases
language plpgsql
security definer
set search_path=public,auth
as $$
declare
  a uuid:=public.snacky_current_team_member_id();
  v_period public.operator_money_periods%rowtype;
  q integer;
  reserved integer;
  price numeric;
  row public.operator_personal_purchases;
  movement uuid;
  v_local_date date;
begin
  if a is null then
    raise exception 'Not authenticated' using errcode='28000';
  end if;
  if not public.snacky_operator_money_is_manager() then
    raise exception 'Only owner/admin can add an item to a selected money period' using errcode='42501';
  end if;
  if p_quantity is null or p_quantity<=0 then
    raise exception 'Quantity must be positive' using errcode='23514';
  end if;
  if p_purchased_at is null then
    raise exception 'Item taken date is required' using errcode='23514';
  end if;
  if p_purchased_at>now()+interval '5 minutes' then
    raise exception 'Item taken date cannot be in the future' using errcode='23514';
  end if;

  select * into row
  from public.operator_personal_purchases
  where client_submission_id=p_client_submission_id;
  if found then
    return row;
  end if;

  select * into v_period
  from public.operator_money_periods
  where id=p_period_id and person_id=p_person_id
  for update;
  if not found then
    raise exception 'Money period not found for this operator' using errcode='P0002';
  end if;
  if v_period.lifecycle_status<>'open' or v_period.settled_at is not null then
    raise exception 'The selected operator money period is closed or settled' using errcode='23514';
  end if;

  v_local_date:=(p_purchased_at at time zone 'Africa/Tripoli')::date;
  if v_local_date<v_period.period_start or v_local_date>v_period.period_end then
    raise exception 'Item taken date must be inside the selected money period' using errcode='23514';
  end if;

  select coalesce(current_selling_price_lyd,selling_price,0)
  into price
  from public.products
  where id=p_product_id and active=true;
  if not found then
    raise exception 'Product not found' using errcode='P0002';
  end if;
  if price<=0 then
    raise exception 'Product selling price is missing or invalid' using errcode='23514';
  end if;

  select coalesce(quantity_on_hand,0)::integer
  into q
  from public.current_inventory_by_location
  where location_type='storage'
    and location_id=p_storage_location_id
    and product_id=p_product_id;

  reserved:=public.operator_money_reserved_qty(p_product_id);
  if greatest(coalesce(q,0)-reserved,0)<p_quantity then
    raise exception 'Not enough genuinely available storage stock after route reservations' using errcode='23514';
  end if;

  insert into public.inventory_movements(
    product_id,quantity,from_entity_type,from_entity_id,to_entity_type,to_entity_id,
    reason,idempotency_key,source_type,created_by,notes
  ) values(
    p_product_id,p_quantity,'storage',p_storage_location_id,
    'operator_personal_purchase',p_person_id,
    'operator_personal_purchase',p_client_submission_id,
    'operator_personal_purchase',a,
    concat_ws(' · ',
      nullif(trim(coalesce(p_note,'')),''),
      'Recorded for operator money period '||v_period.label,
      'Item taken date '||v_local_date::text
    )
  ) returning id into movement;

  insert into public.operator_personal_purchases(
    person_id,period_id,product_id,storage_location_id,quantity,unit_price_lyd,note,
    inventory_movement_id,client_submission_id,created_by,purchased_at
  ) values(
    p_person_id,p_period_id,p_product_id,p_storage_location_id,p_quantity,price,
    nullif(trim(coalesce(p_note,'')),''),movement,p_client_submission_id,a,p_purchased_at
  ) returning * into row;

  return row;
end
$$;

revoke all on function public.create_operator_personal_purchase_for_period(
  uuid,uuid,uuid,uuid,integer,timestamptz,text,text
) from public,anon;
grant execute on function public.create_operator_personal_purchase_for_period(
  uuid,uuid,uuid,uuid,integer,timestamptz,text,text
) to authenticated;

notify pgrst,'reload schema';
