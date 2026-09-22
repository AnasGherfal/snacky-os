create index if not exists idx_system_activity_logs_metadata_gin
  on public.system_activity_logs
  using gin (metadata jsonb_path_ops);
