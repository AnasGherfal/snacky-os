-- Historical payment confirmations are separate from original source cells.
-- NULL means unconfirmed; never infer unpaid from an empty payment ledger.
-- No personal data, inferred settlement amounts or automatic backfill here.
alter table public.investor_historical_months
  add column confirmed_payable_usd numeric(14,2),
  add column confirmed_paid_usd numeric(14,2),
  add column payment_confirmed_at timestamptz,
  add column payment_confirmation_note text,
  add constraint investor_history_payment_confirmation_complete check (
    (confirmed_payable_usd is null and confirmed_paid_usd is null
      and payment_confirmed_at is null and payment_confirmation_note is null)
    or
    (confirmed_payable_usd is not null and confirmed_paid_usd is not null
      and payment_confirmed_at is not null and isfinite(payment_confirmed_at)
      and payment_confirmation_note is not null and length(trim(payment_confirmation_note)) > 0
      and confirmed_payable_usd >= 0 and confirmed_payable_usd < 10000000000
      and confirmed_paid_usd >= 0 and confirmed_paid_usd <= confirmed_payable_usd)
  );
comment on column public.investor_historical_months.confirmed_payable_usd is
  'Explicitly confirmed payable USD amount for the historical month, not the signed source share. Do not infer by summing signed source shares or subtract a loss carried into another month twice.';
comment on column public.investor_historical_months.confirmed_paid_usd is
  'Owner-confirmed cumulative historical payment position as of payment_confirmed_at. This is not a Finance posting or a new payout command.';
comment on column public.investor_historical_months.payment_confirmation_note is
  'Confirmation provenance kept separately from the immutable-as-supplied source_cells.';
-- Existing authenticated SELECT-only grant and per-investor RLS continue to apply.
