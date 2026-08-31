-- XY returns spjg/spjj in minor units (300 means 3.00 LYD).
-- Preserve raw provider JSON and repair only products/snapshots proven to come from XY.

with latest_xy as (
  select distinct on(s.product_id)
    s.product_id,(s.raw_data->>'spjg')::numeric raw_selling,
    nullif(s.raw_data->>'spjj','')::numeric raw_cost
  from public.vms_product_catalog_snapshots s
  join public.vms_sync_runs r on r.id=s.sync_run_id and r.provider='xy'
  where s.product_id is not null and (s.raw_data->>'spjg') ~ '^[0-9]+(\\.[0-9]+)?$'
  order by s.product_id,s.captured_at desc,s.id desc
)
update public.products p
set
  selling_price=case when p.selling_price_source='vms' and p.selling_price=x.raw_selling then round(x.raw_selling/100,2) else p.selling_price end,
  current_selling_price_lyd=case when p.selling_price_source='vms' and p.current_selling_price_lyd=x.raw_selling then round(x.raw_selling/100,2) else p.current_selling_price_lyd end,
  vms_selling_price_lyd=case when p.vms_selling_price_lyd=x.raw_selling then round(x.raw_selling/100,2) else p.vms_selling_price_lyd end,
  cost_price=case when p.cost_price_source='vms' and x.raw_cost is not null and p.cost_price=x.raw_cost then round(x.raw_cost/100,4) else p.cost_price end,
  current_cost_price_lyd=case when p.cost_price_source='vms' and x.raw_cost is not null and p.current_cost_price_lyd=x.raw_cost then round(x.raw_cost/100,4) else p.current_cost_price_lyd end,
  price_updated_at=now(),updated_at=now()
from latest_xy x
where p.id=x.product_id
  and (
    (p.selling_price_source='vms' and (p.selling_price=x.raw_selling or p.current_selling_price_lyd=x.raw_selling))
    or p.vms_selling_price_lyd=x.raw_selling
    or (p.cost_price_source='vms' and x.raw_cost is not null
      and (p.cost_price=x.raw_cost or p.current_cost_price_lyd=x.raw_cost))
  );

update public.vms_product_catalog_snapshots s
set selling_price_lyd=round((s.raw_data->>'spjg')::numeric/100,2)
from public.vms_sync_runs r
where r.id=s.sync_run_id and r.provider='xy'
  and (s.raw_data->>'spjg') ~ '^[0-9]+(\.[0-9]+)?$'
  and s.selling_price_lyd=(s.raw_data->>'spjg')::numeric;

update public.vms_product_mappings m
set
  vms_selling_price_lyd=case
    when (m.vms_raw_metadata->'raw'->>'spjg') ~ '^[0-9]+(\.[0-9]+)?$'
      and m.vms_selling_price_lyd=(m.vms_raw_metadata->'raw'->>'spjg')::numeric
      then round((m.vms_raw_metadata->'raw'->>'spjg')::numeric/100,2)
    else m.vms_selling_price_lyd end,
  vms_cost_price_lyd=case
    when (m.vms_raw_metadata->'raw'->>'spjj') ~ '^[0-9]+(\.[0-9]+)?$'
      and m.vms_cost_price_lyd=(m.vms_raw_metadata->'raw'->>'spjj')::numeric
      then round((m.vms_raw_metadata->'raw'->>'spjj')::numeric/100,4)
    else m.vms_cost_price_lyd end,
  updated_at=now()
where m.vms_raw_metadata->>'provider'='xy'
  and (
    ((m.vms_raw_metadata->'raw'->>'spjg') ~ '^[0-9]+(\.[0-9]+)?$'
      and m.vms_selling_price_lyd=(m.vms_raw_metadata->'raw'->>'spjg')::numeric)
    or ((m.vms_raw_metadata->'raw'->>'spjj') ~ '^[0-9]+(\.[0-9]+)?$'
      and m.vms_cost_price_lyd=(m.vms_raw_metadata->'raw'->>'spjj')::numeric)
  );

update public.vms_stock_snapshots s
set vms_selling_price_lyd=round((s.metadata->'raw'->>'spjg')::numeric/100,2)
where s.source_provider='xy'
  and (s.metadata->'raw'->>'spjg') ~ '^[0-9]+(\.[0-9]+)?$'
  and s.vms_selling_price_lyd=(s.metadata->'raw'->>'spjg')::numeric;

with latest_xy as (
  select distinct on(s.product_id) s.product_id,(s.raw_data->>'spjg')::numeric raw_selling
  from public.vms_product_catalog_snapshots s
  join public.vms_sync_runs r on r.id=s.sync_run_id and r.provider='xy'
  where s.product_id is not null and (s.raw_data->>'spjg') ~ '^[0-9]+(\.[0-9]+)?$'
  order by s.product_id,s.captured_at desc,s.id desc
)
insert into public.operator_personal_purchase_corrections(
  purchase_id,person_id,period_id,old_unit_price_lyd,new_unit_price_lyd,reason,correction_key
)
select p.id,p.person_id,p.period_id,p.unit_price_lyd,round(x.raw_selling/100,2),
  'XY API minor-unit price was previously stored as LYD',
  'xy-minor-unit-repair:'||p.id::text
from public.operator_personal_purchases p
join latest_xy x on x.product_id=p.product_id
where p.unit_price_lyd>=100 and p.unit_price_lyd=x.raw_selling
on conflict(correction_key) do nothing;

update public.operator_personal_purchases p
set unit_price_lyd=c.new_unit_price_lyd
from public.operator_personal_purchase_corrections c
where c.purchase_id=p.id
  and c.correction_key='xy-minor-unit-repair:'||p.id::text
  and p.unit_price_lyd=c.old_unit_price_lyd;

do $$
begin
  if exists(
    select 1
    from public.products p
    where p.id in(
      select s.product_id
      from public.vms_product_catalog_snapshots s
      join public.vms_sync_runs r on r.id=s.sync_run_id and r.provider='xy'
      where s.product_id is not null
    )
    and p.selling_price_source='vms'
    and p.current_selling_price_lyd>=100
  ) then raise exception 'XY product selling-price repair left unconverted values'; end if;
end $$;

notify pgrst,'reload schema';
