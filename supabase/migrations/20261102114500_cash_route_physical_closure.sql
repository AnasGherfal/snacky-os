-- Cash custody closure for route-linked pilot collections.
-- This closes only physical custody after independent receipt/count, not XY reconciliation.
create table if not exists public.cash_route_closures (
  route_id uuid primary key references public.routes(id) on delete restrict,
  closed_by uuid not null references public.team_members(id) on delete restrict,
  closed_by_user_id uuid not null,
  closed_at timestamptz not null default now(),
  closure_status text not null check (closure_status in ('physically_verified','closed_with_exceptions')),
  counted_bags integer not null check (counted_bags >= 0),
  exception_stops integer not null check (exception_stops >= 0),
  total_counted_lyd numeric(14,2) not null check (total_counted_lyd >= 0),
  owner_note text,
  created_at timestamptz not null default now()
);
alter table public.cash_route_closures enable row level security;
revoke all on table public.cash_route_closures from public, anon, authenticated;

create or replace function public.snacky_close_route_cash_v1(p_route_id uuid, p_owner_note text default null)
returns jsonb
language plpgsql security definer
set search_path to pg_catalog, public, auth, snacky_private
as $cash_route$
declare
  v_user uuid := auth.uid();
  v_actor uuid := public.snacky_current_team_member_id();
  v_route record;
  v_policy record;
  v_expected integer;
  v_bag_count integer;
  v_exception_count integer;
  v_total numeric(14,2);
  v_status text;
  v_saved public.cash_route_closures%rowtype;
  v_note text := nullif(btrim(coalesce(p_owner_note,'')),'');
begin
  if v_user is null or v_actor is null
    or not public.snacky_current_profile_has_any_role(array['owner','admin'])
    or not exists(select 1 from public.profiles p where p.id=v_user and p.active_status='active' and p.team_member_id=v_actor)
  then
    raise exception 'Only an active owner or admin can close route cash custody' using errcode='42501';
  end if;
  if p_route_id is null then raise exception 'A route is required' using errcode='22023'; end if;
  if length(coalesce(v_note,''))>1500 then raise exception 'Owner note is too long' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('route-cash-close:'||p_route_id::text,0));
  select * into v_saved from public.cash_route_closures where route_id=p_route_id;
  if found then
    return jsonb_build_object('route_id',v_saved.route_id,'closure_status',v_saved.closure_status,
      'counted_bags',v_saved.counted_bags,'exception_stops',v_saved.exception_stops,
      'total_counted_lyd',v_saved.total_counted_lyd,'closed_at',v_saved.closed_at,'replayed',true);
  end if;
  select r.id,r.status into v_route from public.routes r where r.id=p_route_id for update;
  if not found or v_route.status::text <> 'completed' then
    raise exception 'Route must be completed before physical cash close' using errcode='23514';
  end if;
  select enabled,pilot_machine_ids into v_policy from public.cash_refill_policy where id=1;
  if not coalesce(v_policy.enabled,false) or coalesce(cardinality(v_policy.pilot_machine_ids),0)=0 then
    raise exception 'Cash close is available only for an active selected-machine pilot' using errcode='23514';
  end if;
  select count(*) into v_expected from public.route_stops s
    where s.route_id=p_route_id and s.status::text='completed'
      and s.machine_id=any(v_policy.pilot_machine_ids);
  if v_expected=0 then raise exception 'No completed pilot machine on this route' using errcode='23514'; end if;
  if exists(
    select 1 from public.route_stops s
    where s.route_id=p_route_id and s.status::text='completed'
      and s.machine_id=any(v_policy.pilot_machine_ids)
      and not exists(select 1 from public.route_stop_cash_receipts x
        where x.route_stop_id=s.id and x.route_id=p_route_id and x.machine_id=s.machine_id
          and x.state in ('collected','exception'))
  ) then
    raise exception 'Every completed pilot stop needs cash collection or a documented exception'
      using errcode='23514';
  end if;
  if exists(
    select 1 from public.route_stop_cash_receipts x
    left join public.cash_collections c on c.id=x.collection_id
    left join snacky_private.cash_handovers h on h.collection_id=x.collection_id
    where x.route_id=p_route_id and x.machine_id=any(v_policy.pilot_machine_ids)
      and (x.state='pending'
        or (x.state='collected' and (
          c.id is null or c.route_id is distinct from p_route_id or c.machine_id is distinct from x.machine_id
          or c.operator_id is distinct from x.operator_id
          or c.custody_status not in ('counted','reconciled')
          or c.actual_cash_collected is null or c.counted_at is null or c.counted_by is null
          or c.voided_at is not null
          or c.counted_by=c.operator_id
          or coalesce(c.storage_seal_condition,'')<>'intact'
          or coalesce(c.count_seal_condition,'')<>'intact'
          or h.collection_id is null or h.deposited_at is null or h.picked_up_at is null
          or h.deposited_by is null or h.picked_up_by is null
          or h.deposited_by=h.picked_up_by
          or coalesce(h.pickup_seal,'')<>'intact'
        ))))
  ) then
    raise exception 'One or more bags are not independently received and counted with intact seals'
      using errcode='23514';
  end if;
  select count(*) filter(where x.state='collected'),
    count(*) filter(where x.state='exception'),
    coalesce(sum(c.actual_cash_collected) filter(where x.state='collected'),0)
    into v_bag_count,v_exception_count,v_total
  from public.route_stop_cash_receipts x
  left join public.cash_collections c on c.id=x.collection_id
  where x.route_id=p_route_id and x.machine_id=any(v_policy.pilot_machine_ids);
  if v_bag_count+v_exception_count <> v_expected then
    raise exception 'Pilot cash records are inconsistent with the completed route stops' using errcode='23514';
  end if;
  if v_exception_count>0 and length(coalesce(v_note,''))<15 then
    raise exception 'Explain all collection exceptions before closing this route' using errcode='22023';
  end if;
  v_status:=case when v_exception_count>0 then 'closed_with_exceptions' else 'physically_verified' end;
  insert into public.cash_route_closures(
    route_id,closed_by,closed_by_user_id,closure_status,
    counted_bags,exception_stops,total_counted_lyd,owner_note
  ) values(
    p_route_id,v_actor,v_user,v_status,v_bag_count,v_exception_count,round(v_total,2),v_note
  );
  return jsonb_build_object('route_id',p_route_id,'closure_status',v_status,
    'counted_bags',v_bag_count,'exception_stops',v_exception_count,
    'total_counted_lyd',round(v_total,2),'closed_at',now(),
    'xy_reconciliation','separate_unverified_until_exact_cash_transactions','replayed',false);
end
$cash_route$;
revoke all on function public.snacky_close_route_cash_v1(uuid,text) from public,anon;
grant execute on function public.snacky_close_route_cash_v1(uuid,text) to authenticated;
