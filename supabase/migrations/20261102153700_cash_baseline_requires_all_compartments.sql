-- A previous 'full' removal is not a verified baseline when notes/coins were not both documented as emptied.
CREATE OR REPLACE FUNCTION snacky_private.previous_full_cash_removal_at(p_machine_id uuid, p_collection_id uuid, p_before timestamp with time zone)
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'snacky_private', 'pg_temp'
AS $function$
  with last_full as (
    select c.id,c.collected_at,c.actual_cash_collected,c.counted_at,
           c.custody_status,c.storage_seal_condition,c.count_seal_condition,
           (line.compartments @> array['notes','coins']::text[]) as all_cash_compartments_documented,
           exists(select 1 from public.route_stop_cash_receipts receipt
             where receipt.collection_id=c.id and receipt.state='collected') as from_verified_refill
    from public.cash_collection_machines line
    join public.cash_collections c on c.id=line.cash_collection_id
    where line.machine_id=p_machine_id and line.removal_type='full'
      and c.id<>p_collection_id and c.collected_at<p_before
      and c.voided_at is null and coalesce(c.review_status,'')<>'voided'
    order by c.collected_at desc,c.id desc
    limit 1
  )
  select case when actual_cash_collected is not null and counted_at is not null
      and custody_status in ('counted','reconciled')
      and storage_seal_condition='intact' and count_seal_condition='intact'
      and from_verified_refill and all_cash_compartments_documented
    then collected_at else null end
  from last_full;
$function$
