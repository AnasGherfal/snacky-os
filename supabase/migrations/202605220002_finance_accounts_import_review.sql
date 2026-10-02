create table if not exists finance_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_file text not null,
  source_sheet text not null,
  mode text not null default 'import',
  imported_by uuid references team_members(id) on delete set null,
  status text not null default 'processing',
  row_count integer not null default 0,
  imported_count integer not null default 0,
  auto_classified_count integer not null default 0,
  confirmed_count integer not null default 0,
  needs_review_count integer not null default 0,
  ignored_count integer not null default 0,
  review_group_count integer not null default 0,
  clarification_prompts jsonb not null default '[]'::jsonb,
  error_message text,
  imported_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table finance_settings
  add column if not exists opening_balance_snacky_lyd numeric(12,2) not null default 0,
  add column if not exists opening_balance_snacky_usd numeric(12,2) not null default 0,
  add column if not exists opening_balance_owner_lyd numeric(12,2) not null default 0,
  add column if not exists opening_balance_owner_usd numeric(12,2) not null default 0,
  add column if not exists exchange_rate_usd_to_lyd numeric(12,6);

update finance_settings
set opening_balance_snacky_lyd = coalesce(opening_balance_snacky_lyd, opening_balance, 0)
where id = 'default';

alter table financial_transactions
  add column if not exists currency text not null default 'LYD',
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists exchange_rate_usd_to_lyd numeric(12,6),
  add column if not exists import_batch_id uuid references finance_import_batches(id) on delete set null,
  add column if not exists original_csv_row jsonb not null default '{}'::jsonb,
  add column if not exists review_reason text,
  add column if not exists suggested_category text,
  add column if not exists suggested_account text,
  add column if not exists suggested_machine text,
  add column if not exists confidence_score numeric(5,4);

update financial_transactions
set
  currency = coalesce(nullif(currency, ''), 'LYD'),
  account_id = coalesce(nullif(account_id, ''), 'snacky_lyd'),
  transaction_effect = coalesce(nullif(transaction_effect, ''), case when direction = 'money_in' then 'income' else 'expense' end)
where currency is null
   or account_id is null
   or transaction_effect is null;

alter table financial_transactions
  alter column account_id set default 'snacky_lyd',
  alter column transaction_effect set default 'expense';

update financial_transactions
set
  transaction_effect = 'transfer',
  account_id = 'snacky_lyd',
  source_account_id = 'snacky_lyd',
  destination_account_id = 'owner_lyd',
  final_bucket = coalesce(nullif(final_bucket, 'Owner Draw'), 'Owner Transfer')
where transaction_status = 'active'
  and (
    lower(coalesce(transaction_type, '')) = 'anas'
    or lower(coalesce(final_bucket, '')) = 'owner draw'
  );

update financial_transactions
set
  transaction_effect = 'transfer',
  account_id = 'snacky_lyd',
  source_account_id = 'owner_lyd',
  destination_account_id = 'snacky_lyd',
  final_bucket = 'Owner Funding'
where transaction_status = 'active'
  and lower(coalesce(transaction_type, '')) = 'to snacky';

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'financial_transactions'::regclass
      and pg_get_constraintdef(oid) ilike '%import_status%'
  loop
    execute format('alter table financial_transactions drop constraint %I', constraint_name);
  end loop;
end $$;

alter table financial_transactions
  add constraint financial_transactions_import_status_check
  check (import_status is null or import_status in ('imported', 'auto_classified', 'needs_review', 'confirmed', 'ignored', 'skipped'));

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_currency_check check (currency in ('LYD', 'USD'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_account_id_check check (
      account_id is null or account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_effect_check check (
      transaction_effect in ('income', 'expense', 'transfer', 'opening_balance')
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table financial_transactions
    add constraint financial_transactions_transfer_accounts_check check (
      transaction_effect <> 'transfer'
      or (
        source_account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
        and destination_account_id in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
        and source_account_id <> destination_account_id
      )
    );
exception when duplicate_object then null; end $$;

alter table finance_import_rows
  add column if not exists import_batch_id uuid references finance_import_batches(id) on delete set null,
  add column if not exists currency text,
  add column if not exists account_id text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists review_group_key text,
  add column if not exists suggested_category text,
  add column if not exists suggested_account text,
  add column if not exists suggested_currency text,
  add column if not exists suggested_machine text,
  add column if not exists suggested_machine_id uuid references machines(id) on delete set null,
  add column if not exists suggested_source_account text,
  add column if not exists suggested_destination_account text,
  add column if not exists confidence_score numeric(5,4),
  add column if not exists clarification_question text;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select conname
    from pg_constraint
    where conrelid = 'finance_import_rows'::regclass
      and pg_get_constraintdef(oid) ilike '%import_status%'
  loop
    execute format('alter table finance_import_rows drop constraint %I', constraint_name);
  end loop;
end $$;

alter table finance_import_rows
  add constraint finance_import_rows_import_status_check
  check (import_status in ('imported', 'auto_classified', 'needs_review', 'confirmed', 'ignored', 'skipped'));

create table if not exists machine_aliases (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references machines(id) on delete cascade,
  alias_name text not null,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  unique(alias_name)
);

update machines
set name = 'جامعة طرابلس الاهليه',
    updated_at = now()
where vms_machine_id = '2510001719'
   or machine_code in ('2510001719', 'SNK-2510001719')
   or name = 'خليج ليبيا';

insert into machine_aliases (machine_id, alias_name, source)
select m.id, alias_name, 'finance_import'
from machines m
cross join (values
  ('KhalijUniversity'),
  ('Khalij University'),
  ('2510001719'),
  ('خليج ليبيا'),
  ('جامعة طرابلس الاهليه')
) as aliases(alias_name)
where m.vms_machine_id = '2510001719'
   or m.machine_code in ('2510001719', 'SNK-2510001719')
   or m.name = 'جامعة طرابلس الاهليه'
on conflict (alias_name) do update
set machine_id = excluded.machine_id,
    source = excluded.source;

create index if not exists idx_machine_aliases_lookup
  on machine_aliases(lower(alias_name));

create index if not exists idx_financial_transactions_account_currency_date
  on financial_transactions(account_id, currency, transaction_date desc);

create index if not exists idx_financial_transactions_import_batch
  on financial_transactions(import_batch_id);

create index if not exists idx_finance_import_rows_review_group
  on finance_import_rows(import_status, review_group_key);

create unique index if not exists idx_financial_transactions_source_file_row
  on financial_transactions(source_file, source_sheet, source_row)
  where source_file is not null and source_sheet is not null and source_row is not null;

create index if not exists idx_financial_transactions_business_dedupe
  on financial_transactions(
    transaction_date,
    amount,
    coalesce(original_description, description, ''),
    currency,
    transaction_effect,
    coalesce(account_id, ''),
    coalesce(source_account_id, ''),
    coalesce(destination_account_id, '')
  )
  where transaction_status = 'active'
    and coalesce(import_status, '') not in ('ignored', 'skipped');

create or replace view finance_account_balance_impacts as
select
  id as financial_transaction_id,
  transaction_date,
  account_id as account_id,
  currency,
  signed_amount as amount_delta,
  transaction_effect,
  final_bucket,
  source_file,
  source_sheet,
  source_row
from financial_transactions
where transaction_status = 'active'
  and coalesce(needs_review, false) = false
  and coalesce(import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and transaction_effect <> 'transfer'
  and account_id is not null

union all

select
  id,
  transaction_date,
  source_account_id,
  case when right(source_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  -abs(amount),
  transaction_effect,
  final_bucket,
  source_file,
  source_sheet,
  source_row
from financial_transactions
where transaction_status = 'active'
  and coalesce(needs_review, false) = false
  and coalesce(import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and transaction_effect = 'transfer'
  and source_account_id is not null

union all

select
  id,
  transaction_date,
  destination_account_id,
  case when right(destination_account_id, 3) = 'usd' then 'USD' else 'LYD' end,
  abs(amount),
  transaction_effect,
  final_bucket,
  source_file,
  source_sheet,
  source_row
from financial_transactions
where transaction_status = 'active'
  and coalesce(needs_review, false) = false
  and coalesce(import_status, '') not in ('needs_review', 'ignored', 'skipped')
  and transaction_effect = 'transfer'
  and destination_account_id is not null;

create or replace view finance_account_balances as
select
  account_id,
  currency,
  sum(amount_delta)::numeric(12,2) as balance
from finance_account_balance_impacts
group by account_id, currency;

create or replace view finance_import_clarification_groups as
select
  coalesce(review_group_key, review_reason, 'needs_review') as review_group_key,
  count(*)::integer as affected_rows,
  (array_agg(coalesce(nullif(original_description, ''), raw_category, 'Unclear transaction') order by source_row))[1:3] as example_descriptions,
  sum(abs(coalesce(amount, 0)))::numeric(12,2) as total_amount,
  coalesce(max(suggested_currency), max(currency), 'LYD') as currency,
  max(suggested_category) as suggested_category,
  max(suggested_account) as suggested_account,
  max(suggested_machine) as suggested_machine,
  max(suggested_source_account) as suggested_source_account,
  max(suggested_destination_account) as suggested_destination_account,
  avg(coalesce(confidence_score, 0))::numeric(5,4) as confidence_score,
  max(clarification_question) as clarification_question,
  max(review_reason) as review_reason
from finance_import_rows
where import_status = 'needs_review'
group by coalesce(review_group_key, review_reason, 'needs_review');
