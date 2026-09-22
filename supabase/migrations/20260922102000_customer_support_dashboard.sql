-- Focused customer-support summary for My Work.
-- Read-only and scoped to the signed-in customer-relations employee.

create or replace function public.snacky_customer_support_dashboard_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $support$
declare
  me uuid := public.snacky_current_team_member_id();
  day date := (now() at time zone 'Africa/Tripoli')::date;
  result jsonb;
begin
  if me is null or not public.snacky_crm_staff() then
    raise exception 'Customer relations access required' using errcode='42501';
  end if;

  with issue_state as (
    select
      i.id,
      i.customer_name,
      i.customer_phone,
      i.customer_whatsapp,
      i.contact_channel,
      i.description,
      i.issue_type,
      i.status::text as status,
      i.priority::text as priority,
      i.location_id,
      l.name as location_name,
      i.next_action,
      i.next_action_date,
      i.is_waiting,
      nullif(trim(i.waiting_on),'') as waiting_on,
      i.updated_at,
      i.resolved_at,
      (
        exists (
          select 1
          from public.crm_tasks t
          join public.team_members tm on tm.id=t.assigned_to
          where t.issue_id=i.id
            and t.task_type='field_action'
            and t.status<>'completed'
            and t.archived_at is null
            and tm.active
            and tm.active_status='active'
            and (tm.role::text='operator' or tm.roles::text[]&&array['operator'])
        )
        or (coalesce(i.is_waiting,false) and lower(coalesce(i.waiting_on,'')) in ('operator','المشغل','المشغّل'))
      ) as waiting_operator,
      (
        coalesce(i.is_waiting,false)
        and (
          lower(coalesce(i.waiting_on,'')) in ('customer','client','العميل','عميل')
          or lower(coalesce(i.waiting_on,'')) like '%customer%'
          or coalesce(i.waiting_on,'') like '%العميل%'
        )
      ) as waiting_customer,
      (
        exists (
          select 1
          from public.crm_tasks t
          join public.team_members tm on tm.id=t.assigned_to
          where t.issue_id=i.id
            and t.task_type='admin'
            and t.status<>'completed'
            and t.archived_at is null
            and tm.active
            and tm.active_status='active'
            and (
              tm.role::text in ('owner','admin','supervisor')
              or tm.roles::text[]&&array['owner','admin','supervisor']
            )
        )
        or (coalesce(i.is_waiting,false) and lower(coalesce(i.waiting_on,'')) in ('management','manager','الإدارة','الادارة'))
      ) as needs_management
    from public.issues i
    left join public.locations l on l.id=i.location_id
    where i.assigned_to=me
      and i.archived_at is null
      and not coalesce(i.is_practice,false)
      and not coalesce(i.is_historical,false)
  ),
  active as (
    select *,
      (next_action_date is not null and next_action_date<day and status not in ('resolved','closed')) as overdue,
      (next_action_date=day and status not in ('resolved','closed')) as due_today
    from issue_state
    where status not in ('resolved','closed')
  ),
  recent as (
    select count(*)::int as count
    from issue_state
    where status in ('resolved','closed')
      and resolved_at>=now()-interval '7 days'
  ),
  counts as (
    select jsonb_build_object(
      'open', count(*)::int,
      'waiting_operator', count(*) filter(where waiting_operator)::int,
      'waiting_customer', count(*) filter(where waiting_customer)::int,
      'needs_management', count(*) filter(where needs_management)::int,
      'due_today', count(*) filter(where due_today)::int,
      'overdue', count(*) filter(where overdue)::int,
      'recent_resolved', (select count from recent)
    ) as value
    from active
  ),
  rows as (
    select coalesce(jsonb_agg(to_jsonb(x) order by x.needs_management desc,x.overdue desc,x.due_today desc,x.updated_at asc),'[]'::jsonb) as value
    from (
      select id,customer_name,customer_phone,customer_whatsapp,contact_channel,description,issue_type,status,priority,
             location_id,location_name,next_action,next_action_date,is_waiting,waiting_on,waiting_operator,waiting_customer,
             needs_management,overdue,due_today,updated_at
      from active
      order by needs_management desc,overdue desc,due_today desc,updated_at asc
      limit 8
    ) x
  )
  select jsonb_build_object(
    'counts',(select value from counts),
    'rows',(select value from rows),
    'generated_at',now()
  ) into result;

  return result;
end;
$support$;

revoke all on function public.snacky_customer_support_dashboard_v1() from public, anon;
grant execute on function public.snacky_customer_support_dashboard_v1() to authenticated;

comment on function public.snacky_customer_support_dashboard_v1() is
'Read-only customer-support dashboard for the signed-in CRM employee. No Finance mutations.';
