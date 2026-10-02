-- Restore the finance ledger read contract and expose an admin health report.
-- This does not add new finance features; it makes existing ledger pages resilient and auditable.

alter table public.financial_transactions
  add column if not exists transaction_datetime timestamptz,
  add column if not exists notes text,
  add column if not exists currency text default 'LYD',
  add column if not exists account_id text,
  add column if not exists account_key text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists import_status text,
  add column if not exists category text,
  add column if not exists payment_method text,
  add column if not exists transaction_status text default 'active',
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists related_location_id uuid,
  add column if not exists receipt_url text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists is_void boolean default false,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists status_reason text;

update public.financial_transactions
set
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), nullif(trim(source_account_id), ''), 'snacky_lyd'),
  category = coalesce(nullif(trim(category), ''), nullif(trim(final_bucket), ''), nullif(trim(transaction_type), ''), nullif(trim(bucket), '')),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), case when coalesce(is_void, false) or voided_at is not null then 'voided' else 'active' end),
  import_status = coalesce(nullif(trim(import_status), ''), case when coalesce(needs_review, false) then 'needs_review' else 'imported' end),
  is_void = coalesce(is_void, false),
  notes = coalesce(notes, description),
  updated_at = now()
where transaction_datetime is null
   or currency is null
   or account_key is null
   or category is null
   or transaction_status is null
   or import_status is null
   or is_void is null
   or notes is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_purchase_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_fkey
      foreign key (linked_purchase_id) references public.purchase_orders(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_linked_cash_collection_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_cash_collection_id_fkey
      foreign key (linked_cash_collection_id) references public.cash_collections(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_related_route_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_related_route_id_fkey
      foreign key (related_route_id) references public.routes(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_related_machine_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_related_machine_id_fkey
      foreign key (related_machine_id) references public.machines(id) on delete set null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'financial_transactions_related_location_id_fkey' and conrelid = 'public.financial_transactions'::regclass) then
    alter table public.financial_transactions
      add constraint financial_transactions_related_location_id_fkey
      foreign key (related_location_id) references public.locations(id) on delete set null;
  end if;
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_financial_transactions_status_date
  on public.financial_transactions(transaction_status, transaction_date desc);

create index if not exists idx_financial_transactions_source_type_source_id
  on public.financial_transactions(source_type, source_id)
  where source_type is not null and source_id is not null;

create index if not exists idx_financial_transactions_linked_purchase_active
  on public.financial_transactions(linked_purchase_id)
  where linked_purchase_id is not null and coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false;

create index if not exists idx_financial_transactions_linked_cash_collection_active
  on public.financial_transactions(linked_cash_collection_id)
  where linked_cash_collection_id is not null and coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false;

drop function if exists public.finance_health_report();

create or replace function public.finance_health_report()
returns jsonb
language plpgsql
security definer
set search_path = public, information_schema, pg_catalog
as $$
declare
  v_expected text[] := array[
    'id', 'transaction_date', 'transaction_datetime', 'direction', 'transaction_kind', 'transaction_type',
    'location', 'description', 'notes', 'amount', 'signed_amount', 'currency', 'account_id', 'account_key',
    'transaction_effect', 'source_account_id', 'destination_account_id', 'import_status', 'category', 'bucket',
    'final_bucket', 'payment_method', 'transaction_status', 'review_status', 'needs_review', 'source_sheet',
    'source_row', 'related_purchase_id', 'linked_purchase_id', 'source_type', 'source_id',
    'related_cash_collection_id', 'linked_cash_collection_id', 'related_route_id', 'related_machine_id',
    'related_location_id', 'receipt_url', 'counterparty_text', 'payer_text', 'paid_to_text', 'is_void',
    'voided_at', 'void_reason', 'created_at', 'updated_at', 'created_by'
  ];
  v_missing text[];
  v_purchase_count integer;
  v_cash_count integer;
  v_transaction_count integer;
  v_linked_purchase_count integer;
  v_linked_cash_count integer;
  v_missing_purchase_count integer;
  v_missing_cash_count integer;
begin
  select coalesce(array_agg(expected_column order by expected_column), array[]::text[])
  into v_missing
  from unnest(v_expected) as expected_column
  where not exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'financial_transactions'
      and c.column_name = expected_column
  );

  select count(*)::integer into v_purchase_count from public.purchase_orders;
  select count(*)::integer into v_cash_count from public.cash_collections;
  select count(*)::integer into v_transaction_count from public.financial_transactions;

  select count(*)::integer
  into v_linked_purchase_count
  from public.purchase_orders po
  where exists (
    select 1
    from public.financial_transactions ft
    where ft.linked_purchase_id = po.id
       or ft.related_purchase_id = po.id
       or (ft.source_type = 'purchase' and ft.source_id = po.id)
  );

  select count(*)::integer
  into v_linked_cash_count
  from public.cash_collections cc
  where exists (
    select 1
    from public.financial_transactions ft
    where ft.linked_cash_collection_id = cc.id
       or ft.related_cash_collection_id = cc.id
       or (ft.source_type = 'cash_collection' and ft.source_id = cc.id)
  );

  v_missing_purchase_count := greatest(v_purchase_count - v_linked_purchase_count, 0);
  v_missing_cash_count := greatest(v_cash_count - v_linked_cash_count, 0);

  return jsonb_build_object(
    'schema_status', case when cardinality(v_missing) = 0 then 'ok' else 'missing_columns' end,
    'missing_columns', to_jsonb(v_missing),
    'transactions_count', v_transaction_count,
    'purchases_count', v_purchase_count,
    'cash_collections_count', v_cash_count,
    'purchases_with_linked_finance_transaction', v_linked_purchase_count,
    'cash_collections_with_linked_finance_transaction', v_linked_cash_count,
    'purchases_missing_finance_transaction', v_missing_purchase_count,
    'cash_collections_missing_finance_transaction', v_missing_cash_count,
    'failed_sync_count', v_missing_purchase_count + v_missing_cash_count,
    'schema_columns', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'column_name', c.column_name,
        'data_type', c.data_type,
        'is_nullable', c.is_nullable,
        'column_default', c.column_default,
        'ordinal_position', c.ordinal_position
      ) order by c.ordinal_position), '[]'::jsonb)
      from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'financial_transactions'
    ),
    'constraints', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'constraint_name', tc.constraint_name,
        'constraint_type', tc.constraint_type,
        'definition', coalesce(cc.check_clause, '')
      ) order by tc.constraint_name), '[]'::jsonb)
      from information_schema.table_constraints tc
      left join information_schema.check_constraints cc on cc.constraint_schema = tc.constraint_schema and cc.constraint_name = tc.constraint_name
      where tc.table_schema = 'public' and tc.table_name = 'financial_transactions'
    ),
    'indexes', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'indexname', i.indexname,
        'indexdef', i.indexdef
      ) order by i.indexname), '[]'::jsonb)
      from pg_indexes i
      where i.schemaname = 'public' and i.tablename = 'financial_transactions'
    )
  );
end;
$$;
