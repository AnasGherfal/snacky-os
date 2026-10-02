-- Add a source link, not a second purchase or inventory ledger.
-- Supabase CLI generated this migration identity. No historical rows are backfilled.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table buying_private.purchase_links (
 purchase_id uuid primary key references public.purchase_orders(id),
 list_id uuid not null references buying_private.lists(id),
 buyer_id uuid not null references public.team_members(id),
 supplier_id uuid not null references public.suppliers(id),
 receipt_sha256 text not null check(receipt_sha256 ~ '^[a-f0-9]{64}$'),
 receipt_number text,
 snapshot jsonb not null,
 created_at timestamptz not null default now(),
 retired_at timestamptz
);
create unique index buying_receipt_hash_once on buying_private.purchase_links(list_id,supplier_id,receipt_sha256) where retired_at is null;
create unique index buying_receipt_number_once on buying_private.purchase_links(list_id,supplier_id,lower(receipt_number)) where receipt_number is not null and retired_at is null;
create index buying_purchase_link_list on buying_private.purchase_links(list_id,created_at);
create table buying_private.purchase_requests (
 request_id uuid primary key,
 actor uuid not null references auth.users(id),
 list_id uuid not null references buying_private.lists(id),
 request jsonb not null,
 response jsonb not null,
 created_at timestamptz not null default now()
);
alter table buying_private.purchase_links enable row level security;
alter table buying_private.purchase_requests enable row level security;
revoke all on buying_private.purchase_links,buying_private.purchase_requests from public,anon,authenticated;

create function buying_private.invoiced_units(p_list uuid,p_product uuid)
returns bigint language sql stable security definer set search_path='' as $$
 select coalesce(sum(line.total_units),0)::bigint
 from buying_private.purchase_links link
 join public.purchase_orders po on po.id=link.purchase_id
 join public.purchase_order_lines line on line.purchase_order_id=po.id
 where link.list_id=p_list and line.product_id=p_product
   and po.status not in ('cancelled','voided') and po.voided_at is null;
$$;
create function buying_private.purchase_access(p_list uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and buying_private.member() is not null
 and public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing'])
 and exists(select 1 from buying_private.lists l where l.id=p_list
   and case when p_write then l.assigned_to=buying_private.member() and l.status<>'cancelled'
       else buying_private.visible(l.id) end);
$$;
create function buying_private.purchase_workspace(p_list uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not buying_private.purchase_access(p_list,false) then raise exception 'Purchase list access denied' using errcode='42501';end if;
 select jsonb_build_object(
  'list_id',l.id,'title',l.title,'revision',l.revision,'can_record',buying_private.purchase_access(l.id,true),
  'today',(now() at time zone 'Africa/Tripoli')::date,
  'items',coalesce((select jsonb_agg(jsonb_build_object(
    'product_id',i.product_id,'name',i.name,'units_per_box',i.units_per_box,
    'bought_units',i.bought_boxes*i.units_per_box,
    'remaining_units',greatest(i.bought_boxes*i.units_per_box-buying_private.invoiced_units(l.id,i.product_id),0),
    'primary',s.primary_store,'alternative',s.alternative_store
   ) order by i.position) from buying_private.items i left join buying_private.sources s using(list_id,product_id)
   where i.list_id=l.id and i.outcome in ('bought','partial')),'[]'::jsonb),
  'storage',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name,s.id)
   from public.storage_locations s where s.active=true and s.location_type in ('main_storage','vehicle','temporary','other')),'[]'::jsonb),
  'receipts',coalesce((select jsonb_agg(jsonb_build_object(
    'purchase_id',po.id,'supplier_name',s.name,'receipt_number',po.receipt_number,'order_date',po.order_date,
    'status',po.status,'payment_status',po.payment_status,'total_amount',po.total_amount,
    'storage_id',po.receiving_storage_location_id,'received_at',po.received_at,
    'received_by',po.received_by,'buyer_id',link.buyer_id,'version',po.updated_at::text,
    'lines',link.snapshot->'lines','note',link.snapshot->>'note',
    'can_receive',buying_private.purchase_access(l.id,true) and link.buyer_id=buying_private.member() and po.status='draft'
   ) order by link.created_at desc) from buying_private.purchase_links link
   join public.purchase_orders po on po.id=link.purchase_id join public.suppliers s on s.id=po.supplier_id
   where link.list_id=l.id),'[]'::jsonb)
 ) into result from buying_private.lists l where l.id=p_list;
 return result;
end $$;

-- Protect only newly linked receipt contents. Existing ordinary purchases are unaffected.
-- Received quantities, status, genuine payment entries and receiving timestamps remain mutable
-- through their existing authorized writers; product/price evidence cannot silently be replaced.
create function buying_private.purchase_snapshot_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare pid uuid; oldj jsonb; newj jsonb;
begin
 if tg_table_name='purchase_orders' then
  pid:=old.id;
  if exists(select 1 from buying_private.purchase_links where purchase_id=pid) then
   oldj:=to_jsonb(old);newj:=to_jsonb(new);
   if (old.status in ('cancelled','voided') or old.voided_at is not null)
      and new.status not in ('cancelled','voided') and new.voided_at is null then
    raise exception 'Cancelled linked receipts remain in history. Create a corrected receipt instead.' using errcode='23514';
   end if;
   if new.status in ('cancelled','voided') or new.voided_at is not null then
    update buying_private.purchase_links set retired_at=coalesce(retired_at,clock_timestamp()) where purchase_id=pid;
   end if;
   if oldj->'supplier_id' is distinct from newj->'supplier_id'
    or oldj->'order_date' is distinct from newj->'order_date'
    or oldj->'total_amount' is distinct from newj->'total_amount'
    or oldj->'receipt_storage_path' is distinct from newj->'receipt_storage_path'
    or oldj->'receipt_number' is distinct from newj->'receipt_number' then
    raise exception 'Linked buying receipt is immutable. Cancel the draft and record the corrected receipt from its buying list.' using errcode='23514';
   end if;
  end if;
 else
  pid:=case when tg_op='INSERT' then new.purchase_order_id else old.purchase_order_id end;
  if exists(select 1 from buying_private.purchase_links where purchase_id=pid) then
   if tg_op<>'UPDATE' then
    raise exception 'Linked buying receipt lines cannot be replaced. Cancel the draft first.' using errcode='23514';
   end if;
   if (to_jsonb(new)-array['received_qty','updated_at']) is distinct from (to_jsonb(old)-array['received_qty','updated_at']) then
    raise exception 'Linked buying receipt quantities and prices are immutable. Cancel the draft first.' using errcode='23514';
   end if;
  end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger buying_purchase_header_snapshot before update on public.purchase_orders for each row execute function buying_private.purchase_snapshot_guard();
create trigger buying_purchase_line_snapshot before insert or update or delete on public.purchase_order_lines for each row execute function buying_private.purchase_snapshot_guard();
create function buying_private.purchased_checklist_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.bought_boxes*new.units_per_box < buying_private.invoiced_units(old.list_id,old.product_id) then
  raise exception 'Recorded receipt quantities exceed this checklist change. Cancel or review the linked purchase first.' using errcode='23514';
 end if;
 return new;
end $$;
create trigger buying_invoiced_quantity_guard before update on buying_private.items for each row execute function buying_private.purchased_checklist_guard();

create function buying_private.purchase_command(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 me uuid:=buying_private.member(); req uuid; lid uuid; act text; p jsonb; rev integer;
 prior buying_private.purchase_requests%rowtype; l buying_private.lists%rowtype;
 src buying_private.sources%rowtype; item buying_private.items%rowtype;
 po public.purchase_orders%rowtype; link buying_private.purchase_links%rowtype;
 entry jsonb; lines jsonb:='[]'; snapshot_lines jsonb:='[]'; ids uuid[]:='{}';
 sid uuid; pid uuid; boxes integer; loose integer; qty integer; cents bigint; total_cents bigint:=0;
 ref_price numeric; chosen jsonb; pos integer:=0; result jsonb; created record;
 storage_id uuid; placed boolean; path text; sha text; mime text; order_day date; note text; receipt_no text;
begin
 if auth.uid() is null or me is null then raise exception 'Sign in required' using errcode='42501';end if;
 if jsonb_typeof(p_command) is distinct from 'object' or p_command-array['request_id','list_id','revision','action','payload']<>'{}'::jsonb or octet_length(p_command::text)>100000 then raise exception 'Invalid receipt command' using errcode='22023';end if;
 req:=(p_command->>'request_id')::uuid;lid:=(p_command->>'list_id')::uuid;act:=p_command->>'action';
 rev:=(p_command->>'revision')::integer;p:=p_command->'payload';
 if req is null or lid is null or act is null or act not in ('create','receive') or rev is null or rev<1 or jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid receipt identity' using errcode='22023';end if;
 if not buying_private.purchase_access(lid,true) then raise exception 'Only the assigned purchasing or storage employee can record this receipt' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('buying-purchase:'||req::text,0));
 select * into prior from buying_private.purchase_requests where request_id=req;
 if found then
  if prior.actor is distinct from auth.uid() or prior.request is distinct from p_command then raise exception 'Receipt request identity conflict' using errcode='23505';end if;
  return prior.response;
 end if;
 select * into l from buying_private.lists where id=lid for update;
 if l.assigned_to is distinct from me or l.status='cancelled' then raise exception 'Buying assignment changed' using errcode='42501';end if;
 if l.revision<>rev then raise exception 'Buying list changed; reload first' using errcode='40001';end if;

 if act='create' then
  if p-array['supplier_id','order_date','receipt_number','lines','storage_id','placed_in_storage','note','receipt_path','receipt_sha256','receipt_mime','receipt_name']<>'{}'::jsonb then raise exception 'Unsupported receipt fields' using errcode='22023';end if;
  sid:=(p->>'supplier_id')::uuid;order_day:=(p->>'order_date')::date;
  placed:=(p->>'placed_in_storage')::boolean;storage_id:=nullif(p->>'storage_id','')::uuid;
  note:=trim(coalesce(p->>'note',''));receipt_no:=nullif(trim(p->>'receipt_number'),'');
  path:=p->>'receipt_path';sha:=p->>'receipt_sha256';mime:=p->>'receipt_mime';
  if sid is null or order_day is null or order_day>(now() at time zone 'Africa/Tripoli')::date
   or jsonb_typeof(p->'placed_in_storage') is distinct from 'boolean' or length(note)>2000
   or length(coalesce(receipt_no,''))>100 or (placed and storage_id is null) then raise exception 'Check receipt date, store and physical storage confirmation' using errcode='22023';end if;
  if sha is null or sha !~ '^[a-f0-9]{64}$' or path is null
   or path !~ ('^buying/'||auth.uid()::text||'/'||lid::text||'/'||sha||'\.(jpg|png|webp|pdf)$')
   or mime is null or mime not in ('image/jpeg','image/png','image/webp','application/pdf')
   or not exists(select 1 from storage.objects o where o.bucket_id='receipt-images' and o.name=path
      and o.metadata->>'mimetype'=mime and (o.metadata->>'size')::bigint between 1 and 5242880) then
   raise exception 'A verified private receipt image or PDF is required' using errcode='23514';
  end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' then raise exception 'Receipt lines required' using errcode='22023';end if;
  if jsonb_array_length(p->'lines') not between 1 and 200 then raise exception 'Receipt must contain 1 to 200 lines' using errcode='22023';end if;
  for entry in select value from jsonb_array_elements(p->'lines') loop
   if entry-array['product_id','boxes','loose','line_total_cents']<>'{}'::jsonb
    or jsonb_typeof(entry->'boxes') is distinct from 'number' or entry->>'boxes' !~ '^[0-9]+$'
    or jsonb_typeof(entry->'loose') is distinct from 'number' or entry->>'loose' !~ '^[0-9]+$'
    or jsonb_typeof(entry->'line_total_cents') is distinct from 'number' or entry->>'line_total_cents' !~ '^[1-9][0-9]*$' then
    raise exception 'Exact quantities and actual line prices are required' using errcode='22023';end if;
   pid:=(entry->>'product_id')::uuid;boxes:=(entry->>'boxes')::integer;loose:=(entry->>'loose')::integer;cents:=(entry->>'line_total_cents')::bigint;
   select * into item from buying_private.items where list_id=lid and product_id=pid;
   select * into src from buying_private.sources where list_id=lid and product_id=pid;
   if item.product_id is null or pid=any(ids) or item.outcome not in ('bought','partial')
    or boxes>10000 or loose>=item.units_per_box or cents>1000000000 then raise exception 'Review bought quantities and selected products' using errcode='22023';end if;
   chosen:=case when src.primary_store->>'supplier_id'=sid::text then src.primary_store
                when src.alternative_store->>'supplier_id'=sid::text then src.alternative_store end;
   if chosen is null then raise exception 'This store is not approved for the selected product' using errcode='23514';end if;
   qty:=boxes*item.units_per_box+loose;
   if qty<=0 or qty+buying_private.invoiced_units(lid,pid)>item.bought_boxes*item.units_per_box then
    raise exception 'These bought units are already recorded, or exceed the buying checklist. Reload and review quantities.' using errcode='23514';end if;
   ref_price:=(chosen->>'unit_cost_lyd')::numeric;
   if ref_price is not null and cents::numeric/100>ref_price*qty+0.01 and note='' then
    raise exception 'Explain the price increase compared with the selected store history' using errcode='23514';end if;
   ids:=array_append(ids,pid);total_cents:=total_cents+cents;
   lines:=lines||jsonb_build_array(jsonb_build_object('product_id',pid,'line_position',pos,'boxes_qty',boxes,
     'units_per_box',item.units_per_box,'loose_units_qty',loose,'line_total',cents::numeric/100));
   snapshot_lines:=snapshot_lines||jsonb_build_array(jsonb_build_object('product_id',pid,'name',item.name,
     'quantity',qty,'boxes',boxes,'loose',loose,'units_per_box',item.units_per_box,
     'line_total_cents',cents,'reference_unit_cost',ref_price,'reference_date',chosen->>'purchased_on'));
   pos:=pos+1;
  end loop;
  if exists(select 1 from buying_private.purchase_links b where b.list_id=lid and b.supplier_id=sid and b.retired_at is null
    and (b.receipt_sha256=sha or (receipt_no is not null and lower(b.receipt_number)=lower(receipt_no)))) then
   raise exception 'This store receipt is already linked. Open its existing purchase instead.' using errcode='23505';end if;
  select * into created from public.snacky_create_purchase_with_lines_v2(
   p_client_submission_id=>req,p_supplier_id=>sid,p_order_date=>order_day,p_receipt_number=>receipt_no,
   p_payment_method=>'cash',p_payment_status=>'unpaid',
   p_receipt_url=>'/api/storage/receipt-images/'||path,p_receipt_file_name=>left(p->>'receipt_name',200),
   p_receipt_content_type=>mime,p_receipt_storage_path=>path,
   p_notes=>'Buying list '||lid::text||E'\n'||note,
   p_calculated_total_lyd=>total_cents::numeric/100,p_manual_total_lyd=>total_cents::numeric/100,
   p_total_adjustment_lyd=>null,p_total_source=>'manual',p_total_amount=>total_cents::numeric/100,
   p_payment_account_id=>'snacky_lyd',p_receiving_storage_location_id=>storage_id,
   p_submit_action=>case when placed then 'received' else 'draft' end,p_lines=>lines);
  if created.id is null then raise exception 'Purchase writer returned no receipt' using errcode='23514';end if;
  insert into buying_private.purchase_links(purchase_id,list_id,buyer_id,supplier_id,receipt_sha256,receipt_number,snapshot)
   values(created.id,lid,me,sid,sha,receipt_no,jsonb_build_object('lines',snapshot_lines,'note',note,'list_revision',rev));
  result:=jsonb_build_object('purchase_id',created.id,'status',created.status,'total_amount',created.total_amount);
 else
  if p-array['purchase_id','version','storage_id','confirmed']<>'{}'::jsonb or p->'confirmed' is distinct from 'true'::jsonb then raise exception 'Confirm the actual quantities placed in storage' using errcode='22023';end if;
  pid:=(p->>'purchase_id')::uuid;storage_id:=(p->>'storage_id')::uuid;
  select * into link from buying_private.purchase_links where purchase_id=pid and list_id=lid;
  if link.purchase_id is null or link.buyer_id is distinct from me then raise exception 'Only the buyer can confirm this receipt on this page' using errcode='42501';end if;
  select * into po from public.purchase_orders where id=pid for update;
  if p->>'version' is distinct from po.updated_at::text or po.status<>'draft' then raise exception 'Purchase changed or was already received; reload first' using errcode='40001';end if;
  if storage_id is null then raise exception 'Choose the actual storage location' using errcode='22023';end if;
  perform public.snacky_receive_purchase_v1(pid,req::text,storage_id);
  result:=jsonb_build_object('purchase_id',pid,'status','received','total_amount',po.total_amount);
 end if;
 update buying_private.lists set revision=revision+1,updated_at=clock_timestamp() where id=lid returning revision into rev;
 result:=result||jsonb_build_object('ok',true,'request_id',req,'list_id',lid,'action',act,'revision',rev);
 insert into buying_private.purchase_requests(request_id,actor,list_id,request,response) values(req,auth.uid(),lid,p_command,result);
 return result;
end $$;

revoke all on function buying_private.invoiced_units(uuid,uuid),buying_private.purchase_access(uuid,boolean),buying_private.purchase_workspace(uuid),buying_private.purchase_command(jsonb),buying_private.purchase_snapshot_guard(),buying_private.purchased_checklist_guard() from public,anon,authenticated;
grant execute on function buying_private.purchase_workspace(uuid),buying_private.purchase_command(jsonb) to authenticated;
create function public.snacky_buying_purchase_workspace_v1(p_list uuid)
returns jsonb language sql security invoker set search_path='' as $$select buying_private.purchase_workspace(p_list);$$;
create function public.snacky_buying_purchase_command_v1(p_command jsonb)
returns jsonb language sql security invoker set search_path='' as $$select buying_private.purchase_command(p_command);$$;
revoke all on function public.snacky_buying_purchase_workspace_v1(uuid),public.snacky_buying_purchase_command_v1(jsonb) from public,anon;
grant execute on function public.snacky_buying_purchase_workspace_v1(uuid),public.snacky_buying_purchase_command_v1(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
