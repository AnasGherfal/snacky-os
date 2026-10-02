alter table machine_refill_history
  add column if not exists route_id uuid references routes(id) on delete set null,
  add column if not exists route_stop_id uuid references route_stops(id) on delete set null;

create index if not exists idx_machine_refill_history_route_id
  on machine_refill_history(route_id);

create index if not exists idx_machine_refill_history_route_stop_id
  on machine_refill_history(route_stop_id);
