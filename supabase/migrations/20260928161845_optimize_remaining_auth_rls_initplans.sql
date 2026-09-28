alter policy crm_receipt_read
on public.crm_command_receipts
using (actor_user_id = (select auth.uid()));

alter policy investor_agreements_investor_read
on public.investor_agreements
using (investor_user_id = (select auth.uid()));

alter policy investor_contributions_read
on public.investor_contributions
using (
  (select public.snacky_current_profile_has_any_role(array['owner','admin']::text[]))
  or (
    (select public.snacky_current_profile_has_any_role(array['investor']::text[]))
    and exists (
      select 1
      from public.investor_agreements a
      where a.id = investor_contributions.agreement_id
        and a.investor_user_id = (select auth.uid())
    )
  )
);

alter policy investor_historical_months_read
on public.investor_historical_months
using (
  (select public.snacky_current_profile_has_any_role(array['owner','admin']::text[]))
  or (
    investor_user_id = (select auth.uid())
    and (select public.snacky_current_profile_has_any_role(array['investor']::text[]))
  )
);

alter policy crm_profile_read_boundary
on public.profiles
using (
  (select (not public.snacky_crm_is_limited()))
  or id = (select auth.uid())
);

alter policy snacky_profiles_self_read
on public.profiles
using (id = (select auth.uid()));

alter policy snacky_push_subscriptions_delete_own
on public.push_subscriptions
using (user_id = (select auth.uid()));

alter policy snacky_push_subscriptions_insert_own
on public.push_subscriptions
with check (user_id = (select auth.uid()));

alter policy snacky_push_subscriptions_select_own
on public.push_subscriptions
using (user_id = (select auth.uid()));

alter policy snacky_push_subscriptions_update_own
on public.push_subscriptions
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

alter policy snacky_notifications_delete_own
on public.notifications
using (user_id = (select auth.uid()));

alter policy snacky_notifications_select_own
on public.notifications
using (user_id = (select auth.uid()));

alter policy snacky_notifications_update_own
on public.notifications
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

select pg_notify('pgrst','reload schema');
