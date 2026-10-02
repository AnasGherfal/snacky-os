\set ON_ERROR_STOP on
-- Synthetic isolated PostgreSQL fixture only. No actual Snacky business records.
begin;
insert into public.team_members(id,auth_user_id,full_name,role,roles)
select ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,('20000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Test staff '||n,r,array[r]
from (values(1,'owner'),(2,'warehouse'),(3,'warehouse'),(4,'operator'),(5,'crm'),(6,'investor'),(7,'purchasing')) t(n,r);
insert into public.profiles select auth_user_id,full_name,id,'active',role,roles from public.team_members;
insert into snacky_private.cash_handover_settings values(true,true);
insert into snacky_private.cash_handover_counters values('20000000-0000-4000-8000-000000000002',true);
insert into public.cash_collections(id,cash_bag_id,operator_id,custody_status,collected_at,actual_cash_collected,counted_at)
select ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
case when n=11 then '   ' else 'Box '||n end,'10000000-0000-4000-8000-000000000004',
case when n=12 then 'pending_collection' else 'in_storage' end,now()-n*interval '1 hour',case when n=10 then 0 else null end,case when n=10 then now() else null end
from generate_series(1,12) n;
insert into snacky_private.cash_handovers(collection_id,stage,assigned_to,picked_up_by,picked_up_at,deposited_at)
select id,case when cash_bag_id='Box 1' then 'picked_up' else 'dropped' end,
case when cash_bag_id='Box 9' then '20000000-0000-4000-8000-000000000003'::uuid else '20000000-0000-4000-8000-000000000002'::uuid end,
case when cash_bag_id='Box 1' then '20000000-0000-4000-8000-000000000002'::uuid else null end,
case when cash_bag_id='Box 1' then now()-interval '1 hour' else null end,now()-interval '2 hours' from public.cash_collections;
-- One collector still holds a box assigned to the counter; do not tell counter to pick up yet.
insert into public.cash_collections(id,cash_bag_id,operator_id,custody_status) values('30000000-0000-4000-8000-000000000013','Waiting for drop-off','10000000-0000-4000-8000-000000000004','removed');
insert into snacky_private.cash_handovers(collection_id,stage,assigned_to) values('30000000-0000-4000-8000-000000000013','assigned','20000000-0000-4000-8000-000000000002');
insert into buying_private.lists(id,title,assigned_to,status,due_on,created_at) select ('40000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Shopping '||n,
case when n=5 then '10000000-0000-4000-8000-000000000003'::uuid else '10000000-0000-4000-8000-000000000002'::uuid end,
case when n=3 then 'completed' when n=4 then 'cancelled' else 'open' end,
(now() at time zone 'Africa/Tripoli')::date+case when n=2 then 1 else -1 end,now()-n*interval '1 hour' from generate_series(1,5)n;
insert into buying_private.items(list_id,product_id,outcome,bought_boxes,units_per_box) select id,'50000000-0000-4000-8000-000000000001',case when status='completed' then 'bought' else 'pending' end,case when status='completed' then 1 else 0 end,10 from buying_private.lists;
insert into buying_private.sources values('40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','{"name":"Test Store","phone":"PRIVATE-PHONE","unit_price":12345}');
insert into public.suppliers values('60000000-0000-4000-8000-000000000001','Test Store');
insert into public.purchase_orders(id,receipt_number,supplier_id,status,received_at) select ('61000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Receipt '||n,'60000000-0000-4000-8000-000000000001',case when n=2 then 'received' else 'draft' end,case when n=2 then now() else null end from generate_series(1,4)n;
insert into buying_private.purchase_links(purchase_id,list_id,buyer_id) select id,'40000000-0000-4000-8000-000000000001',case when receipt_number='Receipt 3' then '10000000-0000-4000-8000-000000000003'::uuid else '10000000-0000-4000-8000-000000000002'::uuid end from public.purchase_orders where receipt_number<>'Receipt 4';
insert into public.storage_locations values('70000000-0000-4000-8000-000000000001','Test Storage');
insert into stocktake_private.assignments(id,title,storage_location_id,assigned_to,status,due_on,submitted_at,approved_at,cancelled_at)
select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Count '||n,'70000000-0000-4000-8000-000000000001',
case when n=7 then '20000000-0000-4000-8000-000000000003'::uuid else '20000000-0000-4000-8000-000000000002'::uuid end,
case n when 2 then 'needs_recount' when 3 then 'submitted' when 4 then 'approved' when 5 then 'cancelled' else 'assigned' end,
(now() at time zone 'Africa/Tripoli')::date+case when n=6 then 1 else -1 end,
case when n=3 then now() end,case when n=4 then now() end,case when n=5 then now() end from generate_series(1,7)n;
insert into stocktake_private.lines select id,'50000000-0000-4000-8000-000000000001',case when status in ('submitted','approved') then 999 else null end from stocktake_private.assignments;
-- Both phases must deny unlinked, inactive, mismatched and unauthorized accounts.
set local role authenticated;
do $$declare v jsonb;p2 jsonb;seen boolean;s text;n integer;begin
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
 v:=public.snacky_personal_work_section_v1('cash');
 if (v->>'total')::integer<>9 or (v->>'actions')::integer<>8 or jsonb_array_length(v->'rows')<>5 or v->'rows'->0->>'state'<>'cash_count' then raise exception 'Cash scope/priority failed: %',v;end if;
 if (v->'totals'->>'history')::integer<>1 then raise exception 'Counted zero not retained in history';end if;
 p2:=public.snacky_personal_work_section_v1('cash','active',5);
 if jsonb_array_length(p2->'rows')<>4 then raise exception 'Page two incomplete';end if;
 if exists(select 1 from jsonb_array_elements(v->'rows') a join jsonb_array_elements(p2->'rows') b on a.value->>'id'=b.value->>'id') then raise exception 'Pages overlap';end if;
 if not exists(select 1 from jsonb_array_elements(p2->'rows') r where r->>'state'='cash_wait_dropoff' and r->>'actionable'='false') then raise exception 'Undeposited box was made actionable';end if;
 if v::text like '%actual_cash_collected%' or v::text like '%PRIVATE%' then raise exception 'Cash payload leak';end if;
 v:=public.snacky_personal_work_section_v1('buying');
 if (v->>'total')::integer<>2 or (v->'totals'->>'upcoming')::integer<>1 or (v->'totals'->>'history')::integer<>1 then raise exception 'Buying scope/receipt gap failed: %',v;end if;
 if not exists(select 1 from jsonb_array_elements(v->'rows')r where r->>'state'='buying_receipt') then raise exception 'Completed checklist hid missing receipt';end if;
 if v::text like '%PRIVATE-PHONE%' or v::text like '%unit_price%' or v::text like '%12345%' then raise exception 'Supplier sensitive fields leaked';end if;
 v:=public.snacky_personal_work_section_v1('storage');
 if (v->>'total')::integer<>1 or (v->>'actions')::integer<>1 or (v->'totals'->>'history')::integer<>1 or v->'rows'->0->>'target_id'<>'40000000-0000-4000-8000-000000000001' then raise exception 'Storage buyer/scope/link failed: %',v;end if;
 v:=public.snacky_personal_work_section_v1('stocktakes');
 if (v->>'total')::integer<>3 or (v->>'actions')::integer<>2 or (v->'totals'->>'upcoming')::integer<>1 or (v->'totals'->>'history')::integer<>2 then raise exception 'Stocktake scope/counts failed: %',v;end if;
 if v::text like '%counted_qty%' or v::text like '%999%' then raise exception 'Blind count quantity leaked';end if;
 if exists(select 1 from jsonb_array_elements(v->'rows')r where r->>'state'='stock_wait_review' and r->>'actionable'='true') then raise exception 'Worker offered own stock approval';end if;
 -- Personal means personal even for owner: no implicit all-staff view.
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',true);
 foreach s in array array['cash','buying','storage','stocktakes'] loop
  v:=public.snacky_personal_work_section_v1(s);if (v->>'total')::integer<>0 then raise exception 'Owner personal page included other assignments';end if;
 end loop;
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000004',true);
 v:=public.snacky_personal_work_section_v1('stocktakes');if v->>'status'<>'restricted' or v?'total' then raise exception 'Plain operator received inaccessible stocktakes';end if;
 v:=public.snacky_personal_work_section_v1('storage');if v->>'status'<>'restricted' then raise exception 'Plain operator received purchasing authority';end if;
 for n in 5..6 loop
  perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-'||lpad(n::text,12,'0'),true);
  seen:=false;begin perform public.snacky_personal_work_section_v1('cash');exception when insufficient_privilege then seen:=true;end;
  if not seen then raise exception 'CRM/investor bypass';end if;
 end loop;
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
 seen:=false;begin perform public.snacky_personal_work_section_v1('cash','active',1);exception when invalid_parameter_value then seen:=true;end;if not seen then raise exception 'Bad offset accepted';end if;
 seen:=false;begin perform public.snacky_personal_work_section_v1('finance');exception when invalid_parameter_value then seen:=true;end;if not seen then raise exception 'Other module accepted';end if;
 raise notice 'PASS: own-only reads, roles, reference/zero handling, receipt gap, same buyer, progress-only, waiting and pagination';
end$$;
reset role;
update snacky_private.cash_handover_counters set enabled=false;
update buying_private.lists set assigned_to='10000000-0000-4000-8000-000000000003' where id='40000000-0000-4000-8000-000000000001';
set local role authenticated;
do $$declare v jsonb;begin
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
 v:=public.snacky_personal_work_section_v1('cash');if (v->>'total')::integer<>0 then raise exception 'Revoked counter retained access';end if;
 v:=public.snacky_personal_work_section_v1('storage');if (v->>'total')::integer<>0 then raise exception 'Reassigned list retained receipt access';end if;
 raise notice 'PASS: live revocation and reassignment';
end$$;
reset role;
update public.team_members set active=false where id='10000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$declare denied boolean:=false;begin
 perform set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
 begin perform public.snacky_personal_work_section_v1('buying');exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'Inactive team member passed';end if;
end$$;
reset role;
update public.team_members set active=true,auth_user_id='20000000-0000-4000-8000-000000000003' where id='10000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$declare denied boolean:=false;begin
 begin perform public.snacky_personal_work_section_v1('cash');exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'Mismatched identity passed';end if;
end$$;
reset role;
update public.team_members set auth_user_id='20000000-0000-4000-8000-000000000002' where id='10000000-0000-4000-8000-000000000002';
-- Block DML during every final reader call. STABLE alone is not our only assertion.
create function public.reject_personal_write() returns trigger language plpgsql as $$begin raise exception 'Personal reader wrote business data';end$$;
do $$declare r record;begin for r in select schemaname,tablename from pg_tables where schemaname in ('public','buying_private','snacky_private','stocktake_private') loop
 execute format('create trigger no_personal_writes before insert or update or delete on %I.%I for each statement execute function public.reject_personal_write()',r.schemaname,r.tablename);
end loop;end$$;
set local role authenticated;
do $$declare s text;v text;begin
 foreach s in array array['cash','buying','storage','stocktakes'] loop foreach v in array array['active','upcoming','history'] loop perform public.snacky_personal_work_section_v1(s,v);end loop;end loop;
end$$;
reset role;
drop table stocktake_private.lines;
set local role authenticated;
do $$declare missing boolean:=false;begin
 begin perform public.snacky_personal_work_section_v1('stocktakes');exception when undefined_table then missing:=true;end;
 if not missing then raise exception 'Missing table became an empty response';end if;
 perform public.snacky_personal_work_section_v1('buying');
end$$;
reset role;
do $$begin
 if has_function_privilege('anon','public.snacky_personal_work_section_v1(text,text,integer)','execute') then raise exception 'Anonymous execute grant';end if;
 if (select prosecdef from pg_proc where oid='public.snacky_personal_work_section_v1(text,text,integer)'::regprocedure) then raise exception 'Public wrapper must be invoker';end if;
 if has_table_privilege('authenticated','buying_private.lists','SELECT') then raise exception 'Raw lists exposed';end if;
 raise notice 'PASS: fail-closed missing source, no business writes, no anonymous/raw-table access';
end$$;
rollback;
