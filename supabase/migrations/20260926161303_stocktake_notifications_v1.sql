-- CLI-generated migration. Optional stocktake event alerts, not inventory writers.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table snacky_notice_private.stocktake_notice_settings (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 epoch uuid not null default gen_random_uuid(),
 last_error_at timestamptz,
 last_error_code text
);
insert into snacky_notice_private.stocktake_notice_settings(singleton) values(true);
-- Current event generation only; delivery still uses the existing shared outbox.
create table snacky_notice_private.stocktake_notice_generations (
 assignment_id uuid primary key references stocktake_private.assignments(id) on delete cascade,
 assignee_user_id uuid not null,
 reviewer_user_id uuid not null,
 state text not null,
 generation uuid not null default gen_random_uuid(),
 epoch uuid not null,
 event_kind text check(event_kind in ('assigned','recount','submitted')),
 notification_id uuid references public.notifications(id) on delete set null,
 updated_at timestamptz not null default now()
);
alter table snacky_notice_private.stocktake_notice_settings enable row level security;
alter table snacky_notice_private.stocktake_notice_generations enable row level security;
revoke all on snacky_notice_private.stocktake_notice_settings,snacky_notice_private.stocktake_notice_generations from public,anon,authenticated;
grant all on snacky_notice_private.stocktake_notice_settings,snacky_notice_private.stocktake_notice_generations to service_role;

create function snacky_notice_private.stocktake_notice_source(i uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare a uuid;c uuid;st text;target uuid;u uuid;m uuid;roles text[];allowed boolean;
begin
 select assigned_to,created_by,status into a,c,st from stocktake_private.assignments where id=i;
 if not found then return null;end if;
 target:=case when st='submitted' then c else a end;
 -- Stocktake assignment and creator IDs are Auth/profile IDs, NOT team IDs.
 select p.id,t.id,array[p.role::text]||coalesce(p.roles::text[],'{}')||array[t.role::text]||coalesce(t.roles::text[],'{}')
 into u,m,roles from public.profiles p join public.team_members t on t.id=p.team_member_id
 where p.id=target and p.active_status='active' and t.active_status='active' and t.active is true
   and (t.auth_user_id is null or t.auth_user_id=p.id);
 -- Match the existing destination page. Pure operators/purchasers do not gain
 -- stocktake-page access merely by receiving a notification.
 allowed:=u is not null and case when st='submitted' then roles&&array['owner','admin']
   else roles&&array['owner','admin','supervisor','warehouse'] end;
 return jsonb_build_object('assignee',a,'reviewer',c,'state',st,'user_id',u,'member_id',m,
   'allowed',coalesce(allowed,false),'href','/inventory/stocktake?id='||i::text);
end;
$$;

create function snacky_notice_private.stocktake_notice_eligible(n public.notifications)
returns boolean language plpgsql volatile security definer set search_path=''
as $$
declare s jsonb;g snacky_notice_private.stocktake_notice_generations%rowtype;
begin
 if n.id is null or n.source_kind is distinct from 'stocktake' then return false;end if;
 if not exists(select 1 from snacky_notice_private.settings where singleton and enabled) then return false;end if;
 select g0.* into g from snacky_notice_private.stocktake_notice_generations g0
 join snacky_notice_private.stocktake_notice_settings cfg on cfg.singleton and cfg.enabled and cfg.epoch=g0.epoch
 where g0.assignment_id=n.source_id;
 if not found or g.notification_id is distinct from n.id or g.event_kind is distinct from n.event_kind then return false;end if;
 s:=snacky_notice_private.stocktake_notice_source(n.source_id);
 return coalesce((s->>'allowed')::boolean
   and (s->>'assignee')::uuid=g.assignee_user_id and (s->>'reviewer')::uuid=g.reviewer_user_id
   and s->>'state'=g.state and (s->>'user_id')::uuid=n.user_id and (s->>'member_id')::uuid=n.recipient_member_id
   and snacky_notice_private.member_user(n.recipient_member_id)=n.user_id
   and case n.event_kind when 'submitted' then g.state='submitted'
     when 'recount' then g.state='needs_recount'
     when 'assigned' then g.state in ('assigned','counting','needs_recount') else false end,false);
end;
$$;

-- Add one guarded case without replacing any existing route/CRM/escalation or
-- buying/cash behavior. Compatible with the buying/cash extension in either order.
do $extend$
declare d text;patched text;anchor text:=E'\nbegin\n';hook text:=E' if n.source_kind=''stocktake'' then\n  return snacky_notice_private.stocktake_notice_eligible(n);\n end if;\n';
begin
 d:=pg_get_functiondef('snacky_notice_private.eligible(public.notifications)'::regprocedure);
 if position('stocktake_notice_eligible' in d)>0 or position(anchor in d)=0
   or length(d)-length(replace(d,anchor,''))<>length(anchor) then
  raise exception 'Notification eligibility changed; review stocktake extension before installing';
 end if;
 patched:=replace(d,anchor,anchor||hook);
 if replace(patched,hook,'') is distinct from d then raise exception 'Existing notification body was not preserved';end if;
 execute patched;
end;
$extend$;

create function snacky_notice_private.sync_stocktake_notice(i uuid,e text)
returns void language plpgsql security definer set search_path=''
as $$
declare s jsonb;g snacky_notice_private.stocktake_notice_generations%rowtype;ep uuid;nid uuid;
 en text;ar text;body_en text;body_ar text;
begin
 s:=snacky_notice_private.stocktake_notice_source(i);
 if s is null then return;end if;
 select epoch into ep from snacky_notice_private.stocktake_notice_settings where singleton;
 insert into snacky_notice_private.stocktake_notice_generations(assignment_id,assignee_user_id,reviewer_user_id,state,epoch,event_kind)
 values(i,(s->>'assignee')::uuid,(s->>'reviewer')::uuid,s->>'state',ep,e)
 on conflict(assignment_id) do update
 set assignee_user_id=excluded.assignee_user_id,reviewer_user_id=excluded.reviewer_user_id,state=excluded.state,
     generation=gen_random_uuid(),epoch=excluded.epoch,event_kind=excluded.event_kind,notification_id=null,updated_at=now()
 where (stocktake_notice_generations.assignee_user_id,stocktake_notice_generations.reviewer_user_id,stocktake_notice_generations.state)
   is distinct from (excluded.assignee_user_id,excluded.reviewer_user_id,excluded.state)
 returning * into g;
 -- Invalidate on every real state/ownership change, including while disabled.
 -- No alert is emitted for ordinary saves, approval or cancellation.
 if not found or e is null or not (s->>'allowed')::boolean then return;end if;
 if not exists(select 1 from snacky_notice_private.stocktake_notice_settings where singleton and enabled)
   or not exists(select 1 from snacky_notice_private.settings where singleton and enabled) then return;end if;
 if e='submitted' then
  en:='Storage count ready for review';ar:='جرد المخزن جاهز للمراجعة';
  body_en:='A storage count you assigned was submitted. Open Snacky OS to review it. Stock has not been adjusted.';
  body_ar:='تم إرسال جرد مخزن أسندته للمراجعة. افتح سناكي لمراجعته. لم يتم تعديل المخزون.';
 elsif e='recount' then
  en:='Storage recount requested';ar:='مطلوب إعادة جرد المخزن';
  body_en:='A storage recount is assigned to you. Open Snacky OS to view the instructions and due date.';
  body_ar:='طُلب منك إعادة جرد المخزن. افتح سناكي للاطلاع على التعليمات وموعد الجرد.';
 else
  en:='Storage count assigned';ar:='تم إسناد جرد مخزن إليك';
  body_en:='A storage count is assigned to you. Open Snacky OS for the instructions and due date.';
  body_ar:='تم إسناد جرد مخزن إليك. افتح سناكي للاطلاع على التعليمات وموعد الجرد.';
 end if;
 nid:=gen_random_uuid();
 insert into public.notifications(id,user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar)
 values(nid,(s->>'user_id')::uuid,'work_stocktake_'||e,en,body_en,s->>'href',
   'stocktake:'||i::text||':'||g.generation::text,'stocktake',i,(s->>'member_id')::uuid,e,ar,body_ar);
 update snacky_notice_private.stocktake_notice_generations set notification_id=nid
 where assignment_id=i and generation=g.generation;
 insert into snacky_notice_private.deliveries(notification_id,subscription_id)
 select nid,sub.id from public.push_subscriptions sub where sub.user_id=(s->>'user_id')::uuid and sub.is_active
 on conflict do nothing;
 begin perform snacky_notice_private.wake();
 exception when others then raise warning 'Stocktake notification wake failed (%); queued delivery retained',sqlstate;end;
end;
$$;

create function snacky_notice_private.stocktake_notice_changed()
returns trigger language plpgsql security definer set search_path=''
as $$
declare e text:=null;code text;
begin
 if tg_op='UPDATE' and (new.assigned_to,new.created_by,new.status)
   is not distinct from (old.assigned_to,old.created_by,old.status) then return new;end if;
 if new.status='submitted' then e:='submitted';
 elsif new.status='needs_recount' then e:='recount';
 elsif new.status='assigned' then e:='assigned';
 elsif tg_op='UPDATE' and new.status='counting' and new.assigned_to is distinct from old.assigned_to then e:='assigned';
 end if;
 perform snacky_notice_private.sync_stocktake_notice(new.id,e);
 return new;
exception when others then
 code:=sqlstate;
 -- Optional alert failures cannot undo submission/approval/inventory work.
 -- Rotate epoch so a failed transition cannot revive old alerts after re-enable.
 begin
  update snacky_notice_private.stocktake_notice_settings
  set enabled=false,epoch=gen_random_uuid(),last_error_at=now(),last_error_code=code where singleton;
 exception when others then null;end;
 raise warning 'Stocktake notifications paused after error (%); business action retained',code;
 return new;
end;
$$;

create trigger snacky_stocktake_event_notice
 after insert or update of assigned_to,created_by,status on stocktake_private.assignments
 for each row execute function snacky_notice_private.stocktake_notice_changed();
revoke all on function snacky_notice_private.stocktake_notice_source(uuid),
 snacky_notice_private.stocktake_notice_eligible(public.notifications),
 snacky_notice_private.sync_stocktake_notice(uuid,text),
 snacky_notice_private.stocktake_notice_changed() from public,anon,authenticated;
grant execute on function snacky_notice_private.stocktake_notice_source(uuid),
 snacky_notice_private.stocktake_notice_eligible(public.notifications) to service_role;
-- No backfill, no activation and no change to stocktake commands or role grants.
select pg_notify('pgrst','reload schema');
commit;
