create or replace function public.log_inventory_movement_activity()
returns trigger
language plpgsql
as $$
declare
  activity_actor_user_id uuid;
  activity_actor_name text;
  activity_actor_role text;
begin
  if new.created_by is not null then
    select p.id, coalesce(tm.full_name, p.full_name), coalesce(tm.role::text, p.role::text)
      into activity_actor_user_id, activity_actor_name, activity_actor_role
    from team_members tm
    left join profiles p on p.team_member_id = tm.id
    where tm.id = new.created_by
    order by p.created_at nulls last
    limit 1;
  end if;

  insert into system_activity_logs (
    actor_user_id,
    actor_team_member_id,
    actor_name,
    actor_role,
    action,
    entity_type,
    entity_id,
    entity_label,
    summary,
    after_data,
    metadata
  )
  values (
    activity_actor_user_id,
    new.created_by,
    activity_actor_name,
    activity_actor_role,
    'create_inventory_movement',
    'inventory_movement',
    new.id,
    concat(replace(new.reason::text, '_', ' '), ' ', new.quantity::text),
    concat('Created ', replace(new.reason::text, '_', ' '), ' movement for ', new.quantity::text, ' units'),
    to_jsonb(new),
    jsonb_build_object(
      'product_id', new.product_id,
      'quantity', new.quantity,
      'from_entity_type', new.from_entity_type,
      'from_entity_id', new.from_entity_id,
      'to_entity_type', new.to_entity_type,
      'to_entity_id', new.to_entity_id,
      'movement_reason', new.reason,
      'related_route_id', new.related_route_id,
      'related_route_stop_id', new.related_route_stop_id,
      'related_purchase_id', new.related_purchase_id,
      'related_purchase_line_id', new.related_purchase_line_id,
      'related_machine_id', new.related_machine_id,
      'reversed_movement_id', new.reversed_movement_id,
      'import_batch_id', new.import_batch_id,
      'historical_route_deduction_line_id', new.historical_route_deduction_line_id,
      'original_text', new.original_text
    )
  );

  return new;
end;
$$;
