-- Defense in depth for the restricted Customer Relations role. Existing
-- owner/admin/operator/warehouse/finance API behavior is not broadened.
-- This migration contains no user identities, business records or money writes.

-- Classify restricted accounts independently of active state: deactivation
-- must never turn off the restricted-role boundary.
create or replace function public.snacky_crm_is_limited()
returns boolean language sql stable security definer set search_path=public,pg_catalog as $$
 with identity_roles as (
  select coalesce(p.roles::text[],'{}') || array[p.role::text]
    || coalesce(t.roles::text[],'{}') || array[t.role::text] as roles
  from public.profiles p left join public.team_members t on t.id=p.team_member_id or t.auth_user_id=p.id
  where p.id=auth.uid()
 )
 select exists(select 1 from identity_roles where roles&&array['crm'])
  and not exists(select 1 from identity_roles where roles&&array['owner','admin','supervisor','finance','warehouse','purchasing','procurement','operator']);
$$;
revoke all on function public.snacky_crm_is_limited() from public,anon;
grant execute on function public.snacky_crm_is_limited() to authenticated;

-- Metadata on a broad location must not expose private obligations/tasks.
drop policy if exists crm_activity_read on public.crm_activities;
create policy crm_activity_read on public.crm_activities for select to authenticated using(
 public.snacky_crm_activity_visible(task_id,obligation_id,issue_id,lead_id,contact_id,location_id));
drop policy if exists crm_document_read on public.crm_documents;
create policy crm_document_read on public.crm_documents for select to authenticated using(
 public.snacky_crm_activity_visible(task_id,obligation_id,issue_id,lead_id,contact_id,location_id));

-- Pure CRM clients may not modify access through raw profiles/team endpoints.
-- The existing server-side owner/admin Team workflow is unchanged.
create policy crm_profile_read_boundary on public.profiles as restrictive for select to authenticated
 using(not public.snacky_crm_is_limited() or id=auth.uid());
create policy crm_profile_update_boundary on public.profiles as restrictive for update to authenticated
 using(not public.snacky_crm_is_limited()) with check(not public.snacky_crm_is_limited());
create policy crm_profile_insert_boundary on public.profiles as restrictive for insert to authenticated
 with check(not public.snacky_crm_is_limited());
create policy crm_profile_delete_boundary on public.profiles as restrictive for delete to authenticated
 using(not public.snacky_crm_is_limited());
create policy crm_team_read_boundary on public.team_members as restrictive for select to authenticated
 using(not public.snacky_crm_is_limited() or id=public.snacky_current_team_member_id());

-- Old table writers cannot bypass the validated command's ownership and
-- workflow checks. Their existing access remains intact for other roles.
do $$declare tbl text;begin
 foreach tbl in array array['location_pipeline_leads','issues'] loop
  execute format('create policy crm_native_update_boundary on public.%I as restrictive for update to authenticated using(not public.snacky_crm_is_limited()) with check(not public.snacky_crm_is_limited())',tbl);
  execute format('create policy crm_native_insert_boundary on public.%I as restrictive for insert to authenticated with check(not public.snacky_crm_is_limited())',tbl);
  execute format('create policy crm_native_delete_boundary on public.%I as restrictive for delete to authenticated using(not public.snacky_crm_is_limited())',tbl);
 end loop;
end $$;

-- Storage does not use PostgREST pre-request hooks. Its own restrictive policy
-- prevents older permissive bucket policies from leaking unrelated receipts.
create policy crm_storage_boundary on storage.objects as restrictive for all to authenticated
 using(not public.snacky_crm_is_limited() or (
  bucket_id='crm-documents' and case when split_part(name,'/',3)~'^[0-9a-fA-F-]{36}$'
   then public.snacky_crm_allowed(split_part(name,'/',2),split_part(name,'/',3)::uuid)
   else false end))
 with check(not public.snacky_crm_is_limited() or (
  bucket_id='crm-documents' and split_part(name,'/',1)=auth.uid()::text
  and case when split_part(name,'/',3)~'^[0-9a-fA-F-]{36}$'
   then public.snacky_crm_allowed(split_part(name,'/',2),split_part(name,'/',3)::uuid,true)
   else false end));

-- Legacy SECURITY DEFINER RPCs are not governed by table RLS. Restricted CRM
-- clients can call only the explicitly reviewed read/command surface. This
-- blocks direct REST calls to legacy finance, payroll, inventory and role RPCs,
-- without changing those functions or their non-CRM consumers.
create or replace function public.snacky_crm_api_request_guard()
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare path text:=coalesce(current_setting('request.path',true),'');
 method text:=upper(coalesce(current_setting('request.method',true),''));
begin
 if not public.snacky_crm_is_limited() then return;end if;
 if not public.snacky_current_profile_has_any_role(array['crm']) then
  raise exception 'This account is inactive' using errcode='42501';
 end if;
 path:=regexp_replace(path,'^/rest/v1','');
 if path in (
  '/rpc/snacky_crm_workspace_v1','/rpc/snacky_crm_command_v1',
  '/rpc/snacky_crm_timeline_v1','/rpc/snacky_crm_allowed',
  '/rpc/snacky_current_team_member_id','/rpc/snacky_current_profile_has_any_role'
 ) then return;end if;
 if method in ('GET','HEAD') and path in (
  '/profiles','/team_members','/crm_documents',
  '/investor_agreements','/investor_monthly_statements','/investor_payments',
  '/investor_contributions','/investor_historical_months'
 ) then return;end if;
 raise exception 'Use the assigned Customer Relations workspace for this account' using errcode='42501';
end $$;
revoke all on function public.snacky_crm_api_request_guard() from public;
grant execute on function public.snacky_crm_api_request_guard() to authenticated,anon,service_role;

-- Do not silently replace another application's pre-request hook.
do $$
declare previous_hook text;
begin
 if exists(select 1 from pg_roles where rolname='authenticator') then
  select split_part(setting,'=',2) into previous_hook
  from pg_db_role_setting settings join pg_roles r on r.oid=settings.setrole,
   lateral unnest(settings.setconfig) setting
  where r.rolname='authenticator' and setting like 'pgrst.db_pre_request=%'
   and split_part(setting,'=',2) not in ('','public.snacky_crm_api_request_guard') limit 1;
  if previous_hook is not null then
   raise exception 'Existing API pre-request hook % must be composed with the CRM guard before deployment',previous_hook;
  end if;
  alter role authenticator set pgrst.db_pre_request='public.snacky_crm_api_request_guard';
 end if;
end $$;
notify pgrst,'reload config';
notify pgrst,'reload schema';

-- Prevent a finance-linked administrative payment from being reused for a
-- second obligation. Already-present unique constraints remain compatible.
create unique index if not exists crm_obligation_finance_once
 on public.location_admin_obligations(finance_transaction_id)
 where finance_transaction_id is not null;
