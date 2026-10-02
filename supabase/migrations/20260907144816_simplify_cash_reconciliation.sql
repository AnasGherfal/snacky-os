-- Cash is available to Snacky as soon as the witnessed physical count is saved.
-- Reconciliation remains a missing-cash control; a separate banking stage is not
-- part of the operating workflow.

update public.cash_collections
set custody_status = 'reconciled',
    updated_at = now()
where custody_status = 'banked';

update public.cash_removal_receipts
set custody_status = 'reconciled',
    updated_at = now()
where custody_status = 'banked';

-- Keep any historical deposit rows for audit, but close every API entry point so
-- new bank-deposit records cannot be created or voided by the application.
revoke all on function public.record_cash_bank_deposit(uuid[], timestamptz, numeric, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function snacky_private.record_cash_bank_deposit_impl(uuid[], timestamptz, numeric, text, text, text, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.void_cash_bank_deposit(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function snacky_private.void_cash_bank_deposit_impl(uuid, text)
  from public, anon, authenticated, service_role;

select pg_notify('pgrst', 'reload schema');
