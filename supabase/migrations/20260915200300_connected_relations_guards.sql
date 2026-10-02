-- Generic audit triggers must never reference a column absent on another table.
create or replace function public.snacky_crm_audit_change()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare kind text;target uuid;summary text;me uuid:=public.snacky_current_team_member_id();b jsonb;a jsonb;
begin
 a:=to_jsonb(new);b:=case when tg_op='UPDATE' then to_jsonb(old) end;
 kind:=case tg_table_name when 'location_pipeline_leads' then 'lead' when 'issues' then 'issue' when 'location_relationships' then 'location' when 'crm_tasks' then 'task' when 'crm_contacts' then 'contact' when 'location_admin_obligations' then 'obligation' when 'crm_lead_bonus' then 'lead' end;
 target:=case tg_table_name when 'location_relationships' then (a->>'location_id')::uuid when 'crm_lead_bonus' then (a->>'lead_id')::uuid else (a->>'id')::uuid end;
 if b is not null and (b-array['updated_at','updated_by','updated_by_member_id'])=(a-array['updated_at','updated_by','updated_by_member_id']) then return new;end if;
 summary:=case when tg_op='INSERT' then 'Created' when b->>'assigned_to' is distinct from a->>'assigned_to' or b->>'assigned_to_user_id' is distinct from a->>'assigned_to_user_id' then 'Assignment changed' when b->>'status' is distinct from a->>'status' then 'Status: '||coalesce(b->>'status','')||' → '||coalesce(a->>'status','') else 'Record updated' end;
 if tg_table_name='crm_lead_bonus' then
  perform public.snacky_crm_emit(kind,target,'bonus_status','Bonus status: '||(a->>'status'),null,jsonb_build_object('eligible',a->'eligible','status',a->'status'));return new;
 end if;
 perform public.snacky_crm_emit(kind,target,case when tg_op='INSERT' then 'created' else 'updated' end,summary,b,a);
 if tg_table_name='crm_tasks' and a->>'task_type'='field_action' and a->>'status'='completed' and (b is null or b->>'status' is distinct from a->>'status') then
  update public.issues set field_completed_at=now(),is_waiting=false,waiting_on=null,next_action='Contact customer after field action',next_action_date=(now() at time zone 'Africa/Tripoli')::date,updated_at=now(),updated_by=me where id=(a->>'issue_id')::uuid and status not in ('resolved','closed');
  perform public.snacky_crm_emit('issue',(a->>'issue_id')::uuid,'field_completed','Field action completed: '||(a->>'result'),null,jsonb_build_object('task_id',target,'performed_by',a->>'completed_by'));
 end if;
 return new;
end $$;

create or replace function public.snacky_crm_allowed(p_kind text,p_id uuid,p_write boolean default false)
returns boolean language plpgsql stable security definer set search_path=public,pg_catalog as $$
declare me uuid:=public.snacky_current_team_member_id();manager boolean:=public.snacky_crm_manager();staff boolean:=public.snacky_crm_staff();
begin
 if me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then return false;end if;
 if p_kind='lead' then return exists(select 1 from public.location_pipeline_leads l where l.id=p_id and (manager or (staff and (case when p_write then l.assigned_to_user_id=me or (l.assigned_to_user_id is null and l.created_by_member_id=me) else l.visibility='team' or l.assigned_to_user_id=me or l.created_by_member_id=me end))));
 elsif p_kind='issue' then return exists(select 1 from public.issues i where i.id=p_id and (manager or (staff and (not p_write or i.assigned_to=me or (i.assigned_to is null and i.reported_by=me))) or (not p_write and (i.reported_by=me or exists(select 1 from public.crm_tasks t where t.issue_id=i.id and t.assigned_to=me and t.archived_at is null)))));
 elsif p_kind='location' then return exists(select 1 from public.locations l where l.id=p_id and (manager or (staff and (not p_write or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)))));
 elsif p_kind='contact' then return staff and exists(select 1 from public.crm_contacts c where c.id=p_id);
 elsif p_kind='obligation' then return exists(select 1 from public.location_admin_obligations o where o.id=p_id and (manager or (staff and o.assigned_to=me)));
 elsif p_kind='task' then return exists(select 1 from public.crm_tasks t where t.id=p_id and (manager or t.assigned_to=me or (staff and (t.created_by=me or public.snacky_crm_allowed('issue',t.issue_id,true) or public.snacky_crm_allowed('lead',t.lead_id,true) or public.snacky_crm_allowed('location',t.location_id,true) or public.snacky_crm_allowed('obligation',t.obligation_id,true)))));
 end if;
 return false;
end $$;

-- Verify roles and stable record identity even when older code writes directly.
create or replace function public.snacky_crm_validate_record()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
declare a jsonb:=to_jsonb(new);b jsonb:=case when tg_op='UPDATE' then to_jsonb(old) end;assignee uuid;
begin
 if tg_table_name='location_pipeline_leads' then
  if length(trim(a->>'place_name')) not between 1 and 200 then raise exception 'Place name must be 1–200 characters';end if;
  if tg_op='UPDATE' and (a->>'id' is distinct from b->>'id' or a->>'created_by_member_id' is distinct from b->>'created_by_member_id') then raise exception 'Original lead identity and creator cannot be changed';end if;
  if coalesce((a->>'is_practice')::boolean,false) and a->>'converted_location_id' is not null then raise exception 'Practice leads cannot become real locations';end if;
 elsif tg_table_name='crm_tasks' then
  assignee:=(a->>'assigned_to')::uuid;
  if not exists(select 1 from public.team_members t where t.id=assignee and t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm','operator') or t.roles::text[]&&array['owner','admin','supervisor','crm','operator'])) then raise exception 'Choose an active team member who can perform this work';end if;
  if not exists(select 1 from public.team_members t where t.id=assignee and (t.role::text in ('owner','admin','supervisor','crm') or coalesce(t.roles::text[],'{}')&&array['owner','admin','supervisor','crm'])) and (a->>'task_type'<>'field_action' or a->>'issue_id' is null) then raise exception 'Operators may only receive issue field actions';end if;
  if a->>'status'='completed' and nullif(trim(a->>'result'),'') is null then raise exception 'Write the result before completing the task';end if;
  if b is not null and (a->>'created_by' is distinct from b->>'created_by' or a->>'issue_id' is distinct from b->>'issue_id' or a->>'lead_id' is distinct from b->>'lead_id' or a->>'location_id' is distinct from b->>'location_id' or a->>'obligation_id' is distinct from b->>'obligation_id') then raise exception 'Work history cannot be moved to an unrelated record';end if;
 elsif tg_table_name='crm_lead_bonus' then
  if a->>'status' in ('approved','paid') and not exists(select 1 from public.location_pipeline_leads l where l.id=(a->>'lead_id')::uuid and l.status in ('accepted','machine_placed') and not l.is_practice) then raise exception 'Approve bonuses only for accepted real locations';end if;
 elsif tg_table_name='location_admin_obligations' then
  assignee:=(a->>'assigned_to')::uuid;
  if not exists(select 1 from public.team_members t where t.id=assignee and t.active and t.active_status='active' and (t.role::text in ('owner','admin','supervisor','crm') or t.roles::text[]&&array['owner','admin','supervisor','crm'])) then raise exception 'Choose an active customer-relations employee for the obligation';end if;
  if a->>'finance_transaction_id' is not null and (b is null or a->>'finance_transaction_id' is distinct from b->>'finance_transaction_id') then
   perform 1 from public.financial_transactions f where f.id=(a->>'finance_transaction_id')::uuid and f.direction='money_out' and f.currency='LYD' and f.amount=(a->>'amount_lyd')::numeric and f.related_location_id=(a->>'location_id')::uuid and f.transaction_date=(a->>'payment_date')::date and f.transaction_status='active' and not coalesce(f.is_void,false) and f.voided_at is null and not coalesce(f.needs_review,true) for update;
   if not found then raise exception 'Matching Finance payment changed; verification stopped';end if;
  end if;
 end if;
 return new;
end $$;
do $$declare tbl text;begin
 foreach tbl in array array['location_pipeline_leads','crm_tasks','crm_lead_bonus','location_admin_obligations'] loop
  execute format('create trigger crm_validate_record before insert or update on public.%I for each row execute function public.snacky_crm_validate_record()',tbl);
 end loop;
end $$;
revoke all on function public.snacky_crm_validate_record() from public,anon,authenticated;

create or replace function public.snacky_crm_keep_verified_payment()
returns trigger language plpgsql security definer set search_path=public,pg_catalog as $$
begin
 if exists(select 1 from public.location_admin_obligations o where o.finance_transaction_id=old.id) then
  if tg_op='DELETE' then raise exception 'This payment is verified against a location obligation; its history cannot be deleted';end if;
  if (to_jsonb(new)-array['notes','description','updated_at']) is distinct from (to_jsonb(old)-array['notes','description','updated_at']) then raise exception 'A verified location payment cannot be changed independently of its obligation';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger crm_keep_verified_payment before update or delete on public.financial_transactions for each row execute function public.snacky_crm_keep_verified_payment();
revoke all on function public.snacky_crm_keep_verified_payment() from public,anon,authenticated;

-- Several older core tables had RLS disabled. A limited CRM account must not
-- gain raw balances, machine stock, salary or team-edit access through REST.
-- Preserve existing policies for other roles; service-role jobs are unaffected.
create or replace function public.snacky_crm_is_limited()
returns boolean language sql stable security definer set search_path=public,pg_catalog as $$
 select public.snacky_current_profile_has_any_role(array['crm'])
 and not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','finance','warehouse','purchasing','procurement','operator']);
$$;
revoke all on function public.snacky_crm_is_limited() from public,anon;
grant execute on function public.snacky_crm_is_limited() to authenticated;
do $$declare tbl record;begin
 for tbl in select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname not in (
  'profiles','team_members','issues','location_pipeline_leads','location_pipeline_activities','location_relationships','crm_contacts','crm_contact_links','crm_tasks','crm_activities','crm_documents','location_admin_obligations','crm_lead_bonus','crm_command_receipts'
 ) loop
  if not tbl.relrowsecurity then
   execute format('alter table public.%I enable row level security',tbl.relname);
   execute format('create policy crm_legacy_noncrm_access on public.%I for all to authenticated using (not public.snacky_crm_is_limited()) with check (not public.snacky_crm_is_limited())',tbl.relname);
  end if;
  execute format('create policy crm_raw_record_boundary on public.%I as restrictive for all to authenticated using (not public.snacky_crm_is_limited()) with check (not public.snacky_crm_is_limited())',tbl.relname);
 end loop;
 if not (select relrowsecurity from pg_class where oid='public.team_members'::regclass) then
  alter table public.team_members enable row level security;
  create policy crm_team_existing_access on public.team_members for all to authenticated using(not public.snacky_crm_is_limited()) with check(not public.snacky_crm_is_limited());
 end if;
end $$;
create policy crm_team_own_identity on public.team_members for select to authenticated using(id=public.snacky_current_team_member_id());
create policy crm_team_write_boundary on public.team_members as restrictive for update to authenticated using(not public.snacky_crm_is_limited()) with check(not public.snacky_crm_is_limited());
create policy crm_team_insert_boundary on public.team_members as restrictive for insert to authenticated with check(not public.snacky_crm_is_limited());
create policy crm_team_delete_boundary on public.team_members as restrictive for delete to authenticated using(not public.snacky_crm_is_limited());
