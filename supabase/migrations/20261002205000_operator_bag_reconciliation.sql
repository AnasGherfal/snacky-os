-- Operator-bag physical-count reconciliation for Data Health.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table if not exists data_health_private.operator_bag_reconciliation_receipts(
  request_id uuid primary key,
  case_id uuid not null references data_health_private.inventory_cases(id) on delete cascade,
  operator_id uuid not null references public.team_members(id),
  product_id uuid not null references public.products(id),
  counted_qty integer not null check(counted_qty>=0),
  before_qty integer not null,
  correction_qty integer not null check(correction_qty>0),
  movement_id uuid not null references public.inventory_movements(id),
  reason text not null,
  created_by uuid not null references public.team_members(id),
  created_at timestamptz not null default now()
);
alter table data_health_private.operator_bag_reconciliation_receipts enable row level security;
revoke all on data_health_private.operator_bag_reconciliation_receipts from public,anon,authenticated;
grant all on data_health_private.operator_bag_reconciliation_receipts to service_role;

CREATE OR REPLACE FUNCTION data_health_private.reconcile_operator_bag(p_request_id uuid, p_case_id uuid, p_counted_qty integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me uuid:=public.snacky_current_team_member_id();
  v_reason text:=nullif(pg_catalog.btrim(coalesce(p_reason,'')),'');
  c data_health_private.inventory_cases%rowtype;
  existing data_health_private.operator_bag_reconciliation_receipts%rowtype;
  before_qty bigint:=0;
  after_qty bigint:=0;
  correction integer;
  movement_id uuid;
begin
  if auth.uid() is null or me is null then
    raise exception 'Active staff access required' using errcode='42501';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner','admin']) then
    raise exception 'Owner or admin access required' using errcode='42501';
  end if;
  if p_request_id is null or p_case_id is null then
    raise exception 'Request and inventory case are required' using errcode='22023';
  end if;
  if p_counted_qty is null or p_counted_qty<0 or p_counted_qty>100000 then
    raise exception 'Verified physical count must be a non-negative whole number' using errcode='22023';
  end if;
  if v_reason is null or length(v_reason)<3 or length(v_reason)>1000 then
    raise exception 'A reconciliation reason between 3 and 1000 characters is required' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('snacky:data-health:bag:'||p_case_id::text,0));

  select * into existing
  from data_health_private.operator_bag_reconciliation_receipts
  where request_id=p_request_id
  for update;
  if found then
    if existing.case_id is distinct from p_case_id
      or existing.counted_qty is distinct from p_counted_qty
      or existing.reason is distinct from v_reason
    then
      raise exception 'This request id was already used for another reconciliation' using errcode='23505';
    end if;
    return jsonb_build_object(
      'ok',true,'already_applied',true,'request_id',existing.request_id,
      'case_id',existing.case_id,'before_qty',existing.before_qty,
      'counted_qty',existing.counted_qty,'correction_qty',existing.correction_qty,
      'movement_id',existing.movement_id
    );
  end if;

  select * into c
  from data_health_private.inventory_cases
  where id=p_case_id
  for update;
  if not found then raise exception 'Inventory health case not found' using errcode='P0002';end if;
  if c.status<>'open' then raise exception 'Inventory health case is already closed' using errcode='23514';end if;
  if c.location_type<>'operator_bag' or c.location_id is null then
    raise exception 'This workflow only reconciles operator-bag inventory cases' using errcode='23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('snacky:operator-custody:'||c.location_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('snacky:operator-bag:'||c.location_id::text||':'||c.product_id::text,0));

  select coalesce(sum(delta),0)::bigint into before_qty
  from (
    select m.quantity::bigint delta
    from public.inventory_movements m
    where m.product_id=c.product_id
      and m.to_entity_type='operator_bag'::public.inventory_entity_type
      and m.to_entity_id=c.location_id
    union all
    select -m.quantity::bigint
    from public.inventory_movements m
    where m.product_id=c.product_id
      and m.from_entity_type='operator_bag'::public.inventory_entity_type
      and m.from_entity_id=c.location_id
  ) legs;

  if before_qty>=0 then
    raise exception 'Operator-bag ledger is no longer negative. Refresh the case before reconciling.' using errcode='23514';
  end if;

  correction:=p_counted_qty-before_qty::integer;
  if correction<=0 then
    raise exception 'Verified count must improve the current negative balance' using errcode='23514';
  end if;

  insert into public.inventory_movements(
    product_id,quantity,
    from_entity_type,from_entity_id,
    to_entity_type,to_entity_id,
    reason,
    source_type,source_id,
    idempotency_key,idempotency_payload,
    created_by,notes
  ) values(
    c.product_id,correction,
    'adjustment'::public.inventory_entity_type,null,
    'operator_bag'::public.inventory_entity_type,c.location_id,
    'stock_count_adjustment'::public.movement_reason,
    'data_health_operator_bag_reconciliation',c.id,
    'data-health:operator-bag:'||p_request_id::text,
    jsonb_build_object(
      'case_id',c.id,'operator_id',c.location_id,'product_id',c.product_id,
      'before_qty',before_qty,'physical_count',p_counted_qty,'correction_qty',correction,
      'reason',v_reason
    ),
    me,
    'Operator bag physical-count reconciliation: '||v_reason
  )
  returning id into movement_id;

  select coalesce(sum(delta),0)::bigint into after_qty
  from (
    select m.quantity::bigint delta
    from public.inventory_movements m
    where m.product_id=c.product_id
      and m.to_entity_type='operator_bag'::public.inventory_entity_type
      and m.to_entity_id=c.location_id
    union all
    select -m.quantity::bigint
    from public.inventory_movements m
    where m.product_id=c.product_id
      and m.from_entity_type='operator_bag'::public.inventory_entity_type
      and m.from_entity_id=c.location_id
  ) legs;

  if after_qty<>p_counted_qty then
    raise exception 'Reconciliation did not produce the verified physical balance' using errcode='23514';
  end if;

  insert into data_health_private.operator_bag_reconciliation_receipts(
    request_id,case_id,operator_id,product_id,counted_qty,before_qty,correction_qty,movement_id,reason,created_by
  ) values(
    p_request_id,c.id,c.location_id,c.product_id,p_counted_qty,before_qty::integer,correction,movement_id,v_reason,me
  );

  update data_health_private.inventory_cases
  set observed_quantity=after_qty,status='resolved',last_seen_at=clock_timestamp(),
      resolved_at=clock_timestamp(),resolved_by=me,
      resolution_note='Operator bag physical count set to '||p_counted_qty::text||'. '||v_reason
  where id=c.id;

  return jsonb_build_object(
    'ok',true,'already_applied',false,'request_id',p_request_id,
    'case_id',c.id,'before_qty',before_qty,'counted_qty',p_counted_qty,
    'correction_qty',correction,'movement_id',movement_id
  );
end
$function$;
revoke all on function data_health_private.reconcile_operator_bag(uuid,uuid,integer,text) from public,anon;
grant execute on function data_health_private.reconcile_operator_bag(uuid,uuid,integer,text) to authenticated,service_role;

CREATE OR REPLACE FUNCTION public.snacky_data_health_operator_bag_reconcile_v1(p_request_id uuid, p_case_id uuid, p_counted_qty integer, p_reason text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select data_health_private.reconcile_operator_bag(p_request_id,p_case_id,p_counted_qty,p_reason);
$function$;
revoke all on function public.snacky_data_health_operator_bag_reconcile_v1(uuid,uuid,integer,text) from public,anon;
grant execute on function public.snacky_data_health_operator_bag_reconcile_v1(uuid,uuid,integer,text) to authenticated,service_role;

select pg_notify('pgrst','reload schema');
commit;
