alter type movement_reason add value if not exists 'manual_correction';
alter type movement_reason add value if not exists 'product_substitution';

alter table inventory_movements
  add column if not exists related_machine_id uuid references machines(id) on delete set null;

alter table inventory_movements
  add column if not exists movement_reason movement_reason generated always as (reason) stored;

create index if not exists idx_inventory_movements_reason_created on inventory_movements(reason, created_at desc);
create index if not exists idx_inventory_movements_created_by on inventory_movements(created_by);
create index if not exists idx_inventory_movements_related_route on inventory_movements(related_route_id);
create index if not exists idx_inventory_movements_related_route_stop on inventory_movements(related_route_stop_id);
create index if not exists idx_inventory_movements_related_machine on inventory_movements(related_machine_id);

create table if not exists system_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references profiles(id) on delete set null,
  actor_team_member_id uuid references team_members(id) on delete set null,
  actor_name text,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  entity_label text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb,
  ip_address text,
  user_agent text,
  summary text,
  created_at timestamptz not null default now()
);

alter table system_activity_logs
  add column if not exists actor_user_id uuid references profiles(id) on delete set null,
  add column if not exists actor_team_member_id uuid references team_members(id) on delete set null,
  add column if not exists actor_name text,
  add column if not exists actor_role text,
  add column if not exists entity_label text,
  add column if not exists before_data jsonb,
  add column if not exists after_data jsonb,
  add column if not exists metadata jsonb,
  add column if not exists ip_address text,
  add column if not exists user_agent text,
  add column if not exists summary text;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'system_activity_logs' and column_name = 'actor_id'
  ) then
    execute 'update system_activity_logs set actor_team_member_id = coalesce(actor_team_member_id, actor_id) where actor_team_member_id is null';
  end if;
end $$;

alter table system_activity_logs
  alter column metadata set default '{}'::jsonb;

update system_activity_logs set metadata = '{}'::jsonb where metadata is null;

create index if not exists idx_system_activity_logs_actor on system_activity_logs(actor_team_member_id, created_at desc);
create index if not exists idx_system_activity_logs_actor_user on system_activity_logs(actor_user_id, created_at desc);
create index if not exists idx_system_activity_logs_action on system_activity_logs(action, created_at desc);
create index if not exists idx_system_activity_logs_entity on system_activity_logs(entity_type, entity_id);
create index if not exists idx_system_activity_logs_created on system_activity_logs(created_at desc);

create or replace function log_inventory_movement_activity()
returns trigger as $$
begin
  insert into system_activity_logs (actor_team_member_id, action, entity_type, entity_id, entity_label, summary, after_data, metadata)
  values (
    new.created_by,
    'create',
    'inventory_movement',
    new.id,
    concat(new.reason::text, ' ', new.quantity::text),
    concat('Created ', new.reason::text, ' movement for ', new.quantity::text, ' units'),
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
      'related_machine_id', new.related_machine_id
    )
  );

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_log_inventory_movement_activity on inventory_movements;
create trigger trg_log_inventory_movement_activity
after insert on inventory_movements
for each row execute function log_inventory_movement_activity();
