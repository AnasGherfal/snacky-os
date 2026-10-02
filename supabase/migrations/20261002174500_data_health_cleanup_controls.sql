-- Data Health cleanup controls. Classification and archival are intentionally non-destructive.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create schema if not exists data_health_private;
revoke all on schema data_health_private from public,anon;
grant usage on schema data_health_private to authenticated,service_role;

create table if not exists data_health_private.cash_classifications(
  cash_collection_id uuid primary key references public.cash_collections(id) on delete cascade,
  classification text not null check(classification in ('legacy_backlog')),
  reason text not null,
  classified_by uuid not null references public.team_members(id),
  classified_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table data_health_private.cash_classifications enable row level security;
revoke all on data_health_private.cash_classifications from public,anon,authenticated;
grant all on data_health_private.cash_classifications to service_role;

create table if not exists data_health_private.inventory_cases(
  id uuid primary key default gen_random_uuid(),
  location_key text not null,
  location_type text not null,
  location_id uuid,
  location_name text,
  product_id uuid not null references public.products(id),
  product_name text,
  observed_quantity numeric not null,
  status text not null default 'open' check(status in ('open','resolved')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.team_members(id),
  resolution_note text,
  unique(location_key,product_id)
);
alter table data_health_private.inventory_cases enable row level security;
revoke all on data_health_private.inventory_cases from public,anon,authenticated;
grant all on data_health_private.inventory_cases to service_role;

CREATE OR REPLACE FUNCTION data_health_private.command(p_action text, p_target_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  me uuid:=public.snacky_current_team_member_id();
  reason_text text:=nullif(pg_catalog.btrim(coalesce(p_reason,'')),'');
  refill public.refill_orders%rowtype;
  route_status text;
  batch public.vms_import_batches%rowtype;
  cash public.cash_collections%rowtype;
  changed integer:=0;
  case_row data_health_private.inventory_cases%rowtype;
  current_qty numeric;
begin
  if auth.uid() is null or me is null then
    raise exception 'Active staff access required' using errcode='42501';
  end if;
  if not public.snacky_current_profile_has_any_role(array['owner','admin']) then
    raise exception 'Owner or admin access required' using errcode='42501';
  end if;
  if p_action not in ('scan_negative_inventory','cancel_stale_refill','archive_vms_batch','classify_legacy_cash','unclassify_legacy_cash','resolve_inventory_case') then
    raise exception 'Unsupported data health action' using errcode='22023';
  end if;

  if p_action='scan_negative_inventory' then
    insert into data_health_private.inventory_cases(
      location_key,location_type,location_id,location_name,product_id,product_name,
      observed_quantity,status,first_seen_at,last_seen_at,resolved_at,resolved_by,resolution_note
    )
    select
      coalesce(i.location_type,'unknown')||':'||coalesce(i.location_id::text,i.location_name,'unknown'),
      coalesce(i.location_type,'unknown'),i.location_id,i.location_name,i.product_id,i.product_name,
      i.quantity_on_hand,'open',clock_timestamp(),clock_timestamp(),null,null,null
    from public.current_inventory_by_location i
    where i.quantity_on_hand<0
    on conflict(location_key,product_id) do update
      set location_type=excluded.location_type,
          location_id=excluded.location_id,
          location_name=excluded.location_name,
          product_name=excluded.product_name,
          observed_quantity=excluded.observed_quantity,
          status='open',
          last_seen_at=clock_timestamp(),
          resolved_at=null,
          resolved_by=null,
          resolution_note=null;
    get diagnostics changed=row_count;
    return jsonb_build_object('ok',true,'action',p_action,'negative_cases_seen',changed);

  elsif p_action='cancel_stale_refill' then
    if p_target_id is null or reason_text is null or length(reason_text)<3 or length(reason_text)>1000 then
      raise exception 'Refill and cancellation reason are required' using errcode='22023';
    end if;
    select * into refill from public.refill_orders where id=p_target_id for update;
    if not found then raise exception 'Refill order not found' using errcode='P0002';end if;
    if refill.status::text not in ('draft','assigned') then
      raise exception 'Only draft or assigned refill orders can be safely cancelled here' using errcode='23514';
    end if;
    if refill.generated_at>=clock_timestamp()-interval '48 hours' then
      raise exception 'Only refill orders older than 48 hours can be cancelled from Data Health' using errcode='23514';
    end if;
    if exists(select 1 from public.inventory_movements m where m.related_refill_order_id=refill.id) then
      raise exception 'This refill has inventory movements and must be reviewed manually' using errcode='23514';
    end if;
    if refill.route_id is not null then
      select r.status::text into route_status from public.routes r where r.id=refill.route_id;
      if route_status is null or route_status not in ('completed','cancelled') then
        raise exception 'This refill belongs to an active or unknown route and cannot be cancelled here' using errcode='23514';
      end if;
    end if;
    update public.refill_orders
    set status='cancelled',
        notes=concat_ws(' | ',nullif(notes,''),'Data Health cancellation: '||reason_text)
    where id=refill.id;
    return jsonb_build_object('ok',true,'action',p_action,'refill_order_id',refill.id);

  elsif p_action='archive_vms_batch' then
    if p_target_id is null or reason_text is null or length(reason_text)<3 or length(reason_text)>1000 then
      raise exception 'VMS batch and archive reason are required' using errcode='22023';
    end if;
    select * into batch from public.vms_import_batches where id=p_target_id for update;
    if not found then raise exception 'VMS batch not found' using errcode='P0002';end if;
    if batch.deleted_at is not null then
      return jsonb_build_object('ok',true,'action',p_action,'batch_id',batch.id,'already_archived',true);
    end if;
    if batch.uploaded_at>=clock_timestamp()-interval '14 days'
      or batch.status not in ('draft','previewed','failed')
      or coalesce(batch.rows_imported,0)<>0
      or coalesce(batch.is_active,false)
    then
      raise exception 'Only old inactive zero-import draft, previewed, or failed batches can be archived here' using errcode='23514';
    end if;
    update public.vms_import_batches
    set deleted_at=clock_timestamp(),deleted_by=me,delete_reason=reason_text,is_active=false,updated_at=clock_timestamp()
    where id=batch.id;
    return jsonb_build_object('ok',true,'action',p_action,'batch_id',batch.id);

  elsif p_action='classify_legacy_cash' then
    if p_target_id is null or reason_text is null or length(reason_text)<3 or length(reason_text)>1000 then
      raise exception 'Cash collection and classification reason are required' using errcode='22023';
    end if;
    select * into cash from public.cash_collections where id=p_target_id for share;
    if not found or cash.voided_at is not null then raise exception 'Cash collection unavailable' using errcode='23514';end if;
    if cash.collected_at>=clock_timestamp()-interval '30 days'
      or cash.reconciliation_status not in ('pending','variance_review')
    then
      raise exception 'Only unresolved cash older than 30 days can be classified as legacy backlog' using errcode='23514';
    end if;
    insert into data_health_private.cash_classifications(cash_collection_id,classification,reason,classified_by)
    values(cash.id,'legacy_backlog',reason_text,me)
    on conflict(cash_collection_id) do update
      set classification='legacy_backlog',reason=excluded.reason,classified_by=excluded.classified_by,
          classified_at=clock_timestamp(),updated_at=clock_timestamp();
    return jsonb_build_object('ok',true,'action',p_action,'cash_collection_id',cash.id);

  elsif p_action='unclassify_legacy_cash' then
    if p_target_id is null then raise exception 'Cash collection required' using errcode='22023';end if;
    delete from data_health_private.cash_classifications where cash_collection_id=p_target_id;
    return jsonb_build_object('ok',true,'action',p_action,'cash_collection_id',p_target_id);

  else
    if p_target_id is null or reason_text is null or length(reason_text)<3 or length(reason_text)>1000 then
      raise exception 'Inventory case and resolution note are required' using errcode='22023';
    end if;
    select * into case_row from data_health_private.inventory_cases where id=p_target_id for update;
    if not found then raise exception 'Inventory case not found' using errcode='P0002';end if;

    select i.quantity_on_hand into current_qty
    from public.current_inventory_by_location i
    where i.product_id=case_row.product_id
      and coalesce(i.location_type,'unknown')=case_row.location_type
      and coalesce(i.location_id::text,i.location_name,'unknown')=substring(case_row.location_key from position(':' in case_row.location_key)+1)
    limit 1;

    if coalesce(current_qty,0)<0 then
      raise exception 'Inventory is still negative. Correct the physical/ledger balance before resolving this case.' using errcode='23514';
    end if;

    update data_health_private.inventory_cases
    set status='resolved',resolved_at=clock_timestamp(),resolved_by=me,
        resolution_note=reason_text,last_seen_at=clock_timestamp()
    where id=case_row.id;
    return jsonb_build_object('ok',true,'action',p_action,'inventory_case_id',case_row.id);
  end if;
end
$function$;
revoke all on function data_health_private.command(text,uuid,text) from public,anon;
grant execute on function data_health_private.command(text,uuid,text) to authenticated,service_role;

CREATE OR REPLACE FUNCTION public.snacky_data_health_command_v1(p_action text, p_target_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select data_health_private.command(p_action,p_target_id,p_reason);
$function$;
revoke all on function public.snacky_data_health_command_v1(text,uuid,text) from public,anon;
grant execute on function public.snacky_data_health_command_v1(text,uuid,text) to authenticated,service_role;

CREATE OR REPLACE FUNCTION public.snacky_data_health_workspace_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 me uuid:=public.snacky_current_team_member_id();
 result jsonb;
begin
 if auth.uid() is null or me is null
   or not public.snacky_current_profile_has_any_role(array['owner','admin'])
 then raise exception 'Owner or admin access required' using errcode='42501';end if;

 with current_inventory as (
   select i.product_id,i.product_name,i.location_type,i.location_id,i.location_name,i.quantity_on_hand,
          coalesce(i.location_type,'unknown')||':'||coalesce(i.location_id::text,i.location_name,'unknown') location_key
   from public.current_inventory_by_location i
 ),
 inventory_health as (
   select
     coalesce(ci.product_id,c.product_id) product_id,
     coalesce(ci.product_name,c.product_name) product_name,
     coalesce(ci.location_type,c.location_type) location_type,
     coalesce(ci.location_id,c.location_id) location_id,
     coalesce(ci.location_name,c.location_name) location_name,
     ci.quantity_on_hand current_quantity,
     c.id case_id,c.status case_status,c.first_seen_at,c.last_seen_at,
     (c.id is not null and c.status='open' and coalesce(ci.quantity_on_hand,0)>=0) ready_to_resolve
   from current_inventory ci
   full join data_health_private.inventory_cases c
     on c.location_key=ci.location_key and c.product_id=ci.product_id and c.status='open'
   where coalesce(ci.quantity_on_hand,0)<0 or (c.id is not null and c.status='open')
 ),
 stale_refill as (
   select r.id,r.status::text status,r.generated_at,r.route_id,r.machine_id,
          m.name machine_name,m.machine_code,
          exists(select 1 from public.inventory_movements im where im.related_refill_order_id=r.id) has_movements,
          rt.status::text route_status,
          (r.status::text in ('draft','assigned')
            and r.generated_at<clock_timestamp()-interval '48 hours'
            and not exists(select 1 from public.inventory_movements im where im.related_refill_order_id=r.id)
            and (r.route_id is null or rt.status::text in ('completed','cancelled'))
          ) can_cancel
   from public.refill_orders r
   left join public.machines m on m.id=r.machine_id
   left join public.routes rt on rt.id=r.route_id
   where r.status::text in ('draft','assigned','picked')
     and r.generated_at<clock_timestamp()-interval '48 hours'
 ),
 legacy_cash as (
   select c.id,c.collected_at,c.reconciliation_status,c.review_status,c.custody_status,
          c.actual_cash_collected,c.vms_expected_cash,c.variance,
          cl.classification,cl.reason classification_reason,cl.classified_at
   from public.cash_collections c
   left join data_health_private.cash_classifications cl on cl.cash_collection_id=c.id
   where c.voided_at is null
     and c.collected_at<clock_timestamp()-interval '30 days'
     and c.reconciliation_status in ('pending','variance_review')
 ),
 vms_cleanup as (
   select b.id,b.original_file_name,b.file_name,b.report_type,b.status,b.uploaded_at,b.rows_imported,
          b.error_count,b.rows_needing_review,b.latest_error,
          (b.uploaded_at<clock_timestamp()-interval '14 days'
           and b.status in ('draft','previewed','failed')
           and coalesce(b.rows_imported,0)=0
           and not coalesce(b.is_active,false)
           and b.deleted_at is null
          ) can_archive
   from public.vms_import_batches b
   where b.deleted_at is null
     and (
       (b.status in ('failed','partially_imported','imported_with_warnings') and b.uploaded_at>=clock_timestamp()-interval '30 days')
       or (b.status in ('draft','previewed','failed') and b.uploaded_at<clock_timestamp()-interval '14 days')
     )
 ),
 counts as (
   select jsonb_build_object(
     'negative_inventory',(select count(*)::int from inventory_health where coalesce(current_quantity,0)<0),
     'inventory_ready_to_resolve',(select count(*)::int from inventory_health where ready_to_resolve),
     'stale_refills',(select count(*)::int from stale_refill),
     'safe_refill_cancellations',(select count(*)::int from stale_refill where can_cancel),
     'picked_refill_review',(select count(*)::int from stale_refill where status='picked'),
     'legacy_cash_unclassified',(select count(*)::int from legacy_cash where classification is null),
     'legacy_cash_classified',(select count(*)::int from legacy_cash where classification='legacy_backlog'),
     'vms_cleanup_candidates',(select count(*)::int from vms_cleanup where can_archive),
     'vms_recent_attention',(select count(*)::int from vms_cleanup where status in ('failed','partially_imported','imported_with_warnings') and uploaded_at>=clock_timestamp()-interval '30 days')
   ) value
 )
 select jsonb_build_object(
   'counts',(select value from counts),
   'inventory_health',coalesce((select jsonb_agg(to_jsonb(x) order by coalesce(x.current_quantity,0) asc,x.first_seen_at asc nulls last) from inventory_health x),'[]'::jsonb),
   'stale_refills',coalesce((select jsonb_agg(to_jsonb(x) order by x.generated_at asc) from stale_refill x),'[]'::jsonb),
   'legacy_cash',coalesce((select jsonb_agg(to_jsonb(x) order by x.collected_at asc) from legacy_cash x),'[]'::jsonb),
   'vms_cleanup',coalesce((select jsonb_agg(to_jsonb(x) order by x.uploaded_at asc) from vms_cleanup x),'[]'::jsonb)
 ) into result;
 return result;
end
$function$;
revoke all on function public.snacky_data_health_workspace_v1() from public,anon;
grant execute on function public.snacky_data_health_workspace_v1() to authenticated,service_role;

select pg_notify('pgrst','reload schema');
commit;
