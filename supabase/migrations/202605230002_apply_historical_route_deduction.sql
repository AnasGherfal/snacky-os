create or replace function public.apply_historical_route_deduction_batch(
  target_batch_id uuid,
  actor_team_member_id uuid
)
returns table(inserted_movements integer, skipped_review_rows integer)
language plpgsql
as $$
declare
  current_status text;
  ready_count integer;
  inserted_count integer := 0;
  review_count integer := 0;
  deduction_line record;
  inserted_movement_id uuid;
begin
  select status
    into current_status
  from historical_route_deduction_batches
  where id = target_batch_id
  for update;

  if not found then
    raise exception 'Historical route deduction batch was not found.';
  end if;

  if current_status = 'applied' then
    raise exception 'This historical route deduction batch has already been applied.';
  end if;

  if current_status <> 'previewed' then
    raise exception 'Only previewed historical route deduction batches can be applied.';
  end if;

  select count(*)::integer
    into ready_count
  from historical_route_deduction_lines
  where import_batch_id = target_batch_id
    and status = 'ready'
    and product_id is not null
    and machine_id is not null
    and quantity is not null
    and quantity > 0
    and storage_location_id is not null;

  if coalesce(ready_count, 0) = 0 then
    raise exception 'This batch has no ready deduction rows to apply.';
  end if;

  for deduction_line in
    select *
    from historical_route_deduction_lines
    where import_batch_id = target_batch_id
      and status = 'ready'
      and product_id is not null
      and machine_id is not null
      and quantity is not null
      and quantity > 0
      and storage_location_id is not null
    order by line_number, id
    for update
  loop
    insert into inventory_movements (
      product_id,
      quantity,
      from_entity_type,
      from_entity_id,
      to_entity_type,
      to_entity_id,
      reason,
      related_machine_id,
      created_by,
      notes,
      import_batch_id,
      original_text,
      historical_route_deduction_line_id
    )
    values (
      deduction_line.product_id,
      deduction_line.quantity,
      'storage',
      deduction_line.storage_location_id,
      'historical_route',
      null,
      'historical_route_deduction',
      deduction_line.machine_id,
      actor_team_member_id,
      concat_ws(
        ' - ',
        'Old route data was not previously deducted from storage',
        concat('Machine/location: ', coalesce(deduction_line.section_name, deduction_line.machine_alias, 'Unknown')),
        concat('Original row: ', deduction_line.original_text)
      ),
      target_batch_id,
      deduction_line.original_text,
      deduction_line.id
    )
    returning id into inserted_movement_id;

    update historical_route_deduction_lines
    set
      status = 'applied',
      movement_id = inserted_movement_id,
      applied_at = now()
    where id = deduction_line.id;

    inserted_count := inserted_count + 1;
  end loop;

  select count(*)::integer
    into review_count
  from historical_route_deduction_lines
  where import_batch_id = target_batch_id
    and status = 'needs_review';

  update historical_route_deduction_batches
  set
    status = 'applied',
    applied_by = actor_team_member_id,
    applied_at = now(),
    updated_at = now()
  where id = target_batch_id;

  return query select inserted_count, coalesce(review_count, 0);
end;
$$;
