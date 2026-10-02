-- Bulk-safe Data Health cleanup actions.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

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
  if p_action not in (
    'scan_negative_inventory','cancel_stale_refill','archive_vms_batch',
    'classify_legacy_cash','unclassify_legacy_cash','resolve_inventory_case',
    'bulk_cancel_stale_refills','bulk_archive_vms_batches'
  ) then
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

  elsif p_action='bulk_cancel_stale_refills' then
    if reason_text is null or length(reason_text)<3 or length(reason_text)>1000 then
      raise exception 'Bulk cancellation reason is required' using errcode='22023';
    end if;
    with safe as (
      select r.id
      from public.refill_orders r
      left join public.routes rt on rt.id=r.route_id
      where r.status::text in ('draft','assigned')
        and r.generated_at<clock_timestamp()-interval '48 hours'
        and not exists(select 1 from public.inventory_movements m where m.related_refill_order_id=r.id)
        and (r.route_id is null or rt.status::text in ('completed','cancelled'))
      order by r.generated_at
      for update of r
    )
    update public.refill_orders r
    set status='cancelled',
        notes=concat_ws(' | ',nullif(r.notes,''),'Data Health bulk cancellation: '||reason_text)
    where r.id in (select id from safe);
    get diagnostics changed=row_count;
    return jsonb_build_object('ok',true,'action',p_action,'cancelled',changed);

  elsif p_action='bulk_archive_vms_batches' then
    if reason_text is null or length(reason_text)<3 or length(reason_text)>1000 then
      raise exception 'Bulk archive reason is required' using errcode='22023';
    end if;
    update public.vms_import_batches b
    set deleted_at=clock_timestamp(),deleted_by=me,delete_reason=reason_text,is_active=false,updated_at=clock_timestamp()
    where b.deleted_at is null
      and b.uploaded_at<clock_timestamp()-interval '14 days'
      and b.status in ('draft','previewed','failed')
      and coalesce(b.rows_imported,0)=0
      and not coalesce(b.is_active,false);
    get diagnostics changed=row_count;
    return jsonb_build_object('ok',true,'action',p_action,'archived',changed);

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

select pg_notify('pgrst','reload schema');
commit;
