alter table public.issues
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists contact_channel text not null default 'other';

-- Customer contact details are internal. Operators retain access only to their
-- own reports; the existing service-role route workflow remains unaffected.
alter table public.issues enable row level security;
drop policy if exists snacky_customer_issues_read on public.issues;
create policy snacky_customer_issues_read on public.issues for select to authenticated using (
  public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm'])
  or (public.snacky_current_profile_has_any_role(array['operator']) and reported_by=public.snacky_current_team_member_id())
);
drop policy if exists snacky_customer_issues_insert on public.issues;
create policy snacky_customer_issues_insert on public.issues for insert to authenticated with check (
  reported_by=public.snacky_current_team_member_id()
  and public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator'])
);
drop policy if exists snacky_customer_issues_update on public.issues;
create policy snacky_customer_issues_update on public.issues for update to authenticated using (
  public.snacky_current_profile_has_any_role(array['owner','admin','supervisor'])
) with check (public.snacky_current_profile_has_any_role(array['owner','admin','supervisor']));
grant select on public.issues to authenticated;

create or replace function public.snacky_create_customer_issue_v1(
  p_client_submission_id uuid, p_machine_id uuid, p_issue_type text, p_priority text,
  p_customer_name text, p_customer_phone text, p_contact_channel text, p_description text
) returns jsonb language plpgsql security definer set search_path=public,pg_catalog as $$
declare
  actor uuid := public.snacky_current_team_member_id();
  saved public.issues%rowtype;
  customer text := nullif(btrim(coalesce(p_customer_name,'')),'');
  phone text := nullif(btrim(coalesce(p_customer_phone,'')),'');
  body text := nullif(btrim(coalesce(p_description,'')),'');
  replay boolean := false;
begin
  if actor is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']) then
    raise exception 'Only active customer-support or management staff can add customer issues' using errcode='42501';
  end if;
  if p_client_submission_id is null then raise exception 'A saved request ID is required' using errcode='22023'; end if;
  if p_issue_type is null or p_issue_type not in ('payment_problem','product_stuck','machine_down','product_quality','other')
    or p_priority is null or p_priority not in ('low','normal','high','critical')
    or p_contact_channel is null or p_contact_channel not in ('whatsapp','phone','facebook','instagram','in_person','other') then
    raise exception 'Select a valid issue type, priority, and contact channel' using errcode='22023';
  end if;
  if body is null or length(body)>5000 or length(coalesce(customer,''))>150 or length(coalesce(phone,''))>50 then
    raise exception 'Describe the issue and keep contact details within the field limits' using errcode='22023';
  end if;
  if p_machine_id is not null and not exists(select 1 from public.machines where id=p_machine_id) then
    raise exception 'Select an existing machine or choose unknown' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('snacky-customer-issue:'||p_client_submission_id::text,0));
  select * into saved from public.issues where id=p_client_submission_id;
  if found then
    if saved.reported_by is distinct from actor or saved.machine_id is distinct from p_machine_id
      or saved.issue_type is distinct from p_issue_type or saved.priority::text is distinct from p_priority
      or saved.customer_name is distinct from customer or saved.customer_phone is distinct from phone
      or saved.contact_channel is distinct from p_contact_channel or saved.description is distinct from body then
      raise exception 'This saved request already belongs to different details. Review its history.' using errcode='23505';
    end if;
    replay := true;
  else
    insert into public.issues(id,machine_id,reported_by,issue_type,priority,status,customer_name,customer_phone,contact_channel,description)
      values(p_client_submission_id,p_machine_id,actor,p_issue_type,p_priority::public.issue_priority,'open',customer,phone,p_contact_channel,body)
      returning * into saved;
  end if;
  return jsonb_build_object('id',saved.id,'status',saved.status,'machine_id',saved.machine_id,'already_applied',replay);
end $$;
revoke all on function public.snacky_create_customer_issue_v1(uuid,uuid,text,text,text,text,text,text) from public,anon;
grant execute on function public.snacky_create_customer_issue_v1(uuid,uuid,text,text,text,text,text,text) to authenticated;
notify pgrst,'reload schema';
