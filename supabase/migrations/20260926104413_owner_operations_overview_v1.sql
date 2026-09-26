-- Owner Operations: bounded, independently readable projections, no business writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema if not exists owner_operations_private;

create or replace function owner_operations_private.section(p_section text,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare payload jsonb;
begin
 if auth.uid() is null or not coalesce(public.snacky_current_profile_has_any_role(array['owner','admin']),false) then
  raise exception 'Owner/admin access required' using errcode='42501';
 end if;
 if p_section is null or p_section not in ('cash','buying','stocktakes','issues','notifications')
    or p_offset is null or p_offset<0 or p_offset>100000 or p_offset%25<>0 then
  raise exception 'Invalid overview section or offset' using errcode='22023';
 end if;

 if p_section='cash' then
  with queue as (
   select c.id,
     coalesce(nullif(btrim(c.cash_bag_id),''),'—') as title,
     coalesce((select string_agg(coalesce(nullif(m.name,''),m.machine_code),' · ' order by m.id)
       from public.cash_collection_machines cm join public.machines m on m.id=cm.machine_id
       where cm.cash_collection_id=c.id),machine.name) as context,
     case when h.stage='picked_up' then custodian.full_name
       when h.stage='dropped' or c.custody_status='in_storage' then assignee.full_name
       else collector.full_name end as person,
     case when coalesce(c.cash_bag_id,'') !~ '[^[:space:]]' then 'cash_reference'
       when h.stage='picked_up' then 'cash_count'
       when h.stage='dropped' or c.custody_status='in_storage' then 'cash_pickup'
       else 'cash_deposit' end as state,
     case when coalesce(c.cash_bag_id,'') !~ '[^[:space:]]' then null::timestamptz
       when h.stage='picked_up' then h.picked_up_at
       when h.stage='dropped' or c.custody_status='in_storage' then coalesce(h.deposited_at,c.storage_received_at,c.collected_at)
       else c.collected_at end as since,
     null::timestamptz as due_at,
     case when coalesce(c.cash_bag_id,'') !~ '[^[:space:]]' then '/cash-collections/'||c.id::text
       else '/cash-handling?id='||c.id::text end as href,
     case when coalesce(c.cash_bag_id,'') !~ '[^[:space:]]' then 3 else 1 end as sort_priority
   from public.cash_collections c
   left join snacky_private.cash_handovers h on h.collection_id=c.id
   left join public.team_members collector on collector.id=c.operator_id
   left join public.profiles assignee on assignee.id=h.assigned_to
   left join public.profiles custodian on custodian.id=h.picked_up_by
   left join public.machines machine on machine.id=c.machine_id
   where c.actual_cash_collected is null and c.voided_at is null and c.custody_status in ('removed','in_storage')
  )
  select jsonb_build_object(
   'total',(select count(*) from queue),
   'counts',coalesce((select jsonb_object_agg(state,n) from (select state,count(*) n from queue group by state) g),'{}'::jsonb),
   'rows',coalesce((select jsonb_agg(to_jsonb(q)-'sort_priority' order by q.sort_priority,q.since nulls last,q.id)
     from (select * from queue order by sort_priority,since nulls last,id limit 25 offset p_offset) q),'[]'::jsonb)
  ) into payload;

 elsif p_section='buying' then
  with queue as (
   select l.id,l.title,null::text as context,tm.full_name as person,
     case when exists(select 1 from buying_private.items item where item.list_id=l.id and item.outcome in ('partial','unavailable'))
       then 'buying_exception' else 'buying_open' end as state,
     l.created_at as since,((l.due_on+1)::timestamp at time zone 'Africa/Tripoli') as due_at,
     '/buying-lists/'||l.id::text as href,2 as sort_priority
   from buying_private.lists l left join public.team_members tm on tm.id=l.assigned_to
   where l.status='open' or (l.status='completed' and exists(select 1 from buying_private.items item where item.list_id=l.id and item.outcome in ('partial','unavailable')))
   union all
   select po.id,coalesce(nullif(po.receipt_number,''),l.title),supplier.name,tm.full_name,'storage_pending',
     link.created_at,((po.expected_delivery_date+1)::timestamp at time zone 'Africa/Tripoli'),
     '/buying-lists/'||l.id::text,1
   from buying_private.purchase_links link
   join public.purchase_orders po on po.id=link.purchase_id
   join buying_private.lists l on l.id=link.list_id
   left join public.team_members tm on tm.id=link.buyer_id
   left join public.suppliers supplier on supplier.id=po.supplier_id
   where link.retired_at is null and po.voided_at is null and po.status='draft' and po.received_at is null
  )
  select jsonb_build_object(
   'total',(select count(*) from queue),
   'counts',coalesce((select jsonb_object_agg(state,n) from (select state,count(*) n from queue group by state) g),'{}'::jsonb),
   'rows',coalesce((select jsonb_agg(to_jsonb(q)-'sort_priority' order by q.sort_priority,q.since nulls last,q.id)
     from (select * from queue order by sort_priority,since nulls last,id limit 25 offset p_offset) q),'[]'::jsonb)
  ) into payload;

 elsif p_section='stocktakes' then
  with queue as (
   select a.id,a.title,s.name as context,p.full_name as person,
     case when a.status='submitted' then 'stock_review' when a.status='needs_recount' then 'stock_recount' else 'stock_count' end as state,
     case when a.status='submitted' then a.submitted_at else a.created_at end as since,
     ((a.due_on+1)::timestamp at time zone 'Africa/Tripoli') as due_at,
     '/inventory/stocktake?id='||a.id::text as href,
     case when a.status='submitted' then 1 else 2 end as sort_priority
   from stocktake_private.assignments a
   left join public.storage_locations s on s.id=a.storage_location_id
   left join public.profiles p on p.id=a.assigned_to
   where a.status in ('assigned','counting','needs_recount','submitted')
  )
  select jsonb_build_object(
   'total',(select count(*) from queue),
   'counts',coalesce((select jsonb_object_agg(state,n) from (select state,count(*) n from queue group by state) g),'{}'::jsonb),
   'rows',coalesce((select jsonb_agg(to_jsonb(q)-'sort_priority' order by q.sort_priority,q.since nulls last,q.id)
     from (select * from queue order by sort_priority,since nulls last,id limit 25 offset p_offset) q),'[]'::jsonb)
  ) into payload;

 elsif p_section='issues' then
  with queue as (
   select i.id,coalesce(nullif(m.name,''),nullif(l.name,''),i.issue_type) as title,
     case when m.name is not null then l.name else null end as context,
     case when field.dispatch_state in ('blocked','assigned') then operator.full_name else crm.full_name end as person,
     case when field.dispatch_state='blocked' then 'crm_blocked'
       when field.dispatch_state='assigned' and field.ack_due_at<=now() then 'crm_acceptance'
       when not exists(select 1 from public.crm_tasks pending where pending.issue_id=i.id and pending.task_type='field_action'
         and pending.status not in ('completed','cancelled','canceled') and pending.archived_at is null and not coalesce(pending.is_practice,false))
         and (i.field_completed_at is not null or field.dispatch_state='fixed') then 'crm_verify'
       when i.assigned_to is null then 'crm_unassigned'
       when i.sla_due_at<=now() then 'crm_overdue' else 'crm_open' end as state,
     coalesce(case when field.dispatch_state='blocked' then field.blocked_at
       when field.dispatch_state='fixed' then field.fixed_at else null end,i.field_completed_at,i.created_at) as since,
     case when field.dispatch_state='assigned' then field.ack_due_at else i.sla_due_at end as due_at,
     '/issues/'||i.id::text as href,
     case when field.dispatch_state='blocked' or (field.dispatch_state='assigned' and field.ack_due_at<=now()) then 0
       when i.priority::text in ('critical','urgent','high') then 1 else 2 end as sort_priority
   from public.issues i
   left join public.machines m on m.id=i.machine_id
   left join public.locations l on l.id=coalesce(i.location_id,m.location_id)
   left join public.team_members crm on crm.id=i.assigned_to
   left join lateral (
     select t.* from public.crm_tasks t
     where t.issue_id=i.id and t.task_type='field_action' and t.archived_at is null and not coalesce(t.is_practice,false)
       and t.status not in ('cancelled','canceled')
     order by case when t.dispatch_state='blocked' then 0
       when t.dispatch_state='assigned' and t.ack_due_at<=now() then 1
       when t.status<>'completed' then 2 else 3 end,t.created_at,t.id limit 1
   ) field on true
   left join public.team_members operator on operator.id=field.assigned_to
   where i.archived_at is null and not coalesce(i.is_practice,false) and not coalesce(i.is_historical,false)
     and i.status::text not in ('resolved','closed','cancelled','canceled')
  )
  select jsonb_build_object(
   'total',(select count(*) from queue),
   'counts',coalesce((select jsonb_object_agg(state,n) from (select state,count(*) n from queue group by state) g),'{}'::jsonb),
   'rows',coalesce((select jsonb_agg(to_jsonb(q)-'sort_priority' order by q.sort_priority,q.since nulls last,q.id)
     from (select * from queue order by sort_priority,since nulls last,id limit 25 offset p_offset) q),'[]'::jsonb)
  ) into payload;

 else
  with queue as (
   select p.id,p.full_name as title,null::text as context,p.full_name as person,
     case when exists(select 1 from public.push_subscriptions s where s.user_id=p.id and s.is_active)
       then 'device_registered' else 'no_device' end as state,
     null::timestamptz as since,null::timestamptz as due_at,
     '/team/'||tm.id::text as href,
     case when exists(select 1 from public.push_subscriptions s where s.user_id=p.id and s.is_active) then 2 else 1 end as sort_priority
   from public.profiles p join public.team_members tm on tm.id=p.team_member_id
   where p.active_status='active' and tm.active_status='active' and tm.active is not false
     and (tm.auth_user_id is null or tm.auth_user_id=p.id)
     and (public.snacky_profile_has_any_role(p.roles,p.role,array['operator','warehouse','purchasing','crm'])
       or public.snacky_profile_has_any_role(tm.roles,tm.role,array['operator','warehouse','purchasing','crm']))
  )
  select jsonb_build_object(
   'total',(select count(*) from queue),
   'counts',coalesce((select jsonb_object_agg(state,n) from (select state,count(*) n from queue group by state) g),'{}'::jsonb),
   'rows',coalesce((select jsonb_agg(to_jsonb(q)-'sort_priority' order by q.sort_priority,q.title,q.id)
     from (select * from queue order by sort_priority,title,id limit 25 offset p_offset) q),'[]'::jsonb),
   'diagnostics',jsonb_build_object(
      'notifications_enabled',(select enabled from snacky_notice_private.settings where singleton),
      'escalation_enabled',(select enabled from snacky_notice_private.dispatch_escalation_settings where singleton),
      'last_scan_at',(select last_scan_at from snacky_notice_private.dispatch_escalation_settings where singleton))
  ) into payload;
 end if;
 return payload||jsonb_build_object('version',1,'section',p_section,'checked_at',now(),'offset',p_offset,'page_size',25);
end;
$$;
revoke all on function owner_operations_private.section(text,integer) from public,anon,authenticated;
grant usage on schema owner_operations_private to authenticated;
grant execute on function owner_operations_private.section(text,integer) to authenticated;
create or replace function public.snacky_owner_operations_section_v1(p_section text,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$ select owner_operations_private.section(p_section,p_offset); $$;
revoke all on function public.snacky_owner_operations_section_v1(text,integer) from public,anon;
grant execute on function public.snacky_owner_operations_section_v1(text,integer) to authenticated;
select pg_notify('pgrst','reload schema');
commit;
