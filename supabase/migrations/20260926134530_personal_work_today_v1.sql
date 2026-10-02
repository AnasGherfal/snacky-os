-- CLI-generated identity. Read-only personal projections; no business tables or writers.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema if not exists personal_work_private;
revoke all on schema personal_work_private from public,anon;

create function personal_work_private.section(p_section text,p_view text default 'active',p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
 actor uuid:=auth.uid(); member_id uuid; payload jsonb; supported boolean:=true;
 today date:=(now() at time zone 'Africa/Tripoli')::date; is_counter boolean;
begin
 if actor is null or not coalesce(public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','warehouse','purchasing']),false) then
  raise exception 'Active operational staff required' using errcode='42501';
 end if;
 select p.team_member_id into member_id from public.profiles p join public.team_members t on t.id=p.team_member_id
 where p.id=actor and p.active_status='active' and t.active_status='active' and t.active is true
   and (t.auth_user_id is null or t.auth_user_id=actor);
 if member_id is null then raise exception 'Active linked staff account required' using errcode='42501';end if;
 if p_section is null or p_section not in ('cash','buying','storage','stocktakes') or p_view is null
   or p_view not in ('active','upcoming','history') or p_offset is null or p_offset<0 or p_offset>100000 or p_offset%5<>0 then
  raise exception 'Invalid personal work filter' using errcode='22023';end if;
 -- Match existing destination permissions. This page never broadens access to a workflow.
 if p_section='storage' then supported:=public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing']);
 elsif p_section='stocktakes' then supported:=public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse']);
 end if;
 if not coalesce(supported,false) then
  return jsonb_build_object('version',1,'section',p_section,'view',p_view,'offset',p_offset,'page_size',5,'status','restricted','checked_at',now());
 end if;

 if p_section='cash' then
  is_counter:=snacky_private.cash_handover_counter_v1(actor);
  with scoped as (
   select c.id,c.cash_bag_id as title,coalesce(h.storage_location,c.storage_location,m.name) as context,
    case when c.voided_at is not null or c.custody_status='voided' then 'cash_voided'
      when c.actual_cash_collected is not null then 'cash_done'
      when h.stage='picked_up' and h.assigned_to=actor and h.picked_up_by=actor and is_counter then 'cash_count'
      when c.custody_status='in_storage' and h.assigned_to=actor and h.stage in ('assigned','dropped') and is_counter then 'cash_pickup'
      when c.custody_status='removed' and c.operator_id=member_id and coalesce(h.stage,'assigned')='assigned'
        and ((select enabled from snacky_private.cash_handover_settings where singleton) or h.collection_id is not null) then 'cash_dropoff'
      when c.custody_status='removed' and h.assigned_to=actor and c.operator_id<>member_id then 'cash_wait_dropoff'
      else 'cash_wait_counter' end as state,
    case when c.actual_cash_collected is not null or c.voided_at is not null or c.custody_status='voided' then 'history' else 'active' end as bucket,
    coalesce(c.counted_at,c.voided_at,h.picked_up_at,h.deposited_at,c.collected_at) as since,
    null::timestamptz as due_at,null::bigint as done,null::bigint as total
   from public.cash_collections c left join snacky_private.cash_handovers h on h.collection_id=c.id
   left join public.machines m on m.id=c.machine_id
   where (c.operator_id=member_id or (is_counter and h.assigned_to=actor))
    and coalesce(c.cash_bag_id,'') ~ '[^[:space:]]' and c.custody_status<>'pending_collection'
    and (h.collection_id is not null or (c.actual_cash_collected is null and c.voided_at is null and c.custody_status in ('removed','in_storage')))
  ), ranked as (
   select *,id as target_id,case state when 'cash_count' then 1 when 'cash_pickup' then 2 when 'cash_dropoff' then 3 else 9 end as rank,
     state in ('cash_count','cash_pickup','cash_dropoff') as actionable from scoped
  ), page as (select * from ranked where bucket=p_view order by rank,
    case when p_view='history' then since end desc nulls last,case when p_view<>'history' then since end nulls last,id limit 5 offset p_offset)
  select jsonb_build_object('totals',jsonb_build_object('active',(select count(*) from ranked where bucket='active'),'upcoming',0,'history',(select count(*) from ranked where bucket='history')),
   'total',(select count(*) from ranked where bucket=p_view),'actions',(select count(*) from ranked where bucket=p_view and actionable),
   'rows',coalesce((select jsonb_agg(to_jsonb(page)-'bucket' order by rank,case when p_view='history' then since end desc nulls last,case when p_view<>'history' then since end nulls last,id) from page),'[]'::jsonb)) into payload;

 elsif p_section='buying' then
  if buying_private.member() is distinct from member_id then raise exception 'Buying access changed' using errcode='42501';end if;
  with scoped as (
   select l.id,l.id as target_id,l.title,
    (select string_agg(distinct nullif(s.primary_store->>'name',''),' · ') from buying_private.sources s where s.list_id=l.id) as context,
    l.status,l.due_on,coalesce(l.updated_at,l.created_at) as since,
    (select count(*) from buying_private.items i where i.list_id=l.id and i.outcome<>'pending') as done,
    (select count(*) from buying_private.items i where i.list_id=l.id) as total,
    exists(select 1 from buying_private.items i where i.list_id=l.id and i.outcome<>'pending') as started,
    buying_private.purchase_access(l.id,true) and exists(select 1 from buying_private.items i where i.list_id=l.id and i.outcome in ('bought','partial')
      and i.bought_boxes*i.units_per_box>buying_private.invoiced_units(l.id,i.product_id)) as needs_receipt
   from buying_private.lists l where l.assigned_to=member_id
  ), ranked as (
   select id,target_id,title,context,since,done,total,
    case when status='cancelled' then 'buying_cancelled' when needs_receipt then 'buying_receipt' when status='completed' then 'buying_done' else 'buying_shop' end as state,
    case when status='cancelled' or (status='completed' and not needs_receipt) then 'history'
      when due_on>today and not started then 'upcoming' else 'active' end as bucket,
    ((due_on+1)::timestamp at time zone 'Africa/Tripoli') as due_at,
    case when status='cancelled' or (status='completed' and not needs_receipt) then 9 when due_on<today then 0 else 4 end as rank,status<>'cancelled' and (status='open' or needs_receipt) as actionable
   from scoped
  ), page as (select * from ranked where bucket=p_view order by rank,case when p_view<>'history' then due_at end,
    case when p_view='history' then since end desc nulls last,id limit 5 offset p_offset)
  select jsonb_build_object('totals',jsonb_build_object('active',(select count(*) from ranked where bucket='active'),'upcoming',(select count(*) from ranked where bucket='upcoming'),'history',(select count(*) from ranked where bucket='history')),
   'total',(select count(*) from ranked where bucket=p_view),'actions',(select count(*) from ranked where bucket=p_view and actionable),
   'rows',coalesce((select jsonb_agg(to_jsonb(page)-'bucket' order by rank,case when p_view<>'history' then due_at end,case when p_view='history' then since end desc nulls last,id) from page),'[]'::jsonb)) into payload;

 elsif p_section='storage' then
  with ranked as (
   select po.id,l.id as target_id,coalesce(nullif(po.receipt_number,''),l.title) as title,s.name as context,
    case when po.status in ('cancelled','voided') or po.voided_at is not null or link.retired_at is not null then 'storage_cancelled'
      when po.received_at is not null or po.status='received' then 'storage_done' when l.status='cancelled' or po.status<>'draft' then 'storage_review' else 'storage_place' end as state,
    case when po.status='draft' and po.received_at is null and po.voided_at is null and link.retired_at is null then 'active' else 'history' end as bucket,
    coalesce(po.received_at,link.retired_at,po.voided_at,link.created_at) as since,
    null::timestamptz as due_at,null::bigint as done,null::bigint as total,2 as rank,
    po.status='draft' and po.received_at is null and po.voided_at is null and link.retired_at is null and l.status<>'cancelled' as actionable
   from buying_private.purchase_links link join public.purchase_orders po on po.id=link.purchase_id
   join buying_private.lists l on l.id=link.list_id left join public.suppliers s on s.id=po.supplier_id
   where l.assigned_to=member_id and link.buyer_id=member_id and buying_private.purchase_access(l.id,false)
  ), page as (select * from ranked where bucket=p_view order by case when p_view='history' then since end desc nulls last,
    case when p_view<>'history' then since end nulls last,id limit 5 offset p_offset)
  select jsonb_build_object('totals',jsonb_build_object('active',(select count(*) from ranked where bucket='active'),'upcoming',0,'history',(select count(*) from ranked where bucket='history')),
   'total',(select count(*) from ranked where bucket=p_view),'actions',(select count(*) from ranked where bucket=p_view and actionable),
   'rows',coalesce((select jsonb_agg(to_jsonb(page)-'bucket' order by case when p_view='history' then since end desc nulls last,case when p_view<>'history' then since end nulls last,id) from page),'[]'::jsonb)) into payload;

 else
  with ranked as (
   select a.id,a.id as target_id,a.title,s.name as context,
    case a.status when 'submitted' then 'stock_wait_review' when 'needs_recount' then 'stock_recount' when 'approved' then 'stock_done' when 'cancelled' then 'stock_cancelled' else 'stock_count' end as state,
    case when a.status in ('approved','cancelled') then 'history' when a.status='assigned' and a.due_on>today then 'upcoming' else 'active' end as bucket,
    coalesce(a.approved_at,a.cancelled_at,a.submitted_at,a.created_at) as since,
    ((a.due_on+1)::timestamp at time zone 'Africa/Tripoli') as due_at,
    (select count(*) from stocktake_private.lines line where line.assignment_id=a.id and line.counted_qty is not null) as done,
    (select count(*) from stocktake_private.lines line where line.assignment_id=a.id) as total,
    case when a.status in ('submitted','approved','cancelled') then 9 when a.due_on<today then 0 else 5 end as rank,
    a.status in ('assigned','counting','needs_recount') as actionable
   from stocktake_private.assignments a left join public.storage_locations s on s.id=a.storage_location_id
   where a.assigned_to=actor
  ), page as (select * from ranked where bucket=p_view order by rank,case when p_view<>'history' then due_at end nulls last,
    case when p_view='history' then since end desc nulls last,id limit 5 offset p_offset)
  select jsonb_build_object('totals',jsonb_build_object('active',(select count(*) from ranked where bucket='active'),'upcoming',(select count(*) from ranked where bucket='upcoming'),'history',(select count(*) from ranked where bucket='history')),
   'total',(select count(*) from ranked where bucket=p_view),'actions',(select count(*) from ranked where bucket=p_view and actionable),
   'rows',coalesce((select jsonb_agg(to_jsonb(page)-'bucket' order by rank,case when p_view<>'history' then due_at end nulls last,case when p_view='history' then since end desc nulls last,id) from page),'[]'::jsonb)) into payload;
 end if;
 return payload||jsonb_build_object('version',1,'section',p_section,'view',p_view,'offset',p_offset,'page_size',5,'status','ready','checked_at',now());
end;
$$;
revoke all on function personal_work_private.section(text,text,integer) from public,anon,authenticated;
grant usage on schema personal_work_private to authenticated;
grant execute on function personal_work_private.section(text,text,integer) to authenticated;
create function public.snacky_personal_work_section_v1(p_section text,p_view text default 'active',p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path=''
as $$select personal_work_private.section(p_section,p_view,p_offset);$$;
revoke all on function public.snacky_personal_work_section_v1(text,text,integer) from public,anon;
grant execute on function public.snacky_personal_work_section_v1(text,text,integer) to authenticated;
select pg_notify('pgrst','reload schema');
commit;
