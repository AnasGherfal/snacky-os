\set ON_ERROR_STOP on
-- Migration is intentionally rerunnable.
\i supabase/migrations/20260920101500_expiry_batch_safety.sql

do $$
declare
  unknown_units integer;
  pid uuid;
  good_batch uuid;
  short_batch uuid;
  short_line uuid;
  outbound uuid;
  allocated_batch uuid;
  before_count integer;
begin
 select coalesce(sum(remaining_qty),0) into unknown_units
 from public.snacky_expiry_batch_status
 where product_id='00000000-0000-4000-8000-000000000001' and source_kind='legacy_unknown';
 if unknown_units<>6 then raise exception 'Expected 6 seeded unknown units, got %',unknown_units;end if;

 -- Missing expiry cannot receive, and the wrapper transaction leaves no purchase behind.
 select count(*) into before_count from public.purchase_orders;
 begin
  perform * from public.snacky_create_purchase_with_lines_v3(
   gen_random_uuid(),null,current_date,'MISSING','cash','unpaid',null,null,null,null,null,5,null,0,'calculated',5,null,
   '00000000-0000-4000-8000-000000000011','received',
   jsonb_build_array(jsonb_build_object('line_position',1,'product_id','00000000-0000-4000-8000-000000000001','total_units',5,'unit_cost_lyd',1,'line_total_lyd',5))
  );
  raise exception 'Missing-expiry receipt unexpectedly succeeded';
 exception when check_violation then null; end;
 if (select count(*) from public.purchase_orders)<>before_count then raise exception 'Failed receipt was not atomic';end if;

 begin
  perform * from public.snacky_create_purchase_with_lines_v3(
   gen_random_uuid(),null,current_date,'EXPIRED','cash','unpaid',null,null,null,null,null,5,null,0,'calculated',5,null,
   '00000000-0000-4000-8000-000000000011','received',
   jsonb_build_array(jsonb_build_object('line_position',1,'product_id','00000000-0000-4000-8000-000000000001','total_units',5,'unit_cost_lyd',1,'line_total_lyd',5,'expiry_date',((now() at time zone 'Africa/Tripoli')::date)::text))
  );
  raise exception 'Expired receipt unexpectedly succeeded';
 exception when check_violation then null; end;

 begin
  perform * from public.snacky_create_purchase_with_lines_v3(
   gen_random_uuid(),null,current_date,'SHORT-NO','cash','unpaid',null,null,null,null,null,5,null,0,'calculated',5,null,
   '00000000-0000-4000-8000-000000000011','received',
   jsonb_build_array(jsonb_build_object('line_position',1,'product_id','00000000-0000-4000-8000-000000000001','total_units',5,'unit_cost_lyd',1,'line_total_lyd',5,'expiry_date',(((now() at time zone 'Africa/Tripoli')::date)+10)::text))
  );
  raise exception 'Unconfirmed short receipt unexpectedly succeeded';
 exception when check_violation then null; end;

 -- Two Water batches with different dates coexist.
 select id into pid from public.snacky_create_purchase_with_lines_v3(
   gen_random_uuid(),null,current_date,'GOOD','cash','unpaid',null,null,null,null,null,8,null,0,'calculated',8,null,
   '00000000-0000-4000-8000-000000000011','received',
   jsonb_build_array(jsonb_build_object('line_position',1,'product_id','00000000-0000-4000-8000-000000000001','total_units',8,'unit_cost_lyd',1,'line_total_lyd',8,'expiry_date',(((now() at time zone 'Africa/Tripoli')::date)+60)::text,'supplier_lot_code','LOT-LONG'))
 );
 select b.id into good_batch from public.inventory_batches b join public.purchase_order_lines l on l.id=b.purchase_line_id where l.purchase_order_id=pid;

 select id into pid from public.snacky_create_purchase_with_lines_v3(
   gen_random_uuid(),null,current_date,'SHORT-YES','cash','unpaid',null,null,null,null,null,3,null,0,'calculated',3,null,
   '00000000-0000-4000-8000-000000000011','received',
   jsonb_build_array(jsonb_build_object('line_position',1,'product_id','00000000-0000-4000-8000-000000000001','total_units',3,'unit_cost_lyd',1,'line_total_lyd',3,'expiry_date',(((now() at time zone 'Africa/Tripoli')::date)+10)::text,'short_expiry_confirmed',true,'supplier_lot_code','LOT-SHORT'))
 );
 select l.id,b.id into short_line,short_batch from public.purchase_order_lines l join public.inventory_batches b on b.purchase_line_id=l.id where l.purchase_order_id=pid;
 if short_batch=good_batch then raise exception 'Different expiries collapsed into one batch';end if;

 -- FEFO selects the earlier known-safe batch before long-dated or legacy unknown stock.
 insert into public.inventory_movements(id,product_id,quantity,reason,from_entity_type,from_entity_id,to_entity_type,to_entity_id)
 values(gen_random_uuid(),'00000000-0000-4000-8000-000000000001',2,'storage_to_operator_bag','storage','00000000-0000-4000-8000-000000000011','operator_bag','00000000-0000-4000-8000-000000000101')
 returning id into outbound;
 select batch_id into allocated_batch from public.inventory_batch_movement_allocations where inventory_movement_id=outbound;
 if allocated_batch is distinct from short_batch then raise exception 'FEFO did not choose short-dated batch first';end if;

 -- Add a known-expired Juice batch beside one safe unit. Two sellable units must be rejected.
 insert into public.inventory_batches(product_id,expiry_date,source_kind,original_quantity)
 values('00000000-0000-4000-8000-000000000002',((now() at time zone 'Africa/Tripoli')::date)-1,'purchase',2)
 returning id into good_batch;
 insert into public.inventory_batch_balances(batch_id,entity_type,entity_id,quantity)
 values(good_batch,'storage','00000000-0000-4000-8000-000000000011',2);
 insert into public.inventory_batches(product_id,expiry_date,source_kind,original_quantity)
 values('00000000-0000-4000-8000-000000000002',((now() at time zone 'Africa/Tripoli')::date)+90,'purchase',1)
 returning id into good_batch;
 insert into public.inventory_batch_balances(batch_id,entity_type,entity_id,quantity)
 values(good_batch,'storage','00000000-0000-4000-8000-000000000011',1);
 begin
   insert into public.inventory_movements(product_id,quantity,reason,from_entity_type,from_entity_id,to_entity_type,to_entity_id)
   values('00000000-0000-4000-8000-000000000002',2,'storage_to_operator_bag','storage','00000000-0000-4000-8000-000000000011','operator_bag','00000000-0000-4000-8000-000000000101');
   raise exception 'Known expired units were allowed into sellable stock';
 exception when check_violation then null;end;

 -- Alert scan: short batch and aggregate unknown audit create once, then deduplicate.
 perform public.snacky_scan_expiry_safety_v1();
 if not exists(select 1 from public.notifications where source_kind='expiry_batch' and source_id=short_batch) then
   raise exception 'Near-expiry notification missing';
 end if;
 if not exists(select 1 from public.notifications where source_kind='expiry_audit') then
   raise exception 'Unknown-expiry audit notification missing';
 end if;
 select count(*) into before_count from public.notifications;
 perform public.snacky_scan_expiry_safety_v1();
 if (select count(*) from public.notifications)<>before_count then raise exception 'Expiry alerts did not deduplicate';end if;
 if not exists(select 1 from snacky_notice_private.deliveries) then raise exception 'Push delivery jobs were not queued';end if;
end$$;

select 'expiry-db-tests-passed' as result;
