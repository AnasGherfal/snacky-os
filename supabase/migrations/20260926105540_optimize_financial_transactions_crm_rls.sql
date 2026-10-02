alter policy crm_raw_record_boundary
on public.financial_transactions
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));
