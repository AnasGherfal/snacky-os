-- Explicitly scope mandatory collection to selected pilot machines only.
CREATE OR REPLACE FUNCTION public.snacky_cash_refill_completion_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public
AS $function$
DECLARE v_policy record;
BEGIN
  IF new.status::text='completed' AND old.status::text IS DISTINCT FROM 'completed' THEN
    SELECT enabled,pilot_machine_ids INTO v_policy FROM public.cash_refill_policy WHERE id=1;
    IF coalesce(v_policy.enabled,false)
      AND coalesce(cardinality(v_policy.pilot_machine_ids),0)>0
      AND new.machine_id=ANY(v_policy.pilot_machine_ids)
      AND NOT EXISTS (
        SELECT 1 FROM public.route_stop_cash_receipts x
        WHERE x.route_stop_id=new.id AND x.route_id=new.route_id
          AND x.machine_id=new.machine_id AND x.state IN ('collected','exception')
      )
    THEN
      RAISE EXCEPTION 'Record a cash collection or cash exception before completing this stop.'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN new;
END $function$;
REVOKE ALL ON FUNCTION public.snacky_cash_refill_completion_guard() FROM PUBLIC, anon, authenticated;
