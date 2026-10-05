\set ON_ERROR_STOP on
-- Isolated contract fixture: represent the real stock view's lockable source tables.
alter table public.latest_vms_stock_by_slot rename to vms_stock_snapshots;
create table public.vms_import_batches(id uuid primary key);
create view public.latest_vms_stock_by_slot as select * from public.vms_stock_snapshots;
grant all on public.vms_stock_snapshots,public.vms_import_batches,public.latest_vms_stock_by_slot to service_role;
