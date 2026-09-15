-- Connected Customer Relations & Business Development. Reuses crm/team auth,
-- locations, machines, issues, pipeline leads, Finance and Supabase Storage.
-- No staff identities, real contacts, financial amounts or practice records seeded.

alter table public.location_pipeline_leads
 add column if not exists name_ar text,
 add column if not exists website text,
 add column if not exists social_links text,
 add column if not exists attraction_notes text,
 add column if not exists contact_email text,
 add column if not exists reception_phone text,
 add column if not exists source_detail text,
 add column if not exists next_action_time time,
 add column if not exists created_by_member_id uuid references public.team_members(id) on delete set null,
 add column if not exists updated_by_member_id uuid references public.team_members(id) on delete set null,
 add column if not exists accepted_at timestamptz,
 add column if not exists closed_by_member_id uuid references public.team_members(id) on delete set null,
 add column if not exists visibility text not null default 'team' check(visibility in ('team','assigned')),
 add column if not exists is_practice boolean not null default false;
alter table public.location_pipeline_leads drop constraint if exists location_pipeline_leads_status_check;
alter table public.location_pipeline_leads add constraint location_pipeline_leads_status_check check(status in ('want_to_contact','trying_to_reach','contacted','interested','meeting_needed','visit_scheduled','visited','offer_sent','negotiating','trial_contract','accepted','rejected','follow_up_later','machine_placed'));

alter table public.issues
 add column if not exists location_id uuid references public.locations(id) on delete restrict,
 add column if not exists product_id uuid references public.products(id) on delete set null,
 add column if not exists lane_number text,
 add column if not exists customer_whatsapp text,
 add column if not exists amount_involved_lyd numeric(14,2) check(amount_involved_lyd>=0),
 add column if not exists happened_at timestamptz,
 add column if not exists is_waiting boolean not null default false,
 add column if not exists waiting_on text,
 add column if not exists next_action text,
 add column if not exists next_action_date date,
 add column if not exists resolution text,
 add column if not exists refund_amount_lyd numeric(14,2) check(refund_amount_lyd>=0),
 add column if not exists resolved_by uuid references public.team_members(id) on delete set null,
 add column if not exists updated_by uuid references public.team_members(id) on delete set null,
 add column if not exists updated_at timestamptz not null default now(),
 add column if not exists field_completed_at timestamptz,
 add column if not exists archived_at timestamptz,
 add column if not exists archive_reason text,
 add column if not exists is_practice boolean not null default false;
-- Keep old machine links, but a deleted machine must not erase complaint history.
alter table public.issues drop constraint if exists issues_machine_id_fkey;
alter table public.issues add constraint issues_machine_id_fkey foreign key(machine_id) references public.machines(id) on delete restrict;

create table public.location_relationships(
 location_id uuid primary key references public.locations(id) on delete restrict,
 assigned_to uuid references public.team_members(id) on delete set null,
 next_action text,next_action_date date,next_action_time time,last_contact_at timestamptz,
 notes text,agreement_type text not null default 'other' check(agreement_type in ('fixed_rent','revenue_share','free_service','other')),
 payment_frequency text not null default 'monthly' check(payment_frequency in ('once','monthly','quarterly','yearly')),
 created_by uuid references public.team_members(id) on delete set null,
 updated_by uuid references public.team_members(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);

create or replace function public.snacky_crm_phone_key(p_phone text)
returns text language sql immutable set search_path=pg_catalog as $$
 select case when v='' then null when left(v,2)='00' then substr(v,3) when length(v)=10 and left(v,1)='0' then '218'||substr(v,2) else v end
 from (select regexp_replace(coalesce(p_phone,''),'[^0-9]','','g') v) s;
$$;
create table public.crm_contacts(
 id uuid primary key default gen_random_uuid(),name text not null check(length(trim(name)) between 1 and 200),
 position text,organization text,phone text,whatsapp text,email text,
 phone_key text generated always as (public.snacky_crm_phone_key(phone)) stored,
 email_key text generated always as (nullif(lower(trim(email)),'')) stored,
 preferred_channel text not null default 'phone' check(preferred_channel in ('phone','whatsapp','email','other')),
 notes text,archived_at timestamptz,
 created_by uuid references public.team_members(id) on delete set null,updated_by uuid references public.team_members(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index crm_contacts_phone_idx on public.crm_contacts(phone_key);
create index crm_contacts_email_idx on public.crm_contacts(email_key);
create table public.crm_contact_links(
 id uuid primary key default gen_random_uuid(),contact_id uuid not null references public.crm_contacts(id) on delete restrict,
 lead_id uuid references public.location_pipeline_leads(id) on delete restrict,
 location_id uuid references public.locations(id) on delete restrict,
 issue_id uuid references public.issues(id) on delete restrict,
 created_by uuid references public.team_members(id) on delete set null,created_at timestamptz not null default now(),
 check(num_nonnulls(lead_id,location_id,issue_id)=1)
);
create unique index crm_contact_lead_unique on public.crm_contact_links(contact_id,lead_id) where lead_id is not null;
create unique index crm_contact_location_unique on public.crm_contact_links(contact_id,location_id) where location_id is not null;
create unique index crm_contact_issue_unique on public.crm_contact_links(contact_id,issue_id) where issue_id is not null;

create table public.location_admin_obligations(
 id uuid primary key default gen_random_uuid(),location_id uuid not null references public.locations(id) on delete restrict,
 title text not null check(length(trim(title)) between 1 and 200),amount_lyd numeric(14,2) not null check(amount_lyd>=0),
 due_date date not null,frequency text not null default 'monthly' check(frequency in ('once','monthly','quarterly','yearly')),
 assigned_to uuid not null references public.team_members(id) on delete restrict,
 status text not null default 'open' check(status in ('open','paid','not_applicable','cancelled')),
 payment_date date,paid_by uuid references public.team_members(id) on delete restrict,payment_method text,
 finance_transaction_id uuid unique references public.financial_transactions(id) on delete restrict,
 finance_verified_at timestamptz,finance_verified_by uuid references public.team_members(id) on delete restrict,
 notes text,is_practice boolean not null default false,
 created_by uuid references public.team_members(id) on delete set null,updated_by uuid references public.team_members(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(location_id,title,due_date),
 check((finance_transaction_id is null and finance_verified_at is null and finance_verified_by is null) or (status='paid' and finance_transaction_id is not null and finance_verified_at is not null and finance_verified_by is not null))
);
comment on table public.location_admin_obligations is 'Administrative obligation/proof tracking. Reported paid is not a Finance posting. Managers explicitly link a matching existing Finance expense.';

create table public.crm_tasks(
 id uuid primary key default gen_random_uuid(),title text not null check(length(trim(title)) between 1 and 240),
 lead_id uuid references public.location_pipeline_leads(id) on delete restrict,
 location_id uuid references public.locations(id) on delete restrict,
 issue_id uuid references public.issues(id) on delete restrict,
 contact_id uuid references public.crm_contacts(id) on delete restrict,
 obligation_id uuid references public.location_admin_obligations(id) on delete restrict,
 task_type text not null default 'follow_up' check(task_type in ('follow_up','field_action','meeting','admin','other')),
 assigned_to uuid not null references public.team_members(id) on delete restrict,
 due_date date not null,due_time time,
 priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
 status text not null default 'open' check(status in ('open','in_progress','completed')),
 notes text,result text,completed_at timestamptz,completed_by uuid references public.team_members(id) on delete restrict,
 is_practice boolean not null default false,archived_at timestamptz,
 created_by uuid references public.team_members(id) on delete set null,updated_by uuid references public.team_members(id) on delete set null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(num_nonnulls(lead_id,location_id,issue_id,contact_id,obligation_id)<=1),
 check(task_type<>'field_action' or issue_id is not null),
 check((status='completed' and completed_at is not null and completed_by is not null and length(trim(result))>0) or (status<>'completed' and completed_at is null and completed_by is null))
);
create table public.crm_activities(
 id uuid primary key default gen_random_uuid(),
 lead_id uuid references public.location_pipeline_leads(id) on delete restrict,
 location_id uuid references public.locations(id) on delete restrict,
 issue_id uuid references public.issues(id) on delete restrict,
 contact_id uuid references public.crm_contacts(id) on delete restrict,
 obligation_id uuid references public.location_admin_obligations(id) on delete restrict,
 task_id uuid references public.crm_tasks(id) on delete restrict,
 activity_type text not null,summary text not null check(length(trim(summary)) between 1 and 4000),
 actor_id uuid references public.team_members(id) on delete set null,actor_name text,
 before_data jsonb,after_data jsonb,occurred_at timestamptz not null default now(),created_at timestamptz not null default now(),
 check(num_nonnulls(lead_id,location_id,issue_id,contact_id,obligation_id,task_id)>=1)
);
create table public.crm_documents(
 id uuid primary key default gen_random_uuid(),
 lead_id uuid references public.location_pipeline_leads(id) on delete restrict,
 location_id uuid references public.locations(id) on delete restrict,
 issue_id uuid references public.issues(id) on delete restrict,
 contact_id uuid references public.crm_contacts(id) on delete restrict,
 obligation_id uuid references public.location_admin_obligations(id) on delete restrict,
 task_id uuid references public.crm_tasks(id) on delete restrict,
 object_path text not null unique,original_name text not null,mime_type text not null,
 uploaded_by uuid not null references public.team_members(id) on delete restrict,
 created_at timestamptz not null default now(),check(num_nonnulls(lead_id,location_id,issue_id,contact_id,obligation_id,task_id)=1)
);
create table public.crm_lead_bonus(
 lead_id uuid primary key references public.location_pipeline_leads(id) on delete restrict,
 eligible boolean not null default false,amount_lyd numeric(14,2) check(amount_lyd>=0),
 status text not null default 'pending' check(status in ('pending','approved','paid')),
 notes text,updated_by uuid references public.team_members(id) on delete set null,updated_at timestamptz not null default now()
);
create table public.crm_command_receipts(
 id uuid primary key,actor_user_id uuid not null references auth.users(id) on delete restrict,
 action text not null,request jsonb not null,response jsonb not null,created_at timestamptz not null default now()
);

create or replace function public.snacky_crm_manager()
returns boolean language sql stable security definer set search_path=public,pg_catalog as $$select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor']);$$;
create or replace function public.snacky_crm_staff()
returns boolean language sql stable security definer set search_path=public,pg_catalog as $$select public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm']);$$;
create or replace function public.snacky_crm_allowed(p_kind text,p_id uuid,p_write boolean default false)
returns boolean language plpgsql stable security definer set search_path=public,pg_catalog as $$
declare me uuid:=public.snacky_current_team_member_id(); manager boolean:=public.snacky_crm_manager(); staff boolean:=public.snacky_crm_staff();
begin
 if me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then return false;end if;
 if p_kind='lead' then return exists(select 1 from public.location_pipeline_leads l where l.id=p_id and (manager or (staff and (case when p_write then l.assigned_to_user_id=me or (l.assigned_to_user_id is null and l.created_by_member_id=me) else l.visibility='team' or l.assigned_to_user_id=me or l.created_by_member_id=me end))));
 elsif p_kind='issue' then return exists(select 1 from public.issues i where i.id=p_id and (manager or (staff and (not p_write or i.assigned_to=me or (i.assigned_to is null and i.reported_by=me))) or (not p_write and (i.reported_by=me or exists(select 1 from public.crm_tasks t where t.issue_id=i.id and t.assigned_to=me and t.archived_at is null)))));
 elsif p_kind='location' then return exists(select 1 from public.locations l where l.id=p_id and (manager or (staff and (not p_write or exists(select 1 from public.location_relationships r where r.location_id=l.id and r.assigned_to=me)))));
 elsif p_kind='contact' then return staff and exists(select 1 from public.crm_contacts c where c.id=p_id);
 elsif p_kind='obligation' then return exists(select 1 from public.location_admin_obligations o where o.id=p_id and (manager or (staff and o.assigned_to=me)));
 elsif p_kind='task' then return exists(select 1 from public.crm_tasks t where t.id=p_id and (manager or t.assigned_to=me or (staff and t.created_by=me)));
 end if;
 return false;
end $$;

-- New tables are deny-by-default; all mutations go through transactional commands.
do $$declare tbl text;begin
 foreach tbl in array array['location_relationships','crm_contacts','crm_contact_links','location_admin_obligations','crm_tasks','crm_activities','crm_documents','crm_lead_bonus','crm_command_receipts'] loop
  execute format('alter table public.%I enable row level security',tbl);
  execute format('revoke all on public.%I from public,anon,authenticated',tbl);
  execute format('grant select on public.%I to authenticated',tbl);
  execute format('grant all on public.%I to service_role',tbl);
 end loop;
end $$;
create policy crm_relationship_read on public.location_relationships for select to authenticated using(public.snacky_crm_allowed('location',location_id));
create policy crm_contacts_read on public.crm_contacts for select to authenticated using(public.snacky_crm_staff());
create policy crm_contact_links_read on public.crm_contact_links for select to authenticated using(public.snacky_crm_allowed('lead',lead_id) or public.snacky_crm_allowed('location',location_id) or public.snacky_crm_allowed('issue',issue_id));
create policy crm_obligation_read on public.location_admin_obligations for select to authenticated using(public.snacky_crm_allowed('obligation',id));
create policy crm_task_read on public.crm_tasks for select to authenticated using(public.snacky_crm_allowed('task',id));
create policy crm_activity_read on public.crm_activities for select to authenticated using(public.snacky_crm_allowed('lead',lead_id) or public.snacky_crm_allowed('location',location_id) or public.snacky_crm_allowed('issue',issue_id) or public.snacky_crm_allowed('contact',contact_id) or public.snacky_crm_allowed('obligation',obligation_id) or public.snacky_crm_allowed('task',task_id));
create policy crm_document_read on public.crm_documents for select to authenticated using(public.snacky_crm_allowed('lead',lead_id) or public.snacky_crm_allowed('location',location_id) or public.snacky_crm_allowed('issue',issue_id) or public.snacky_crm_allowed('contact',contact_id) or public.snacky_crm_allowed('obligation',obligation_id) or public.snacky_crm_allowed('task',task_id));
create policy crm_bonus_read on public.crm_lead_bonus for select to authenticated using(public.snacky_current_profile_has_any_role(array['owner','admin']));
create policy crm_receipt_read on public.crm_command_receipts for select to authenticated using(actor_user_id=auth.uid());

create index crm_task_assignee_due on public.crm_tasks(assigned_to,status,due_date);
create index crm_task_issue on public.crm_tasks(issue_id) where issue_id is not null;
create index crm_task_lead on public.crm_tasks(lead_id) where lead_id is not null;
create index crm_task_location on public.crm_tasks(location_id) where location_id is not null;
create index crm_obligation_due on public.location_admin_obligations(assigned_to,status,due_date);
create index crm_obligation_location on public.location_admin_obligations(location_id,due_date);
create index crm_activity_lead on public.crm_activities(lead_id,occurred_at desc);
create index crm_activity_issue on public.crm_activities(issue_id,occurred_at desc);
create index crm_activity_location on public.crm_activities(location_id,occurred_at desc);
create index crm_activity_task on public.crm_activities(task_id,occurred_at desc);
create index crm_issue_phone on public.issues(public.snacky_crm_phone_key(customer_phone));
create index crm_issue_location_status on public.issues(location_id,status);
create index crm_lead_assignee_followup on public.location_pipeline_leads(assigned_to_user_id,next_action_date);

-- Enforce source-history retention, including older entry points.
create or replace function public.snacky_crm_no_delete()
returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception 'Keep relationship history. Archive or cancel this record instead of deleting it' using errcode='23514';end $$;
do $$declare tbl text;begin
 foreach tbl in array array['issues','location_pipeline_leads','location_pipeline_activities','crm_tasks','crm_activities','crm_contacts','crm_contact_links','crm_documents','location_admin_obligations'] loop
  execute format('create trigger crm_keep_history before delete on public.%I for each row execute function public.snacky_crm_no_delete()',tbl);
 end loop;
end $$;
create trigger crm_activity_immutable before update on public.crm_activities for each row execute function public.snacky_crm_no_delete();
create trigger crm_lead_activity_immutable before update on public.location_pipeline_activities for each row execute function public.snacky_crm_no_delete();

revoke all on function public.snacky_crm_manager(),public.snacky_crm_staff(),public.snacky_crm_allowed(text,uuid,boolean),public.snacky_crm_no_delete() from public,anon;
grant execute on function public.snacky_crm_manager(),public.snacky_crm_staff(),public.snacky_crm_allowed(text,uuid,boolean) to authenticated;
