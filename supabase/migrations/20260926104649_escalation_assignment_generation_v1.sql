-- Narrow follow-up to PR #218: stale generation, pause, and batch starvation.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function snacky_notice_private.escalation_generation_current(n public.notifications)
returns boolean language sql stable security definer set search_path=''
as $$
 select exists (
  select 1 from snacky_notice_private.dispatch_escalation_settings cfg
  join snacky_notice_private.dispatch_escalation_receipts r on r.notification_id=n.id
  join public.crm_tasks t on t.id=r.task_id
  where cfg.singleton and cfg.enabled
    and r.stage='ack_overdue' and r.task_id=n.source_id
    and r.issue_id=t.issue_id and r.recipient_member_id=n.recipient_member_id
    and r.assignee_member_id=t.assigned_to and r.ack_due_at=t.ack_due_at
 );
$$;
revoke all on function snacky_notice_private.escalation_generation_current(public.notifications) from public,anon,authenticated;

-- Preserve the installed authorization and ordinary-notification logic. Refuse
-- deployment if the reviewed anchors moved instead of rewriting a newer body.
do $patch$
declare definition text; anchor text; replacement text;
begin
 definition:=pg_get_functiondef('snacky_notice_private.eligible(public.notifications)'::regprocedure);
 anchor:=' if n.event_kind=''ack_overdue'' then';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
  raise exception 'Escalation eligibility changed; review before applying generation patch';
 end if;
 replacement:=anchor||E'\n  if not snacky_notice_private.escalation_generation_current(n) then return false;end if;';
 execute replace(definition,anchor,replacement);

 definition:=pg_get_functiondef('snacky_notice_private.process_dispatch_escalations(timestamptz)'::regprocedure);
 anchor:=E'  order by t.ack_due_at,t.id\n  limit 100';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
  raise exception 'Escalation scanner changed; review before applying batch patch';
 end if;
 replacement:=E'    and not exists (\n      select 1 from snacky_notice_private.dispatch_escalation_receipts previous\n      where previous.task_id=t.id and previous.assignee_member_id=t.assigned_to\n        and previous.issue_id=i.id and previous.recipient_member_id=i.assigned_to\n        and previous.ack_due_at=t.ack_due_at and previous.stage=''ack_overdue''\n    )\n'||anchor;
 execute replace(definition,anchor,replacement);
end;
$patch$;
select pg_notify('pgrst','reload schema');
commit;
