\set ON_ERROR_STOP on
create function pg_temp.assert_true(ok boolean,label text) returns void language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;

select pg_temp.assert_true((select relrowsecurity from pg_class where oid='public.smart_work_dispatch_scope'::regclass),'pilot scope RLS enabled');
select pg_temp.assert_true(not has_table_privilege('anon','public.smart_work_dispatch_scope','SELECT'),'anon cannot read pilot scope');
select pg_temp.assert_true(not has_table_privilege('authenticated','public.smart_work_dispatch_scope','SELECT'),'browser cannot read pilot scope');
select pg_temp.assert_true(has_table_privilege('service_role','public.smart_work_dispatch_scope','SELECT'),'server may read pilot scope');
select pg_temp.assert_true(not has_table_privilege('service_role','public.smart_work_dispatch_scope','INSERT,UPDATE,DELETE'),'application cannot change rollout scope');
select pg_temp.assert_true((select mode='all' from public.smart_work_dispatch_control where id=1),'legacy enabled gate defaults to all mode');

begin;
update public.smart_work_dispatch_control
set enabled=true,mode='pilot',updated_by=test_uuid(201),updated_at=now()
where id=1;
insert into public.smart_work_dispatch_scope(operator_id,machine_id,created_by)
values(test_uuid(201),test_uuid(1),test_uuid(201));
select test_start(601) as result \gset
select pg_temp.assert_true((select count(*)=1 from public.routes),'scoped operator and machine may start pilot trip');
select pg_temp.assert_true((select count(*)=1 from public.smart_work_trip_requests),'pilot trip gets one immutable receipt');
set constraints all immediate;
rollback;

begin;
update public.smart_work_dispatch_control
set enabled=true,mode='pilot',updated_by=test_uuid(201),updated_at=now()
where id=1;
delete from public.smart_work_dispatch_scope;
select test_error('select test_start(602)','42501','unscoped operator cannot start pilot trip');
select pg_temp.assert_true((select count(*)=0 from public.routes),'unscoped pilot attempt creates no route');
rollback;

begin;
update public.smart_work_dispatch_control
set enabled=true,mode='pilot',updated_by=test_uuid(201),updated_at=now()
where id=1;
delete from public.smart_work_dispatch_scope;
insert into public.smart_work_dispatch_scope(operator_id,machine_id,created_by)
values(test_uuid(201),test_uuid(1),test_uuid(201));
select test_error('select test_start(603,array[test_uuid(302)])','42501','scoped operator cannot start an unscoped machine');
select pg_temp.assert_true((select count(*)=0 from public.routes),'unscoped machine attempt creates no route');
rollback;

begin;
update public.smart_work_dispatch_control
set enabled=true,mode='all',updated_by=test_uuid(201),updated_at=now()
where id=1;
delete from public.smart_work_dispatch_scope;
select test_start(604);
select pg_temp.assert_true((select count(*)=1 from public.routes),'all mode remains compatible without pilot rows');
set constraints all immediate;
rollback;

begin;
update public.smart_work_dispatch_control
set enabled=false,mode='off',updated_by=test_uuid(201),updated_at=now()
where id=1;
delete from public.smart_work_dispatch_scope;
select test_error('select test_start(605)','55000','off mode remains disabled');
rollback;
