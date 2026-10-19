-- Extend only the already authenticated machine issue surface. Do not replace
-- the evolving CRM API guard or expose financial/other privileged endpoints.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $safeguards$
declare
  body text;
  updated text;
  signature text;
  marker text;
begin
  body:=pg_get_functiondef('public.snacky_crm_api_request_guard()'::regprocedure);
  marker:='''/rpc/snacky_issue_dispatch_command_v1''';
  if position('''/rpc/snacky_report_machine_issue_v1''' in body)=0 then
    if position(marker in body)=0 then raise exception 'CRM API allowlist changed; review required';end if;
    updated:=replace(body,marker,marker||',''/rpc/snacky_report_machine_issue_v1'',''/rpc/snacky_issue_field_queue_command_v1''');
    execute updated;
  end if;

  -- A later edit must not turn a shared machine incident into a customer case
  -- which an operator can claim directly by guessing its task ID.
  body:=pg_get_functiondef('public.snacky_claim_machine_issue_v1(uuid,uuid)'::regprocedure);
  marker:='    or coalesce(v_issue.is_practice,false)';
  if position('v_issue.customer_phone' in body)=0 then
    if position(marker in body)=0 then raise exception 'Machine claim guard changed';end if;
    updated:=replace(body,marker,marker||E'\n    or v_issue.contact_channel<>''other''\n    or nullif(pg_catalog.btrim(v_issue.customer_name),'''') is not null\n    or nullif(pg_catalog.btrim(v_issue.customer_phone),'''') is not null\n    or nullif(pg_catalog.btrim(v_issue.customer_whatsapp),'''') is not null\n    or coalesce(v_issue.amount_involved_lyd,0)<>0\n    or coalesce(v_issue.refund_amount_lyd,0)<>0');
    execute updated;
  end if;

  -- Customer compensation and other unresolved field work prevent automatic
  -- parent closure, even when the task itself is successfully repaired.
  body:=pg_get_functiondef('crm_dispatch_private.command(jsonb)'::regprocedure);
  marker:='    and v_issue.contact_channel=''other''';
  if position('and coalesce(v_issue.amount_involved_lyd,0)=0' in body)=0 then
    if position(marker in body)=0 then raise exception 'Machine closure guard changed';end if;
    updated:=replace(body,marker,marker||E'\n    and coalesce(v_issue.amount_involved_lyd,0)=0\n    and coalesce(v_issue.refund_amount_lyd,0)=0\n    and not exists(select 1 from public.crm_tasks other_task where other_task.issue_id=v_issue.id and other_task.id<>v_task.id and other_task.task_type=''field_action'' and other_task.archived_at is null and other_task.status<>''completed'')');
    execute updated;
  end if;

  -- Intake deduplication and the public read projection follow identical
  -- machine-only classification (no customer or compensation obligation).
  foreach signature in array array[
    'public.snacky_report_machine_issue_v1(uuid,uuid,text,text)',
    'public.snacky_available_machine_issues_v1()'
  ] loop
    body:=pg_get_functiondef(signature::regprocedure);
    marker:='    and i.contact_channel=''other''';
    if position('and coalesce(i.amount_involved_lyd,0)=0' in body)=0 then
      if position(marker in body)=0 then raise exception 'Machine-only classification changed in %',signature;end if;
      updated:=replace(body,marker,marker||E'\n    and coalesce(i.amount_involved_lyd,0)=0\n    and coalesce(i.refund_amount_lyd,0)=0');
      execute updated;
    end if;
  end loop;
end
$safeguards$;
select pg_notify('pgrst','reload schema');
commit;
