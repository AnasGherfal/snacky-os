-- Server-side XY inventory-depletion history for conservative in-app activity alerts.
-- No new sales transactions are inferred; only observed same-product slot decreases.
-- Include individually validated rows from otherwise partial XY batches in the
-- HISTORICAL trend only; current alerting still requires an active fresh batch.
-- Read permissions are service_role-only; no direct user, anonymous or browser access.
create or replace function public.snacky_xy_stock_activity_history(p_days integer default 29)
returns table (
  machine_id uuid,
  last_observed_at timestamptz,
  last_decrease_at timestamptz,
  recent_slots integer,
  recent_stocked_slots integer,
  hourly jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
with source_rows as (
  select s.machine_id,s.slot_code,s.current_qty,s.capacity,
         s.vms_product_id,s.captured_at,s.created_at,s.import_batch_id
  from public.vms_stock_snapshots s
  join public.vms_import_batches b on b.id=s.import_batch_id
  join public.machines m on m.id=s.machine_id
  where s.source_provider='xy'
    and s.import_row_status='imported'
    and s.captured_at >= now() - make_interval(days => least(greatest(p_days,7),35))
    and b.status in ('imported','imported_with_warnings','partially_imported')
    and b.deleted_at is null
    and m.status='active'
    and m.vms_machine_id is not null
    and s.slot_code is not null
    and coalesce(s.metadata->>'freshness','') <> 'stale_verified_fallback'
    and s.capacity>0 and s.current_qty between 0 and s.capacity
),
ordered as (
  select s.*,
         lag(s.current_qty) over w previous_qty,
         lag(s.vms_product_id) over w previous_product,
         lag(s.captured_at) over w previous_at
  from source_rows s
  window w as (partition by s.machine_id,s.slot_code
               order by s.captured_at,s.created_at,s.import_batch_id)
),
readings as (
  select o.*,
    case when o.previous_qty>o.current_qty
       and o.previous_product=o.vms_product_id
       and o.vms_product_id is not null
       and o.captured_at-o.previous_at between interval '1 second' and interval '60 minutes'
       and o.previous_qty-o.current_qty<=8
    then o.previous_qty-o.current_qty else 0 end as decreased_units
  from ordered o
),
recent as (
  select machine_id,max(captured_at) last_observed_at,
    count(distinct slot_code) filter(where captured_at>now()-interval '25 minutes')::integer recent_slots,
    count(distinct slot_code) filter(where captured_at>now()-interval '25 minutes' and current_qty>0)::integer recent_stocked_slots,
    max(captured_at) filter(where decreased_units>0) last_decrease_at
  from readings group by machine_id
),
hours as (
  select machine_id,
    (captured_at at time zone 'Africa/Tripoli')::date as local_day,
    extract(hour from captured_at at time zone 'Africa/Tripoli')::integer as local_hour,
    count(distinct import_batch_id)::integer as batches,
    count(distinct slot_code)::integer as slots,
    sum(case when decreased_units>0 then 1 else 0 end)::integer as decrease_events,
    sum(decreased_units)::integer as decrease_units
  from readings group by machine_id,local_day,local_hour
),
bundles as (
  select machine_id,jsonb_agg(jsonb_build_object(
    'day',local_day::text,'hour',local_hour,'batches',batches,'slots',slots,
    'events',decrease_events,'units',decrease_units
  ) order by local_day,local_hour) as hourly
  from hours group by machine_id
)
select r.machine_id,r.last_observed_at,r.last_decrease_at,
       r.recent_slots,r.recent_stocked_slots,
       coalesce(h.hourly,'[]'::jsonb)
from recent r left join bundles h on h.machine_id=r.machine_id
$function$;

revoke all on function public.snacky_xy_stock_activity_history(integer) from public,anon,authenticated;
grant execute on function public.snacky_xy_stock_activity_history(integer) to service_role;

comment on function public.snacky_xy_stock_activity_history(integer) is
'Machine-slot same-product inventory decreases by Tripoli local day/hour; service-only inference, never authoritative sales.';
