-- CLI-generated migration. CRM collaboration only; no money, stock or lead-stage writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Buying is an operational role, not an automatic CRM privilege. Roles remain additive.
create or replace function buying_private.member() returns uuid language sql stable security definer set search_path='' as $$
 select t.id from public.profiles p join public.team_members t on t.id=p.team_member_id
 where p.id=auth.uid() and p.active_status='active' and t.active_status='active' and t.active is true
 and (t.auth_user_id is null or t.auth_user_id=p.id)
 and public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','operator','warehouse','purchasing','finance']) limit 1;
$$;
-- Preserve the existing list reader, removing CRM-only accounts from assignment choices.
do $buying$
declare d text:=pg_get_functiondef('buying_private.workspace(uuid,jsonb)'::regprocedure);
 old_roles text:='array[''owner'',''admin'',''supervisor'',''crm'',''operator'',''warehouse'',''purchasing'',''finance'']';
begin
 if position(old_roles in d)=0 then raise exception 'Review current buying workspace before role restriction';end if;
 execute replace(d,old_roles,'array[''owner'',''admin'',''supervisor'',''operator'',''warehouse'',''purchasing'',''finance'']');
end $buying$;

create schema crm_collab_private;
revoke all on schema crm_collab_private from public,anon,authenticated;
create table crm_collab_private.notes(
 id uuid primary key,
 author_id uuid not null references public.profiles(id),
 lead_id uuid references public.location_pipeline_leads(id) on delete restrict,
 body text not null check(length(btrim(body)) between 1 and 4000),
 status text not null default 'open' check(status in ('open','seen','done')),
 response text not null default '' check(length(response)<=4000),
 reviewed_by uuid references public.profiles(id),
 revision integer not null default 1 check(revision>0),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index crm_notes_author_recent on crm_collab_private.notes(author_id,created_at desc,id);
create index crm_notes_status_recent on crm_collab_private.notes(status,created_at desc,id);
create table crm_collab_private.labels(
 id uuid primary key,owner_id uuid not null references public.profiles(id),
 name text not null check(length(btrim(name)) between 1 and 40),
 color text not null default 'blue' check(color in ('blue','green','amber','rose','purple','slate')),
 archived boolean not null default false,revision integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index crm_label_name_per_owner on crm_collab_private.labels(owner_id,lower(btrim(name))) where not archived;
create table crm_collab_private.label_sets(
 lead_id uuid not null references public.location_pipeline_leads(id) on delete restrict,
 owner_id uuid not null references public.profiles(id),revision integer not null default 0,
 primary key(lead_id,owner_id)
);
create table crm_collab_private.lead_labels(
 lead_id uuid not null references public.location_pipeline_leads(id) on delete restrict,
 label_id uuid not null references crm_collab_private.labels(id) on delete restrict,
 applied_at timestamptz not null default now(),primary key(lead_id,label_id)
);
create index crm_lead_labels_by_label on crm_collab_private.lead_labels(label_id,lead_id);
create table crm_collab_private.receipts(
 id uuid primary key,actor uuid not null references public.profiles(id),request jsonb not null,
 response jsonb not null,created_at timestamptz not null default now()
);
create table crm_collab_private.events(
 id bigint generated always as identity primary key,actor uuid not null references public.profiles(id),
 action text not null,record_id uuid not null,detail jsonb not null default '{}',created_at timestamptz not null default now()
);
alter table crm_collab_private.notes enable row level security;
alter table crm_collab_private.labels enable row level security;
alter table crm_collab_private.label_sets enable row level security;
alter table crm_collab_private.lead_labels enable row level security;
alter table crm_collab_private.receipts enable row level security;
alter table crm_collab_private.events enable row level security;
revoke all on all tables in schema crm_collab_private from public,anon,authenticated;
revoke all on all sequences in schema crm_collab_private from public,anon,authenticated;

create function crm_collab_private.active() returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
 and public.snacky_current_profile_has_any_role(array['owner','admin','crm'])
 and exists(select 1 from public.profiles p join public.team_members t on t.id=p.team_member_id
   where p.id=auth.uid() and p.active_status='active' and t.active is true and t.active_status='active'
   and (t.auth_user_id is null or t.auth_user_id=p.id));
$$;
create function crm_collab_private.manager() returns boolean language sql stable security definer set search_path='' as $$
 select crm_collab_private.active() and public.snacky_current_profile_has_any_role(array['owner','admin']);
$$;
create function crm_collab_private.labels_for(p_lead uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color,'owner_id',l.owner_id,'owner_name',p.full_name) order by l.name,l.id),'[]')
 from crm_collab_private.lead_labels x join crm_collab_private.labels l on l.id=x.label_id join public.profiles p on p.id=l.owner_id
 where x.lead_id=p_lead and not l.archived and crm_collab_private.active()
 and (l.owner_id=auth.uid() or crm_collab_private.manager()) and public.snacky_crm_allowed('lead',p_lead);
$$;
create function crm_collab_private.has_label(p_lead uuid,p_label uuid) returns boolean language sql stable security definer set search_path='' as $$
 select crm_collab_private.active() and exists(select 1 from crm_collab_private.lead_labels x
 join crm_collab_private.labels l on l.id=x.label_id where x.lead_id=p_lead and x.label_id=p_label
 and not l.archived and (l.owner_id=auth.uid() or crm_collab_private.manager()));
$$;
create function crm_collab_private.options() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'color',l.color,'owner_id',l.owner_id,'owner_name',p.full_name,'revision',l.revision) order by l.name,l.id),'[]')
 from crm_collab_private.labels l join public.profiles p on p.id=l.owner_id
 where not l.archived and crm_collab_private.active() and (l.owner_id=auth.uid() or crm_collab_private.manager());
$$;

create function crm_collab_private.workspace(p_kind text,p_id uuid,p_filter text,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare is_manager boolean:=crm_collab_private.manager();rows jsonb;total integer;pending integer;rev integer;
begin
 if not crm_collab_private.active() then raise exception 'CRM or owner/admin access required' using errcode='42501';end if;
 if p_kind is null or p_kind not in ('notes','labels') or p_offset is null or p_offset<0 or p_offset>100000 or p_offset%10<>0 then raise exception 'Invalid workspace filter' using errcode='22023';end if;
 if p_kind='labels' then
  if p_id is not null and not public.snacky_crm_allowed('lead',p_id) then raise exception 'Lead access denied' using errcode='42501';end if;
  select revision into rev from crm_collab_private.label_sets where lead_id=p_id and owner_id=auth.uid();
  return jsonb_build_object('kind','labels','manager',is_manager,'me',auth.uid(),'options',crm_collab_private.options(),
    'lead_id',p_id,'revision',coalesce(rev,0),'selected',case when p_id is null then '[]'::jsonb else crm_collab_private.labels_for(p_id) end,
    'can_edit',p_id is not null and public.snacky_crm_allowed('lead',p_id,true),'checked_at',now());
 end if;
 if p_filter is null or p_filter not in ('open','done','all') then raise exception 'Invalid note filter' using errcode='22023';end if;
 with scoped as (select n.*,p.full_name author_name,r.full_name reviewer_name,
   case when n.lead_id is not null and public.snacky_crm_allowed('lead',n.lead_id) then l.place_name end lead_name
   from crm_collab_private.notes n join public.profiles p on p.id=n.author_id
   left join public.profiles r on r.id=n.reviewed_by left join public.location_pipeline_leads l on l.id=n.lead_id
   where (is_manager or n.author_id=auth.uid()) and (p_id is null or n.id=p_id)
 ), filtered as (select * from scoped where p_filter='all' or (p_filter='open' and status<>'done') or (p_filter='done' and status='done')),
 page as (select * from filtered order by created_at desc,id limit 10 offset p_offset)
 select (select count(*) from filtered),(select count(*) from scoped where status<>'done'),
 coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id) from page p),'[]') into total,pending,rows;
 return jsonb_build_object('kind','notes','manager',is_manager,'me',auth.uid(),'rows',rows,'total',total,'pending',pending,'offset',p_offset,'page_size',10,'checked_at',now());
end $$;

create function crm_collab_private.command(p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();rid uuid;id uuid;act text;payload jsonb;answer jsonb;saved crm_collab_private.receipts;
 n crm_collab_private.notes;l crm_collab_private.labels;lead uuid;rev integer;ids uuid[];txt text;col text;
begin
 if not crm_collab_private.active() then raise exception 'CRM or owner/admin access required' using errcode='42501';end if;
 if jsonb_typeof(p_command) is distinct from 'object' or octet_length(p_command::text)>24000
   or p_command-array['request_id','id','action','revision','payload']<>'{}'
   or jsonb_typeof(p_command->'payload') is distinct from 'object'
   or jsonb_typeof(p_command->'revision') is distinct from 'number' or p_command->>'revision' !~ '^\d+$' then raise exception 'Invalid command' using errcode='22023';end if;
 rid:=(p_command->>'request_id')::uuid;id:=(p_command->>'id')::uuid;act:=p_command->>'action';payload:=p_command->'payload';
 if rid is null or id is null or act is null or act not in ('note.create','note.review','label.create','label.update','labels.set') then raise exception 'Invalid command identity' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('crm-collab:'||rid::text,0));
 select * into saved from crm_collab_private.receipts where receipts.id=rid;
 if found then
  if saved.actor<>actor or saved.request is distinct from p_command then raise exception 'Request identity reused' using errcode='23505';end if;
  return saved.response;
 end if;
 if act='note.create' then
  if (p_command->>'revision')::integer<>0 then raise exception 'New note version required' using errcode='40001';end if;
  txt:=btrim(payload->>'body');lead:=nullif(payload->>'lead_id','')::uuid;
  if txt is null or length(txt) not between 1 and 4000 then raise exception 'Write a note' using errcode='22023';end if;
  if lead is not null and not public.snacky_crm_allowed('lead',lead) then raise exception 'Lead access denied' using errcode='42501';end if;
  insert into crm_collab_private.notes(id,author_id,lead_id,body) values(id,actor,lead,txt);rev:=1;
 elsif act='note.review' then
  if not crm_collab_private.manager() then raise exception 'Owner/admin review required' using errcode='42501';end if;
  select * into n from crm_collab_private.notes where notes.id=id for update;
  if not found then raise exception 'Note unavailable' using errcode='42501';end if;
  if n.revision<>(p_command->>'revision')::integer then raise exception 'Note changed; reload' using errcode='40001';end if;
  if payload->>'status' is null or payload->>'status' not in ('open','seen','done') or length(coalesce(payload->>'response',''))>4000 then raise exception 'Invalid review' using errcode='22023';end if;
  update crm_collab_private.notes set status=payload->>'status',response=coalesce(payload->>'response',''),reviewed_by=actor,revision=revision+1,updated_at=now()
   where notes.id=id returning revision into rev;
 elsif act in ('label.create','label.update') then
  perform pg_advisory_xact_lock(hashtextextended('crm-label-owner:'||actor::text,0));
  txt:=btrim(payload->>'name');col:=payload->>'color';
  if txt is null or length(txt) not between 1 and 40 or col is null or col not in ('blue','green','amber','rose','purple','slate') then raise exception 'Invalid label' using errcode='22023';end if;
  if act='label.create' then
   if (p_command->>'revision')::integer<>0 then raise exception 'New label version required' using errcode='40001';end if;
   if (select count(*) from crm_collab_private.labels where owner_id=actor and not archived)>=50 then raise exception 'Maximum 50 active personal labels' using errcode='22023';end if;
   insert into crm_collab_private.labels(id,owner_id,name,color) values(id,actor,txt,col);rev:=1;
  else
   select * into l from crm_collab_private.labels where labels.id=id for update;
   if not found or l.owner_id<>actor then raise exception 'Only edit your own labels' using errcode='42501';end if;
   if l.revision<>(p_command->>'revision')::integer then raise exception 'Label changed; reload' using errcode='40001';end if;
   update crm_collab_private.labels set name=txt,color=col,archived=coalesce((payload->>'archived')::boolean,false),revision=revision+1,updated_at=now() where labels.id=id returning revision into rev;
  end if;
 else
  lead:=id;
  perform 1 from public.location_pipeline_leads where location_pipeline_leads.id=lead for update;
  if not found or not public.snacky_crm_allowed('lead',lead,true) then raise exception 'Only organize leads you may edit' using errcode='42501';end if;
  if jsonb_typeof(payload->'label_ids') is distinct from 'array' or jsonb_array_length(payload->'label_ids')>10 then raise exception 'Choose up to 10 personal labels' using errcode='22023';end if;
  select coalesce(array_agg(value::uuid),'{}') into ids from jsonb_array_elements_text(payload->'label_ids');
  if cardinality(ids)<>(select count(distinct x) from unnest(ids) x) or exists(select 1 from unnest(ids) x where not exists(select 1 from crm_collab_private.labels z where z.id=x and z.owner_id=actor and not z.archived)) then raise exception 'Choose your active labels' using errcode='42501';end if;
  insert into crm_collab_private.label_sets(lead_id,owner_id) values(lead,actor) on conflict do nothing;
  select revision into rev from crm_collab_private.label_sets where lead_id=lead and owner_id=actor for update;
  if rev<>(p_command->>'revision')::integer then raise exception 'Labels changed; reload' using errcode='40001';end if;
  delete from crm_collab_private.lead_labels x using crm_collab_private.labels z where x.label_id=z.id and x.lead_id=lead and z.owner_id=actor;
  insert into crm_collab_private.lead_labels(lead_id,label_id) select lead,x from unnest(ids) x;
  update crm_collab_private.label_sets set revision=revision+1 where lead_id=lead and owner_id=actor returning revision into rev;
 end if;
 answer:=jsonb_build_object('ok',true,'request_id',rid,'id',id,'action',act,'revision',rev);
 insert into crm_collab_private.events(actor,action,record_id,detail) values(actor,act,id,jsonb_build_object('payload',payload,'previous',case when act='note.review' then to_jsonb(n) else null end));
 insert into crm_collab_private.receipts(id,actor,request,response) values(rid,actor,p_command,answer);
 return answer;
end $$;

-- Add label filtering BEFORE pagination and attach only authorized label metadata.
do $lead$
declare d text:=pg_get_functiondef('crm_lead_private.workspace(jsonb)'::regprocedure);
 a text:='select * from permitted r where';b text:='return jsonb_build_object(''me'',me';
begin
 if position(a in d)=0 or position(b in d)=0 or position('crm_collab_private' in d)>0 then raise exception 'Review current lead reader before extending labels';end if;
 d:=replace(d,a,'select * from permitted r where (nullif(p_filters->>''label'','''') is null or crm_collab_private.has_label(r.id,(p_filters->>''label'')::uuid)) and');
 d:=replace(d,b,E'select coalesce(jsonb_agg(value||jsonb_build_object(''labels'',crm_collab_private.labels_for((value->>''id'')::uuid)) order by ord),''[]''::jsonb) into rows from jsonb_array_elements(rows) with ordinality as x(value,ord);\n return jsonb_build_object(''label_options'',crm_collab_private.options(),''me'',me');
 execute d;
end $lead$;

create function public.snacky_crm_collaboration_workspace_v1(p_kind text default 'notes',p_id uuid default null,p_filter text default 'open',p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$select crm_collab_private.workspace(p_kind,p_id,p_filter,p_offset);$$;
create function public.snacky_crm_collaboration_command_v1(p_command jsonb)
returns jsonb language sql security invoker set search_path='' as $$select crm_collab_private.command(p_command);$$;
revoke all on all functions in schema crm_collab_private from public,anon,authenticated;
grant usage on schema crm_collab_private to authenticated;
grant execute on function crm_collab_private.workspace(text,uuid,text,integer),crm_collab_private.command(jsonb) to authenticated;
revoke all on function public.snacky_crm_collaboration_workspace_v1(text,uuid,text,integer),public.snacky_crm_collaboration_command_v1(jsonb) from public,anon;
grant execute on function public.snacky_crm_collaboration_workspace_v1(text,uuid,text,integer),public.snacky_crm_collaboration_command_v1(jsonb) to authenticated;

-- Add narrowly scoped RPCs without replacing any installed CRM/API restrictions.
do $guard$
declare d text:=pg_get_functiondef('public.snacky_crm_api_request_guard()'::regprocedure);a text:='''/rpc/snacky_crm_workspace_v1''';
begin
 if position(a in d)=0 or position('snacky_crm_collaboration_workspace_v1' in d)>0 then raise exception 'Review current CRM API allowlist';end if;
 execute replace(d,a,'''/rpc/snacky_crm_collaboration_workspace_v1'',''/rpc/snacky_crm_collaboration_command_v1'','||a);
end $guard$;
notify pgrst,'reload schema';
commit;
