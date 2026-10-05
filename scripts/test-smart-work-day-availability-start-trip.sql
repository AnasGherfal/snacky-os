\set ON_ERROR_STOP on
begin;
update public.smart_work_coverage_settings set value=jsonb_build_object('mode','days','days',jsonb_build_array(extract(isodow from now() at time zone 'Africa/Tripoli')::int),'enabled',true)
where kind='operator' and operator_id=test_uuid(201);
update public.smart_work_coverage_settings set value=jsonb_build_object('primaryId',test_uuid(201),'backupId',test_uuid(202),'mode','standing','enabled',true)
where kind='machine' and machine_id=test_uuid(1);
update public.smart_work_duties set due_at=null,expected_minutes=null,blocker=null,revision=revision+1,updated_by=test_uuid(201),updated_at=now() where id=test_uuid(301);
select test_start(420) as result \gset
select test_assert((select count(*)=1 from routes),'weekday-only operator can start one standing machine');
select test_assert((select planned_qty=5 and picked_qty=0 from route_stock_lines where route_id=(:'result'::jsonb->>'routeId')::uuid),'standing trip reserves stock without deducting pickup');
set constraints all immediate;
rollback;

begin;
update public.smart_work_coverage_settings set value=jsonb_build_object('mode','days','days',
  (select coalesce(jsonb_agg(d),'[]'::jsonb) from generate_series(1,7)d where d<>extract(isodow from now() at time zone 'Africa/Tripoli')::int),'enabled',true)
where kind='operator' and operator_id=test_uuid(201);
update public.smart_work_coverage_settings set value=jsonb_build_object('primaryId',test_uuid(201),'backupId',test_uuid(202),'mode','standing','enabled',true)
where kind='machine' and machine_id=test_uuid(1);
update public.smart_work_duties set due_at=null,expected_minutes=null,blocker=null,revision=revision+1,updated_by=test_uuid(201),updated_at=now() where id=test_uuid(301);
select test_error('select test_start(421)','22023','operator cannot Start Trip on an unavailable weekday');
select test_assert((select count(*)=0 from routes),'unavailable weekday creates no route');
select test_assert((select count(*)=0 from smart_work_trip_requests),'unavailable weekday creates no request receipt');
rollback;

begin;
update public.smart_work_coverage_settings set value=jsonb_build_object('mode','days','days',jsonb_build_array(extract(isodow from now() at time zone 'Africa/Tripoli')::int),'enabled',true)
where kind='operator' and operator_id=test_uuid(201);
update public.smart_work_coverage_settings set value=jsonb_build_object('primaryId',test_uuid(201),'backupId',test_uuid(202),'mode','standing','enabled',true)
where kind='machine' and machine_id in (test_uuid(1),test_uuid(2));
update public.smart_work_duties set due_at=null,expected_minutes=null,blocker=null,revision=revision+1,updated_by=test_uuid(201),updated_at=now()
where id in (test_uuid(301),test_uuid(302));
update public.smart_work_duties set priority='immediate',revision=revision+1,updated_by=test_uuid(201),updated_at=now() where id=test_uuid(302);
select test_error('select test_start(422,array[test_uuid(301)])','40001','null deadlines still respect higher priority work');
rollback;
