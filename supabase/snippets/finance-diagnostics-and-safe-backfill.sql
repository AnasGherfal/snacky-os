-- Finance source sync diagnostics and safe additive repair.
-- Safety rules:
-- - Run diagnostics first.
-- - Do not DROP, TRUNCATE, or DELETE production data.
-- - The repair step only creates/updates source-linked finance rows through the
--   audited backfill_missing_finance_transactions() RPC.
-- - Run verification after repair.

-- 1) SELECT diagnostics first.
select public.finance_health_report() as finance_health_report;
select public.finance_source_sync_diagnosis() as finance_source_sync_diagnosis;

select 'purchase_orders' as relation_name, count(*) as row_count from public.purchase_orders
union all
select 'cash_collections' as relation_name, count(*) as row_count from public.cash_collections
union all
select 'financial_transactions' as relation_name, count(*) as row_count from public.financial_transactions;

-- 2) Optional additive repair. Uncomment only after reviewing diagnostics.
-- select * from public.backfill_missing_finance_transactions();

-- 3) Verification after repair.
-- select public.finance_health_report() as finance_health_report_after_repair;
-- select public.finance_source_sync_diagnosis() as finance_source_sync_diagnosis_after_repair;
