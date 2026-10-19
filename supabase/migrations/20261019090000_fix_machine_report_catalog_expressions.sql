-- Production fix: PostgreSQL COALESCE and NULLIF are SQL expressions,
-- not pg_catalog-qualified callable functions.
-- A machine.report RPC failed with 42883 at 2026-10-19 01:24 UTC.
-- Preserve the exact existing security-definer body and GRANTs; only correct
-- these two invalid built-in qualifications. No data is inserted or modified.
do $fix$
declare
  v_function text;
  v_repaired text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.snacky_report_machine_issue_v1(uuid,uuid,text,text)'::regprocedure
  ) into v_function;
  if v_function is null then
    raise exception 'Machine report function is missing; cannot apply safe repair';
  end if;
  v_repaired := replace(
    replace(v_function, 'pg_catalog.coalesce(', 'coalesce('),
    'pg_catalog.nullif(', 'nullif('
  );
  if v_repaired <> v_function then
    execute v_repaired;
  end if;
  if position('pg_catalog.coalesce(' in pg_catalog.pg_get_functiondef('public.snacky_report_machine_issue_v1(uuid,uuid,text,text)'::regprocedure))>0
    or position('pg_catalog.nullif(' in pg_catalog.pg_get_functiondef('public.snacky_report_machine_issue_v1(uuid,uuid,text,text)'::regprocedure))>0 then
    raise exception 'Machine report function repair did not persist';
  end if;
end
$fix$;
select pg_notify('pgrst','reload schema');
