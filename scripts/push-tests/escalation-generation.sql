\set ON_ERROR_STOP on
begin;
insert into auth.users values ('c1000000-0000-4000-8000-000000000001'),('c1000000-0000-4000-8000-000000000002'),('c1000000-0000-4000-8000-000000000003');
insert into public.team_members(id,auth_user_id,role,roles) values
 ('d1000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001','crm',array['crm']),
 ('d1000000-0000-4000-8000-000000000002','c1000000-0000-4000-8000-000000000002','operator',array['operator']),
 ('d1000000-0000-4000-8000-000000000003','c1000000-0000-4000-8000-000000000003','operator',array['operator']);
insert into public.profiles(id,active_status,role,roles,team_member_id) select auth_user_id,'active',role,roles,id from public.team_members where id::text like 'd1000000%';
update snacky_notice_private.settings set enabled=true where singleton;
update snacky_notice_private.dispatch_escalation_settings set enabled=true where singleton;
do $$
declare crm uuid:='d1000000-0000-4000-8000-000000000001'; op1 uuid:='d1000000-0000-4000-8000-000000000002'; op2 uuid:='d1000000-0000-4000-8000-000000000003'; iid uuid:=gen_random_uuid(); tid uuid:=gen_random_uuid(); old_notice public.notifications%rowtype; fresh_notice public.notifications%rowtype; result jsonb; j integer;
begin
 insert into public.issues(id,assigned_to,reported_by,status,priority) values(iid,crm,crm,'open','urgent');
 insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at) values(tid,'Synthetic assignment test',op1,crm,'open','field_action',iid,'urgent','assigned',now()-interval '30 minutes');
 perform public.snacky_process_dispatch_escalations_v1(null);
 select * into strict old_notice from public.notifications where source_id=tid and event_kind='ack_overdue';
 if not snacky_notice_private.eligible(old_notice) then raise exception 'Current overdue alert unexpectedly ineligible'; end if;
 -- Simulate a reassignment whose NEW deadline has also passed before the old
 -- queued push is retried. The previous tests checked only a future deadline.
 update public.crm_tasks set assigned_to=op2,ack_due_at=now()-interval '1 minute' where id=tid;
 if snacky_notice_private.eligible(old_notice) then raise exception 'Old generation resurrected after new deadline'; end if;
 perform public.snacky_process_dispatch_escalations_v1(null);
 select * into strict fresh_notice from public.notifications where source_id=tid and event_kind='ack_overdue' and id<>old_notice.id;
 if not snacky_notice_private.eligible(fresh_notice) then raise exception 'New generation not eligible'; end if;
 update snacky_notice_private.dispatch_escalation_settings set enabled=false where singleton;
 if snacky_notice_private.eligible(fresh_notice) then raise exception 'Pause did not suppress queued escalation'; end if;
 update snacky_notice_private.dispatch_escalation_settings set enabled=true where singleton;
 update public.crm_tasks set dispatch_state='accepted' where id=tid;
 -- More than one batch: already-receipted tasks must not occupy the first 100
 -- slots forever and starve task 101.
 for j in 1..101 loop
  insert into public.crm_tasks(id,title,assigned_to,created_by,status,task_type,issue_id,priority,dispatch_state,ack_due_at) values(gen_random_uuid(),'Synthetic batch task',op1,crm,'open','field_action',iid,'urgent','assigned',now()-interval '5 minutes');
 end loop;
 result:=public.snacky_process_dispatch_escalations_v1(null);
 if (result->>'generated')::integer<>100 then raise exception 'First batch size wrong: %',result; end if;
 result:=public.snacky_process_dispatch_escalations_v1(null);
 if (result->>'generated')::integer<>1 then raise exception 'Second batch starved: %',result; end if;
 result:=public.snacky_process_dispatch_escalations_v1(null);
 if (result->>'generated')::integer<>0 then raise exception 'Duplicate batch notifications: %',result; end if;
 raise notice 'PASS: old-generation rejection, new-generation acceptance, pause, 101-task pagination and dedupe';
end $$;
rollback;
