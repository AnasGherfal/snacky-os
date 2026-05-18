alter table products
  alter column import_source set default 'initial_import';

update products
set import_source = 'initial_import'
where import_source = 'manual'
  and last_vms_import_batch_id is null
  and last_vms_seen_at is null;
