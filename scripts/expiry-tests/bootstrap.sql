\set ON_ERROR_STOP on
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to anon,authenticated,service_role;

create table public.products(id uuid primary key,name text not null,sku text);
create table public.storage_locations(id uuid primary key,name text,active boolean default true,location_type text);
create table public.machines(id uuid primary key,name text);
create table public.purchase_orders(
 id uuid primary key default gen_random_uuid(),receipt_number text,status text default 'draft',
 total_amount numeric default 0,payment_status text default 'unpaid',receiving_storage_location_id uuid references public.storage_locations(id)
);
create table public.purchase_order_lines(
 id uuid primary key default gen_random_uuid(),purchase_order_id uuid not null references public.purchase_orders(id),
 line_position integer not null,product_id uuid not null references public.products(id),total_units integer not null,
 unit_cost_lyd numeric default 1,line_total_lyd numeric default 0
);
create table public.inventory_movements(
 id uuid primary key default gen_random_uuid(),product_id uuid not null references public.products(id),quantity integer not null,
 reason text not null,from_entity_type text,from_entity_id uuid,to_entity_type text,to_entity_id uuid,
 related_purchase_line_id uuid references public.purchase_order_lines(id),related_purchase_id uuid references public.purchase_orders(id),
 reversed_movement_id uuid references public.inventory_movements(id),related_route_id uuid,related_route_stop_id uuid,related_machine_id uuid,
 created_at timestamptz not null default now()
);
create table public.current_inventory_by_location(product_id uuid,location_type text,location_id uuid,quantity_on_hand integer);
create table public.latest_vms_stock_by_slot(machine_id uuid,product_id uuid,current_qty integer,captured_at timestamptz);

create table public.team_members(
 id uuid primary key,auth_user_id uuid,role text,roles text[],active boolean default true,active_status text default 'active'
);
create table public.profiles(
 id uuid primary key,team_member_id uuid,role text,roles text[],active_status text default 'active'
);
create table public.push_subscriptions(
 id uuid primary key default gen_random_uuid(),user_id uuid not null,endpoint text,p256dh text,auth text,is_active boolean default true
);
create table public.notifications(
 id uuid primary key default gen_random_uuid(),user_id uuid not null,type text,title text,message text,action_url text,
 read_at timestamptz,created_at timestamptz default now(),event_key text,source_kind text,source_id uuid,
 recipient_member_id uuid,event_kind text,title_ar text,message_ar text
);
create unique index notification_event_key_test on public.notifications(event_key) where event_key is not null;

create schema snacky_notice_private;
create table snacky_notice_private.deliveries(
 id uuid primary key default gen_random_uuid(),notification_id uuid not null references public.notifications(id),
 subscription_id uuid not null references public.push_subscriptions(id),status text default 'queued',
 unique(notification_id,subscription_id)
);
create function snacky_notice_private.member_user(m uuid) returns uuid language sql stable security definer set search_path='' as $$
 select p.id from public.profiles p join public.team_members t on t.id=p.team_member_id
 where t.id=m and t.active is not false and t.active_status='active' and p.active_status='active'
 order by p.id limit 1
$$;
create function snacky_notice_private.source(k text,i uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('active',true,'member',null,'href','/account')
$$;
create function snacky_notice_private.eligible(n public.notifications) returns boolean language sql stable security definer set search_path='' as $$select true$$;
create function snacky_notice_private.wake() returns void language plpgsql security definer set search_path='' as $$begin return;end$$;

create function public.snacky_current_profile_has_any_role(text[]) returns boolean language sql stable as $$select true$$;

-- Exact legacy purchase function shapes used by the production wrappers.
create function public.snacky_create_purchase_with_lines_v2(
 p_client_submission_id uuid,p_supplier_id uuid,p_order_date date,p_receipt_number text,p_payment_method text,
 p_payment_status text,p_receipt_url text,p_receipt_file_name text,p_receipt_content_type text,p_receipt_storage_path text,
 p_notes text,p_calculated_total_lyd numeric,p_manual_total_lyd numeric,p_total_adjustment_lyd numeric,p_total_source text,
 p_total_amount numeric,p_payment_account_id text,p_receiving_storage_location_id uuid,p_submit_action text,p_lines jsonb
) returns table(id uuid,receipt_number text,status text,total_amount numeric,payment_status text,movement_count integer,receiving_storage_location_id uuid)
language plpgsql as $$
declare pid uuid:=gen_random_uuid();x record;
begin
 insert into public.purchase_orders(id,receipt_number,status,total_amount,payment_status,receiving_storage_location_id)
 values(pid,p_receipt_number,'draft',coalesce(p_total_amount,0),'unpaid',p_receiving_storage_location_id);
 for x in select * from jsonb_to_recordset(coalesce(p_lines,'[]'::jsonb))
  as l(line_position integer,product_id uuid,total_units integer,unit_cost_lyd numeric,line_total_lyd numeric)
 loop
  insert into public.purchase_order_lines(purchase_order_id,line_position,product_id,total_units,unit_cost_lyd,line_total_lyd)
  values(pid,x.line_position,x.product_id,x.total_units,coalesce(x.unit_cost_lyd,1),coalesce(x.line_total_lyd,x.total_units));
 end loop;
 return query select po.id,po.receipt_number,po.status,po.total_amount,po.payment_status,0,po.receiving_storage_location_id
 from public.purchase_orders po where po.id=pid;
end$$;

create function public.snacky_update_draft_purchase_v1(
 p_purchase_id uuid,p_client_submission_id text,p_expected_updated_at timestamptz,p_supplier_id uuid,p_order_date date,
 p_receiving_storage_location_id uuid,p_receipt_number text,p_payment_method text,p_receipt_url text,p_receipt_file_name text,
 p_receipt_content_type text,p_receipt_storage_path text,p_notes text,p_manual_total_lyd numeric,p_lines jsonb
) returns jsonb language sql as $$select jsonb_build_object('purchase',jsonb_build_object('id',p_purchase_id,'status','draft'))$$;

create function public.snacky_receive_purchase_v1(p_purchase_id uuid,p_client_submission_id text,p_receiving_storage_location_id uuid)
returns jsonb language plpgsql as $$
declare l record;cnt integer:=0;
begin
 for l in select * from public.purchase_order_lines where purchase_order_id=p_purchase_id order by line_position loop
  insert into public.inventory_movements(product_id,quantity,reason,from_entity_type,to_entity_type,to_entity_id,related_purchase_line_id,related_purchase_id)
  values(l.product_id,l.total_units,'purchase_received','supplier','storage',p_receiving_storage_location_id,l.id,p_purchase_id);
  cnt:=cnt+1;
 end loop;
 update public.purchase_orders set status='received' where id=p_purchase_id;
 return jsonb_build_object('movement_count',cnt);
end$$;

insert into auth.users values('00000000-0000-4000-8000-000000000100');
insert into public.team_members(id,auth_user_id,role,roles) values('00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000100','owner',array['owner']);
insert into public.profiles(id,team_member_id,role,roles) values('00000000-0000-4000-8000-000000000100','00000000-0000-4000-8000-000000000101','owner',array['owner']);
insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values('00000000-0000-4000-8000-000000000100','https://web.push.apple.com/test','p','a');
insert into public.products values
 ('00000000-0000-4000-8000-000000000001','Water','WATER'),
 ('00000000-0000-4000-8000-000000000002','Juice','JUICE');
insert into public.storage_locations values('00000000-0000-4000-8000-000000000011','Main',true,'main_storage');
insert into public.machines values('00000000-0000-4000-8000-000000000021','Machine A');
insert into public.current_inventory_by_location values('00000000-0000-4000-8000-000000000001','storage','00000000-0000-4000-8000-000000000011',4);
insert into public.latest_vms_stock_by_slot values('00000000-0000-4000-8000-000000000021','00000000-0000-4000-8000-000000000001',2,now());
