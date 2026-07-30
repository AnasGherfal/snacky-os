-- Keep enum additions in their own committed migration so later schema objects can safely use them.
alter type public.inventory_entity_type add value if not exists 'operator_personal_purchase';
alter type public.movement_reason add value if not exists 'operator_personal_purchase';
