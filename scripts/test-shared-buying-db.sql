\set ON_ERROR_STOP on
\ir test-company-hub-db.sql
alter table public.products add column active boolean default true, add column case_quantity integer, add column last_purchase_cost_lyd numeric, add column current_cost_price_lyd numeric, add column cost_price numeric, add column last_supplier_id uuid;
create table public.suppliers(id uuid primary key,name text);
\ir ../supabase/migrations/20260920133731_shared_buying_lists.sql
begin;
insert into auth.users values('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Planner','owner',array['owner']::public.team_role[],'11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Buyer','operator',array['operator']::public.team_role[],'22222222-2222-4222-8222-222222222222'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Other','operator',array['operator']::public.team_role[],'33333333-3333-4333-8333-333333333333'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','CRM buyer','crm',array['crm']::public.team_role[],'44444444-4444-4444-8444-444444444444');
insert into public.profiles(id,team_member_id,role,roles) select auth_user_id,id,role,roles from public.team_members;
insert into public.products(id,name,case_quantity,last_purchase_cost_lyd) values('99999999-9999-4999-8999-999999999999','Water',12,1),('88888888-8888-4888-8888-888888888888','Juice',24,null);
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
set local role authenticated;
do $$declare c jsonb;result jsonb;blocked boolean;begin
 c:=jsonb_build_object('request_id','55555555-5555-4555-8555-555555555555','list_id','66666666-6666-4666-8666-666666666666','action','create','revision',0,'payload',jsonb_build_object('title','Shared fixture','instructions','Check expiry','assigned_to','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','due_on','2026-09-20','items',jsonb_build_array(jsonb_build_object('product_id','99999999-9999-4999-8999-999999999999','boxes',2,'units_per_box',12),jsonb_build_object('product_id','88888888-8888-4888-8888-888888888888','boxes',2,'units_per_box',24))));
 result:=public.snacky_buying_command_v1(c);if result<>public.snacky_buying_command_v1(c) then raise exception 'Create retry duplicated';end if;
 blocked:=false;begin perform public.snacky_buying_command_v1(jsonb_set(c,'{payload,title}','"changed"'));exception when unique_violation then blocked:=true;end;if not blocked then raise exception 'Changed request identity accepted';end if;
 c:=jsonb_set(jsonb_set(c,'{request_id}',to_jsonb(gen_random_uuid()::text)),'{list_id}',to_jsonb(gen_random_uuid()::text));c:=jsonb_set(c,'{payload,items,1,units_per_box}','25');
 blocked:=false;begin perform public.snacky_buying_command_v1(c);exception when invalid_parameter_value then blocked:=true;end;if not blocked then raise exception 'Changed packaging accepted';end if;
end $$;
reset role;
do $$begin if (select count(*) from buying_private.lists)<>1 or (select count(*) from buying_private.items)<>2 or (select count(*) from buying_private.commands)<>1 then raise exception 'Partial/duplicate creation escaped rollback';end if;end $$;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
set local role authenticated;
do $$declare r jsonb;c jsonb;blocked boolean;begin
 r:=public.snacky_buying_workspace_v1('66666666-6666-4666-8666-666666666666');if (r->>'planner')::boolean or r#>>'{record,items,0,name}'<>'Water' or (r->>'total')::integer<>1 then raise exception 'Buyer workspace incorrect';end if;
 blocked:=false;begin perform count(*) from buying_private.items;exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Direct private read grant';end if;
 c:=jsonb_build_object('request_id',gen_random_uuid(),'list_id','66666666-6666-4666-8666-666666666666','action','item','revision',1,'payload',jsonb_build_object('product_id','99999999-9999-4999-8999-999999999999','outcome','bought','bought_boxes',2,'note',''));
 r:=public.snacky_buying_command_v1(c);if r<>public.snacky_buying_command_v1(c) then raise exception 'Progress retry duplicated';end if;
 blocked:=false;begin perform public.snacky_buying_command_v1(jsonb_set(c,'{request_id}',to_jsonb(gen_random_uuid()::text)));exception when serialization_failure then blocked:=true;end;if not blocked then raise exception 'Stale progress overwrote newer version';end if;
 blocked:=false;begin perform public.snacky_buying_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'list_id','66666666-6666-4666-8666-666666666666','action','complete','revision',2,'payload','{}'::jsonb));exception when invalid_parameter_value then blocked:=true;end;if not blocked then raise exception 'Completed unchecked list';end if;
 c:=jsonb_build_object('request_id',gen_random_uuid(),'list_id','66666666-6666-4666-8666-666666666666','action','item','revision',2,'payload',jsonb_build_object('product_id','88888888-8888-4888-8888-888888888888','outcome','unavailable','bought_boxes',0,'note','Supplier out of stock'));
 perform public.snacky_buying_command_v1(c);
 perform public.snacky_buying_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'list_id','66666666-6666-4666-8666-666666666666','action','complete','revision',3,'payload','{}'::jsonb));
 if public.snacky_buying_workspace_v1('66666666-6666-4666-8666-666666666666')#>>'{record,status}'<>'completed' then raise exception 'Completion not saved';end if;
end $$;
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
do $$declare blocked boolean:=false;begin
 if (public.snacky_buying_workspace_v1(null,'{"scope":"all"}')->>'total')::integer<>0 then raise exception 'Other buyer list leak';end if;
 begin perform public.snacky_buying_workspace_v1('66666666-6666-4666-8666-666666666666');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Other buyer detail leak';end if;
end $$;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.snacky_buying_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'list_id','66666666-6666-4666-8666-666666666666','action','reopen','revision',4,'payload','{}'::jsonb));
select public.snacky_buying_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'list_id','66666666-6666-4666-8666-666666666666','action','assign','revision',5,'payload','{"assigned_to":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}'::jsonb));
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select set_config('request.path','/rpc/snacky_buying_workspace_v1',true);
select public.snacky_crm_api_request_guard();
select public.snacky_buying_workspace_v1('66666666-6666-4666-8666-666666666666');
reset role;
update public.team_members set active_status='inactive' where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
set local role authenticated;
do $$declare blocked boolean:=false;begin begin perform public.snacky_buying_workspace_v1('66666666-6666-4666-8666-666666666666');exception when insufficient_privilege then blocked:=true;end;if not blocked then raise exception 'Inactive buyer access';end if;end $$;
reset role;
do $$begin
 if has_function_privilege('anon','public.snacky_buying_workspace_v1(uuid,jsonb)','EXECUTE') or has_table_privilege('authenticated','buying_private.lists','UPDATE') then raise exception 'Private permission boundary broken';end if;
 if exists(select 1 from public.financial_transactions) or exists(select 1 from public.crm_tasks) then raise exception 'Checklist generated money or duplicate work';end if;
 if (select count(*) from buying_private.items)<>2 or (select count(*) from buying_private.lists)<>1 then raise exception 'Checklist history changed';end if;
end $$;
rollback;
\echo 'Shared buying-list access, atomicity, replay, progression and no-money invariants passed.'
