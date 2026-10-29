\set ON_ERROR_STOP on
-- Run only in a freshly created, disposable market_checklist_tests database.
do $$begin
  if current_database() <> 'market_checklist_tests'
    or to_regclass('public.profiles') is not null
    or to_regnamespace('buying_private') is not null then
    raise exception 'This fixture requires a fresh isolated market_checklist_tests database';
  end if;
end $$;

do $$begin
  if not exists(select 1 from pg_roles where rolname = 'anon') then create role anon;end if;
  if not exists(select 1 from pg_roles where rolname = 'authenticated') then create role authenticated;end if;
end $$;
create schema auth;
create schema storage;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
grant usage on schema auth to authenticated, anon;
create table public.team_members(
  id uuid primary key, full_name text, role text, roles text[], auth_user_id uuid,
  active boolean not null default true, active_status text not null default 'active'
);
create table public.profiles(
  id uuid primary key, team_member_id uuid, role text, roles text[],
  active_status text not null default 'active'
);
create table public.suppliers(id uuid primary key, name text, phone text);
create table public.products(
  id uuid primary key, name text, active boolean default true, case_quantity integer,
  last_purchase_cost_lyd numeric, current_cost_price_lyd numeric, cost_price numeric, last_supplier_id uuid
);
create table public.purchase_orders(
  id uuid primary key, supplier_id uuid, receipt_number text, order_date date, received_date date,
  status text default 'draft', payment_status text default 'unpaid', total_amount numeric,
  receiving_storage_location_id uuid, received_at timestamptz, received_by uuid, voided_at timestamptz,
  updated_at timestamptz default now(), created_at timestamptz default now(),
  currency text default 'LYD', receipt_storage_path text
);
create table public.purchase_order_lines(
  id uuid primary key, purchase_order_id uuid, product_id uuid, total_units integer,
  units_per_box integer, received_qty integer default 0, unit_cost_lyd numeric, unit_cost numeric,
  line_position integer, updated_at timestamptz
);
create table public.storage_locations(id uuid primary key, name text, active boolean, location_type text);
create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text, metadata jsonb);
create table public.inventory_movements(id uuid primary key, quantity numeric);
create table public.financial_transactions(id uuid primary key, amount numeric);
create function public.snacky_current_profile_has_any_role(p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles p where p.id = auth.uid()
    and p.active_status = 'active' and (coalesce(p.roles, '{}') || array[p.role]) && p_roles);
$$;
create function public.snacky_crm_is_limited() returns boolean language sql stable as $$select false;$$;
create function public.snacky_crm_api_request_guard() returns void language plpgsql as $$
declare path text := coalesce(current_setting('request.path', true), '');
begin
 if not public.snacky_crm_is_limited() then return;end if;
 raise exception 'CRM denied' using errcode = '42501';
end $$;

-- Execute the actual legacy implementations; only external catalogue/auth and
-- purchase tables are a deliberately small fixture, never a production mirror.
\ir ../supabase/migrations/20260920133731_shared_buying_lists.sql
\ir ../supabase/migrations/20260923130938_buying_store_guidance_v1.sql
\ir ../supabase/migrations/20260924112418_buying_purchase_link_v1.sql
\ir ../supabase/migrations/20260930174500_remove_operator_buying_access.sql

insert into auth.users values
 ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222'),
 ('33333333-3333-4333-8333-333333333333'), ('44444444-4444-4444-8444-444444444444'),
 ('55555555-5555-4555-8555-555555555555'), ('66666666-6666-4666-8666-666666666666');
insert into public.team_members(id, full_name, role, roles, auth_user_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Planner', 'owner', array['owner'], '11111111-1111-4111-8111-111111111111'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Assigned non-planner buyer', 'finance', array['finance'], '22222222-2222-4222-8222-222222222222'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Other non-planner', 'finance', array['finance'], '33333333-3333-4333-8333-333333333333'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Operator', 'operator', array['operator'], '44444444-4444-4444-8444-444444444444'),
 ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'CRM', 'crm', array['crm'], '55555555-5555-4555-8555-555555555555'),
 ('ffffffff-ffff-4fff-8fff-ffffffffffff', 'Additive warehouse operator', 'operator', array['operator','warehouse'], '66666666-6666-4666-8666-666666666666');
insert into public.profiles(id, team_member_id, role, roles) select auth_user_id, id, role, roles from public.team_members;
insert into public.suppliers(id, name) values('90000000-0000-4000-8000-000000000001', 'Fixture wholesale');
insert into public.products(id, name, case_quantity, last_purchase_cost_lyd, active) values
 ('99999999-9999-4999-8999-999999999999', 'Mr Crunch cheese', 24, 1, true),
 ('88888888-8888-4888-8888-888888888888', 'Bebeto bears', 12, 2, true),
 ('77777777-7777-4777-8777-777777777777', 'Inactive example', 12, 1, false);

-- An existing exact list must survive the additive migration unchanged.
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
set role authenticated;
select public.snacky_buying_command_v1(jsonb_build_object(
  'request_id', '50000000-0000-4000-8000-000000000099', 'list_id', '60000000-0000-4000-8000-000000000002',
  'action', 'create', 'revision', 0, 'payload', jsonb_build_object(
    'title', 'Legacy exact list', 'instructions', '', 'assigned_to', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'due_on', '2026-10-28', 'items', jsonb_build_array(jsonb_build_object(
      'product_id', '99999999-9999-4999-8999-999999999999', 'boxes', 2, 'units_per_box', 24))
  )));
reset role;
create temp table checklist_original_definitions as
  select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'buying_private' and p.proname in
    ('member','workspace','command','purchase_workspace','purchase_command','purchase_snapshot_guard','purchased_checklist_guard');
create temp table checklist_legacy_items as select to_jsonb(i) as data from buying_private.items i;

\ir ../supabase/migrations/20261028160233_market_shopping_checklist.sql

create table public.checklist_test_results(label text primary key);
grant select, insert on public.checklist_test_results to authenticated, anon;
create function public.checklist_test_assert(p_condition boolean, p_label text)
returns void language plpgsql security invoker as $$begin
  if p_condition is not true then raise exception 'Checklist test failed: %', p_label;end if;
  insert into public.checklist_test_results values(p_label);
end $$;
create function public.checklist_test_reject_sql(p_sql text, p_code text, p_label text)
returns void language plpgsql security invoker as $$declare rejected boolean := false;begin
  begin execute p_sql;
  exception when others then
    if sqlstate <> p_code then raise exception 'Expected % for %, got %: %', p_code, p_label, sqlstate, sqlerrm;end if;
    rejected := true;
  end;
  perform public.checklist_test_assert(rejected, p_label);
end $$;
create function public.checklist_test_command(p_action text, p_revision integer, p_payload jsonb,
  p_list uuid default '60000000-0000-4000-8000-000000000001', p_request uuid default gen_random_uuid())
returns jsonb language sql as $$select jsonb_build_object(
 'request_id', p_request, 'list_id', p_list, 'action', p_action, 'revision', p_revision, 'payload', p_payload);$$;
create function public.checklist_test_item(p_id uuid, p_label text, p_quantity integer,
  p_product uuid default null, p_unit text default 'boxes', p_flex text default 'any_flavour', p_acquired integer default 0)
returns jsonb language sql as $$select jsonb_build_object('id', p_id, 'product_id', p_product, 'label', p_label,
 'quantity', p_quantity, 'unit', p_unit, 'flexibility', p_flex,
 'acquired_quantity', p_acquired, 'unavailable', false, 'note', '');$$;
create function public.checklist_test_reject(p_command jsonb, p_code text, p_label text, p_legacy boolean default false)
returns void language sql as $$select public.checklist_test_reject_sql(format('select public.%I(%L::jsonb)',
 case when p_legacy then 'snacky_buying_command_v1' else 'snacky_buying_checklist_command_v1' end,
 p_command), p_code, p_label);$$;

begin;
set local role authenticated;
do $$declare c jsonb; result jsonb; bad jsonb;begin
  c := public.checklist_test_command('create', 0, jsonb_build_object(
    'title', 'Market checklist', 'instructions', 'Get chips even when the exact flavour is unavailable.',
    'assigned_to', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'due_on', '2026-10-28',
    'items', jsonb_build_array(
      public.checklist_test_item('70000000-0000-4000-8000-000000000001', 'Chips - any suitable brand', 4, null, 'boxes', 'any_brand'),
      public.checklist_test_item('70000000-0000-4000-8000-000000000002', 'Bebeto - any flavour', 3, '88888888-8888-4888-8888-888888888888')
    )), p_request => '50000000-0000-4000-8000-000000000001');
  result := public.snacky_buying_checklist_command_v1(c);
  perform public.checklist_test_assert(result->>'revision' = '1', 'create generic and preferred-family needs');
  perform public.checklist_test_assert(result = public.snacky_buying_checklist_command_v1(c), 'create replay is exact and idempotent');
  perform public.checklist_test_reject(jsonb_set(c, '{request_id}', to_jsonb(gen_random_uuid())), '40001', 'different creation cannot replace an existing list');
  perform public.checklist_test_reject(jsonb_set(c, '{payload,title}', '"Changed identity"'), '23505', 'changed replay payload is rejected');
  bad := jsonb_set(jsonb_set(c, '{request_id}', to_jsonb(gen_random_uuid())), '{list_id}', '"60000000-0000-4000-8000-000000000004"');
  bad := jsonb_set(bad, '{payload,items,1,id}', bad#>'{payload,items,0,id}');
  perform public.checklist_test_reject(bad, '23505', 'duplicate item rolls back the whole creation');
  bad := jsonb_set(jsonb_set(c, '{request_id}', to_jsonb(gen_random_uuid())), '{list_id}', '"60000000-0000-4000-8000-000000000005"');
  bad := jsonb_set(bad, '{payload,items,1,product_id}', '"70000000-0000-4000-8000-000000009999"');
  perform public.checklist_test_reject(bad, '22023', 'unknown reference rolls back the whole creation');
  bad := jsonb_set(jsonb_set(c, '{request_id}', to_jsonb(gen_random_uuid())), '{list_id}', '"60000000-0000-4000-8000-000000000006"');
  bad := jsonb_set(bad, '{payload,items,0,unit}', '["boxes"]');
  perform public.checklist_test_reject(bad, '22023', 'enum arrays cannot impersonate string units');
  bad := jsonb_set(bad, '{payload,items,0,unit}', '"boxes"');
  bad := jsonb_set(bad, '{payload,items,0,flexibility}', '["any_flavour"]');
  perform public.checklist_test_reject(bad, '22023', 'enum arrays cannot impersonate flexibility');
  bad := jsonb_set(bad, '{payload,items,0,flexibility}', '"any_flavour"');
  bad := jsonb_set(bad, '{payload,items,0,unapproved}', 'true');
  perform public.checklist_test_reject(bad, '22023', 'unknown item properties rejected at database boundary');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('add', 1,
    jsonb_build_object('item', public.checklist_test_item('70000000-0000-4000-8000-000000000003', 'Water packs', 5, null, 'packs', 'exact'))));
end $$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
do $$declare c jsonb; result jsonb; item jsonb;begin
  result := public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000001');
  perform public.checklist_test_assert(result->>'planner' = 'false' and result#>>'{record,item_count}' = '3', 'assigned non-planner can load saved needs');
  perform public.checklist_test_assert(result#>'{record,items}' = '[]'::jsonb, 'market mode emits an empty exact-product list');
  item := result#>'{record,checklist_items,0}';
  perform public.checklist_test_assert((select count(*) from jsonb_object_keys(item)) = 9
    and item ?& array['id','product_id','label','quantity','unit','flexibility','acquired_quantity','unavailable','note'],
    'workspace returns the strict nine-key item DTO');
  perform public.checklist_test_reject_sql('select count(*) from buying_private.checklist_items', '42501', 'authenticated user cannot read the private table');
  c := public.checklist_test_command('progress', 2, '{"item_id":"70000000-0000-4000-8000-000000000001","acquired_quantity":1,"unavailable":false,"note":"Found one box"}',
    p_request => '50000000-0000-4000-8000-000000000002');
  result := public.snacky_buying_checklist_command_v1(c);
  perform public.checklist_test_assert(result->>'revision' = '3' and result = public.snacky_buying_checklist_command_v1(c), 'assigned buyer saves partial progress once');
  perform public.checklist_test_reject(jsonb_set(c, '{request_id}', to_jsonb(gen_random_uuid())), '40001', 'stale progress cannot overwrite newer revision');
  perform public.checklist_test_reject(jsonb_set(c, '{payload,note}', '"Altered retry"'), '23505', 'progress request cannot change on retry');
  perform public.checklist_test_reject(public.checklist_test_command('progress', 3,
    '{"item_id":"70000000-0000-4000-8000-000000000001","acquired_quantity":5,"unavailable":false,"note":""}'), '22023', 'cannot acquire more than requested');
  perform public.checklist_test_reject(public.checklist_test_command('progress', 3,
    '{"item_id":"70000000-0000-4000-8000-000000000001","acquired_quantity":1,"unavailable":true,"note":""}'), '22023', 'unavailable cannot hide a partial acquisition');
  perform public.checklist_test_reject(public.checklist_test_command('complete', 3, '{}'), '22023', 'incomplete and partial needs prevent completion');
  perform public.checklist_test_reject(public.checklist_test_command('complete', 3, '{}'), '22023', 'legacy complete cannot bypass the market guard', true);
  item := public.checklist_test_item('70000000-0000-4000-8000-000000000001', 'Chips priority', 4, null, 'packs', 'any_brand', 0);
  perform public.checklist_test_reject(public.checklist_test_command('edit', 3, jsonb_build_object('item', item)), '22023', 'unit change requires a separate progress reset');
  item := jsonb_set(jsonb_set(item, '{unit}', '"boxes"'), '{acquired_quantity}', '1');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('edit', 3, jsonb_build_object('item', item)));
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('progress', 4,
    '{"item_id":"70000000-0000-4000-8000-000000000001","acquired_quantity":0,"unavailable":false,"note":"Reset before repacking"}'));
  item := jsonb_set(jsonb_set(item, '{unit}', '"packs"'), '{acquired_quantity}', '0');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('edit', 5, jsonb_build_object('item', item)));
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('progress', 6,
    '{"item_id":"70000000-0000-4000-8000-000000000001","acquired_quantity":4,"unavailable":false,"note":"Alternative flavours found"}'));
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('progress', 7,
    '{"item_id":"70000000-0000-4000-8000-000000000002","acquired_quantity":0,"unavailable":true,"note":"Try another store"}'));
  c := public.checklist_test_command('remove', 8, '{"item_id":"70000000-0000-4000-8000-000000000003"}');
  result := public.snacky_buying_checklist_command_v1(c);
  perform public.checklist_test_assert(result = public.snacky_buying_checklist_command_v1(c), 'removal replay is idempotent');
  perform public.checklist_test_reject(public.checklist_test_command('remove', 9, c->'payload'), '22023', 'removed needs cannot be edited again');
  result := public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000001');
  perform public.checklist_test_assert(result#>>'{record,revision}' = '9'
    and result#>>'{record,item_count}' = '2' and result#>>'{record,acquired_count}' = '1'
    and result#>>'{record,remaining_count}' = '1' and result#>>'{record,unavailable_count}' = '1'
    and result#>>'{record,checked_count}' = '2', 'remaining view includes unavailable while checked count permits completion');
  perform public.checklist_test_assert(result#>>'{rows,0,item_count}' = '2' and result#>>'{rows,0,checked_count}' = '2', 'list summaries use market item counts');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('complete', 9, '{}'));
  perform public.checklist_test_reject(public.checklist_test_command('add', 10, jsonb_build_object('item', item)), '22023', 'closed checklist cannot change');
  perform public.checklist_test_reject(public.checklist_test_command('reopen', 10, '{}'), '42501', 'non-planner cannot reopen');
end $$;

select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
select public.checklist_test_reject_sql('select public.snacky_buying_workspace_v1(''60000000-0000-4000-8000-000000000001'')', '42501', 'other non-planner cannot read a checklist');
select public.checklist_test_reject(public.checklist_test_command('progress', 10,
  '{"item_id":"70000000-0000-4000-8000-000000000001","acquired_quantity":0,"unavailable":false,"note":""}'), '42501', 'other non-planner cannot write a checklist');

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select public.snacky_buying_checklist_command_v1(public.checklist_test_command('reopen', 10, '{}'));
select public.snacky_buying_checklist_command_v1(public.checklist_test_command('assign', 11,
  '{"assigned_to":"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}'));
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select public.checklist_test_reject_sql('select public.snacky_buying_workspace_v1(''60000000-0000-4000-8000-000000000001'')', '42501', 'reassignment removes old buyer visibility');
select public.checklist_test_reject(public.checklist_test_command('progress', 2,
  '{"item_id":"70000000-0000-4000-8000-000000000001","acquired_quantity":1,"unavailable":false,"note":"Found one box"}',
  p_request => '50000000-0000-4000-8000-000000000002'), '42501', 'old buyer cannot replay after access is removed');

reset role;
update public.profiles set role = 'finance', roles = array['finance'] where id = '11111111-1111-4111-8111-111111111111';
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
select public.checklist_test_assert(public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000001')#>>'{record,title}' = 'Market checklist', 'creator retains read access after losing planner role');
select public.checklist_test_reject(public.checklist_test_command('remove', 12,
  '{"item_id":"70000000-0000-4000-8000-000000000001"}'), '42501', 'creator visibility does not grant editing');
reset role;
update public.profiles set role = 'owner', roles = array['owner'] where id = '11111111-1111-4111-8111-111111111111';
update public.team_members set active = false where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', true);
set local role authenticated;
select public.checklist_test_reject_sql('select public.snacky_buying_workspace_v1(''60000000-0000-4000-8000-000000000001'')', '42501', 'deactivated assigned member loses access');
select set_config('request.jwt.claim.sub', '44444444-4444-4444-8444-444444444444', true);
select public.checklist_test_reject_sql('select public.snacky_buying_workspace_v1()', '42501', 'operator-only role stays outside buying');
select public.checklist_test_reject(public.checklist_test_command('remove', 12,
  '{"item_id":"70000000-0000-4000-8000-000000000001"}'), '42501', 'operator-only role cannot use the new command');
select set_config('request.jwt.claim.sub', '55555555-5555-4555-8555-555555555555', true);
select public.checklist_test_reject_sql('select public.snacky_buying_workspace_v1()', '42501', 'CRM-only role stays outside buying');
select set_config('request.jwt.claim.sub', '66666666-6666-4666-8666-666666666666', true);
select public.checklist_test_assert(public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000001')->>'planner' = 'true', 'additive warehouse permission is retained');
select set_config('request.jwt.claim.sub', '', true);
select public.checklist_test_reject_sql('select public.snacky_buying_workspace_v1()', '42501', 'authenticated role without a signed-in identity is denied');
set local role anon;
select public.checklist_test_reject_sql('select public.snacky_buying_checklist_command_v1(''{}''::jsonb)', '42501', 'anonymous users cannot call the command');
reset role;

-- Planner-level receipt access must still reject a market checklist.
update public.team_members set active = true where id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
select public.snacky_buying_checklist_command_v1(public.checklist_test_command('assign', 12,
  '{"assigned_to":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'));
select public.checklist_test_reject_sql('select public.snacky_buying_purchase_workspace_v1(''60000000-0000-4000-8000-000000000001'')', '22023', 'market intent cannot enter the exact linked receipt workspace');
select public.checklist_test_reject_sql('select public.snacky_buying_purchase_command_v1(''{"list_id":"60000000-0000-4000-8000-000000000001"}''::jsonb)', '22023', 'market intent cannot create a linked receipt');
select public.checklist_test_reject_sql('select buying_private.purchase_workspace(''60000000-0000-4000-8000-000000000001'')', '42501', 'legacy private receipt reader cannot bypass the mode guard');
select public.checklist_test_reject_sql('select buying_private.purchase_command(''{}''::jsonb)', '42501', 'legacy private receipt writer cannot bypass the mode guard');
select public.checklist_test_reject(public.checklist_test_command('add', 1,
  jsonb_build_object('item', public.checklist_test_item(gen_random_uuid(), 'No crossover', 1)),
  '60000000-0000-4000-8000-000000000002'), '22023', 'new commands cannot mutate a legacy exact list');

-- Legacy exact quantities, supplier guidance and the actual receipt reader remain usable.
select public.checklist_test_assert(public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000002')#>>'{record,items,0,name}' = 'Mr Crunch cheese', 'legacy exact-product list remains readable');
select public.snacky_buying_source_save_v1(jsonb_build_object('request_id', gen_random_uuid(),
  'list_id', '60000000-0000-4000-8000-000000000002', 'product_id', '99999999-9999-4999-8999-999999999999',
  'revision', 1, 'primary_supplier_id', '90000000-0000-4000-8000-000000000001', 'alternative_supplier_id', null, 'note', ''));
select public.snacky_buying_command_v1(public.checklist_test_command('item', 2,
  '{"product_id":"99999999-9999-4999-8999-999999999999","outcome":"bought","bought_boxes":2,"note":""}',
  '60000000-0000-4000-8000-000000000002'));
select public.checklist_test_assert(public.snacky_buying_purchase_workspace_v1('60000000-0000-4000-8000-000000000002')#>>'{items,0,remaining_units}' = '48', 'legacy receipt reader keeps exact bought units');
select public.snacky_buying_checklist_command_v1(public.checklist_test_command('cancel', 13, '{"reason":"Trip cancelled after testing"}'));
select public.checklist_test_reject(public.checklist_test_command('reopen', 14, '{}'), '22023', 'cancelled shopping history cannot be reopened');
reset role;

select public.checklist_test_assert((select count(*) from buying_private.lists) = 2, 'invalid create commands left no partial lists');
select public.checklist_test_assert((select count(*) from buying_private.checklist_items) = 3
  and (select count(*) from buying_private.checklist_items where removed_at is not null and removed_by is not null) = 1,
  'removed checklist rows retain their audit history');
select public.checklist_test_assert(not exists(select 1 from public.purchase_orders)
  and not exists(select 1 from public.purchase_order_lines)
  and not exists(select 1 from public.inventory_movements)
  and not exists(select 1 from public.financial_transactions), 'shopping commands create no purchase, stock or money writes');
select public.checklist_test_assert(not exists(select 1 from checklist_original_definitions d
  where pg_get_functiondef(d.name::regprocedure) is distinct from d.definition), 'legacy membership, command and receipt implementations stay unchanged');
select public.checklist_test_assert((select relrowsecurity from pg_class where oid = 'buying_private.checklist_items'::regclass)
  and not has_table_privilege('authenticated', 'buying_private.checklist_items', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('anon', 'buying_private.checklist_items', 'SELECT,INSERT,UPDATE,DELETE'), 'private checklist table has RLS and no direct client grants');
select public.checklist_test_assert(not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('snacky_buying_workspace_v1','snacky_buying_checklist_command_v1',
    'snacky_buying_purchase_workspace_v1','snacky_buying_purchase_command_v1')
  and (p.prosecdef or has_function_privilege('anon', p.oid, 'EXECUTE'))), 'public RPC wrappers stay invoker-only and authenticated-only');
select public.checklist_test_assert(not has_function_privilege('authenticated', 'buying_private.checklist_counts(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'buying_private.checklist_item_value(jsonb)', 'EXECUTE'), 'private helpers are not callable by clients');

-- Insert fixture receipt evidence directly as the test administrator, then
-- exercise the unchanged predecessor triggers against it.
insert into public.purchase_orders(id, supplier_id, total_amount) values
 ('80000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000001', 24);
insert into public.purchase_order_lines(id, purchase_order_id, product_id, total_units, units_per_box) values
 ('80000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', '99999999-9999-4999-8999-999999999999', 24, 24);
insert into buying_private.purchase_links(purchase_id, list_id, buyer_id, supplier_id, receipt_sha256, snapshot) values
 ('80000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '90000000-0000-4000-8000-000000000001', repeat('a',64), '{"lines":[]}');
select public.checklist_test_reject_sql('update buying_private.items set outcome=''pending'', bought_boxes=0 where list_id=''60000000-0000-4000-8000-000000000002''',
  '23514', 'legacy invoice quantity guard is still enforced');
select public.checklist_test_reject_sql('update public.purchase_order_lines set total_units=25 where id=''80000000-0000-4000-8000-000000000002''',
  '23514', 'legacy linked receipt line snapshot remains immutable');
select public.checklist_test_reject_sql('update public.purchase_orders set total_amount=25 where id=''80000000-0000-4000-8000-000000000001''',
  '23514', 'legacy linked receipt header snapshot remains immutable');

-- Exercise the active-row bound and a catalogue reference changing after the
-- buyer has already started shopping. Progress must stay usable without a SKU.
set local role authenticated;
do $$declare selected_items jsonb; result jsonb;begin
  select jsonb_agg(public.checklist_test_item(
    ('71000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
    'Fixture need ' || n, 2,
    case when n = 1 then '88888888-8888-4888-8888-888888888888'::uuid else null end
  ) order by n) into selected_items from generate_series(1,200) n;
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('create', 0,
    jsonb_build_object('title','Capacity fixture','instructions','','assigned_to','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'due_on','2026-10-28','items',selected_items), '60000000-0000-4000-8000-000000000003'));
  perform public.checklist_test_reject(public.checklist_test_command('add', 1,
    jsonb_build_object('item', public.checklist_test_item('71000000-0000-4000-8000-000000000201','Extra',1)),
    '60000000-0000-4000-8000-000000000003'), '22023', 'active row limit is enforced on add');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('remove', 1,
    '{"item_id":"71000000-0000-4000-8000-000000000200"}', '60000000-0000-4000-8000-000000000003'));
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('add', 2,
    jsonb_build_object('item', public.checklist_test_item('71000000-0000-4000-8000-000000000201','Replacement',1)),
    '60000000-0000-4000-8000-000000000003'));
  result := public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000003');
  perform public.checklist_test_assert(result#>>'{record,item_count}' = '200', 'removed history does not consume the active row limit');
end $$;
reset role;
update public.products set active = false where id = '88888888-8888-4888-8888-888888888888';
set local role authenticated;
do $$declare item jsonb; result jsonb;begin
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('progress', 3,
    '{"item_id":"71000000-0000-4000-8000-000000000001","acquired_quantity":1,"unavailable":false,"note":"Different flavour found"}',
    '60000000-0000-4000-8000-000000000003'));
  result := public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000003');
  item := result#>'{record,checklist_items,0}';
  perform public.checklist_test_assert(item->>'acquired_quantity' = '1', 'catalogue deactivation does not block shopping progress');
  item := item || '{"label":"Bebeto preferred example - any flavour","quantity":3}'::jsonb;
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('edit', 4,
    jsonb_build_object('item',item), '60000000-0000-4000-8000-000000000003'));
  result := public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000003');
  perform public.checklist_test_assert(result#>>'{record,checklist_items,0,label}' = 'Bebeto preferred example - any flavour'
    and result#>>'{record,checklist_items,0,quantity}' = '3'
    and result#>>'{record,checklist_items,0,product_id}' = '88888888-8888-4888-8888-888888888888',
    'inactive preferred example does not block label or quantity edits');
  perform public.checklist_test_reject(public.checklist_test_command('edit', 5,
    jsonb_build_object('item', jsonb_set(item, '{product_id}', '"70000000-0000-4000-8000-000000009999"')),
    '60000000-0000-4000-8000-000000000003'), '22023', 'unknown preferred example is still rejected on edit');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('create', 0,
    jsonb_build_object('title','Saved draft with an inactive example','instructions','',
      'assigned_to','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','due_on','2026-10-28',
      'items',jsonb_build_array(jsonb_set(item, '{id}', '"72000000-0000-4000-8000-000000000001"'))),
    '60000000-0000-4000-8000-000000000004'));
  result := public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000004');
  perform public.checklist_test_assert(result#>>'{record,checklist_items,0,product_id}' = '88888888-8888-4888-8888-888888888888'
    and result#>>'{record,checklist_items,0,acquired_quantity}' = '1',
    'draft with a deactivated preferred example can publish with its progress');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('add', 1,
    jsonb_build_object('item', public.checklist_test_item('72000000-0000-4000-8000-000000000002',
      'Another optional example', 2, '77777777-7777-4777-8777-777777777777')),
    '60000000-0000-4000-8000-000000000004'));
  result := public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000004');
  perform public.checklist_test_assert(result#>>'{record,item_count}' = '2'
    and result#>>'{record,checklist_items,1,product_id}' = '77777777-7777-4777-8777-777777777777',
    'new need can use an existing inactive preferred example');
  item := jsonb_set(item, '{product_id}', 'null');
  perform public.snacky_buying_checklist_command_v1(public.checklist_test_command('edit', 5,
    jsonb_build_object('item',item), '60000000-0000-4000-8000-000000000003'));
  perform public.checklist_test_assert(public.snacky_buying_workspace_v1('60000000-0000-4000-8000-000000000003')#>'{record,checklist_items,0,product_id}' = 'null'::jsonb,
    'clearing an inactive preference preserves the generic need');
  perform public.checklist_test_reject(public.checklist_test_command('assign', 6,
    '{"assigned_to":"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}', '60000000-0000-4000-8000-000000000003'),
    '22023', 'operator-only employee cannot be assigned buying work');
  perform public.checklist_test_reject(public.checklist_test_command('assign', 6,
    '{"assigned_to":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"}', '60000000-0000-4000-8000-000000000003'),
    '22023', 'CRM-only employee cannot be assigned buying work');
  perform public.checklist_test_reject(public.checklist_test_command('edit', 6,
    jsonb_build_object('item', item - 'product_id'), '60000000-0000-4000-8000-000000000003'),
    '22023', 'database requires the explicit nullable product-reference key');
end $$;
reset role;

select count(*) as passed_sql_assertions from public.checklist_test_results;
rollback;
\echo 'Market checklist SQL access, replay, editing, progress, receipt-isolation and legacy invariants passed.'
