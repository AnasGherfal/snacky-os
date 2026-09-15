-- Specify each side independently; never text-replace abs(amount), because
-- the source projection also contains that expression with a minus sign.
create or replace view public.finance_account_balance_impacts with (security_invoker=true) as
select fob.id as financial_transaction_id, fob.balance_date as transaction_date,
  fob.account_id, fob.currency, fob.opening_balance as amount_delta,
  'opening_balance'::text as transaction_effect, 'Opening Balance'::text as final_bucket,
  'finance_opening_balances'::text as source_file, null::text as source_sheet, null::integer as source_row
from public.finance_opening_balances fob where fob.balance_date=date '2026-05-15'
union all
select ft.id,ft.transaction_date,ft.account_id,ft.currency,ft.signed_amount,
  ft.transaction_effect,ft.final_bucket,ft.source_file,ft.source_sheet,ft.source_row
from public.financial_transactions ft
where ft.transaction_status='active' and ft.transaction_date>date '2026-05-15'
  and coalesce(ft.needs_review,false)=false and coalesce(ft.import_status,'') not in ('needs_review','ignored','skipped')
  and ft.transaction_effect not in ('transfer','opening_balance') and ft.account_id is not null
union all
select ft.id,ft.transaction_date,ft.source_account_id,
  case when right(ft.source_account_id,3)='usd' then 'USD' else 'LYD' end,
  -abs(ft.amount) as amount_delta,
  ft.transaction_effect,ft.final_bucket,ft.source_file,ft.source_sheet,ft.source_row
from public.financial_transactions ft
where ft.transaction_status='active' and ft.transaction_date>date '2026-05-15'
  and coalesce(ft.needs_review,false)=false and coalesce(ft.import_status,'') not in ('needs_review','ignored','skipped')
  and ft.transaction_effect='transfer' and ft.source_account_id is not null
union all
select ft.id,ft.transaction_date,ft.destination_account_id,
  case when right(ft.destination_account_id,3)='usd' then 'USD' else 'LYD' end,
  CASE WHEN right(ft.source_account_id,3)<>right(ft.destination_account_id,3) THEN ft.transfer_destination_amount ELSE abs(ft.amount) END as amount_delta,
  ft.transaction_effect,ft.final_bucket,ft.source_file,ft.source_sheet,ft.source_row
from public.financial_transactions ft
where ft.transaction_status='active' and ft.transaction_date>date '2026-05-15'
  and coalesce(ft.needs_review,false)=false and coalesce(ft.import_status,'') not in ('needs_review','ignored','skipped')
  and ft.transaction_effect='transfer' and ft.destination_account_id is not null;
notify pgrst,'reload schema';
