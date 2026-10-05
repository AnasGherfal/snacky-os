#!/usr/bin/env bash
set -euo pipefail
# Refuse to run this destructive fixture reset against anything but the isolated CI database.
[[ "${PGHOST:-}" == "localhost" && "${PGDATABASE:-}" == "smart_trip_test" ]] || { echo 'Isolated CI database required'; exit 1; }
psql -v ON_ERROR_STOP=1 -Atc "select test_assert(current_database()='smart_trip_test','isolated database verified')" >/dev/null
reset_fixture() {
  psql -v ON_ERROR_STOP=1 <<'SQL'
truncate public.smart_work_trip_requests,public.routes,public.route_stops,public.route_stock_lines,public.route_stop_items,public.inventory_movements,public.smart_work_duty_events cascade;
update public.smart_work_duties set route_stop_id=null,revision=revision+1,owner_id=test_uuid(201),assigned_via='primary',blocker=null,state='required';
insert into public.inventory_movements(product_id,from_entity_type,to_entity_type,quantity) values(test_uuid(21),'supplier','storage',5),(test_uuid(22),'supplier','storage',30);
update public.latest_vms_stock_by_slot set current_qty=1,capacity=6,captured_at=clock_timestamp();
SQL
}
wait_for_writer() {
  for _ in $(seq 1 50); do
    if [[ "$(psql -Atc "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='smart_trip_writer' and l.locktype='advisory' and l.granted")" != '0' ]]; then return 0; fi
    sleep .1
  done
  echo 'Writer did not acquire its lock'; return 1
}
expect_failure() {
  local query="$1" code="$2" label="$3"
  if psql -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -c "$query" >/tmp/trip-race-error.log 2>&1; then
    cat /tmp/trip-race-error.log; echo "FAIL: $label unexpectedly succeeded"; exit 1
  fi
  grep -q "$code" /tmp/trip-race-error.log || { cat /tmp/trip-race-error.log; exit 1; }
  echo "PASS: $label"
}
reset_fixture
PGAPPNAME=smart_trip_writer psql -v ON_ERROR_STOP=1 -c "begin;select test_start(501);select pg_sleep(3);commit" >/tmp/trip-race-a.log 2>&1 &
writer=$!
wait_for_writer
expect_failure 'select test_start(502)' '40001' 'competing same-machine start is retryable, not duplicated'
# A manual writer participates in the same lock, rather than relying on Start Trip callers alone.
expect_failure "insert into routes(id,route_date,operator_id,status) values(test_uuid(901),current_date,test_uuid(202),'assigned')" '40001' 'manual route write cannot pass through an in-flight smart commit'
wait "$writer" || { cat /tmp/trip-race-a.log; exit 1; }
psql -v ON_ERROR_STOP=1 <<'SQL'
select test_assert((test_start(501)->>'replayed')::boolean,'lost response retry finds committed route');
select test_assert((select count(*)=1 from routes),'one route after competing starts');
select test_assert((select sum(planned_qty)=5 from route_stock_lines),'one reservation after competing starts');
select test_assert((select count(*)=2 from smart_work_duties where route_stop_id is null),'unselected duties survive competing sessions');
SQL
reset_fixture
psql -v ON_ERROR_STOP=1 -c "update smart_work_duties set owner_id=test_uuid(202),assigned_via='backup',revision=revision+1 where id=test_uuid(303)" >/dev/null
PGAPPNAME=smart_trip_writer psql -v ON_ERROR_STOP=1 -c "begin;select test_start(503);select pg_sleep(3);commit" >/tmp/trip-race-a.log 2>&1 &
writer=$!
wait_for_writer
other="select snacky_start_smart_work_trip_v1(test_uuid(102),test_uuid(202),test_uuid(504),array[test_uuid(303)],repeat('b',64),test_trip_plan(array[test_uuid(303)]))"
expect_failure "$other" '40001' 'second operator cannot concurrently claim the same last product units'
wait "$writer" || { cat /tmp/trip-race-a.log; exit 1; }
expect_failure "$other" '23514' 'retry rechecks storage after the first operator reserved it'
psql -v ON_ERROR_STOP=1 <<'SQL'
select test_assert((select count(*)=1 from routes),'different-machine stock race creates only the supplied route');
select test_assert((select route_stop_id is null and owner_id=test_uuid(202) from smart_work_duties where id=test_uuid(303)),'unsupplied backup duty remains owned and outstanding');
select test_assert((select quantity_on_hand=5 from route_storage_stock_by_product where product_id=test_uuid(21)),'race did not deduct uncollected warehouse goods');
SQL
