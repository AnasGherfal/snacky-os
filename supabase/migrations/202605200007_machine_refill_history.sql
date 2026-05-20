create table if not exists machine_refill_history (
  id uuid primary key default gen_random_uuid(),
  legacy_refill_id text not null,
  refill_at timestamptz not null,
  machine_id uuid references machines(id) on delete set null,
  machine_name text not null,
  operator_id uuid references team_members(id) on delete set null,
  operator_email text,
  machine_photo_url text,
  machine_photo_path text,
  fill_status text,
  issues_found boolean not null default false,
  issue_notes text,
  linked_issue_id uuid references issues(id) on delete set null,
  source_file text not null default 'Items - MachineRefills.csv',
  source_row integer,
  import_status text not null default 'imported',
  review_reason text,
  raw_record jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint machine_refill_history_legacy_refill_id_unique unique (legacy_refill_id),
  constraint machine_refill_history_source_row_unique unique (source_file, source_row),
  constraint machine_refill_history_import_status_check check (import_status in ('imported', 'needs_review', 'skipped'))
);

create index if not exists idx_machine_refill_history_refill_at
  on machine_refill_history(refill_at desc);

create index if not exists idx_machine_refill_history_machine_at
  on machine_refill_history(machine_id, refill_at desc);

create index if not exists idx_machine_refill_history_operator_at
  on machine_refill_history(operator_id, refill_at desc);

create index if not exists idx_machine_refill_history_issues
  on machine_refill_history(issues_found, refill_at desc);

create or replace view machine_refill_history_metrics as
select
  machine_id,
  machine_name,
  count(*)::integer as total_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'full')::integer as full_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'partial')::integer as partial_refills,
  count(*) filter (where issues_found)::integer as issue_refills,
  max(refill_at) as last_refill_at,
  count(distinct operator_id) filter (where operator_id is not null)::integer as operator_count
from machine_refill_history
group by machine_id, machine_name;

create or replace view machine_refill_history_monthly as
select
  date_trunc('month', refill_at)::date as month_start,
  machine_id,
  machine_name,
  count(*)::integer as total_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'full')::integer as full_refills,
  count(*) filter (where lower(coalesce(fill_status, '')) = 'partial')::integer as partial_refills,
  count(*) filter (where issues_found)::integer as issue_refills
from machine_refill_history
group by date_trunc('month', refill_at)::date, machine_id, machine_name;
