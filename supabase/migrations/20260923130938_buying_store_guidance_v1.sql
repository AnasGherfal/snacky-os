-- Additive store instructions only. No purchase, cash, Finance or stock writes.
-- Required predecessor: 20260920133731_shared_buying_lists.sql.
begin;
set local lock_timeout = '5s';
do $$begin
  if to_regprocedure('buying_private.workspace(uuid,jsonb)') is null
     or to_regprocedure('buying_private.command(jsonb)') is null then
    raise exception 'Apply the reviewed shared_buying_lists migration before store guidance';
  end if;
end $$;
create table buying_private.sources (
  list_id uuid not null,
  product_id uuid not null,
  primary_store jsonb not null check (jsonb_typeof(primary_store) = 'object'),
  alternative_store jsonb check (alternative_store is null or jsonb_typeof(alternative_store) = 'object'),
  note text not null check (length(note) <= 1000),
  saved_by uuid not null references public.team_members(id),
  saved_at timestamptz not null default now(),
  primary key (list_id, product_id),
  foreign key (list_id, product_id) references buying_private.items(list_id, product_id)
);
create table buying_private.source_commands (
  request_id uuid primary key,
  actor uuid not null references auth.users(id),
  list_id uuid not null references buying_private.lists(id),
  request jsonb not null, response jsonb not null,
  previous_source jsonb, saved_source jsonb not null,
  created_at timestamptz not null default now()
);
alter table buying_private.sources enable row level security;
alter table buying_private.source_commands enable row level security;
revoke all on buying_private.sources, buying_private.source_commands from public, anon, authenticated;
create index buying_source_command_list on buying_private.source_commands(list_id, created_at);
-- Bound historical-price lookup to this product before joining the purchase headers.
create index if not exists buying_price_product_purchase on public.purchase_order_lines(product_id, purchase_order_id);

create function buying_private.store_price(p_product uuid, p_supplier uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'supplier_id', s.id, 'name', s.name, 'phone', s.phone,
    'unit_cost_lyd', price.unit_cost_lyd, 'purchased_on', price.purchased_on,
    'purchase_line_id', price.id, 'historical_units_per_box', price.units_per_box
  )
  from public.suppliers s
  left join lateral (
    select l.id, coalesce(l.unit_cost_lyd, l.unit_cost) as unit_cost_lyd,
      coalesce(o.order_date, o.received_date, (o.received_at at time zone 'Africa/Tripoli')::date) as purchased_on,
      l.units_per_box
    from public.purchase_order_lines l
    join public.purchase_orders o on o.id = l.purchase_order_id
    where l.product_id = p_product and o.supplier_id = s.id
      and o.status = 'received' and o.voided_at is null and o.currency = 'LYD'
      and l.received_qty > 0 and coalesce(l.unit_cost_lyd, l.unit_cost) > 0
      and coalesce(l.unit_cost_lyd, l.unit_cost) < 100000000
    order by coalesce(o.order_date, o.received_date, (o.received_at at time zone 'Africa/Tripoli')::date) desc nulls last,
      coalesce(o.received_at, o.created_at) desc nulls last,
      coalesce(l.line_position, 0) desc, l.id desc
    limit 1
  ) price on true
  where s.id = p_supplier;
$$;
-- Helper has no direct API grant; staff may read only snapshots on visible lists.
create function buying_private.source_workspace(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  can_edit boolean;
  version integer;
  source_rows jsonb;
  stores jsonb := '[]';
  options jsonb := '[]';
begin
  if auth.uid() is null or not buying_private.visible(p_id) then
    raise exception 'List access denied' using errcode = '42501';
  end if;
  select revision into version from buying_private.lists where id = p_id;
  can_edit := public.snacky_current_profile_has_any_role(array['owner', 'admin']);
  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', s.product_id, 'primary', s.primary_store,
    'alternative', s.alternative_store, 'note', s.note, 'saved_at', s.saved_at
  ) order by i.position), '[]') into source_rows
  from buying_private.sources s join buying_private.items i using (list_id, product_id)
  where s.list_id = p_id;
  if can_edit then
    select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name, id), '[]') into stores
    from public.suppliers;
    select coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'prices', (
      select coalesce(jsonb_agg(buying_private.store_price(i.product_id, supplier.id) order by supplier.name, supplier.id), '[]')
      from public.suppliers supplier
      where exists (select 1 from public.purchase_order_lines line join public.purchase_orders po on po.id = line.purchase_order_id
        where line.product_id = i.product_id and po.supplier_id = supplier.id and po.status = 'received'
          and po.voided_at is null and po.currency = 'LYD' and line.received_qty > 0)
    )) order by i.position), '[]') into options
    from buying_private.items i where i.list_id = p_id;
  end if;
  return jsonb_build_object('list_id', p_id, 'revision', version, 'can_edit', can_edit,
    'sources', source_rows, 'stores', stores, 'options', options);
end $$;

create function buying_private.source_save(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me uuid := buying_private.member();
  requestid uuid; listid uuid; productid uuid; primaryid uuid; alternativeid uuid; version integer;
  old buying_private.source_commands; parent buying_private.lists; item buying_private.items;
  primary_price jsonb; alternative_price jsonb; previous jsonb; saved jsonb; answer jsonb;
begin
  if auth.uid() is null or me is null or not public.snacky_current_profile_has_any_role(array['owner','admin']) then
    raise exception 'Only owner or admin can set buying instructions' using errcode = '42501';
  end if;
  if jsonb_typeof(p_command) is distinct from 'object' or octet_length(p_command::text) > 8000 then
    raise exception 'Invalid source command' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_object_keys(p_command)) <> 7
     or not p_command ?& array['request_id','list_id','product_id','revision','primary_supplier_id','alternative_supplier_id','note']
     or jsonb_typeof(p_command->'note') is distinct from 'string' or length(p_command->>'note') > 1000
     or jsonb_typeof(p_command->'revision') is distinct from 'number' or p_command->>'revision' !~ '^[1-9][0-9]*$'
     or jsonb_typeof(p_command->'request_id') is distinct from 'string'
     or jsonb_typeof(p_command->'list_id') is distinct from 'string'
     or jsonb_typeof(p_command->'product_id') is distinct from 'string'
     or jsonb_typeof(p_command->'primary_supplier_id') is distinct from 'string'
     or jsonb_typeof(p_command->'alternative_supplier_id') not in ('string','null') then
    raise exception 'Invalid source fields' using errcode = '22023';
  end if;
  requestid := (p_command->>'request_id')::uuid; listid := (p_command->>'list_id')::uuid;
  productid := (p_command->>'product_id')::uuid; primaryid := (p_command->>'primary_supplier_id')::uuid;
  alternativeid := (p_command->>'alternative_supplier_id')::uuid; version := (p_command->>'revision')::integer;
  if primaryid = alternativeid or version >= 2147483647 then
    raise exception 'Choose a different alternative store' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('buying-source:' || requestid::text, 0));
  select * into old from buying_private.source_commands where request_id = requestid;
  if found then
    if old.actor <> auth.uid() or old.request is distinct from p_command then
      raise exception 'Request identity conflict' using errcode = '23505';
    end if;
    if not buying_private.visible(old.list_id) then raise exception 'Access changed' using errcode = '42501'; end if;
    return old.response;
  end if;
  if not buying_private.visible(listid) then raise exception 'List access denied' using errcode = '42501'; end if;
  select * into parent from buying_private.lists where id = listid for update;
  if parent.revision <> version then raise exception 'List changed; reload before setting a store' using errcode = '40001'; end if;
  if parent.status <> 'open' then raise exception 'Closed list instructions are immutable' using errcode = '22023'; end if;
  select * into item from buying_private.items where list_id = listid and product_id = productid for update;
  if not found or item.outcome <> 'pending' then
    raise exception 'Only an unchecked item can change buying instructions' using errcode = '22023';
  end if;
  primary_price := buying_private.store_price(productid, primaryid);
  alternative_price := case when alternativeid is not null then buying_private.store_price(productid, alternativeid) end;
  if primary_price is null or (alternativeid is not null and alternative_price is null) then
    raise exception 'Selected supplier no longer exists' using errcode = '22023';
  end if;
  select to_jsonb(s) into previous from buying_private.sources s where list_id = listid and product_id = productid;
  insert into buying_private.sources(list_id, product_id, primary_store, alternative_store, note, saved_by)
    values (listid, productid, primary_price, alternative_price, p_command->>'note', me)
  on conflict (list_id, product_id) do update set primary_store = excluded.primary_store,
    alternative_store = excluded.alternative_store, note = excluded.note, saved_by = excluded.saved_by, saved_at = now();
  select to_jsonb(s) into saved from buying_private.sources s where list_id = listid and product_id = productid;
  update buying_private.lists set revision = revision + 1, updated_at = now() where id = listid;
  answer := jsonb_build_object('ok', true, 'request_id', requestid, 'list_id', listid, 'product_id', productid, 'revision', version + 1);
  insert into buying_private.source_commands(request_id, actor, list_id, request, response, previous_source, saved_source)
    values (requestid, auth.uid(), listid, p_command, answer, previous, saved);
  return answer;
end $$;
create function public.snacky_buying_sources_v1(p_id uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$select buying_private.source_workspace(p_id);$$;
create function public.snacky_buying_source_save_v1(p_command jsonb) returns jsonb
language sql security invoker set search_path = '' as $$select buying_private.source_save(p_command);$$;
revoke all on function buying_private.store_price(uuid,uuid), buying_private.source_workspace(uuid), buying_private.source_save(jsonb) from public, anon, authenticated;
revoke all on function public.snacky_buying_sources_v1(uuid), public.snacky_buying_source_save_v1(jsonb) from public, anon;
grant execute on function buying_private.source_workspace(uuid), buying_private.source_save(jsonb), public.snacky_buying_sources_v1(uuid), public.snacky_buying_source_save_v1(jsonb) to authenticated;
-- Compose the existing CRM request guard: assigned CRM buyers receive only scoped snapshots, never the price catalogue.
do $$declare definition text := pg_get_functiondef('public.snacky_crm_api_request_guard()'::regprocedure);
  anchor text := 'if not public.snacky_crm_is_limited() then return;end if;';
begin
  if position(anchor in definition) = 0 then raise exception 'Review current CRM guard before installing store guidance'; end if;
  execute replace(definition, anchor, anchor || E'\n if path in (''/rpc/snacky_buying_sources_v1'',''/rest/v1/rpc/snacky_buying_sources_v1'') and buying_private.member() is not null then return;end if;');
end $$;
notify pgrst, 'reload schema';
commit;
