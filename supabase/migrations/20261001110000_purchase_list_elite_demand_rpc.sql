-- Compute a compact scheduled-site purchase forecast inside Postgres instead
-- of loading thousands of raw XY stock rows into the Purchase List page.

create or replace function snacky_private.purchase_scheduled_site_demand_v1_impl(
  p_vms_machine_id text,
  p_coverage_days integer,
  p_previous_start date,
  p_previous_end date,
  p_current_start date,
  p_current_end date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, snacky_private
as $$
declare
  v_actor uuid := auth.uid();
  v_machine_id uuid;
  v_site_name text;
  v_open_days smallint[];
  v_today date := (now() at time zone 'Africa/Tripoli')::date;
  v_observed_days integer := 0;
  v_coverage_operating_days integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_observed_total integer := 0;
  v_projected_total integer := 0;
begin
  if v_actor is null
     or not public.snacky_current_profile_has_any_role(
       array['owner','admin','supervisor','warehouse','purchasing','finance']
     ) then
    raise exception 'Purchase forecast access denied' using errcode='42501';
  end if;

  if nullif(trim(coalesce(p_vms_machine_id,'')),'') is null
     or length(trim(p_vms_machine_id)) > 120 then
    raise exception 'A valid VMS machine reference is required' using errcode='22023';
  end if;

  if p_coverage_days is null or p_coverage_days < 1 or p_coverage_days > 90 then
    raise exception 'Coverage days must be between 1 and 90' using errcode='22023';
  end if;

  if (p_previous_start is null) <> (p_previous_end is null)
     or (p_current_start is null) <> (p_current_end is null)
     or (p_previous_start is not null and p_previous_start > p_previous_end)
     or (p_current_start is not null and p_current_start > p_current_end) then
    raise exception 'Sales report periods are invalid' using errcode='22023';
  end if;

  select m.id,
         coalesce(nullif(trim(m.name),''),nullif(trim(m.machine_code),''),trim(p_vms_machine_id)),
         coalesce(m.refill_open_days,array[1,2,3,4,5]::smallint[])
  into v_machine_id,v_site_name,v_open_days
  from public.machines m
  where m.vms_machine_id=trim(p_vms_machine_id)
    and m.status='active'
  order by m.updated_at desc nulls last,m.id
  limit 1;

  if v_machine_id is null then
    raise exception 'Scheduled purchase site was not found' using errcode='P0002';
  end if;

  if cardinality(v_open_days) < 1 then
    raise exception 'Scheduled purchase site has no operating days' using errcode='23514';
  end if;

  select count(*)::integer
  into v_coverage_operating_days
  from generate_series(0,p_coverage_days-1) as g(offset_days)
  where exists (
    select 1
    from unnest(v_open_days) as d(day_no)
    where d.day_no::integer=extract(isodow from (v_today + g.offset_days::integer))::integer
  );

  with snapshot_agg as (
    select
      v.product_id,
      (v.captured_at at time zone 'Africa/Tripoli')::date as day,
      coalesce(v.sync_run_id::text,v.import_batch_id::text,v.captured_at::text) as snapshot_key,
      max(v.captured_at) as captured_at,
      sum(greatest(coalesce(v.current_qty,0),0))::numeric as qty
    from public.vms_stock_snapshots v
    where v.machine_id=v_machine_id
      and v.product_id is not null
      and v.import_row_status='imported'
      and v.captured_at >= now()-interval '21 days'
      and (v.captured_at at time zone 'Africa/Tripoli')::date < v_today
      and exists (
        select 1
        from unnest(v_open_days) as d(day_no)
        where d.day_no::integer=extract(isodow from (v.captured_at at time zone 'Africa/Tripoli'))::integer
      )
    group by
      v.product_id,
      (v.captured_at at time zone 'Africa/Tripoli')::date,
      coalesce(v.sync_run_id::text,v.import_batch_id::text,v.captured_at::text)
  ),
  day_span as (
    select
      day,
      min(captured_at) as first_at,
      max(captured_at) as last_at,
      extract(epoch from (max(captured_at)-min(captured_at)))/3600 as span_hours
    from snapshot_agg
    group by day
  ),
  eligible_days as (
    select day
    from day_span
    where span_hours>=6
    order by day desc
    limit 10
  ),
  ranked as (
    select
      s.*,
      row_number() over(partition by s.product_id,s.day order by s.captured_at) as rn_first,
      row_number() over(partition by s.product_id,s.day order by s.captured_at desc) as rn_last
    from snapshot_agg s
    join eligible_days e using(day)
  ),
  daily as (
    select
      product_id,
      day,
      max(qty) filter(where rn_first=1) as start_qty,
      max(qty) filter(where rn_last=1) as end_qty
    from ranked
    group by product_id,day
  ),
  fills as (
    select
      f.product_id,
      (f.created_at at time zone 'Africa/Tripoli')::date as day,
      sum(greatest(coalesce(f.actual_qty,0),0))::numeric as fill_qty
    from public.route_stop_fill_lines f
    join eligible_days d on d.day=(f.created_at at time zone 'Africa/Tripoli')::date
    where f.machine_id=v_machine_id
      and f.product_id is not null
    group by f.product_id,(f.created_at at time zone 'Africa/Tripoli')::date
  ),
  consumption as (
    select
      d.product_id,
      d.day,
      greatest(0,d.start_qty+coalesce(f.fill_qty,0)-d.end_qty)::numeric as consumed
    from daily d
    left join fills f using(product_id,day)
  ),
  product_day as (
    select
      p.product_id,
      e.day,
      coalesce(c.consumed,0)::numeric as consumed
    from (select distinct product_id from consumption) p
    cross join eligible_days e
    left join consumption c
      on c.product_id=p.product_id
     and c.day=e.day
  ),
  day_count as (
    select count(*)::integer as observed_days
    from eligible_days
  ),
  by_product as (
    select
      pd.product_id,
      dc.observed_days,
      sum(pd.consumed)::numeric as observed_units,
      sum(pd.consumed) filter(
        where pd.day in (select day from eligible_days order by day desc limit 2)
      )::numeric as recent_units,
      case
        when p_previous_start is null then 0::numeric
        else coalesce(sum(pd.consumed) filter(
          where pd.day between p_previous_start and p_previous_end
        ),0)
      end::numeric as previous_units,
      case
        when p_current_start is null then 0::numeric
        else coalesce(sum(pd.consumed) filter(
          where pd.day between p_current_start and p_current_end
        ),0)
      end::numeric as current_units
    from product_day pd
    cross join day_count dc
    group by pd.product_id,dc.observed_days
  ),
  scored as (
    select
      bp.product_id,
      bp.observed_days,
      bp.observed_units,
      greatest(
        bp.observed_units/greatest(bp.observed_days,1),
        coalesce(bp.recent_units,0)/least(greatest(bp.observed_days,1),2)
      )::numeric as daily_rate,
      bp.previous_units,
      bp.current_units
    from by_product bp
  ),
  projected as (
    select
      s.*,
      ceil(s.daily_rate*v_coverage_operating_days)::integer as projected_units
    from scored s
    where s.observed_units>0
      and s.daily_rate>0
  )
  select
    coalesce(max(p.observed_days),0)::integer,
    coalesce(sum(p.observed_units),0)::integer,
    coalesce(sum(p.projected_units),0)::integer,
    coalesce(jsonb_agg(
      jsonb_build_object(
        'product_id',p.product_id,
        'site_name',v_site_name,
        'observed_operating_days',p.observed_days,
        'coverage_operating_days',v_coverage_operating_days,
        'observed_units',p.observed_units::integer,
        'projected_units',p.projected_units,
        'daily_rate',round(p.daily_rate,2),
        'previous_period_units',p.previous_units::integer,
        'current_period_units',p.current_units::integer
      )
      order by p.projected_units desc,p.product_id
    ),'[]'::jsonb)
  into v_observed_days,v_observed_total,v_projected_total,v_rows
  from projected p;

  if v_observed_days < 2 or jsonb_array_length(v_rows)=0 then
    raise exception 'Scheduled purchase site needs at least two complete operating days' using errcode='23514';
  end if;

  return jsonb_build_object(
    'machine_id',v_machine_id,
    'vms_machine_id',trim(p_vms_machine_id),
    'site_name',v_site_name,
    'open_days',to_jsonb(v_open_days),
    'coverage_days',p_coverage_days,
    'coverage_operating_days',v_coverage_operating_days,
    'observed_operating_days',v_observed_days,
    'observed_units',v_observed_total,
    'projected_units',v_projected_total,
    'rows',v_rows
  );
end;
$$;

revoke all on function snacky_private.purchase_scheduled_site_demand_v1_impl(text,integer,date,date,date,date)
  from public,anon;
grant execute on function snacky_private.purchase_scheduled_site_demand_v1_impl(text,integer,date,date,date,date)
  to authenticated,service_role;

create or replace function public.snacky_purchase_scheduled_site_demand_v1(
  p_vms_machine_id text,
  p_coverage_days integer,
  p_previous_start date default null,
  p_previous_end date default null,
  p_current_start date default null,
  p_current_end date default null
)
returns jsonb
language sql
stable
set search_path=public,auth,snacky_private
as $$
  select snacky_private.purchase_scheduled_site_demand_v1_impl(
    p_vms_machine_id,
    p_coverage_days,
    p_previous_start,
    p_previous_end,
    p_current_start,
    p_current_end
  );
$$;

revoke all on function public.snacky_purchase_scheduled_site_demand_v1(text,integer,date,date,date,date)
  from public,anon;
grant execute on function public.snacky_purchase_scheduled_site_demand_v1(text,integer,date,date,date,date)
  to authenticated,service_role;

select pg_notify('pgrst','reload schema');
