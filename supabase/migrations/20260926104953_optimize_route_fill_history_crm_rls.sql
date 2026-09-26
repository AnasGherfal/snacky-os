alter policy crm_legacy_noncrm_access
on public.route_stop_fill_lines
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));

alter policy crm_raw_record_boundary
on public.route_stop_fill_lines
using ((select (not public.snacky_crm_is_limited())))
with check ((select (not public.snacky_crm_is_limited())));
