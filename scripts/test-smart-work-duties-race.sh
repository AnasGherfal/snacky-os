#!/usr/bin/env bash
set -euo pipefail
# Isolated CI database only, supplied by the workflow's local PostgreSQL container.
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
insert into public.machines(id,name) values('10000000-0000-0000-0000-000000000099','Concurrent new duty');
insert into public.machine_slots(machine_id,slot_code) values('10000000-0000-0000-0000-000000000099','001');
insert into public.latest_vms_stock_by_slot(machine_id,slot_code,product_id,current_qty,capacity,captured_at) values('10000000-0000-0000-0000-000000000099','001','20000000-0000-0000-0000-000000000001',0,8,now());
SQL
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "begin;set role service_role;select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000002');select pg_sleep(1);commit;" > /tmp/duty-race-a.log &
a=$!
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -c "begin;set role service_role;select public.snacky_refresh_smart_work_duties('00000000-0000-0000-0000-000000000003');commit;" > /tmp/duty-race-b.log &
b=$!
wait "$a"; wait "$b"
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
do $$begin
 if (select count(*) from public.smart_work_duties where machine_id='10000000-0000-0000-0000-000000000099' and completed_at is null)<>1 then raise exception 'Concurrent refresh duplicated duty';end if;
 if exists(select 1 from public.smart_work_duties d where (select count(*) from public.smart_work_duty_events e where e.duty_id=d.id)<>d.revision) then raise exception 'Missing audit revision';end if;
end $$;
SQL
echo 'PASS: separate database sessions produced one durable obligation with complete audit history'
