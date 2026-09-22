create index if not exists idx_machine_slots_active_machine_product
  on public.machine_slots (machine_id, product_id)
  include (slot_code, min_qty, par_qty, created_at)
  where active = true;
