-- CLI-generated migration. Optional event alerts only; never changes money/stock writers.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table snacky_notice_private.operational_settings (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 last_error_at timestamptz,
 last_error_code text
);
insert into snacky_notice_private.operational_settings(singleton) values(true);
-- A generation marker, not a second delivery queue. Tracks actual assignment/state
-- transitions even while paused so A -> B -> A cannot revive an old queued alert.
create table snacky_notice_private.operational_generations (
 source_kind text not null check(source_kind in ('buying_list','cash_pickup')),
 source_id uuid not null,
 assignment_key uuid,
 ready boolean not null,
 generation uuid not null default gen_random_uuid(),
 notification_id uuid references public.notifications(id) on delete set null,
 updated_at timestamptz not null default now(),
 primary key(source_kind,source_id)
);
alter table snacky_notice_private.operational_settings enable row level security;
alter table snacky_notice_private.operational_generations enable row level security;
revoke all on snacky_notice_private.operational_settings,snacky_notice_private.operational_generations from public,anon,authenticated;
grant all on snacky_notice_private.operational_settings,snacky_notice_private.operational_generations to service_role;

-- Explicit supported-source projection. No customer details, prices, cash totals,
-- physical storage address, photo paths, or user-entered titles in notification copy.
create function snacky_notice_private.operational_source(k text,i uuid)
returns jsonb language plpgsql volatile security definer set search_path=''
as $$
declare a uuid;u uuid;m uuid;r boolean:=false;allowed boolean:=false;roles text[];href text;
begin
 if k='buying_list' then
  select l.assigned_to,l.status='open' into a,r from buying_private.lists l where l.id=i;
  if not found then return null;end if;
  select p.id,t.id,array[p.role::text]||coalesce(p.roles::text[],'{}')||array[t.role::text]||coalesce(t.roles::text[],'{}')
  into u,m,roles from public.team_members t join public.profiles p on p.team_member_id=t.id
  where t.id=a and t.active is true and t.active_status='active' and p.active_status='active'
    and (t.auth_user_id is null or t.auth_user_id=p.id)
  order by p.id limit 1;
  allowed:=u is not null and roles&&array['owner','admin','supervisor','crm','operator','warehouse','purchasing','finance'];
  href:='/buying-lists/'||i::text;
 elsif k='cash_pickup' then
  select h.assigned_to,
    c.custody_status='in_storage' and h.stage in ('assigned','dropped')
    and c.actual_cash_collected is null and c.voided_at is null
    and coalesce(c.cash_bag_id,'') ~ '[^[:space:]]'
    and coalesce(h.deposited_at,c.storage_received_at) is not null
  into a,r from snacky_private.cash_handovers h join public.cash_collections c on c.id=h.collection_id
  where h.collection_id=i;
  if not found then return null;end if;
  select p.id,t.id into u,m from public.profiles p join public.team_members t on t.id=p.team_member_id
  where p.id=a and p.active_status='active' and t.active_status='active' and t.active is true
    and (t.auth_user_id is null or t.auth_user_id=p.id);
  allowed:=u is not null and snacky_private.cash_handover_counter_v1(u);
  href:='/cash-handling?id='||i::text;
 else return null;
 end if;
 return jsonb_build_object('assignment_key',a,'ready',coalesce(r,false),
   'user_id',u,'member_id',m,'allowed',coalesce(allowed,false),'href',href);
end;
$$;

create function snacky_notice_private.operational_eligible(n public.notifications)
returns boolean language plpgsql volatile security definer set search_path=''
as $$
declare s jsonb;g snacky_notice_private.operational_generations%rowtype;
begin
 if n.id is null or n.source_kind not in ('buying_list','cash_pickup') then return false;end if;
 if not exists(select 1 from snacky_notice_private.operational_settings where singleton and enabled)
   or not exists(select 1 from snacky_notice_private.settings where singleton and enabled) then return false;end if;
 select * into g from snacky_notice_private.operational_generations
 where source_kind=n.source_kind and source_id=n.source_id;
 if not found or g.notification_id is distinct from n.id or not g.ready then return false;end if;
 s:=snacky_notice_private.operational_source(n.source_kind,n.source_id);
 return coalesce((s->>'ready')::boolean and (s->>'allowed')::boolean
   and (s->>'assignment_key')::uuid=g.assignment_key
   and (s->>'user_id')::uuid=n.user_id
   and (s->>'member_id')::uuid=n.recipient_member_id
   and snacky_notice_private.member_user(n.recipient_member_id)=n.user_id
   and n.event_kind=case n.source_kind when 'buying_list' then 'assigned' else 'ready_for_pickup' end,false);
end;
$$;

-- Extend ONLY these two source kinds. Preserve the installed eligibility body,
-- including the reviewed urgent-escalation generation guard, verbatim otherwise.
do $extend$
declare d text;patched text;anchor text:=E'\nbegin\n';hook text:=E' if n.source_kind in (''buying_list'',''cash_pickup'') then\n  return snacky_notice_private.operational_eligible(n);\n end if;\n';
begin
 d:=pg_get_functiondef('snacky_notice_private.eligible(public.notifications)'::regprocedure);
 if position('operational_eligible' in d)>0 or position(anchor in d)=0
   or length(d)-length(replace(d,anchor,''))<>length(anchor) then
  raise exception 'Notification eligibility changed; review before installing operational alerts';
 end if;
 patched:=replace(d,anchor,anchor||hook);
 execute patched;
end;
$extend$;

create function snacky_notice_private.sync_operational_notice(k text,i uuid)
returns void language plpgsql security definer set search_path=''
as $$
declare s jsonb;g snacky_notice_private.operational_generations%rowtype;nid uuid;key text;
 en text;ar text;body_en text;body_ar text;
begin
 s:=snacky_notice_private.operational_source(k,i);
 if s is null then return;end if;
 insert into snacky_notice_private.operational_generations(source_kind,source_id,assignment_key,ready)
 values(k,i,(s->>'assignment_key')::uuid,(s->>'ready')::boolean)
 on conflict(source_kind,source_id) do update
 set assignment_key=excluded.assignment_key,ready=excluded.ready,
     generation=gen_random_uuid(),notification_id=null,updated_at=now()
 where (operational_generations.assignment_key,operational_generations.ready)
   is distinct from (excluded.assignment_key,excluded.ready)
 returning * into g;
 -- No-op saves and multiple source updates in the same deposit cannot duplicate.
 if not found or not g.ready or not (s->>'allowed')::boolean then return;end if;
 if not exists(select 1 from snacky_notice_private.operational_settings where singleton and enabled)
   or not exists(select 1 from snacky_notice_private.settings where singleton and enabled) then return;end if;
 nid:=gen_random_uuid();key:='operational:'||k||':'||i::text||':'||g.generation::text;
 if k='buying_list' then
  en:='Shopping list assigned';ar:='تم إسناد قائمة شراء إليك';
  body_en:='A shopping list is assigned to you. Open Snacky OS for the products and stores.';
  body_ar:='تم إسناد قائمة شراء إليك. افتح سناكي للاطلاع على المنتجات والمحلات.';
 else
  en:='Cash box ready for pickup';ar:='صندوق نقد جاهز للاستلام';
  body_en:='A cash box assigned to you has been recorded in storage. Open Snacky OS before collecting it.';
  body_ar:='تم تسجيل إيداع صندوق نقد مسند إليك في المخزن. افتح سناكي قبل استلامه.';
 end if;
 insert into public.notifications(id,user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar)
 values(nid,(s->>'user_id')::uuid,'work_'||k,en,body_en,s->>'href',key,k,i,(s->>'member_id')::uuid,
   case k when 'buying_list' then 'assigned' else 'ready_for_pickup' end,ar,body_ar);
 update snacky_notice_private.operational_generations set notification_id=nid
 where source_kind=k and source_id=i and generation=g.generation;
 insert into snacky_notice_private.deliveries(notification_id,subscription_id)
 select nid,sub.id from public.push_subscriptions sub where sub.user_id=(s->>'user_id')::uuid and sub.is_active
 on conflict do nothing;
 -- Missing devices still leave an in-app notification, never a fake push receipt.
 begin perform snacky_notice_private.wake();
 exception when others then raise warning 'Operational alert wake failed (%); queued delivery retained',sqlstate;
 end;
end;
$$;

create function snacky_notice_private.operational_changed()
returns trigger language plpgsql security definer set search_path=''
as $$
declare k text:=tg_argv[0];i uuid;
begin
 -- Ignore UPDATE statements that mention columns without changing their values.
 -- This also prevents a first no-op save of an old, pre-install record emitting.
 if tg_op='UPDATE' then
  if k='buying_list' then
   if (new.assigned_to,new.status) is not distinct from (old.assigned_to,old.status) then return new;end if;
  elsif tg_table_schema='snacky_private' then
   if (new.assigned_to,new.stage,new.deposited_at) is not distinct from (old.assigned_to,old.stage,old.deposited_at) then return new;end if;
  else
   if (new.custody_status,new.storage_received_at,new.actual_cash_collected,new.voided_at,new.cash_bag_id)
     is not distinct from (old.custody_status,old.storage_received_at,old.actual_cash_collected,old.voided_at,old.cash_bag_id) then return new;end if;
  end if;
 end if;
 if k='buying_list' then i:=new.id;
 elsif tg_table_schema='snacky_private' then i:=new.collection_id;
 else i:=new.id;
 end if;
 perform snacky_notice_private.sync_operational_notice(k,i);
 return new;
exception when others then
 -- Optional alert faults must not roll back shopping, physical custody or Finance.
 -- Pause only this integration and expose a safe diagnostic; existing route/CRM
 -- notifications continue. Do not log source data or PostgreSQL error messages.
 begin
  update snacky_notice_private.operational_settings set enabled=false,last_error_at=now(),last_error_code=sqlstate where singleton;
 exception when others then null;
 end;
 raise warning 'Operational alerts paused after error (%); business action unchanged',sqlstate;
 return new;
end;
$$;

create trigger snacky_buying_assignment_notice
 after insert or update of assigned_to,status on buying_private.lists
 for each row execute function snacky_notice_private.operational_changed('buying_list');
create trigger snacky_cash_handover_ready_notice
 after insert or update of assigned_to,stage,deposited_at on snacky_private.cash_handovers
 for each row execute function snacky_notice_private.operational_changed('cash_pickup');
create trigger snacky_cash_storage_ready_notice
 after update of custody_status,storage_received_at,actual_cash_collected,voided_at,cash_bag_id on public.cash_collections
 for each row execute function snacky_notice_private.operational_changed('cash_pickup');

revoke all on function snacky_notice_private.operational_source(text,uuid),
 snacky_notice_private.operational_eligible(public.notifications),
 snacky_notice_private.sync_operational_notice(text,uuid),
 snacky_notice_private.operational_changed() from public,anon,authenticated;
grant execute on function snacky_notice_private.operational_source(text,uuid),
 snacky_notice_private.operational_eligible(public.notifications),
 snacky_notice_private.sync_operational_notice(text,uuid) to service_role;
-- No backfill and no activation. Only future meaningful events emit after enable.
select pg_notify('pgrst','reload schema');
commit;
