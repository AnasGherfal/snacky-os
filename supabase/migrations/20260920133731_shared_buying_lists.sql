-- CLI-generated identity. Planning/checklist data only: never creates stock, purchases or payments.
create schema buying_private;
revoke all on schema buying_private from public, anon;
grant usage on schema buying_private to authenticated;
create table buying_private.lists (
 id uuid primary key, title text not null check(length(title) between 1 and 160),
 instructions text not null default '' check(length(instructions)<=3000),
 assigned_to uuid not null references public.team_members(id), created_by uuid not null references public.team_members(id),
 due_on date not null, status text not null default 'open' check(status in ('open','completed','cancelled')),
 revision integer not null default 1 check(revision>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table buying_private.items (
 list_id uuid not null references buying_private.lists(id), product_id uuid not null references public.products(id),
 position integer not null, name text not null, supplier text, units_per_box integer not null check(units_per_box between 2 and 10000),
 planned_boxes integer not null check(planned_boxes between 1 and 10000), unit_cost numeric(14,4),
 outcome text not null default 'pending' check(outcome in ('pending','bought','partial','unavailable')),
 bought_boxes integer not null default 0 check(bought_boxes>=0 and bought_boxes<=planned_boxes),
 note text not null default '' check(length(note)<=1000), updated_by uuid references public.team_members(id), updated_at timestamptz,
 primary key(list_id,product_id), unique(list_id,position),
 check((outcome='pending' and bought_boxes=0) or (outcome='bought' and bought_boxes=planned_boxes) or (outcome='partial' and bought_boxes>0 and bought_boxes<planned_boxes) or (outcome='unavailable' and bought_boxes=0))
);
create table buying_private.commands (
 id uuid primary key, actor uuid not null references auth.users(id), list_id uuid not null references buying_private.lists(id),
 request jsonb not null, response jsonb not null, created_at timestamptz not null default now()
);
alter table buying_private.lists enable row level security;
alter table buying_private.items enable row level security;
alter table buying_private.commands enable row level security;
revoke all on all tables in schema buying_private from public,anon,authenticated;
create index buying_assigned on buying_private.lists(assigned_to,status,due_on);
create function buying_private.member() returns uuid language sql stable security definer set search_path='' as $$
 select t.id from public.profiles p join public.team_members t on t.id=p.team_member_id
 where p.id=auth.uid() and p.active_status='active' and t.active_status='active' and t.active is true
 and public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator','warehouse','purchasing','finance']) limit 1;
$$;
create function buying_private.planner() returns boolean language sql stable security definer set search_path='' as $$
 select buying_private.member() is not null and public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing']);
$$;
create function buying_private.visible(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
 select buying_private.member() is not null and exists(select 1 from buying_private.lists l where l.id=p_id and
 (buying_private.planner() or l.assigned_to=buying_private.member() or l.created_by=buying_private.member()));
$$;
create function buying_private.workspace(p_id uuid,p_filters jsonb) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare me uuid:=buying_private.member(); plan boolean:=buying_private.planner(); list_data jsonb; rows jsonb; total integer; people jsonb:='[]';
 off integer:=greatest(0,least(coalesce((p_filters->>'offset')::integer,0),100000)); wanted text:=coalesce(p_filters->>'status','open'); scope text:=coalesce(p_filters->>'scope','mine');
begin
 if me is null then raise exception 'Active staff access required' using errcode='42501';end if;
 if wanted not in ('open','completed','cancelled','all') or scope not in ('mine','all') then raise exception 'Invalid filters' using errcode='22023';end if;
 if p_id is not null then
  if not buying_private.visible(p_id) then raise exception 'List access denied' using errcode='42501';end if;
  select to_jsonb(l)||jsonb_build_object('buyer_name',b.full_name,'creator_name',c.full_name,'items',(select jsonb_agg(to_jsonb(i) order by i.position) from buying_private.items i where i.list_id=l.id)) into list_data
  from buying_private.lists l join public.team_members b on b.id=l.assigned_to join public.team_members c on c.id=l.created_by where l.id=p_id;
 end if;
 with permitted as (
  select l.*,b.full_name buyer_name,c.full_name creator_name,
   (select count(*) from buying_private.items i where i.list_id=l.id) item_count,
   (select count(*) from buying_private.items i where i.list_id=l.id and i.outcome<>'pending') checked_count
  from buying_private.lists l join public.team_members b on b.id=l.assigned_to join public.team_members c on c.id=l.created_by
  where buying_private.visible(l.id) and (scope='all' or l.assigned_to=me) and (wanted='all' or l.status=wanted)
 ), page as (select * from permitted order by due_on,created_at desc,id limit 30 offset off)
 select (select count(*) from permitted),coalesce((select jsonb_agg(to_jsonb(p) order by p.due_on,p.created_at desc,p.id) from page p),'[]') into total,rows;
 if plan then
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.full_name) order by t.full_name),'[]') into people
  from public.team_members t where t.active is true and t.active_status='active' and exists(
   select 1 from public.profiles p where p.team_member_id=t.id and p.active_status='active' and
   (coalesce(p.roles::text[],'{}')||array[p.role::text])&&array['owner','admin','supervisor','crm','operator','warehouse','purchasing','finance']);
 end if;
 return jsonb_build_object('me',me,'planner',plan,'today',(now() at time zone 'Africa/Tripoli')::date,'record',list_data,'rows',rows,'total',total,'offset',off,'people',people);
end $$;
create function buying_private.command(p_command jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare me uuid:=buying_private.member(); request uuid:=(p_command->>'request_id')::uuid; listid uuid:=(p_command->>'list_id')::uuid;
 act text:=p_command->>'action'; payload jsonb:=p_command->'payload'; version integer:=(p_command->>'revision')::integer;
 old buying_private.commands; l buying_private.lists; item buying_private.items; product public.products;
 selection jsonb; ids uuid[]:='{}'; target uuid; n integer:=0; boxes integer; size integer; cost numeric; answer jsonb;
begin
 if me is null then raise exception 'Active staff access required' using errcode='42501';end if;
 if request is null or listid is null or act is null or act not in ('create','item','complete','cancel','reopen','assign') or version is null or version<0 or jsonb_typeof(payload) is distinct from 'object' then raise exception 'Invalid command' using errcode='22023';end if;
 if octet_length(p_command::text)>100000 then raise exception 'Command too large' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('buying:'||request::text,0));
 select * into old from buying_private.commands where id=request;
 if found then
  if old.actor<>auth.uid() or old.request is distinct from p_command then raise exception 'Request identity conflict' using errcode='23505';end if;
  if not buying_private.visible(old.list_id) then raise exception 'Access changed' using errcode='42501';end if;
  return old.response;
 end if;
 if act='create' then
  if not buying_private.planner() then raise exception 'Planning permission required' using errcode='42501';end if;
  if version<>0 or exists(select 1 from buying_private.lists where id=listid) then raise exception 'List already exists' using errcode='40001';end if;
  target:=(payload->>'assigned_to')::uuid;
  if not exists(select 1 from jsonb_array_elements(buying_private.workspace(null,'{}')->'people') p where p->>'id'=target::text) then raise exception 'Choose an active buyer' using errcode='22023';end if;
  if jsonb_typeof(payload->'title') is distinct from 'string' or length(trim(payload->>'title')) not between 1 and 160 or jsonb_typeof(payload->'instructions') is distinct from 'string' or length(payload->>'instructions')>3000 or nullif(payload->>'due_on','') is null then raise exception 'Invalid list details' using errcode='22023';end if;
  if jsonb_typeof(payload->'items') is distinct from 'array' then raise exception 'Select products' using errcode='22023';end if;
  if jsonb_array_length(payload->'items') not between 1 and 200 then raise exception 'Select 1 to 200 products' using errcode='22023';end if;
  insert into buying_private.lists(id,title,instructions,assigned_to,created_by,due_on) values(listid,trim(payload->>'title'),payload->>'instructions',target,me,(payload->>'due_on')::date) returning * into l;
  for selection in select value from jsonb_array_elements(payload->'items') loop
   if jsonb_typeof(selection->'boxes') is distinct from 'number' or selection->>'boxes' !~ '^[1-9][0-9]*$' or jsonb_typeof(selection->'units_per_box') is distinct from 'number' or selection->>'units_per_box' !~ '^[1-9][0-9]*$' then raise exception 'Whole boxes required' using errcode='22023';end if;
   boxes:=(selection->>'boxes')::integer;size:=(selection->>'units_per_box')::integer;
   select * into product from public.products where id=(selection->>'product_id')::uuid for share;
   if product.id is null or product.active is not true or product.id=any(ids) or boxes not between 1 and 10000 or size not between 2 and 10000 or product.case_quantity is distinct from size then raise exception 'Product or packaging changed; review list' using errcode='22023';end if;
   ids:=array_append(ids,product.id);n:=n+1;
   cost:=coalesce(case when product.last_purchase_cost_lyd>0 then product.last_purchase_cost_lyd end,case when product.current_cost_price_lyd>0 then product.current_cost_price_lyd end,case when product.cost_price>0 then product.cost_price end);
   insert into buying_private.items(list_id,product_id,position,name,supplier,units_per_box,planned_boxes,unit_cost)
   values(listid,product.id,n,product.name,(select s.name from public.suppliers s where s.id=product.last_supplier_id),size,boxes,cost);
  end loop;
 else
  if not buying_private.visible(listid) then raise exception 'List access denied' using errcode='42501';end if;
  select * into l from buying_private.lists where id=listid for update;
  if l.revision<>version then raise exception 'List changed; reload' using errcode='40001';end if;
  if act in ('assign','cancel','reopen') and not buying_private.planner() then raise exception 'Planning permission required' using errcode='42501';end if;
  if act in ('item','complete') and not (buying_private.planner() or l.assigned_to=me) then raise exception 'Only the buyer or planner can update progress' using errcode='42501';end if;
  if act<>'reopen' and l.status<>'open' then raise exception 'List is closed' using errcode='22023';end if;
  if act='item' then
   select * into item from buying_private.items where list_id=listid and product_id=(payload->>'product_id')::uuid for update;
   if item.product_id is null or jsonb_typeof(payload->'bought_boxes') is distinct from 'number' or payload->>'bought_boxes' !~ '^[0-9]+$' or payload->>'outcome' not in ('pending','bought','partial','unavailable') or jsonb_typeof(payload->'note') is distinct from 'string' or length(payload->>'note')>1000 then raise exception 'Invalid item result' using errcode='22023';end if;
   if payload->>'outcome' in ('partial','unavailable') and trim(payload->>'note')='' then raise exception 'Explain missing products' using errcode='22023';end if;
   update buying_private.items set outcome=payload->>'outcome',bought_boxes=(payload->>'bought_boxes')::integer,note=payload->>'note',updated_by=me,updated_at=now() where list_id=listid and product_id=item.product_id;
  elsif act='complete' then
   if exists(select 1 from buying_private.items where list_id=listid and outcome='pending') then raise exception 'Record an outcome for every product first' using errcode='22023';end if;
   update buying_private.lists set status='completed' where id=listid;
  elsif act='cancel' then
   if length(trim(coalesce(payload->>'reason',''))) not between 1 and 1000 then raise exception 'Cancellation reason required' using errcode='22023';end if;
   update buying_private.lists set status='cancelled' where id=listid;
  elsif act='reopen' then
   if l.status<>'completed' then raise exception 'Only completed lists may reopen' using errcode='22023';end if;
   update buying_private.lists set status='open' where id=listid;
  elsif act='assign' then
   target:=(payload->>'assigned_to')::uuid;
   if not exists(select 1 from jsonb_array_elements(buying_private.workspace(null,'{}')->'people') p where p->>'id'=target::text) then raise exception 'Choose an active buyer' using errcode='22023';end if;
   update buying_private.lists set assigned_to=target where id=listid;
  end if;
  update buying_private.lists set revision=revision+1,updated_at=now() where id=listid returning * into l;
 end if;
 answer:=jsonb_build_object('request_id',request,'list_id',listid,'revision',l.revision);
 insert into buying_private.commands(id,actor,list_id,request,response) values(request,auth.uid(),listid,p_command,answer);
 return answer;
end $$;
create function public.snacky_buying_workspace_v1(p_id uuid default null,p_filters jsonb default '{}') returns jsonb language sql stable security invoker set search_path='' as $$select buying_private.workspace(p_id,p_filters);$$;
create function public.snacky_buying_command_v1(p_command jsonb) returns jsonb language sql security invoker set search_path='' as $$select buying_private.command(p_command);$$;
revoke all on all functions in schema buying_private from public,anon,authenticated;
grant execute on function buying_private.workspace(uuid,jsonb),buying_private.command(jsonb) to authenticated;
revoke all on function public.snacky_buying_workspace_v1(uuid,jsonb),public.snacky_buying_command_v1(jsonb) from public,anon;
grant execute on function public.snacky_buying_workspace_v1(uuid,jsonb),public.snacky_buying_command_v1(jsonb) to authenticated;
-- Compose the existing CRM boundary, never replace its previous allowlist or staff restrictions.
do $$declare definition text:=pg_get_functiondef('public.snacky_crm_api_request_guard()'::regprocedure); anchor text:='if not public.snacky_crm_is_limited() then return;end if;';begin
 if position(anchor in definition)=0 then raise exception 'Review current CRM API guard before installing buying lists';end if;
 execute replace(definition,anchor,anchor||E'\n if path in (''/rpc/snacky_buying_workspace_v1'',''/rpc/snacky_buying_command_v1'',''/rest/v1/rpc/snacky_buying_workspace_v1'',''/rest/v1/rpc/snacky_buying_command_v1'') and buying_private.member() is not null then return;end if;');
end $$;
notify pgrst,'reload schema';
