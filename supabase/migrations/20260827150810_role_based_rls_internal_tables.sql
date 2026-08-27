-- First least-privilege package for the legacy internal tables hardened in
-- 202608260003. These policies mirror Snacky OS application permissions and
-- keep service-role server workflows available without granting raw Data API
-- access to unrelated signed-in users.

-- Finance and cash are visible/editable only to roles with finance access.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'cash_collections',
    'finance_categories',
    'finance_import_batches',
    'finance_import_rows',
    'finance_opening_balances',
    'finance_settings'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is not null then
      execute format('alter table public.%I enable row level security', target_table);
      execute format('revoke all on table public.%I from authenticated', target_table);
      execute format('grant select, insert, update, delete on table public.%I to authenticated', target_table);

      execute format('drop policy if exists %I on public.%I', 'snacky_' || target_table || '_finance_access', target_table);
      execute format(
        'create policy %I on public.%I for all to authenticated using ((select public.snacky_current_profile_has_any_role(array[''owner'', ''admin'', ''supervisor'', ''finance'']))) with check ((select public.snacky_current_profile_has_any_role(array[''owner'', ''admin'', ''supervisor'', ''finance''])))',
        'snacky_' || target_table || '_finance_access',
        target_table
      );
    end if;
  end loop;
end $$;

-- Historical stock corrections are an owner/admin recovery workflow. The app
-- already performs these writes through an authorized server-only client.
do $$
declare
  target_table text;
begin
  foreach target_table in array array[
    'historical_route_deduction_batches',
    'historical_route_deduction_lines'
  ]
  loop
    if to_regclass(format('public.%I', target_table)) is not null then
      execute format('alter table public.%I enable row level security', target_table);
      execute format('revoke all on table public.%I from authenticated', target_table);
      execute format('grant select, insert, update, delete on table public.%I to authenticated', target_table);

      execute format('drop policy if exists %I on public.%I', 'snacky_' || target_table || '_owner_admin_access', target_table);
      execute format(
        'create policy %I on public.%I for all to authenticated using ((select public.snacky_current_profile_has_any_role(array[''owner'', ''admin'']))) with check ((select public.snacky_current_profile_has_any_role(array[''owner'', ''admin''])))',
        'snacky_' || target_table || '_owner_admin_access',
        target_table
      );
    end if;
  end loop;
end $$;

-- Receipt extraction data may contain supplier names, prices, and receipt
-- text. Limit it to the roles allowed to create/receive purchases.
alter table if exists public.receipt_scan_results enable row level security;
revoke all on table public.receipt_scan_results from authenticated;
grant select, insert, update, delete on table public.receipt_scan_results to authenticated;

drop policy if exists "snacky_receipt_scan_results_purchase_access" on public.receipt_scan_results;
create policy "snacky_receipt_scan_results_purchase_access"
on public.receipt_scan_results for all
to authenticated
using (
  (select public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']
  ))
)
with check (
  (select public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing']
  ))
);

-- Team rows are readable by the employee themselves and by roles whose screens
-- need staff/operator selectors. Only owner/admin may mutate team records.
alter table if exists public.team_members enable row level security;
revoke all on table public.team_members from authenticated;
grant select, insert, update, delete on table public.team_members to authenticated;

-- Replace the older self-only policy instead of leaving two permissive SELECT
-- policies for PostgreSQL to evaluate on every team lookup. The consolidated
-- policy below retains the exact same self access.
drop policy if exists "snacky_team_members_self_read" on public.team_members;
drop policy if exists "snacky_team_members_business_read" on public.team_members;
create policy "snacky_team_members_business_read"
on public.team_members for select
to authenticated
using (
  auth_user_id = (select auth.uid())
  or id = (select public.snacky_current_team_member_id())
  or (select public.snacky_current_profile_has_any_role(
    array['owner', 'admin', 'supervisor', 'warehouse', 'purchasing', 'finance']
  ))
);

drop policy if exists "snacky_team_members_owner_admin_insert" on public.team_members;
create policy "snacky_team_members_owner_admin_insert"
on public.team_members for insert
to authenticated
with check ((select public.snacky_current_profile_has_any_role(array['owner', 'admin'])));

drop policy if exists "snacky_team_members_owner_admin_update" on public.team_members;
create policy "snacky_team_members_owner_admin_update"
on public.team_members for update
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin'])))
with check ((select public.snacky_current_profile_has_any_role(array['owner', 'admin'])));

drop policy if exists "snacky_team_members_owner_admin_delete" on public.team_members;
create policy "snacky_team_members_owner_admin_delete"
on public.team_members for delete
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin'])));

-- Activity history is append-only from the service-role logger. Signed-in
-- owner/admin users can inspect it but cannot forge, change, or delete rows.
alter table if exists public.system_activity_logs enable row level security;
revoke all on table public.system_activity_logs from authenticated;
grant select on table public.system_activity_logs to authenticated;

drop policy if exists "snacky_system_activity_logs_owner_admin_read" on public.system_activity_logs;
create policy "snacky_system_activity_logs_owner_admin_read"
on public.system_activity_logs for select
to authenticated
using ((select public.snacky_current_profile_has_any_role(array['owner', 'admin'])));

select pg_notify('pgrst', 'reload schema');
