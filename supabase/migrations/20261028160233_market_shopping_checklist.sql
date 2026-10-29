-- Supabase CLI generated this migration identity.
-- Shopping intent and progress only. Actual receipt SKUs, stock and payments
-- continue through the existing purchase lifecycle.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('buying_private.workspace(uuid,jsonb)') is null
    or to_regprocedure('buying_private.purchase_workspace(uuid)') is null
    or to_regprocedure('buying_private.purchase_command(jsonb)') is null then
    raise exception 'Install the reviewed buying-list and receipt migrations first';
  end if;
end;
$$;

alter table buying_private.lists
  add column shopping_mode boolean not null default false;

create table buying_private.checklist_items (
  list_id uuid not null references buying_private.lists(id),
  id uuid not null,
  product_id uuid references public.products(id),
  label text not null check (length(btrim(label)) between 1 and 160),
  quantity integer not null check (quantity between 1 and 10000),
  unit text not null check (unit in ('boxes', 'packs', 'units')),
  flexibility text not null check (flexibility in ('exact', 'any_flavour', 'any_brand')),
  acquired_quantity integer not null default 0 check (acquired_quantity between 0 and quantity),
  unavailable boolean not null default false,
  note text not null default '' check (length(note) <= 1000),
  position integer not null check (position > 0),
  created_by uuid not null references public.team_members(id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.team_members(id),
  updated_at timestamptz not null default now(),
  removed_by uuid references public.team_members(id),
  removed_at timestamptz,
  primary key (list_id, id),
  unique (list_id, position),
  check (not unavailable or acquired_quantity = 0),
  check ((removed_at is null) = (removed_by is null))
);
alter table buying_private.checklist_items enable row level security;
revoke all on buying_private.checklist_items from public, anon, authenticated;
create index checklist_active_list_position
  on buying_private.checklist_items(list_id, position) where removed_at is null;
create index checklist_reference_product
  on buying_private.checklist_items(product_id) where product_id is not null;

comment on column buying_private.checklist_items.product_id is
  'Optional preferred product reference. This is not an assertion about the actual SKU purchased.';
comment on column buying_private.checklist_items.acquired_quantity is
  'Market checklist progress in the stated shopping unit; never writes inventory or receipt quantities.';

-- Invoker-only helpers have no API grants. They run inside the checked private
-- boundary, and cannot expose another list through a direct authenticated call.
create function buying_private.checklist_item_value(p_item jsonb)
returns buying_private.checklist_items
language plpgsql security invoker set search_path = ''
as $$
declare
  result buying_private.checklist_items;
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
begin
  if jsonb_typeof(p_item) is distinct from 'object'
    or p_item - array['id','product_id','label','quantity','unit','flexibility','acquired_quantity','unavailable','note'] <> '{}'::jsonb
    or jsonb_typeof(p_item->'id') is distinct from 'string'
    or (p_item->>'id') !~ uuid_pattern
    or not (p_item ? 'product_id')
    or jsonb_typeof(p_item->'label') is distinct from 'string'
    or length(btrim(p_item->>'label')) not between 1 and 160
    or length(p_item->>'label') > 160
    or jsonb_typeof(p_item->'quantity') is distinct from 'number'
    or (p_item->>'quantity') !~ '^[1-9][0-9]{0,4}$'
    or jsonb_typeof(p_item->'unit') is distinct from 'string'
    or (p_item->>'unit') not in ('boxes','packs','units')
    or jsonb_typeof(p_item->'flexibility') is distinct from 'string'
    or (p_item->>'flexibility') not in ('exact','any_flavour','any_brand')
    or jsonb_typeof(p_item->'acquired_quantity') is distinct from 'number'
    or (p_item->>'acquired_quantity') !~ '^[0-9]{1,5}$'
    or jsonb_typeof(p_item->'unavailable') is distinct from 'boolean'
    or jsonb_typeof(p_item->'note') is distinct from 'string'
    or length(p_item->>'note') > 1000 then
    raise exception 'Review the shopping item, quantity, flexibility and progress' using errcode = '22023';
  end if;

  result.id := (p_item->>'id')::uuid;
  result.label := btrim(p_item->>'label');
  result.quantity := (p_item->>'quantity')::integer;
  result.unit := p_item->>'unit';
  result.flexibility := p_item->>'flexibility';
  result.acquired_quantity := (p_item->>'acquired_quantity')::integer;
  result.unavailable := (p_item->>'unavailable')::boolean;
  result.note := p_item->>'note';
  if result.quantity not between 1 and 10000
    or result.acquired_quantity not between 0 and result.quantity
    or (result.unavailable and result.acquired_quantity <> 0) then
    raise exception 'Shopping progress must be within the requested quantity' using errcode = '22023';
  end if;

  if p_item ? 'product_id' and p_item->'product_id' <> 'null'::jsonb then
    if jsonb_typeof(p_item->'product_id') is distinct from 'string'
      or (p_item->>'product_id') !~ uuid_pattern then
      raise exception 'Invalid preferred product' using errcode = '22023';
    end if;
    result.product_id := (p_item->>'product_id')::uuid;
    -- This reference is only a preferred example. Catalogue deactivation must
    -- not strand a saved shopping draft or block edits to the shopping need.
    perform 1 from public.products where id = result.product_id for key share;
    if not found then
      raise exception 'Preferred product does not exist' using errcode = '22023';
    end if;
  end if;
  return result;
end;
$$;

create function buying_private.checklist_counts(p_list uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'item_count', count(*),
    'checked_count', count(*) filter (where acquired_quantity = quantity or unavailable),
    'acquired_count', count(*) filter (where acquired_quantity = quantity),
    'remaining_count', count(*) filter (where acquired_quantity < quantity),
    'unavailable_count', count(*) filter (where unavailable)
  )
  from buying_private.checklist_items where list_id = p_list and removed_at is null;
$$;

create function buying_private.shopping_workspace(p_id uuid, p_filters jsonb)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  result jsonb;
  record_data jsonb;
  list_rows jsonb;
begin
  if auth.uid() is null or buying_private.member() is null then
    raise exception 'Active buying staff access required' using errcode = '42501';
  end if;
  -- Preserve the installed role, visibility, filters, ordering and people rules.
  result := buying_private.workspace(p_id, p_filters);
  record_data := result->'record';
  if record_data is not null and record_data <> 'null'::jsonb then
    record_data := record_data || jsonb_build_object(
      'items', coalesce(nullif(record_data->'items', 'null'::jsonb), '[]'::jsonb),
      'checklist_items', '[]'::jsonb
    );
    if coalesce((record_data->>'shopping_mode')::boolean, false) then
      record_data := record_data || buying_private.checklist_counts(p_id)
        || jsonb_build_object('items', '[]'::jsonb, 'checklist_items', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', i.id, 'product_id', i.product_id, 'label', i.label,
            'quantity', i.quantity, 'unit', i.unit, 'flexibility', i.flexibility,
            'acquired_quantity', i.acquired_quantity, 'unavailable', i.unavailable,
            'note', i.note
          ) order by i.position), '[]'::jsonb)
          from buying_private.checklist_items i where i.list_id = p_id and i.removed_at is null
        ));
    end if;
    result := jsonb_set(result, '{record}', record_data);
  end if;

  select coalesce(jsonb_agg(
    case when coalesce((entry.value->>'shopping_mode')::boolean, false)
      then entry.value || buying_private.checklist_counts((entry.value->>'id')::uuid)
      else entry.value end order by entry.ordinality
  ), '[]'::jsonb)
  into list_rows
  from jsonb_array_elements(result->'rows') with ordinality as entry(value, ordinality);
  return jsonb_set(result, '{rows}', list_rows);
end;
$$;

create function buying_private.checklist_command(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
<<checklist>>
declare
  me uuid := buying_private.member();
  request_id uuid;
  list_id uuid;
  action text;
  payload jsonb;
  version integer;
  prior buying_private.commands%rowtype;
  list_row buying_private.lists%rowtype;
  item buying_private.checklist_items%rowtype;
  previous_item buying_private.checklist_items%rowtype;
  selection jsonb;
  item_id uuid;
  target uuid;
  next_position integer;
  acquired integer;
  unavailable boolean;
  answer jsonb;
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
begin
  if auth.uid() is null or me is null then
    raise exception 'Active buying staff access required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_command) is distinct from 'object'
    or p_command - array['request_id','list_id','action','revision','payload'] <> '{}'::jsonb
    or octet_length(p_command::text) > 400000
    or jsonb_typeof(p_command->'request_id') is distinct from 'string'
    or (p_command->>'request_id') !~ uuid_pattern
    or jsonb_typeof(p_command->'list_id') is distinct from 'string'
    or (p_command->>'list_id') !~ uuid_pattern
    or jsonb_typeof(p_command->'revision') is distinct from 'number'
    or (p_command->>'revision') !~ '^[0-9]{1,10}$'
    or (p_command->>'revision')::bigint > 2147483646
    or jsonb_typeof(p_command->'action') is distinct from 'string'
    or (p_command->>'action') not in ('create','add','edit','progress','remove','complete','assign','cancel','reopen')
    or jsonb_typeof(p_command->'payload') is distinct from 'object' then
    raise exception 'Invalid shopping checklist command' using errcode = '22023';
  end if;
  request_id := (p_command->>'request_id')::uuid;
  list_id := (p_command->>'list_id')::uuid;
  action := p_command->>'action';
  version := (p_command->>'revision')::integer;
  payload := p_command->'payload';

  -- Share the request lock namespace with the legacy buying command. A request
  -- identity cannot race across the old and new handlers or be changed on retry.
  perform pg_advisory_xact_lock(hashtextextended('buying:' || request_id::text, 0));
  select * into prior from buying_private.commands c where c.id = request_id;
  if found then
    if prior.actor is distinct from auth.uid() or prior.request is distinct from p_command then
      raise exception 'Request identity conflict' using errcode = '23505';
    end if;
    select * into list_row from buying_private.lists l where l.id = prior.list_id;
    if not list_row.shopping_mode or not buying_private.visible(prior.list_id)
      or not (buying_private.planner() or list_row.assigned_to = me) then
      raise exception 'Shopping access changed' using errcode = '42501';
    end if;
    return prior.response;
  end if;

  if action = 'create' then
    if not buying_private.planner() then
      raise exception 'Planning permission required' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('buying-list:' || list_id::text, 0));
    if version <> 0 or exists(select 1 from buying_private.lists l where l.id = list_id) then
      raise exception 'List already exists' using errcode = '40001';
    end if;
    if payload - array['title','instructions','assigned_to','due_on','items'] <> '{}'::jsonb
      or jsonb_typeof(payload->'title') is distinct from 'string'
      or length(btrim(payload->>'title')) not between 1 and 160 or length(payload->>'title') > 160
      or jsonb_typeof(payload->'instructions') is distinct from 'string' or length(payload->>'instructions') > 3000
      or jsonb_typeof(payload->'assigned_to') is distinct from 'string' or (payload->>'assigned_to') !~ uuid_pattern
      or jsonb_typeof(payload->'due_on') is distinct from 'string' or (payload->>'due_on') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(payload->'items') is distinct from 'array' then
      raise exception 'Review the checklist title, buyer, date and items' using errcode = '22023';
    end if;
    if jsonb_array_length(payload->'items') not between 1 and 200 then
      raise exception 'Choose 1 to 200 shopping items' using errcode = '22023';
    end if;
    target := (payload->>'assigned_to')::uuid;
    if not exists(select 1 from jsonb_array_elements(buying_private.workspace(null, '{}')->'people') p where p->>'id' = target::text) then
      raise exception 'Choose an active buying employee' using errcode = '22023';
    end if;
    if to_char((payload->>'due_on')::date, 'YYYY-MM-DD') <> payload->>'due_on' then
      raise exception 'Invalid shopping date' using errcode = '22023';
    end if;
    insert into buying_private.lists(id, title, instructions, assigned_to, created_by, due_on, shopping_mode)
      values(list_id, btrim(payload->>'title'), payload->>'instructions', target, me, (payload->>'due_on')::date, true)
      returning * into list_row;
    next_position := 0;
    for selection in select value from jsonb_array_elements(payload->'items') loop
      item := buying_private.checklist_item_value(selection);
      next_position := next_position + 1;
      insert into buying_private.checklist_items(list_id, id, product_id, label, quantity, unit, flexibility,
        acquired_quantity, unavailable, note, position, created_by, updated_by)
      values(list_id, item.id, item.product_id, item.label, item.quantity, item.unit, item.flexibility,
        item.acquired_quantity, item.unavailable, item.note, next_position, me, me);
    end loop;
  else
    if not buying_private.visible(list_id) then
      raise exception 'List access denied' using errcode = '42501';
    end if;
    select * into list_row from buying_private.lists l where l.id = list_id for update;
    if not list_row.shopping_mode then
      raise exception 'This is a legacy exact-product buying list' using errcode = '22023';
    end if;
    if not (buying_private.planner() or list_row.assigned_to = me) then
      raise exception 'Only the buyer or planner can edit this checklist' using errcode = '42501';
    end if;
    if version < 1 or list_row.revision <> version then
      raise exception 'Checklist changed; reload before editing' using errcode = '40001';
    end if;
    if action in ('assign','cancel','reopen') and not buying_private.planner() then
      raise exception 'Planning permission required' using errcode = '42501';
    end if;
    if action <> 'reopen' and list_row.status <> 'open' then
      raise exception 'Checklist is closed' using errcode = '22023';
    end if;

    if action in ('add','edit') then
      if payload - 'item' <> '{}'::jsonb or jsonb_typeof(payload->'item') is distinct from 'object' then
        raise exception 'Choose a shopping item' using errcode = '22023';
      end if;
      item := buying_private.checklist_item_value(payload->'item');
      if action = 'add' then
        if (select count(*) from buying_private.checklist_items i where i.list_id = checklist.list_id and i.removed_at is null) >= 200 then
          raise exception 'A checklist can contain up to 200 active items' using errcode = '22023';
        end if;
        select coalesce(max(i.position), 0) + 1 into next_position from buying_private.checklist_items i where i.list_id = checklist.list_id;
        insert into buying_private.checklist_items(list_id, id, product_id, label, quantity, unit, flexibility,
          acquired_quantity, unavailable, note, position, created_by, updated_by)
        values(list_id, item.id, item.product_id, item.label, item.quantity, item.unit, item.flexibility,
          item.acquired_quantity, item.unavailable, item.note, next_position, me, me);
      else
        select * into previous_item from buying_private.checklist_items i
          where i.list_id = checklist.list_id and i.id = item.id and i.removed_at is null;
        if not found then raise exception 'Shopping item is missing or removed' using errcode = '22023';end if;
        if previous_item.unit <> item.unit and previous_item.acquired_quantity > 0 then
          raise exception 'Reset acquired progress before changing the shopping unit' using errcode = '22023';
        end if;
        update buying_private.checklist_items i
          set product_id = item.product_id, label = item.label, quantity = item.quantity, unit = item.unit,
            flexibility = item.flexibility, acquired_quantity = item.acquired_quantity, unavailable = item.unavailable,
            note = item.note, updated_by = me, updated_at = clock_timestamp()
          where i.list_id = checklist.list_id and i.id = item.id and i.removed_at is null;
        if not found then raise exception 'Shopping item is missing or removed' using errcode = '22023';end if;
      end if;
    elsif action in ('progress','remove') then
      if (action = 'progress' and payload - array['item_id','acquired_quantity','unavailable','note'] <> '{}'::jsonb)
        or (action = 'remove' and payload - 'item_id' <> '{}'::jsonb)
        or jsonb_typeof(payload->'item_id') is distinct from 'string'
        or (payload->>'item_id') !~ uuid_pattern then
        raise exception 'Invalid shopping item identity' using errcode = '22023';
      end if;
      item_id := (payload->>'item_id')::uuid;
      select * into item from buying_private.checklist_items i where i.list_id = checklist.list_id and i.id = item_id and i.removed_at is null for update;
      if not found then raise exception 'Shopping item is missing or removed' using errcode = '22023';end if;
      if action = 'progress' then
        if jsonb_typeof(payload->'acquired_quantity') is distinct from 'number'
          or (payload->>'acquired_quantity') !~ '^[0-9]{1,5}$'
          or jsonb_typeof(payload->'unavailable') is distinct from 'boolean'
          or jsonb_typeof(payload->'note') is distinct from 'string' or length(payload->>'note') > 1000 then
          raise exception 'Invalid shopping progress' using errcode = '22023';
        end if;
        acquired := (payload->>'acquired_quantity')::integer;
        unavailable := (payload->>'unavailable')::boolean;
        if acquired not between 0 and item.quantity or (unavailable and acquired <> 0) then
          raise exception 'Shopping progress must be within the requested quantity' using errcode = '22023';
        end if;
        update buying_private.checklist_items i set acquired_quantity = acquired,
          unavailable = checklist.unavailable, note = payload->>'note', updated_by = me, updated_at = clock_timestamp()
          where i.list_id = checklist.list_id and i.id = item_id;
      else
        update buying_private.checklist_items i set removed_by = me, removed_at = clock_timestamp(),
          updated_by = me, updated_at = clock_timestamp() where i.list_id = checklist.list_id and i.id = item_id;
      end if;
    elsif action = 'complete' then
      if payload <> '{}'::jsonb then raise exception 'Invalid completion command' using errcode = '22023';end if;
      if exists(select 1 from buying_private.checklist_items i where i.list_id = checklist.list_id and i.removed_at is null
        and not i.unavailable and i.acquired_quantity < i.quantity) then
        raise exception 'Resolve every remaining shopping item before finishing' using errcode = '22023';
      end if;
      update buying_private.lists l set status = 'completed' where l.id = list_id;
    elsif action = 'cancel' then
      if payload - 'reason' <> '{}'::jsonb or jsonb_typeof(payload->'reason') is distinct from 'string'
        or length(btrim(payload->>'reason')) not between 1 and 1000 or length(payload->>'reason') > 1000 then
        raise exception 'Cancellation reason required' using errcode = '22023';
      end if;
      update buying_private.lists l set status = 'cancelled' where l.id = list_id;
    elsif action = 'reopen' then
      if payload <> '{}'::jsonb or list_row.status <> 'completed' then
        raise exception 'Only completed checklists may reopen' using errcode = '22023';
      end if;
      update buying_private.lists l set status = 'open' where l.id = list_id;
    elsif action = 'assign' then
      if payload - 'assigned_to' <> '{}'::jsonb or jsonb_typeof(payload->'assigned_to') is distinct from 'string'
        or (payload->>'assigned_to') !~ uuid_pattern then
        raise exception 'Choose an active buying employee' using errcode = '22023';
      end if;
      target := (payload->>'assigned_to')::uuid;
      if not exists(select 1 from jsonb_array_elements(buying_private.workspace(null, '{}')->'people') p where p->>'id' = target::text) then
        raise exception 'Choose an active buying employee' using errcode = '22023';
      end if;
      update buying_private.lists l set assigned_to = target where l.id = list_id;
    end if;
    update buying_private.lists l set revision = l.revision + 1, updated_at = clock_timestamp()
      where l.id = list_id returning * into list_row;
  end if;

  answer := jsonb_build_object('request_id', request_id, 'list_id', list_id, 'revision', list_row.revision);
  insert into buying_private.commands(id, actor, list_id, request, response)
    values(request_id, auth.uid(), list_id, p_command, answer);
  return answer;
end;
$$;

-- This table guard also covers a legacy complete command, which otherwise sees
-- no exact-product rows and could finish a market list with unmet needs.
create function buying_private.checklist_status_guard()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.shopping_mode is distinct from old.shopping_mode then
    raise exception 'A buying list cannot change its shopping mode' using errcode = '23514';
  end if;
  if new.shopping_mode and new.status = 'completed' and old.status <> 'completed'
    and exists(select 1 from buying_private.checklist_items i where i.list_id = new.id and i.removed_at is null
      and not i.unavailable and i.acquired_quantity < i.quantity) then
    raise exception 'Resolve every remaining shopping item before finishing' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger checklist_completion_guard before update on buying_private.lists
  for each row execute function buying_private.checklist_status_guard();

-- Preserve the actual legacy receipt implementations and all receipt/stock
-- guards. Only their checked entry points change for new market-mode lists.
create function buying_private.purchase_workspace_checked(p_list uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if auth.uid() is null or not buying_private.purchase_access(p_list, false) then
    raise exception 'Purchase list access denied' using errcode = '42501';
  end if;
  if exists(select 1 from buying_private.lists where id = p_list and shopping_mode) then
    raise exception 'Market checklists are planning only; record the actual receipt in Purchases' using errcode = '22023';
  end if;
  return buying_private.purchase_workspace(p_list);
end;
$$;

create function buying_private.purchase_command_checked(p_command jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  list_id uuid := (p_command->>'list_id')::uuid;
begin
  if auth.uid() is null or not buying_private.purchase_access(list_id, true) then
    raise exception 'Only the assigned purchasing or storage employee can record this receipt' using errcode = '42501';
  end if;
  if exists(select 1 from buying_private.lists l where l.id = list_id and l.shopping_mode) then
    raise exception 'Market checklists are planning only; record the actual receipt in Purchases' using errcode = '22023';
  end if;
  return buying_private.purchase_command(p_command);
end;
$$;

create or replace function public.snacky_buying_workspace_v1(p_id uuid default null, p_filters jsonb default '{}')
returns jsonb language sql stable security invoker set search_path = ''
as $$select buying_private.shopping_workspace(p_id, p_filters);$$;
create function public.snacky_buying_checklist_command_v1(p_command jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$select buying_private.checklist_command(p_command);$$;
create or replace function public.snacky_buying_purchase_workspace_v1(p_list uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$select buying_private.purchase_workspace_checked(p_list);$$;
create or replace function public.snacky_buying_purchase_command_v1(p_command jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$select buying_private.purchase_command_checked(p_command);$$;

revoke all on function buying_private.checklist_item_value(jsonb), buying_private.checklist_counts(uuid),
  buying_private.shopping_workspace(uuid,jsonb), buying_private.checklist_command(jsonb),
  buying_private.checklist_status_guard(), buying_private.purchase_workspace_checked(uuid),
  buying_private.purchase_command_checked(jsonb) from public, anon, authenticated;
grant execute on function buying_private.shopping_workspace(uuid,jsonb), buying_private.checklist_command(jsonb),
  buying_private.purchase_workspace_checked(uuid), buying_private.purchase_command_checked(jsonb) to authenticated;
-- Direct access to the previous definer entry points must not bypass the mode guard.
revoke all on function buying_private.purchase_workspace(uuid), buying_private.purchase_command(jsonb) from public, anon, authenticated;
revoke all on function public.snacky_buying_workspace_v1(uuid,jsonb), public.snacky_buying_checklist_command_v1(jsonb),
  public.snacky_buying_purchase_workspace_v1(uuid), public.snacky_buying_purchase_command_v1(jsonb) from public, anon;
grant execute on function public.snacky_buying_workspace_v1(uuid,jsonb), public.snacky_buying_checklist_command_v1(jsonb),
  public.snacky_buying_purchase_workspace_v1(uuid), public.snacky_buying_purchase_command_v1(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;
