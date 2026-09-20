-- Current-location relationship ownership and recurring rent obligations.
-- Additive: does not create Finance expenses or mark any payment as paid.
set lock_timeout = '3s';
set statement_timeout = '45s';

alter table public.location_relationships
  add column if not exists payment_recurring boolean not null default false,
  add column if not exists payment_anchor_date date,
  add column if not exists next_payment_due_date date,
  add column if not exists payment_notice_days integer not null default 7;

do $$
begin
 if not exists (
   select 1 from pg_constraint
   where conrelid='public.location_relationships'::regclass
     and conname='location_relationships_payment_notice_days_check'
 ) then
   alter table public.location_relationships
     add constraint location_relationships_payment_notice_days_check
     check (payment_notice_days between 0 and 30);
 end if;
end $$;

create index if not exists idx_location_relationships_payment_due
  on public.location_relationships(next_payment_due_date, assigned_to)
  where payment_recurring and next_payment_due_date is not null;

create or replace function public.snacky_next_location_payment_date(
  p_date date,
  p_frequency text,
  p_anchor date
) returns date
language plpgsql immutable
set search_path=''
as $$
declare
  months_to_add integer;
  first_day date;
  last_day date;
  desired_day integer;
begin
 if p_date is null or p_anchor is null then
   raise exception 'Payment dates are required' using errcode='22023';
 end if;
 months_to_add := case p_frequency
   when 'monthly' then 1
   when 'quarterly' then 3
   when 'yearly' then 12
   else null
 end;
 if months_to_add is null then
   raise exception 'Recurring payment frequency must be monthly, quarterly or yearly' using errcode='22023';
 end if;
 desired_day := extract(day from p_anchor)::integer;
 first_day := (date_trunc('month', p_date) + make_interval(months => months_to_add))::date;
 last_day := (first_day + interval '1 month - 1 day')::date;
 return first_day + least(desired_day, extract(day from last_day)::integer) - 1;
end
$$;

revoke all on function public.snacky_next_location_payment_date(date,text,date) from public,anon,authenticated;

create or replace function public.snacky_generate_due_location_payments(
  p_now timestamptz default clock_timestamp()
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  r record;
  today date := (p_now at time zone 'Africa/Tripoli')::date;
  due_on date;
  next_on date;
  made integer := 0;
  touched integer := 0;
  inserted integer;
begin
 if not pg_try_advisory_xact_lock(hashtextextended('snacky-location-payment-generator',0)) then
   return jsonb_build_object('busy',true);
 end if;

 for r in
   select
     rel.location_id,
     rel.assigned_to,
     rel.payment_frequency,
     rel.payment_anchor_date,
     rel.next_payment_due_date,
     rel.payment_notice_days,
     loc.rent_amount
   from public.location_relationships rel
   join public.locations loc on loc.id=rel.location_id
   join public.team_members tm on tm.id=rel.assigned_to
   where rel.payment_recurring
     and rel.next_payment_due_date is not null
     and rel.payment_frequency in ('monthly','quarterly','yearly')
     and rel.next_payment_due_date <= today + rel.payment_notice_days
     and loc.status not in ('archived','inactive')
     and coalesce(loc.rent_amount,0) > 0
     and tm.active and tm.active_status='active'
   order by rel.next_payment_due_date, rel.location_id
   for update of rel skip locked
 loop
   touched := touched + 1;
   due_on := r.next_payment_due_date;
   while due_on <= today + r.payment_notice_days loop
     insert into public.location_admin_obligations(
       location_id,title,amount_lyd,due_date,frequency,assigned_to,status,notes,is_practice
     ) values(
       r.location_id,
       'Location rent / إيجار الموقع',
       r.rent_amount,
       due_on,
       r.payment_frequency,
       r.assigned_to,
       'open',
       'Generated automatically from the recurring location rent schedule.',
       false
     )
     on conflict(location_id,title,due_date) do nothing;
     get diagnostics inserted = row_count;
     made := made + inserted;

     next_on := public.snacky_next_location_payment_date(
       due_on,
       r.payment_frequency,
       coalesce(r.payment_anchor_date,r.next_payment_due_date)
     );
     if next_on <= due_on then
       raise exception 'Recurring payment date did not advance' using errcode='22023';
     end if;
     due_on := next_on;
   end loop;

   update public.location_relationships
   set next_payment_due_date=due_on, updated_at=now()
   where location_id=r.location_id;
 end loop;

 return jsonb_build_object('generated',made,'schedules_checked',touched,'checked_at',p_now);
end
$$;

revoke all on function public.snacky_generate_due_location_payments(timestamptz) from public,anon,authenticated;

create or replace function public.snacky_location_payment_schedule_v1(
  p_location_id uuid,
  p_rent_amount numeric,
  p_agreement_type text,
  p_frequency text,
  p_next_due_date date,
  p_recurring boolean,
  p_notice_days integer default 7
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  me uuid := public.snacky_current_team_member_id();
  assignee uuid;
  before_value jsonb;
  after_value jsonb;
begin
 if me is null
   or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor'])
 then
   raise exception 'Management access required' using errcode='42501';
 end if;

 if p_location_id is null
   or not exists(select 1 from public.locations where id=p_location_id and status not in ('archived','inactive'))
   or p_rent_amount is null or p_rent_amount < 0
   or p_agreement_type not in ('fixed_rent','revenue_share','free_service','other')
   or p_frequency not in ('once','monthly','quarterly','yearly')
   or p_notice_days not between 0 and 30
 then
   raise exception 'Invalid location payment schedule' using errcode='22023';
 end if;

 if p_recurring and (
   p_agreement_type <> 'fixed_rent'
   or p_frequency='once'
   or p_next_due_date is null
   or p_rent_amount <= 0
 ) then
   raise exception 'Recurring rent needs fixed rent, a positive amount, a recurring frequency and a next due date' using errcode='22023';
 end if;

 select to_jsonb(l)||jsonb_build_object('relationship',to_jsonb(r))
 into before_value
 from public.locations l
 left join public.location_relationships r on r.location_id=l.id
 where l.id=p_location_id;

 select assigned_to into assignee
 from public.location_relationships
 where location_id=p_location_id;

 if assignee is null then
   raise exception 'Assign a relationship owner before setting rent recurrence' using errcode='22023';
 end if;

 update public.locations
 set rent_amount=p_rent_amount,
     rent_type=case
       when p_agreement_type='fixed_rent' then 'monthly_fixed'
       when p_agreement_type='revenue_share' then 'revenue_share'
       when p_agreement_type='free_service' then 'free'
       else coalesce(rent_type,'other')
     end,
     updated_at=now()
 where id=p_location_id;

 update public.location_relationships
 set agreement_type=p_agreement_type,
     payment_frequency=p_frequency,
     payment_recurring=p_recurring,
     payment_anchor_date=case when p_recurring then p_next_due_date else null end,
     next_payment_due_date=case when p_recurring then p_next_due_date else p_next_due_date end,
     payment_notice_days=p_notice_days,
     updated_by=me,
     updated_at=now()
 where location_id=p_location_id;

 select to_jsonb(l)||jsonb_build_object('relationship',to_jsonb(r))
 into after_value
 from public.locations l
 left join public.location_relationships r on r.location_id=l.id
 where l.id=p_location_id;

 perform public.snacky_crm_emit(
   'location',
   p_location_id,
   'payment_schedule_updated',
   'Location payment schedule updated',
   before_value,
   after_value
 );

 if p_recurring then
   perform public.snacky_generate_due_location_payments(clock_timestamp());
 end if;

 return jsonb_build_object(
   'location_id',p_location_id,
   'recurring',p_recurring,
   'next_due_date',(select next_payment_due_date from public.location_relationships where location_id=p_location_id)
 );
end
$$;

revoke all on function public.snacky_location_payment_schedule_v1(uuid,numeric,text,text,date,boolean,integer) from public,anon;
grant execute on function public.snacky_location_payment_schedule_v1(uuid,numeric,text,text,date,boolean,integer) to authenticated;

do $$
begin
 if to_regclass('cron.job') is not null then
   perform cron.schedule(
     'snacky-location-payments',
     '15 * * * *',
     'select public.snacky_generate_due_location_payments();'
   );
 end if;
end
$$;

select public.snacky_generate_due_location_payments();
