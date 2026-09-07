-- Repair prerequisites that can be absent when the atomic purchase migrations
-- were installed manually on an older production schema.
--
-- Received purchases write an immutable inventory movement. The command needs
-- the request payload column, and its audit trigger must remain valid while the
-- SECURITY DEFINER purchase function pins an empty search_path.

alter table public.inventory_movements
  add column if not exists idempotency_payload jsonb;

create or replace function public.log_inventory_movement_activity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  activity_actor_user_id uuid;
  activity_actor_name text;
  activity_actor_role text;
begin
  if new.created_by is not null then
    select
      profile_row.id,
      coalesce(team_row.full_name, profile_row.full_name),
      coalesce(team_row.role::text, profile_row.role::text)
    into activity_actor_user_id, activity_actor_name, activity_actor_role
    from public.team_members team_row
    left join public.profiles profile_row
      on profile_row.team_member_id = team_row.id
    where team_row.id = new.created_by
    order by profile_row.created_at nulls last
    limit 1;
  end if;

  insert into public.system_activity_logs (
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
  ) values (
    activity_actor_user_id,
    new.created_by,
    activity_actor_name,
    activity_actor_role,
    'create_inventory_movement',
    'inventory_movement',
    new.id,
    pg_catalog.concat(
      pg_catalog.replace(new.reason::text, '_', ' '),
      ' ',
      new.quantity::text
    ),
    pg_catalog.concat(
      'Created ',
      pg_catalog.replace(new.reason::text, '_', ' '),
      ' movement for ',
      new.quantity::text,
      ' units'
    ),
    pg_catalog.to_jsonb(new),
    pg_catalog.jsonb_build_object(
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
$function$;

revoke all on function public.log_inventory_movement_activity()
  from public, anon, authenticated;

select pg_catalog.pg_notify('pgrst', 'reload schema');
