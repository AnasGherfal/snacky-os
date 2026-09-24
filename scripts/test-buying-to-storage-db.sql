\set ON_ERROR_STOP on
\ir test-company-hub-db.sql

alter table public.products
 add column active boolean default true,
 add column case_quantity integer,
 add column last_purchase_cost_lyd numeric,
 add column current_cost_price_lyd numeric,
 add column cost_price numeric,
 add column last_supplier_id uuid;

create table public.suppliers(id uuid primary key,name text not null,phone text);
create table public.purchase_orders(
 id uuid primary key default gen_random_uuid(),
 supplier_id uuid references public.suppliers(id),
 status text not null default 'draft',
 created_by uuid references public.team_members(id),
 received_by uuid references public.team_members(id),
 voided_at timestamptz,
 total_amount numeric not null default 0,
 received_at timestamptz,
 receiving_storage_location_id uuid,
 receipt_number text
);
create table public.purchase_order_lines(
 id uuid primary key default gen_random_uuid(),
 purchase_order_id uuid not null references public.purchase_orders(id),
 product_id uuid not null references public.products(id),
 ordered_qty integer not null,
 units_per_box integer default 1
);

create or replace function public.snacky_create_purchase_with_lines_v2(
 p_client_submission_id uuid,p_supplier_id uuid,p_order_date date,p_receipt_number text,p_payment_method text,p_payment_status text,
 p_receipt_url text,p_receipt_file_name text,p_receipt_content_type text,p_receipt_storage_path text,p_notes text,
 p_calculated_total_lyd numeric,p_manual_total_lyd numeric,p_total_adjustment_lyd numeric,p_total_source text,p_total_amount numeric,
 p_payment_account_id text,p_receiving_storage_location_id uuid,p_submit_action text,p_lines jsonb)
returns table(id uuid,receipt_number text,status text,total_amount numeric,payment_status text,movement_count integer,receiving_storage_location_id uuid)
language sql security definer set search_path='' as $$
 select null::uuid,null::text,null::text,null::numeric,null::text,0::integer,null::uuid where false
$$;

\ir ../supabase/migrations/20260920133731_shared_buying_lists.sql

create table buying_private.sources(
 list_id uuid not null,
 product_id uuid not null,
 primary_store jsonb not null,
 alternative_store jsonb,
 note text not null default '',
 saved_by uuid references public.team_members(id),
 saved_at timestamptz not null default now(),
 primary key(list_id,product_id),
 foreign key(list_id,product_id) references buying_private.items(list_id,product_id)
);
alter table buying_private.sources enable row level security;
revoke all on buying_private.sources from public,anon,authenticated;
create or replace function buying_private.source_workspace(p_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$select jsonb_build_object('list_id',p_id)$$;
revoke all on function buying_private.source_workspace(uuid) from public,anon,authenticated;

\ir ../supabase/migrations/20260924094936_buying_to_storage_v1.sql

begin;
insert into auth.users values
 ('61111111-1111-4111-8111-111111111111'),
 ('62222222-2222-4222-8222-222222222222'),
 ('63333333-3333-4333-8333-333333333333');
insert into public.team_members(id,full_name,role,roles,auth_user_id) values
 ('6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Buying Owner','owner',array['owner']::public.team_role[],'61111111-1111-4111-8111-111111111111'),
 ('6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Buyer Warehouse','warehouse',array['warehouse']::public.team_role[],'62222222-2222-4222-8222-222222222222'),
 ('6ccccccc-cccc-4ccc-8ccc-cccccccccccc','Other Warehouse','warehouse',array['warehouse']::public.team_role[],'63333333-3333-4333-8333-333333333333');
insert into public.profiles(id,team_member_id,role,roles) select auth_user_id,id,role,roles from public.team_members where id::text like '6%';

insert into public.products(id,name,active,case_quantity) values
 ('69999999-9999-4999-8999-999999999991','Water',true,12),
 ('69999999-9999-4999-8999-999999999992','Juice',true,24);
insert into public.suppliers(id,name,phone) values
 ('68888888-8888-4888-8888-888888888881','Primary Store','0911'),
 ('68888888-8888-4888-8888-888888888882','Alternative Store','0922'),
 ('68888888-8888-4888-8888-888888888883','Unapproved Store','0933');

select set_config('request.jwt.claim.sub','61111111-1111-4111-8111-111111111111',true);
set local role authenticated;
select public.snacky_buying_command_v1(jsonb_build_object(
 'request_id',gen_random_uuid(),'list_id','67777777-7777-4777-8777-777777777777','action','create','revision',0,
 'payload',jsonb_build_object('title','Storage run','instructions','Use exact stores','assigned_to','6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','due_on','2026-09-24',
 'items',jsonb_build_array(
  jsonb_build_object('product_id','69999999-9999-4999-8999-999999999991','boxes',2,'units_per_box',12),
  jsonb_build_object('product_id','69999999-9999-4999-8999-999999999992','boxes',2,'units_per_box',24)
 )));
reset role;

insert into buying_private.sources(list_id,product_id,primary_store,alternative_store,note,saved_by) values
 ('67777777-7777-4777-8777-777777777777','69999999-9999-4999-8999-999999999991',
  '{"supplier_id":"68888888-8888-4888-8888-888888888881","name":"Primary Store","phone":"0911","unit_cost_lyd":1.1,"purchased_on":"2026-09-01"}',
  '{"supplier_id":"68888888-8888-4888-8888-888888888882","name":"Alternative Store","phone":"0922","unit_cost_lyd":1.2,"purchased_on":"2026-09-02"}','Gate','6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('67777777-7777-4777-8777-777777777777','69999999-9999-4999-8999-999999999992',
  '{"supplier_id":"68888888-8888-4888-8888-888888888881","name":"Primary Store","phone":"0911","unit_cost_lyd":2.1,"purchased_on":"2026-09-01"}',
  null,'Gate','6aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

select set_config('request.jwt.claim.sub','62222222-2222-4222-8222-222222222222',true);
set local role authenticated;
do $$
declare r jsonb; blocked boolean:=false; rev integer:=1; req uuid:=gen_random_uuid();
begin
 begin
  perform public.snacky_buying_item_result_v2(jsonb_build_object(
   'request_id',gen_random_uuid(),'list_id','67777777-7777-4777-8777-777777777777','product_id','69999999-9999-4999-8999-999999999991',
   'revision',rev,'outcome','bought','bought_boxes',2,'note','','actual_supplier_id','68888888-8888-4888-8888-888888888883'));
 exception when check_violation then blocked:=true;end;
 if not blocked then raise exception 'Unapproved store accepted';end if;

 r:=public.snacky_buying_item_result_v2(jsonb_build_object(
  'request_id',req,'list_id','67777777-7777-4777-8777-777777777777','product_id','69999999-9999-4999-8999-999999999991',
  'revision',rev,'outcome','bought','bought_boxes',2,'note','','actual_supplier_id','68888888-8888-4888-8888-888888888882'));
 if r is distinct from public.snacky_buying_item_result_v2(jsonb_build_object(
  'request_id',req,'list_id','67777777-7777-4777-8777-777777777777','product_id','69999999-9999-4999-8999-999999999991',
  'revision',rev,'outcome','bought','bought_boxes',2,'note','','actual_supplier_id','68888888-8888-4888-8888-888888888882'))
 then raise exception 'Item result retry changed';end if;
 rev:=(r->>'revision')::int;

 r:=public.snacky_buying_item_result_v2(jsonb_build_object(
  'request_id',gen_random_uuid(),'list_id','67777777-7777-4777-8777-777777777777','product_id','69999999-9999-4999-8999-999999999992',
  'revision',rev,'outcome','partial','bought_boxes',1,'note','Only one box available','actual_supplier_id','68888888-8888-4888-8888-888888888881'));
 rev:=(r->>'revision')::int;
 perform public.snacky_buying_command_v1(jsonb_build_object('request_id',gen_random_uuid(),'list_id','67777777-7777-4777-8777-777777777777','action','complete','revision',rev,'payload','{}'::jsonb));
end $$;

do $$
declare w jsonb;
begin
 w:=public.snacky_buying_purchase_workspace_v1('67777777-7777-4777-8777-777777777777');
 if (w->>'can_record')::boolean is not true or jsonb_array_length(w->'groups')<>2 then raise exception 'Purchase groups incorrect';end if;
 if not exists(select 1 from jsonb_array_elements(w->'groups') g where g->>'supplier_id'='68888888-8888-4888-8888-888888888882') then raise exception 'Alternative store group missing';end if;
end $$;
reset role;

insert into public.purchase_orders(id,supplier_id,status,created_by,received_by,total_amount,received_at,receiving_storage_location_id,receipt_number)
values('65555555-5555-4555-8555-555555555551','68888888-8888-4888-8888-888888888882','received','6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',26.4,now(),gen_random_uuid(),'ALT-1');
insert into public.purchase_order_lines(purchase_order_id,product_id,ordered_qty,units_per_box)
values('65555555-5555-4555-8555-555555555551','69999999-9999-4999-8999-999999999991',24,12);

insert into public.purchase_orders(id,supplier_id,status,created_by,received_by,total_amount,received_at,receiving_storage_location_id,receipt_number)
values('65555555-5555-4555-8555-555555555552','68888888-8888-4888-8888-888888888881','received','6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','6bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',50.4,now(),gen_random_uuid(),'PRI-1');
insert into public.purchase_order_lines(purchase_order_id,product_id,ordered_qty,units_per_box)
values('65555555-5555-4555-8555-555555555552','69999999-9999-4999-8999-999999999992',24,24);

set local role authenticated;
do $$
declare r jsonb; req uuid:=gen_random_uuid(); blocked boolean:=false;
begin
 r:=public.snacky_buying_purchase_link_v1(jsonb_build_object(
  'request_id',req,'list_id','67777777-7777-4777-8777-777777777777','supplier_id','68888888-8888-4888-8888-888888888882','purchase_id','65555555-5555-4555-8555-555555555551'));
 if r is distinct from public.snacky_buying_purchase_link_v1(jsonb_build_object(
  'request_id',req,'list_id','67777777-7777-4777-8777-777777777777','supplier_id','68888888-8888-4888-8888-888888888882','purchase_id','65555555-5555-4555-8555-555555555551'))
 then raise exception 'Purchase link retry changed';end if;

 perform public.snacky_buying_purchase_link_v1(jsonb_build_object(
  'request_id',gen_random_uuid(),'list_id','67777777-7777-4777-8777-777777777777','supplier_id','68888888-8888-4888-8888-888888888881','purchase_id','65555555-5555-4555-8555-555555555552'));

 if (select count(*) from buying_private.purchase_links where list_id='67777777-7777-4777-8777-777777777777')<>2 then raise exception 'Purchases not linked by store';end if;
end $$;
reset role;

insert into public.purchase_orders(id,supplier_id,status,created_by,received_by,total_amount)
values('65555555-5555-4555-8555-555555555553','68888888-8888-4888-8888-888888888881','received','6ccccccc-cccc-4ccc-8ccc-cccccccccccc','6ccccccc-cccc-4ccc-8ccc-cccccccccccc',1);
insert into public.purchase_order_lines(purchase_order_id,product_id,ordered_qty)
values('65555555-5555-4555-8555-555555555553','69999999-9999-4999-8999-999999999992',24);

select set_config('request.jwt.claim.sub','63333333-3333-4333-8333-333333333333',true);
set local role authenticated;
do $$declare blocked boolean:=false;begin
 begin perform public.snacky_buying_purchase_link_v1(jsonb_build_object(
  'request_id',gen_random_uuid(),'list_id','67777777-7777-4777-8777-777777777777','supplier_id','68888888-8888-4888-8888-888888888881','purchase_id','65555555-5555-4555-8555-555555555553'));
 exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Other buyer linked purchase';end if;
end $$;
reset role;

do $$
begin
 if has_table_privilege('authenticated','buying_private.purchase_links','SELECT') then raise exception 'Purchase links leaked directly';end if;
 if has_table_privilege('authenticated','buying_private.item_result_commands','SELECT') then raise exception 'Result commands leaked directly';end if;
end $$;
rollback;
\echo 'Buying-to-storage same-buyer store, quantity, replay and permission checks passed.'
