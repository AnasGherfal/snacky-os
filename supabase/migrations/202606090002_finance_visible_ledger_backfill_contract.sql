-- Finance visibility and source sync repair.
-- Default finance views must show every non-void money event, including legacy rows
-- with null source_type/category/is_void, and purchase/cash sources must be backfilled.

alter table public.financial_transactions
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists linked_cash_collection_id uuid,
  add column if not exists related_purchase_id uuid,
  add column if not exists related_cash_collection_id uuid,
  add column if not exists transaction_datetime timestamptz,
  add column if not exists currency text default 'LYD',
  add column if not exists account_id text,
  add column if not exists account_key text,
  add column if not exists transaction_effect text,
  add column if not exists source_account_id text,
  add column if not exists destination_account_id text,
  add column if not exists category text,
  add column if not exists location text,
  add column if not exists notes text,
  add column if not exists payment_method text,
  add column if not exists related_route_id uuid,
  add column if not exists related_machine_id uuid,
  add column if not exists related_location_id uuid,
  add column if not exists receipt_url text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists payee_text text,
  add column if not exists transaction_status text default 'active',
  add column if not exists is_void boolean default false,
  add column if not exists voided_at timestamptz,
  add column if not exists void_reason text,
  add column if not exists status_reason text;

update public.financial_transactions
set is_void = false,
    updated_at = now()
where is_void is null;

-- A purchase order is the source event for purchase money-out. The amount guard in
-- sync_purchase_to_financial_transaction still prevents zero-value ledger rows.
create or replace function public.finance_purchase_should_sync(p_purchase public.purchase_orders)
returns boolean
language sql
stable
as $$
  select coalesce(p_purchase.status, '') not in ('cancelled', 'voided')
     and coalesce(p_purchase.payment_status, '') <> 'voided'
$$;

create or replace function public.finance_cash_collection_should_sync(p_cash public.cash_collections)
returns boolean
language sql
stable
as $$
  select coalesce(p_cash.review_status, '') <> 'voided'
     and p_cash.actual_cash_collected is not null
$$;

create or replace function public.backfill_missing_finance_transactions()
returns table (
  purchases_checked integer,
  purchase_transactions_created integer,
  purchase_transactions_skipped_existing integer,
  cash_collections_checked integer,
  cash_collection_transactions_created integer,
  cash_collection_transactions_skipped_existing integer,
  skipped_existing integer,
  errors jsonb
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_cash record;
  v_before uuid;
  v_after uuid;
  v_purchases_checked integer := 0;
  v_purchase_created integer := 0;
  v_purchase_skipped integer := 0;
  v_cash_checked integer := 0;
  v_cash_created integer := 0;
  v_cash_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  for v_purchase in
    select po.id
    from public.purchase_orders po
    where public.finance_purchase_should_sync(po)
  loop
    v_purchases_checked := v_purchases_checked + 1;
    begin
      v_before := null;
      v_after := null;
      select ft.id into v_before
      from public.financial_transactions ft
      where (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
         or ft.linked_purchase_id = v_purchase.id
         or ft.related_purchase_id = v_purchase.id
      limit 1;

      v_after := public.sync_purchase_to_financial_transaction(v_purchase.id);
      if v_after is null then
        v_purchase_skipped := v_purchase_skipped + 1;
      elsif v_before is null then
        v_purchase_created := v_purchase_created + 1;
      else
        v_purchase_skipped := v_purchase_skipped + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'purchase', 'source_id', v_purchase.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  for v_cash in
    select cc.id
    from public.cash_collections cc
    where public.finance_cash_collection_should_sync(cc)
  loop
    v_cash_checked := v_cash_checked + 1;
    begin
      v_before := null;
      v_after := null;
      select ft.id into v_before
      from public.financial_transactions ft
      where (ft.source_type = 'cash_collection' and ft.source_id = v_cash.id)
         or ft.linked_cash_collection_id = v_cash.id
         or ft.related_cash_collection_id = v_cash.id
      limit 1;

      v_after := public.sync_cash_collection_to_financial_transaction(v_cash.id);
      if v_after is null then
        v_cash_skipped := v_cash_skipped + 1;
      elsif v_before is null then
        v_cash_created := v_cash_created + 1;
      else
        v_cash_skipped := v_cash_skipped + 1;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('source_type', 'cash_collection', 'source_id', v_cash.id, 'sqlstate', sqlstate, 'message', sqlerrm));
    end;
  end loop;

  return query select
    v_purchases_checked,
    v_purchase_created,
    v_purchase_skipped,
    v_cash_checked,
    v_cash_created,
    v_cash_skipped,
    v_purchase_skipped + v_cash_skipped,
    v_errors;
end;
$$;

-- Keep the app-side diagnosis exact and executable when inspecting production.
create or replace function public.finance_source_sync_diagnosis()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report jsonb;
begin
  select jsonb_build_object(
    'financial_transactions_count', (select count(*) from public.financial_transactions),
    'rows_by_source', (
      select coalesce(jsonb_agg(jsonb_build_object('source_type', source_type, 'count', count) order by source_type), '[]'::jsonb)
      from (select source_type, count(*)::integer as count from public.financial_transactions group by source_type) s
    ),
    'void_status', (
      select coalesce(jsonb_agg(jsonb_build_object('is_void', is_void, 'count', count) order by is_void), '[]'::jsonb)
      from (select is_void, count(*)::integer as count from public.financial_transactions group by is_void) v
    ),
    'recent_rows', (
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
      from (
        select id, transaction_date, amount, currency, direction, category, source_type, source_id,
               linked_purchase_id, linked_cash_collection_id, is_void, created_at
        from public.financial_transactions
        order by created_at desc
        limit 50
      ) r
    ),
    'missing_purchase_links', (
      select coalesce(jsonb_agg(to_jsonb(p) order by p.order_date desc), '[]'::jsonb)
      from (
        select p.id, p.order_date, p.total_amount, p.payment_status
        from public.purchase_orders p
        where not exists (
          select 1 from public.financial_transactions ft
          where ft.source_type = 'purchase'
            and ft.source_id = p.id
        )
        order by p.order_date desc
        limit 50
      ) p
    ),
    'missing_cash_collection_links', (
      select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at desc), '[]'::jsonb)
      from (
        select c.id, c.collected_at as collection_datetime, c.actual_cash_collected as total_cash_counted, c.created_at
        from public.cash_collections c
        where not exists (
          select 1 from public.financial_transactions ft
          where ft.source_type = 'cash_collection'
            and ft.source_id = c.id
        )
        order by c.created_at desc
        limit 50
      ) c
    )
  ) into v_report;

  return v_report;
end;
$$;

revoke all on function public.backfill_missing_finance_transactions() from public;
grant execute on function public.backfill_missing_finance_transactions() to authenticated;
revoke all on function public.finance_source_sync_diagnosis() from public;
grant execute on function public.finance_source_sync_diagnosis() to authenticated;

-- Repair all historical source rows again after widening the purchase sync contract.
select * from public.backfill_missing_finance_transactions();
select pg_notify('pgrst', 'reload schema');
