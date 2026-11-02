-- Only visits performed after pilot activation may be required retroactively in cash route reports.
alter table public.cash_refill_policy add column if not exists activated_at timestamptz;
update public.cash_refill_policy
set activated_at=updated_at
where enabled=true and activated_at is null;
