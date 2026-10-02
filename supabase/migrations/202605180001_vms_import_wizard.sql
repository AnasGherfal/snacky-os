alter table vms_import_previews
  add column if not exists file_size_bytes bigint;
