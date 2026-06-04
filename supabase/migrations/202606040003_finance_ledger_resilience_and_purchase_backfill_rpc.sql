alter table public.financial_transactions
  add column if not exists transaction_datetime timestamptz,
  add column if not exists currency text,
  add column if not exists account_key text,
  add column if not exists category text,
  add column if not exists counterparty_text text,
  add column if not exists payer_text text,
  add column if not exists paid_to_text text,
  add column if not exists source_type text,
  add column if not exists source_id uuid,
  add column if not exists linked_purchase_id uuid,
  add column if not exists is_void boolean,
  add column if not exists void_reason text,
  add column if not exists transaction_status text default 'active',
  add column if not exists notes text,
  add column if not exists location text,
  add column if not exists updated_at timestamptz default now(),
  add column if not exists created_by uuid references public.team_members(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_fkey'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_fkey
      foreign key (linked_purchase_id) references public.purchase_orders(id) on delete set null;
  end if;
exception
  when duplicate_object then null;
end $$;

update public.financial_transactions
set
  currency = coalesce(nullif(trim(currency), ''), 'LYD'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), nullif(trim(source_account_id), ''), 'snacky_lyd'),
  category = coalesce(nullif(trim(category), ''), nullif(trim(final_bucket), ''), nullif(trim(transaction_type), ''), nullif(trim(bucket), ''), 'Uncategorized'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  transaction_status = coalesce(nullif(trim(transaction_status), ''), 'active'),
  is_void = coalesce(is_void, transaction_status = 'voided' or voided_at is not null),
  void_reason = coalesce(nullif(trim(void_reason), ''), nullif(trim(status_reason), '')),
  counterparty_text = coalesce(
    nullif(trim(counterparty_text), ''),
    case when direction = 'money_in' then nullif(trim(payer_text), '') end,
    case when direction = 'money_out' then nullif(trim(paid_to_text), '') end
  ),
  payer_text = coalesce(nullif(trim(payer_text), ''), case when direction = 'money_in' then nullif(trim(counterparty_text), '') end),
  paid_to_text = coalesce(nullif(trim(paid_to_text), ''), case when direction = 'money_out' then nullif(trim(counterparty_text), '') end),
  updated_at = coalesce(updated_at, now())
where currency is null
   or trim(coalesce(currency, '')) = ''
   or account_key is null
   or trim(coalesce(account_key, '')) = ''
   or category is null
   or trim(coalesce(category, '')) = ''
   or transaction_datetime is null
   or transaction_status is null
   or trim(coalesce(transaction_status, '')) = ''
   or is_void is null
   or void_reason is null
   or counterparty_text is null
   or payer_text is null
   or paid_to_text is null
   or updated_at is null;

alter table public.financial_transactions
  alter column currency set default 'LYD',
  alter column is_void set default false,
  alter column is_void set not null,
  alter column transaction_status set default 'active';

update public.financial_transactions
set
  linked_purchase_id = coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end),
  related_purchase_id = coalesce(related_purchase_id, linked_purchase_id, case when source_type = 'purchase' then source_id end),
  source_type = 'purchase',
  source_id = coalesce(source_id, related_purchase_id, linked_purchase_id),
  direction = 'money_out',
  transaction_kind = 'product_purchase',
  transaction_type = coalesce(nullif(trim(transaction_type), ''), 'Products Restocking'),
  category = 'Products Restocking',
  final_bucket = coalesce(nullif(trim(final_bucket), ''), 'Products Restocking'),
  account_key = coalesce(nullif(trim(account_key), ''), nullif(trim(account_id), ''), 'snacky_lyd'),
  transaction_datetime = coalesce(transaction_datetime, transaction_date::timestamptz),
  updated_at = now()
where transaction_kind = 'product_purchase'
  and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null;

with linked_purchase_transactions as (
  select
    id,
    coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) as purchase_id,
    row_number() over (
      partition by coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end)
      order by
        case when coalesce(transaction_status, 'active') = 'active' and coalesce(is_void, false) = false then 0 else 1 end,
        created_at,
        id
    ) as row_rank
  from public.financial_transactions
  where transaction_kind = 'product_purchase'
    and coalesce(linked_purchase_id, related_purchase_id, case when source_type = 'purchase' then source_id end) is not null
),
duplicate_purchase_transactions as (
  select id, purchase_id
  from linked_purchase_transactions
  where row_rank > 1
)
update public.financial_transactions ft
set
  transaction_status = case when coalesce(ft.transaction_status, 'active') = 'active' then 'voided' else ft.transaction_status end,
  is_void = true,
  voided_at = coalesce(ft.voided_at, now()),
  void_reason = coalesce(ft.void_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
  status_reason = coalesce(ft.status_reason, 'Duplicate purchase finance transaction superseded by the linked transaction.'),
  linked_purchase_id = null,
  source_type = case when ft.source_type = 'purchase' then null else ft.source_type end,
  source_id = case when ft.source_type = 'purchase' then null else ft.source_id end,
  metadata = coalesce(ft.metadata, '{}'::jsonb) || jsonb_build_object(
    'duplicate_purchase_finance_transaction',
    true,
    'duplicate_purchase_id',
    dpt.purchase_id
  ),
  updated_at = now()
from duplicate_purchase_transactions dpt
where ft.id = dpt.id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'financial_transactions_linked_purchase_id_key'
      and conrelid = 'public.financial_transactions'::regclass
  ) then
    alter table public.financial_transactions
      add constraint financial_transactions_linked_purchase_id_key unique (linked_purchase_id);
  end if;
exception
  when duplicate_object then null;
end $$;

create unique index if not exists idx_financial_transactions_purchase_source_type_id
  on public.financial_transactions(source_type, source_id)
  where source_type = 'purchase' and source_id is not null;

create index if not exists idx_financial_transactions_account_key_date
  on public.financial_transactions(account_key, transaction_date desc);

create index if not exists idx_financial_transactions_category_date
  on public.financial_transactions(category, transaction_date desc);

insert into public.finance_categories (name, type, is_active)
values
  ('Products Restocking', 'expense', true),
  ('Transfer', 'transfer', true)
on conflict (name) do update
set type = excluded.type,
    is_active = true;

alter table public.financial_transactions enable row level security;

grant select, insert, update on table public.financial_transactions to authenticated;

drop policy if exists "financial_transactions_select_finance_roles" on public.financial_transactions;
drop policy if exists "financial_transactions_insert_finance_roles" on public.financial_transactions;
drop policy if exists "financial_transactions_update_finance_roles" on public.financial_transactions;

create policy "financial_transactions_select_finance_roles"
  on public.financial_transactions
  for select
  to authenticated
  using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']));

create policy "financial_transactions_insert_finance_roles"
  on public.financial_transactions
  for insert
  to authenticated
  with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']));

create policy "financial_transactions_update_finance_roles"
  on public.financial_transactions
  for update
  to authenticated
  using (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']))
  with check (public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance']));

drop function if exists public.backfill_purchase_financial_transactions(date);

create or replace function public.backfill_purchase_financial_transactions(
  p_start_date date default '2026-06-01',
  p_end_date date default '2026-06-03'
)
returns table (
  purchases_checked integer,
  transactions_created integer,
  transactions_skipped integer,
  errors jsonb
)
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_purchase record;
  v_purchase_date date;
  v_existing_id uuid;
  v_amount numeric;
  v_account_key text;
  v_currency text;
  v_description text;
  v_checked integer := 0;
  v_created integer := 0;
  v_skipped integer := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
    and not public.snacky_current_profile_has_any_role(array['owner', 'admin', 'supervisor', 'finance'])
  then
    raise exception 'Permission denied for purchase finance backfill' using errcode = '42501';
  end if;

  for v_purchase in
    select
      po.*,
      s.name as supplier_name,
      coalesce(
        po.manual_total_lyd,
        po.total_amount,
        po.calculated_total_lyd,
        (
          select sum(coalesce(pol.line_total_lyd, pol.line_total, 0))
          from public.purchase_order_lines pol
          where pol.purchase_order_id = po.id
        ),
        0
      ) as finance_total
    from public.purchase_orders po
    left join public.suppliers s on s.id = po.supplier_id
    where coalesce(po.status, '') not in ('draft', 'cancelled', 'voided')
      and (
        coalesce(po.payment_status, 'paid') in ('paid', 'confirmed', 'saved')
        or coalesce(po.status, '') in ('received', 'confirmed', 'saved', 'ordered')
      )
      and coalesce(po.order_date, po.created_at::date) >= coalesce(p_start_date, '1900-01-01'::date)
      and coalesce(po.order_date, po.created_at::date) <= coalesce(p_end_date, current_date)
    order by coalesce(po.order_date, po.created_at::date), po.created_at, po.id
  loop
    v_checked := v_checked + 1;
    begin
      v_purchase_date := coalesce(v_purchase.order_date, v_purchase.created_at::date);
      v_amount := round(greatest(coalesce(v_purchase.finance_total, 0), 0), 2);
      if v_amount <= 0 then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      v_account_key := case
        when nullif(trim(coalesce(v_purchase.payment_account_id, '')), '') in ('snacky_lyd', 'snacky_usd', 'owner_lyd', 'owner_usd')
          then nullif(trim(v_purchase.payment_account_id), '')
        else 'snacky_lyd'
      end;
      v_currency := case when right(v_account_key, 3) = 'usd' then 'USD' else 'LYD' end;
      v_description := concat_ws(
        ' - ',
        'Purchase from ' || coalesce(nullif(trim(v_purchase.supplier_name), ''), 'supplier'),
        case when nullif(trim(coalesce(v_purchase.receipt_number, '')), '') is not null then 'Receipt ' || trim(v_purchase.receipt_number) end,
        nullif(trim(coalesce(v_purchase.notes, '')), '')
      );

      select ft.id
      into v_existing_id
      from public.financial_transactions ft
      where ft.transaction_kind = 'product_purchase'
        and (
          ft.related_purchase_id = v_purchase.id
          or ft.linked_purchase_id = v_purchase.id
          or (ft.source_type = 'purchase' and ft.source_id = v_purchase.id)
        )
      order by
        case when coalesce(ft.transaction_status, 'active') = 'active' and coalesce(ft.is_void, false) = false then 0 else 1 end,
        ft.created_at,
        ft.id
      limit 1;

      if v_existing_id is not null then
        update public.financial_transactions
        set
          transaction_date = v_purchase_date,
          transaction_datetime = v_purchase_date::timestamptz,
          direction = 'money_out',
          transaction_kind = 'product_purchase',
          transaction_type = 'Products Restocking',
          category = 'Products Restocking',
          description = v_description,
          notes = coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
          amount = v_amount,
          signed_amount = -abs(v_amount),
          currency = v_currency,
          account_id = v_account_key,
          account_key = v_account_key,
          transaction_effect = 'expense',
          source_account_id = null,
          destination_account_id = null,
          bucket = 'Inventory',
          final_bucket = 'Products Restocking',
          review_status = 'confirmed',
          needs_review = false,
          transaction_status = 'active',
          is_void = false,
          voided_at = null,
          void_reason = null,
          payment_method = v_purchase.payment_method,
          receipt_url = v_purchase.receipt_url,
          payer_text = null,
          paid_to_text = nullif(trim(v_purchase.supplier_name), ''),
          counterparty_text = nullif(trim(v_purchase.supplier_name), ''),
          linked_purchase_id = v_purchase.id,
          related_purchase_id = v_purchase.id,
          source_type = 'purchase',
          source_id = v_purchase.id,
          updated_at = now()
        where id = v_existing_id;
        v_skipped := v_skipped + 1;
      else
        insert into public.financial_transactions (
          transaction_date,
          transaction_datetime,
          direction,
          transaction_kind,
          transaction_type,
          category,
          description,
          notes,
          amount,
          signed_amount,
          currency,
          account_id,
          account_key,
          transaction_effect,
          source_account_id,
          destination_account_id,
          bucket,
          final_bucket,
          review_status,
          needs_review,
          transaction_status,
          is_void,
          payment_method,
          receipt_url,
          payer_text,
          paid_to_text,
          counterparty_text,
          linked_purchase_id,
          related_purchase_id,
          source_type,
          source_id,
          created_by,
          updated_at
        )
        values (
          v_purchase_date,
          v_purchase_date::timestamptz,
          'money_out',
          'product_purchase',
          'Products Restocking',
          'Products Restocking',
          v_description,
          coalesce(nullif(trim(coalesce(v_purchase.notes, '')), ''), v_description),
          v_amount,
          -abs(v_amount),
          v_currency,
          v_account_key,
          v_account_key,
          'expense',
          null,
          null,
          'Inventory',
          'Products Restocking',
          'confirmed',
          false,
          'active',
          false,
          v_purchase.payment_method,
          v_purchase.receipt_url,
          null,
          nullif(trim(v_purchase.supplier_name), ''),
          nullif(trim(v_purchase.supplier_name), ''),
          v_purchase.id,
          v_purchase.id,
          'purchase',
          v_purchase.id,
          v_purchase.created_by,
          now()
        )
        on conflict (linked_purchase_id) do update
        set
          transaction_date = excluded.transaction_date,
          transaction_datetime = excluded.transaction_datetime,
          direction = excluded.direction,
          transaction_kind = excluded.transaction_kind,
          transaction_type = excluded.transaction_type,
          category = excluded.category,
          description = excluded.description,
          notes = excluded.notes,
          amount = excluded.amount,
          signed_amount = excluded.signed_amount,
          currency = excluded.currency,
          account_id = excluded.account_id,
          account_key = excluded.account_key,
          transaction_effect = excluded.transaction_effect,
          source_account_id = excluded.source_account_id,
          destination_account_id = excluded.destination_account_id,
          bucket = excluded.bucket,
          final_bucket = excluded.final_bucket,
          review_status = excluded.review_status,
          needs_review = excluded.needs_review,
          transaction_status = excluded.transaction_status,
          is_void = false,
          voided_at = null,
          void_reason = null,
          payment_method = excluded.payment_method,
          receipt_url = excluded.receipt_url,
          payer_text = excluded.payer_text,
          paid_to_text = excluded.paid_to_text,
          counterparty_text = excluded.counterparty_text,
          related_purchase_id = excluded.related_purchase_id,
          source_type = excluded.source_type,
          source_id = excluded.source_id,
          updated_at = now();
        v_created := v_created + 1;
      end if;
    exception
      when others then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object(
          'purchase_id',
          v_purchase.id,
          'sqlstate',
          sqlstate,
          'message',
          sqlerrm
        ));
    end;
  end loop;

  return query select v_checked, v_created, v_skipped, v_errors;
end;
$$;

revoke all on function public.backfill_purchase_financial_transactions(date, date) from public;
grant execute on function public.backfill_purchase_financial_transactions(date, date) to authenticated;

do $$
begin
  perform 1 from public.backfill_purchase_financial_transactions('2026-06-01'::date, '2026-06-03'::date);
  perform 1 from public.backfill_purchase_financial_transactions('1900-01-01'::date, current_date);
end $$;

select pg_notify('pgrst', 'reload schema');
