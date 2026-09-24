-- Connect completed buying checklists to the existing purchase -> inventory ledger.
-- The same assigned buyer may buy and receive into storage; no second-person handoff is introduced.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$begin
 if to_regprocedure('buying_private.workspace(uuid,jsonb)') is null
   or to_regprocedure('buying_private.source_workspace(uuid)') is null
   or to_regprocedure('public.snacky_create_purchase_with_lines_v2(uuid,uuid,date,text,text,text,text,text,text,text,text,numeric,numeric,numeric,text,numeric,text,uuid,text,jsonb)') is null
 then
  raise exception 'Apply shared buying, store guidance, and atomic purchase receiving before buying-to-storage';
 end if;
end $$;

alter table buying_private.items
 add column if not exists actual_supplier_id uuid references public.suppliers(id);

create index if not exists buying_items_actual_supplier
 on buying_private.items(list_id,actual_supplier_id,position)
 where actual_supplier_id is not null;

create table buying_private.item_result_commands(
 request_id uuid primary key,
 actor uuid not null references auth.users(id),
 list_id uuid not null references buying_private.lists(id),
 request jsonb not null,
 response jsonb not null,
 created_at timestamptz not null default now()
);

create table buying_private.purchase_links(
 list_id uuid not null references buying_private.lists(id),
 supplier_id uuid not null references public.suppliers(id),
 purchase_id uuid not null unique references public.purchase_orders(id),
 linked_by uuid not null references public.team_members(id),
 linked_at timestamptz not null default now(),
 primary key(list_id,supplier_id)
);

create table buying_private.purchase_link_commands(
 request_id uuid primary key,
 actor uuid not null references auth.users(id),
 list_id uuid not null references buying_private.lists(id),
 request jsonb not null,
 response jsonb not null,
 created_at timestamptz not null default now()
);

alter table buying_private.item_result_commands enable row level security;
alter table buying_private.purchase_links enable row level security;
alter table buying_private.purchase_link_commands enable row level security;
revoke all on buying_private.item_result_commands,buying_private.purchase_links,buying_private.purchase_link_commands from public,anon,authenticated;

create function buying_private.purchase_actor(p_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select buying_private.visible(p_id)
   and public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing']);
$$;

create function buying_private.item_result(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 me uuid:=buying_private.member();
 requestid uuid; listid uuid; productid uuid; actual_supplier uuid; version integer; boxes integer;
 act text; note_text text;
 old buying_private.item_result_commands;
 parent buying_private.lists; item buying_private.items; source buying_private.sources;
 answer jsonb;
begin
 if auth.uid() is null or me is null then raise exception 'Active staff access required' using errcode='42501';end if;
 if jsonb_typeof(p_command) is distinct from 'object' or octet_length(p_command::text)>10000 then
  raise exception 'Invalid buying result command' using errcode='22023';
 end if;
 if (select count(*) from jsonb_object_keys(p_command))<>8
   or not p_command ?& array['request_id','list_id','product_id','revision','outcome','bought_boxes','note','actual_supplier_id']
   or jsonb_typeof(p_command->'request_id') is distinct from 'string'
   or jsonb_typeof(p_command->'list_id') is distinct from 'string'
   or jsonb_typeof(p_command->'product_id') is distinct from 'string'
   or jsonb_typeof(p_command->'revision') is distinct from 'number'
   or p_command->>'revision' !~ '^[1-9][0-9]*$'
   or jsonb_typeof(p_command->'outcome') is distinct from 'string'
   or jsonb_typeof(p_command->'bought_boxes') is distinct from 'number'
   or p_command->>'bought_boxes' !~ '^[0-9]+$'
   or jsonb_typeof(p_command->'note') is distinct from 'string'
   or jsonb_typeof(p_command->'actual_supplier_id') not in ('string','null')
 then raise exception 'Invalid buying result fields' using errcode='22023';end if;

 requestid:=(p_command->>'request_id')::uuid;
 listid:=(p_command->>'list_id')::uuid;
 productid:=(p_command->>'product_id')::uuid;
 version:=(p_command->>'revision')::integer;
 act:=p_command->>'outcome';
 boxes:=(p_command->>'bought_boxes')::integer;
 note_text:=p_command->>'note';
 actual_supplier:=case when p_command->'actual_supplier_id'='null'::jsonb then null else (p_command->>'actual_supplier_id')::uuid end;

 if requestid is null or listid is null or productid is null or version>=2147483647
   or act not in ('pending','bought','partial','unavailable') or length(note_text)>1000
 then raise exception 'Invalid buying result' using errcode='22023';end if;

 perform pg_advisory_xact_lock(hashtextextended('buying-item-result:'||requestid::text,0));
 select * into old from buying_private.item_result_commands where request_id=requestid for update;
 if found then
  if old.actor<>auth.uid() or old.request is distinct from p_command then raise exception 'Request identity conflict' using errcode='23505';end if;
  if not buying_private.visible(old.list_id) then raise exception 'Access changed' using errcode='42501';end if;
  return old.response;
 end if;

 if not buying_private.visible(listid) then raise exception 'List access denied' using errcode='42501';end if;
 select * into parent from buying_private.lists where id=listid for update;
 if not found then raise exception 'Buying list not found' using errcode='23503';end if;
 if parent.revision<>version then raise exception 'List changed; reload' using errcode='40001';end if;
 if parent.status<>'open' then raise exception 'List is closed' using errcode='22023';end if;
 if not (buying_private.planner() or parent.assigned_to=me) then raise exception 'Only the buyer or planner can update progress' using errcode='42501';end if;

 select * into item from buying_private.items where list_id=listid and product_id=productid for update;
 if not found then raise exception 'Buying item not found' using errcode='23503';end if;
 if boxes<0 or boxes>item.planned_boxes
   or (act='pending' and boxes<>0)
   or (act='bought' and boxes<>item.planned_boxes)
   or (act='partial' and (boxes<=0 or boxes>=item.planned_boxes))
   or (act='unavailable' and boxes<>0)
   or (act in ('partial','unavailable') and trim(note_text)='')
 then raise exception 'Invalid item result' using errcode='22023';end if;

 if act in ('bought','partial') then
  if actual_supplier is null then raise exception 'Record the store actually used' using errcode='22023';end if;
  select * into source from buying_private.sources where list_id=listid and product_id=productid for share;
  if not found then raise exception 'Store instructions are required before recording a purchase' using errcode='23514';end if;
  if actual_supplier is distinct from (source.primary_store->>'supplier_id')::uuid
    and (source.alternative_store is null or actual_supplier is distinct from (source.alternative_store->>'supplier_id')::uuid)
  then raise exception 'Choose the required store or approved alternative' using errcode='23514';end if;
 else
  actual_supplier:=null;
 end if;

 update buying_private.items
 set outcome=act,bought_boxes=boxes,note=note_text,actual_supplier_id=actual_supplier,updated_by=me,updated_at=now()
 where list_id=listid and product_id=productid;
 update buying_private.lists set revision=revision+1,updated_at=now() where id=listid returning * into parent;

 answer:=jsonb_build_object('ok',true,'request_id',requestid,'list_id',listid,'product_id',productid,'revision',parent.revision);
 insert into buying_private.item_result_commands(request_id,actor,list_id,request,response)
 values(requestid,auth.uid(),listid,p_command,answer);
 return answer;
end $$;

create function buying_private.legacy_item_retry(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $
declare old buying_private.commands; requestid uuid; listid uuid;
begin
 if auth.uid() is null or buying_private.member() is null then raise exception 'Active staff access required' using errcode='42501';end if;
 if jsonb_typeof(p_command) is distinct from 'object'
   or p_command->>'action'<>'item'
   or (p_command->'payload') ? 'actual_supplier_id'
 then raise exception 'Legacy retry payload required' using errcode='22023';end if;
 requestid:=(p_command->>'request_id')::uuid;listid:=(p_command->>'list_id')::uuid;
 select * into old from buying_private.commands where id=requestid for share;
 if not found then raise exception 'This old request was never saved. Reload the list and record the store used.' using errcode='40001';end if;
 if old.actor<>auth.uid() or old.list_id<>listid or old.request is distinct from p_command then
  raise exception 'Request identity conflict' using errcode='23505';
 end if;
 if not buying_private.visible(old.list_id) then raise exception 'Access changed' using errcode='42501';end if;
 return old.response;
end $;

create function buying_private.purchase_workspace(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $
declare
 me uuid:=buying_private.member(); parent buying_private.lists; groups jsonb:='[]'; can_record boolean:=false;
begin
 if auth.uid() is null or me is null or not buying_private.visible(p_id) then raise exception 'List access denied' using errcode='42501';end if;
 select * into parent from buying_private.lists where id=p_id;
 if not found then raise exception 'Buying list not found' using errcode='23503';end if;
 can_record:=buying_private.purchase_actor(p_id)
   and (parent.assigned_to=me or public.snacky_current_profile_has_any_role(array['owner','admin']));

 with grouped as (
  select i.actual_supplier_id supplier_id,s.name store_name,s.phone store_phone,
    count(*)::integer item_count,sum(i.bought_boxes)::integer bought_boxes,
    jsonb_agg(jsonb_build_object(
      'product_id',i.product_id,'name',i.name,'bought_boxes',i.bought_boxes,'units_per_box',i.units_per_box,
      'reference_unit_cost_lyd',case
        when (src.primary_store->>'supplier_id')::uuid=i.actual_supplier_id then src.primary_store->'unit_cost_lyd'
        when src.alternative_store is not null and (src.alternative_store->>'supplier_id')::uuid=i.actual_supplier_id then src.alternative_store->'unit_cost_lyd'
        else null end,
      'reference_purchased_on',case
        when (src.primary_store->>'supplier_id')::uuid=i.actual_supplier_id then src.primary_store->'purchased_on'
        when src.alternative_store is not null and (src.alternative_store->>'supplier_id')::uuid=i.actual_supplier_id then src.alternative_store->'purchased_on'
        else null end,
      'note',i.note
    ) order by i.position) items,
    link.purchase_id,po.status purchase_status,po.total_amount,po.received_at,po.receiving_storage_location_id,po.receipt_number,po.voided_at
  from buying_private.items i
  join public.suppliers s on s.id=i.actual_supplier_id
  left join buying_private.sources src on src.list_id=i.list_id and src.product_id=i.product_id
  left join buying_private.purchase_links link on link.list_id=i.list_id and link.supplier_id=i.actual_supplier_id
  left join public.purchase_orders po on po.id=link.purchase_id
  where i.list_id=p_id and i.outcome in ('bought','partial') and i.bought_boxes>0 and i.actual_supplier_id is not null
  group by i.actual_supplier_id,s.name,s.phone,link.purchase_id,po.status,po.total_amount,po.received_at,po.receiving_storage_location_id,po.receipt_number,po.voided_at
 )
 select coalesce(jsonb_agg(jsonb_build_object(
   'supplier_id',supplier_id,'store_name',store_name,'store_phone',store_phone,
   'item_count',item_count,'bought_boxes',bought_boxes,'items',items,
   'linked_purchase',jsonb_build_object(
     'purchase_id',purchase_id,'status',purchase_status,'total_amount',total_amount,
     'received_at',received_at,'receiving_storage_location_id',receiving_storage_location_id,
     'receipt_number',receipt_number,'voided_at',voided_at
   )
 ) order by store_name,supplier_id),'[]'::jsonb)
 into groups from grouped;

 return jsonb_build_object(
  'list_id',p_id,'revision',parent.revision,'status',parent.status,'assigned_to',parent.assigned_to,
  'can_record',can_record,'groups',groups
 );
end $$;

create function buying_private.link_purchase(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 me uuid:=buying_private.member(); requestid uuid; listid uuid; supplierid uuid; purchaseid uuid;
 old buying_private.purchase_link_commands; parent buying_private.lists; po public.purchase_orders; existing buying_private.purchase_links;
 expected_count integer; mismatch_count integer; answer jsonb;
begin
 if auth.uid() is null or me is null then raise exception 'Active staff access required' using errcode='42501';end if;
 if jsonb_typeof(p_command) is distinct from 'object' or octet_length(p_command::text)>5000
   or (select count(*) from jsonb_object_keys(p_command))<>4
   or not p_command ?& array['request_id','list_id','supplier_id','purchase_id']
 then raise exception 'Invalid purchase link command' using errcode='22023';end if;
 requestid:=(p_command->>'request_id')::uuid; listid:=(p_command->>'list_id')::uuid;
 supplierid:=(p_command->>'supplier_id')::uuid; purchaseid:=(p_command->>'purchase_id')::uuid;

 perform pg_advisory_xact_lock(hashtextextended('buying-purchase-link:'||requestid::text,0));
 select * into old from buying_private.purchase_link_commands where request_id=requestid for update;
 if found then
  if old.actor<>auth.uid() or old.request is distinct from p_command then raise exception 'Request identity conflict' using errcode='23505';end if;
  if not buying_private.visible(old.list_id) then raise exception 'Access changed' using errcode='42501';end if;
  return old.response;
 end if;

 if not buying_private.purchase_actor(listid) then raise exception 'Purchase permission required' using errcode='42501';end if;
 select * into parent from buying_private.lists where id=listid for share;
 if not found then raise exception 'Buying list not found' using errcode='23503';end if;
 if parent.status<>'completed' then raise exception 'Finish the buying checklist before recording the purchase' using errcode='23514';end if;
 if parent.assigned_to<>me and not public.snacky_current_profile_has_any_role(array['owner','admin']) then
  raise exception 'Only the assigned buyer can record this purchase' using errcode='42501';
 end if;

 perform pg_advisory_xact_lock(hashtextextended('buying-purchase-group:'||listid::text||':'||supplierid::text,0));
 select * into existing from buying_private.purchase_links where list_id=listid and supplier_id=supplierid for update;
 if found then
  if existing.purchase_id<>purchaseid then raise exception 'This store group is already linked to another purchase' using errcode='23505';end if;
  answer:=jsonb_build_object('ok',true,'request_id',requestid,'list_id',listid,'supplier_id',supplierid,'purchase_id',purchaseid);
  insert into buying_private.purchase_link_commands(request_id,actor,list_id,request,response)
  values(requestid,auth.uid(),listid,p_command,answer);
  return answer;
 end if;

 select * into po from public.purchase_orders where id=purchaseid for share;
 if not found or po.voided_at is not null or po.status not in ('draft','received') then raise exception 'Purchase is unavailable for this buying list' using errcode='23514';end if;
 if po.supplier_id is distinct from supplierid then raise exception 'Purchase supplier does not match the store used' using errcode='23514';end if;
 if po.created_by is distinct from me then raise exception 'The assigned buyer must record their own purchase' using errcode='42501';end if;
 if po.status='received' and po.received_by is distinct from me then raise exception 'The same buyer must receive this purchase into storage' using errcode='42501';end if;

 select count(*)::integer into expected_count
 from buying_private.items i
 where i.list_id=listid and i.actual_supplier_id=supplierid and i.outcome in ('bought','partial') and i.bought_boxes>0;
 if expected_count=0 then raise exception 'No purchased items belong to this store' using errcode='23514';end if;

 with expected as (
  select i.product_id,(i.bought_boxes*i.units_per_box)::integer qty
  from buying_private.items i
  where i.list_id=listid and i.actual_supplier_id=supplierid and i.outcome in ('bought','partial') and i.bought_boxes>0
 ), actual as (
  select l.product_id,sum(l.ordered_qty)::integer qty
  from public.purchase_order_lines l where l.purchase_order_id=purchaseid group by l.product_id
 ), differences as (
  select coalesce(e.product_id,a.product_id) product_id,e.qty expected_qty,a.qty actual_qty
  from expected e full join actual a using(product_id)
  where e.product_id is null or a.product_id is null or e.qty is distinct from a.qty
 )
 select count(*)::integer into mismatch_count from differences;
 if mismatch_count<>0 then raise exception 'Purchase quantities changed from the checked buying list; return to the list and correct the actual boxes first' using errcode='23514';end if;

 insert into buying_private.purchase_links(list_id,supplier_id,purchase_id,linked_by)
 values(listid,supplierid,purchaseid,me);
 answer:=jsonb_build_object('ok',true,'request_id',requestid,'list_id',listid,'supplier_id',supplierid,'purchase_id',purchaseid);
 insert into buying_private.purchase_link_commands(request_id,actor,list_id,request,response)
 values(requestid,auth.uid(),listid,p_command,answer);
 return answer;
end $$;

create function public.snacky_buying_legacy_item_retry_v1(p_command jsonb)
returns jsonb language sql security invoker set search_path='' as $select buying_private.legacy_item_retry(p_command);$;
create function public.snacky_buying_item_result_v2(p_command jsonb)
returns jsonb language sql security invoker set search_path='' as $select buying_private.item_result(p_command);$;
create function public.snacky_buying_purchase_workspace_v1(p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$select buying_private.purchase_workspace(p_id);$$;
create function public.snacky_buying_purchase_link_v1(p_command jsonb)
returns jsonb language sql security invoker set search_path='' as $$select buying_private.link_purchase(p_command);$$;

revoke all on function buying_private.purchase_actor(uuid),buying_private.item_result(jsonb),buying_private.legacy_item_retry(jsonb),buying_private.purchase_workspace(uuid),buying_private.link_purchase(jsonb) from public,anon,authenticated;
revoke all on function public.snacky_buying_legacy_item_retry_v1(jsonb),public.snacky_buying_item_result_v2(jsonb),public.snacky_buying_purchase_workspace_v1(uuid),public.snacky_buying_purchase_link_v1(jsonb) from public,anon;
grant execute on function buying_private.purchase_actor(uuid),buying_private.item_result(jsonb),buying_private.legacy_item_retry(jsonb),buying_private.purchase_workspace(uuid),buying_private.link_purchase(jsonb) to authenticated;
grant execute on function public.snacky_buying_legacy_item_retry_v1(jsonb),public.snacky_buying_item_result_v2(jsonb),public.snacky_buying_purchase_workspace_v1(uuid),public.snacky_buying_purchase_link_v1(jsonb) to authenticated;

-- Keep CRM-only accounts on the scoped checklist API. They may record buying
-- outcomes when assigned, but they still cannot create/receive purchase records.
do $$declare definition text:=pg_get_functiondef('public.snacky_crm_api_request_guard()'::regprocedure);
 anchor text:='if not public.snacky_crm_is_limited() then return;end if;';
begin
 if position(anchor in definition)=0 then raise exception 'Review current CRM API guard before installing buying-to-storage';end if;
 execute replace(definition,anchor,anchor||E'\n if path in (''/rpc/snacky_buying_item_result_v2'',''/rest/v1/rpc/snacky_buying_item_result_v2'',''/rpc/snacky_buying_legacy_item_retry_v1'',''/rest/v1/rpc/snacky_buying_legacy_item_retry_v1'') and buying_private.member() is not null then return;end if;');
end $$;

select pg_notify('pgrst','reload schema');
commit;
