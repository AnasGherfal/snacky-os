-- Expiry-date safety and FEFO batch tracking.
-- Additive shadow ledger: core inventory movements remain authoritative for quantity/accounting.
-- Purchase receipt is the only fail-closed boundary because expired/unknown-expiry stock must not enter sellable inventory.

alter table public.purchase_order_lines
  add column if not exists expiry_date date,
  add column if not exists supplier_lot_code text,
  add column if not exists short_expiry_confirmed boolean not null default false;

create schema if not exists snacky_expiry_private;
revoke all on schema snacky_expiry_private from public, anon, authenticated;
grant usage on schema snacky_expiry_private to service_role;

create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  purchase_order_id uuid references public.purchase_orders(id) on delete restrict,
  purchase_line_id uuid unique references public.purchase_order_lines(id) on delete restrict,
  expiry_date date,
  supplier_lot_code text,
  source_kind text not null check (source_kind in ('purchase','legacy_unknown')),
  original_quantity integer check (original_quantity is null or original_quantity >= 0),
  received_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists inventory_batches_one_unknown_per_product
  on public.inventory_batches(product_id) where source_kind='legacy_unknown';

create table if not exists public.inventory_batch_balances (
  batch_id uuid not null references public.inventory_batches(id) on delete cascade,
  entity_type text not null check(entity_type in ('storage','operator_bag','machine')),
  entity_id uuid not null,
  quantity integer not null default 0 check(quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key(batch_id,entity_type,entity_id)
);
create index if not exists inventory_batch_balances_entity
  on public.inventory_batch_balances(entity_type,entity_id,batch_id);

create table if not exists public.inventory_batch_movement_allocations (
  inventory_movement_id uuid not null references public.inventory_movements(id) on delete cascade,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  quantity integer not null check(quantity > 0),
  created_at timestamptz not null default now(),
  primary key(inventory_movement_id,batch_id)
);

create table if not exists public.inventory_batch_reconciliations (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.machines(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete restrict,
  vms_quantity integer not null,
  tracked_before integer not null,
  adjustment integer not null,
  vms_captured_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists snacky_expiry_private.alert_receipts (
  batch_id uuid not null references public.inventory_batches(id) on delete cascade,
  event_kind text not null,
  recipient_member_id uuid not null references public.team_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(batch_id,event_kind,recipient_member_id)
);

alter table public.inventory_batches enable row level security;
alter table public.inventory_batch_balances enable row level security;
alter table public.inventory_batch_movement_allocations enable row level security;
alter table public.inventory_batch_reconciliations enable row level security;
alter table snacky_expiry_private.alert_receipts enable row level security;

revoke all on public.inventory_batches,public.inventory_batch_balances,public.inventory_batch_movement_allocations,public.inventory_batch_reconciliations from public,anon,authenticated;
grant select on public.inventory_batches,public.inventory_batch_balances,public.inventory_batch_movement_allocations,public.inventory_batch_reconciliations to authenticated;
grant all on public.inventory_batches,public.inventory_batch_balances,public.inventory_batch_movement_allocations,public.inventory_batch_reconciliations to service_role;
revoke all on snacky_expiry_private.alert_receipts from public,anon,authenticated;
grant all on snacky_expiry_private.alert_receipts to service_role;

drop policy if exists snacky_inventory_batches_read on public.inventory_batches;
create policy snacky_inventory_batches_read on public.inventory_batches for select to authenticated
using (public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing']));
drop policy if exists snacky_inventory_batch_balances_read on public.inventory_batch_balances;
create policy snacky_inventory_batch_balances_read on public.inventory_batch_balances for select to authenticated
using (public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing']));
drop policy if exists snacky_inventory_batch_allocations_read on public.inventory_batch_movement_allocations;
create policy snacky_inventory_batch_allocations_read on public.inventory_batch_movement_allocations for select to authenticated
using (public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing']));
drop policy if exists snacky_inventory_batch_reconciliations_read on public.inventory_batch_reconciliations;
create policy snacky_inventory_batch_reconciliations_read on public.inventory_batch_reconciliations for select to authenticated
using (public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','warehouse','purchasing']));

create table if not exists public.purchase_expiry_operations (
  action text not null check(action in ('create','update')),
  client_submission_id text not null,
  purchase_id uuid not null references public.purchase_orders(id) on delete cascade,
  expiry_payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key(action,client_submission_id)
);
alter table public.purchase_expiry_operations enable row level security;
revoke all on public.purchase_expiry_operations from public,anon,authenticated;
grant all on public.purchase_expiry_operations to service_role;

create or replace function snacky_expiry_private.ensure_unknown_batch(p_product_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  select id into v_id from public.inventory_batches where product_id=p_product_id and source_kind='legacy_unknown' limit 1;
  if v_id is null then
    insert into public.inventory_batches(product_id,source_kind)
    values(p_product_id,'legacy_unknown')
    on conflict(product_id) where source_kind='legacy_unknown' do nothing;
    select id into v_id from public.inventory_batches where product_id=p_product_id and source_kind='legacy_unknown' limit 1;
  end if;
  return v_id;
end $$;

create or replace function snacky_expiry_private.adjust_balance(
  p_batch uuid,p_entity_type text,p_entity_id uuid,p_delta integer
) returns void language plpgsql security definer set search_path='' as $$
declare v_current integer;
begin
  if p_entity_id is null or p_delta=0 or p_entity_type not in ('storage','operator_bag','machine') then return; end if;
  insert into public.inventory_batch_balances(batch_id,entity_type,entity_id,quantity)
  values(p_batch,p_entity_type,p_entity_id,greatest(p_delta,0))
  on conflict(batch_id,entity_type,entity_id) do nothing;
  select quantity into v_current from public.inventory_batch_balances
  where batch_id=p_batch and entity_type=p_entity_type and entity_id=p_entity_id for update;
  if coalesce(v_current,0)+p_delta<0 then
    raise exception 'Batch balance cannot become negative';
  end if;
  update public.inventory_batch_balances
  set quantity=quantity+p_delta,updated_at=now()
  where batch_id=p_batch and entity_type=p_entity_type and entity_id=p_entity_id;
end $$;

create or replace function snacky_expiry_private.assert_receivable_line(p_line uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r record;days_left integer;
begin
  select expiry_date,short_expiry_confirmed into r from public.purchase_order_lines where id=p_line;
  if not found or r.expiry_date is null then
    raise exception 'Expiry date is required before receiving stock.' using errcode='23514';
  end if;
  days_left:=r.expiry_date-(now() at time zone 'Africa/Tripoli')::date;
  if days_left<=0 then
    raise exception 'Expired stock cannot be received.' using errcode='23514';
  end if;
  if days_left<=30 and not coalesce(r.short_expiry_confirmed,false) then
    raise exception 'Short-dated stock requires explicit confirmation before receiving.' using errcode='23514';
  end if;
end $$;

create or replace function snacky_expiry_private.guard_purchase_receipt()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.reason::text='purchase_received' then
    if new.related_purchase_line_id is null then
      raise exception 'Purchase receipt movement is missing its purchase line.' using errcode='23514';
    end if;
    perform snacky_expiry_private.assert_receivable_line(new.related_purchase_line_id);
  end if;
  return new;
end $$;
drop trigger if exists snacky_expiry_purchase_receipt_guard on public.inventory_movements;
create trigger snacky_expiry_purchase_receipt_guard
before insert on public.inventory_movements
for each row execute function snacky_expiry_private.guard_purchase_receipt();

create or replace function snacky_expiry_private.guard_sellable_outbound()
returns trigger language plpgsql security definer set search_path='' as $
declare
  v_tracked integer;
  v_safe integer;
  v_today date:=(now() at time zone 'Africa/Tripoli')::date;
begin
  if coalesce(new.quantity,0)<=0
     or new.from_entity_id is null
     or new.from_entity_type::text not in ('storage','operator_bag','machine')
     or new.to_entity_type::text not in ('operator_bag','machine','customer') then
    return new;
  end if;

  select
    coalesce(sum(bal.quantity),0)::integer,
    coalesce(sum(bal.quantity) filter(where b.expiry_date is null or b.expiry_date>v_today),0)::integer
  into v_tracked,v_safe
  from public.inventory_batch_balances bal
  join public.inventory_batches b on b.id=bal.batch_id
  where bal.entity_type=new.from_entity_type::text
    and bal.entity_id=new.from_entity_id
    and b.product_id=new.product_id
    and bal.quantity>0;

  -- A zero tracked balance can occur only before initial seeding / during a
  -- shadow-ledger repair. Core inventory remains available, but once any
  -- batch provenance exists we fail closed against known-expired units.
  if v_tracked>0 and v_safe<new.quantity then
    raise exception 'Known expired stock is excluded from sellable inventory. Safe/unknown units available %, requested %.',v_safe,new.quantity
      using errcode='23514';
  end if;
  return new;
end $;
drop trigger if exists snacky_expiry_sellable_outbound_guard on public.inventory_movements;
create trigger snacky_expiry_sellable_outbound_guard
before insert on public.inventory_movements
for each row execute function snacky_expiry_private.guard_sellable_outbound();

create or replace function snacky_expiry_private.allocate_movement()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_remaining integer:=greatest(coalesce(new.quantity,0),0);
  v_batch uuid;
  v_take integer;
  v_source_tracked boolean:=new.from_entity_type::text in ('storage','operator_bag','machine') and new.from_entity_id is not null;
  v_dest_tracked boolean:=new.to_entity_type::text in ('storage','operator_bag','machine') and new.to_entity_id is not null;
  v_sellable_outbound boolean:=new.to_entity_type::text in ('operator_bag','machine','customer');
  v_today date:=(now() at time zone 'Africa/Tripoli')::date;
  r record;
  line record;
begin
  if v_remaining<=0 then return new;end if;

  if new.reason::text='purchase_received' and new.related_purchase_line_id is not null then
    select pol.product_id,pol.expiry_date,pol.supplier_lot_code,pol.total_units,pol.purchase_order_id
      into line from public.purchase_order_lines pol where pol.id=new.related_purchase_line_id;
    insert into public.inventory_batches(product_id,purchase_order_id,purchase_line_id,expiry_date,supplier_lot_code,source_kind,original_quantity,received_at)
    values(line.product_id,line.purchase_order_id,new.related_purchase_line_id,line.expiry_date,line.supplier_lot_code,'purchase',new.quantity,now())
    on conflict(purchase_line_id) do update
      set expiry_date=excluded.expiry_date,supplier_lot_code=excluded.supplier_lot_code,
          original_quantity=greatest(coalesce(public.inventory_batches.original_quantity,0),excluded.original_quantity);
    select id into v_batch from public.inventory_batches where purchase_line_id=new.related_purchase_line_id;
    if v_dest_tracked then perform snacky_expiry_private.adjust_balance(v_batch,new.to_entity_type::text,new.to_entity_id,new.quantity);end if;
    insert into public.inventory_batch_movement_allocations(inventory_movement_id,batch_id,quantity)
    values(new.id,v_batch,new.quantity) on conflict do nothing;
    return new;
  end if;

  if new.reversed_movement_id is not null and exists(
    select 1 from public.inventory_batch_movement_allocations where inventory_movement_id=new.reversed_movement_id
  ) then
    for r in select batch_id,quantity from public.inventory_batch_movement_allocations where inventory_movement_id=new.reversed_movement_id order by batch_id loop
      v_take:=least(v_remaining,r.quantity);
      exit when v_take<=0;
      if v_source_tracked then
        -- Exact reversal provenance wins. Repair a missing shadow balance without touching the core ledger.
        insert into public.inventory_batch_balances(batch_id,entity_type,entity_id,quantity)
        values(r.batch_id,new.from_entity_type::text,new.from_entity_id,v_take)
        on conflict(batch_id,entity_type,entity_id) do update
          set quantity=greatest(public.inventory_batch_balances.quantity,excluded.quantity),updated_at=now();
        perform snacky_expiry_private.adjust_balance(r.batch_id,new.from_entity_type::text,new.from_entity_id,-v_take);
      end if;
      if v_dest_tracked then perform snacky_expiry_private.adjust_balance(r.batch_id,new.to_entity_type::text,new.to_entity_id,v_take);end if;
      insert into public.inventory_batch_movement_allocations(inventory_movement_id,batch_id,quantity)
      values(new.id,r.batch_id,v_take) on conflict do nothing;
      v_remaining:=v_remaining-v_take;
    end loop;
  end if;

  if v_remaining>0 and v_source_tracked then
    for r in
      select bal.batch_id,bal.quantity,b.expiry_date,b.source_kind
      from public.inventory_batch_balances bal join public.inventory_batches b on b.id=bal.batch_id
      where bal.entity_type=new.from_entity_type::text and bal.entity_id=new.from_entity_id
        and b.product_id=new.product_id and bal.quantity>0
        and (not v_sellable_outbound or b.expiry_date is null or b.expiry_date>v_today)
      order by (b.expiry_date is null) asc,b.expiry_date asc,b.created_at asc,b.id
    loop
      exit when v_remaining<=0;
      v_take:=least(v_remaining,r.quantity);
      perform snacky_expiry_private.adjust_balance(r.batch_id,new.from_entity_type::text,new.from_entity_id,-v_take);
      if v_dest_tracked then perform snacky_expiry_private.adjust_balance(r.batch_id,new.to_entity_type::text,new.to_entity_id,v_take);end if;
      insert into public.inventory_batch_movement_allocations(inventory_movement_id,batch_id,quantity)
      values(new.id,r.batch_id,v_take)
      on conflict(inventory_movement_id,batch_id) do update set quantity=public.inventory_batch_movement_allocations.quantity+excluded.quantity;
      v_remaining:=v_remaining-v_take;
    end loop;
  end if;

  if v_remaining>0 then
    v_batch:=snacky_expiry_private.ensure_unknown_batch(new.product_id);
    if v_source_tracked then
      perform snacky_expiry_private.adjust_balance(v_batch,new.from_entity_type::text,new.from_entity_id,v_remaining);
      perform snacky_expiry_private.adjust_balance(v_batch,new.from_entity_type::text,new.from_entity_id,-v_remaining);
    end if;
    if v_dest_tracked then perform snacky_expiry_private.adjust_balance(v_batch,new.to_entity_type::text,new.to_entity_id,v_remaining);end if;
    insert into public.inventory_batch_movement_allocations(inventory_movement_id,batch_id,quantity)
    values(new.id,v_batch,v_remaining)
    on conflict(inventory_movement_id,batch_id) do update set quantity=public.inventory_batch_movement_allocations.quantity+excluded.quantity;
  end if;
  return new;
exception when others then
  raise warning 'Expiry shadow allocation failed for movement %: %',new.id,sqlerrm;
  return new;
end $$;
drop trigger if exists snacky_expiry_allocate_inventory_movement on public.inventory_movements;
create trigger snacky_expiry_allocate_inventory_movement
after insert on public.inventory_movements
for each row execute function snacky_expiry_private.allocate_movement();

create or replace function snacky_expiry_private.seed_legacy_unknown_v1()
returns void language plpgsql security definer set search_path='' as $$
declare r record;b uuid;
begin
  for r in
    select product_id,location_type,location_id,greatest(quantity_on_hand,0)::integer qty
    from public.current_inventory_by_location
    where location_type in ('storage','operator_bag') and quantity_on_hand>0
  loop
    b:=snacky_expiry_private.ensure_unknown_batch(r.product_id);
    insert into public.inventory_batch_balances(batch_id,entity_type,entity_id,quantity)
    values(b,r.location_type,r.location_id,r.qty)
    on conflict(batch_id,entity_type,entity_id) do update set quantity=greatest(public.inventory_batch_balances.quantity,excluded.quantity),updated_at=now();
  end loop;

  for r in
    select machine_id,product_id,greatest(sum(current_qty),0)::integer qty
    from public.latest_vms_stock_by_slot
    where product_id is not null
    group by machine_id,product_id
    having sum(current_qty)>0
  loop
    b:=snacky_expiry_private.ensure_unknown_batch(r.product_id);
    insert into public.inventory_batch_balances(batch_id,entity_type,entity_id,quantity)
    values(b,'machine',r.machine_id,r.qty)
    on conflict(batch_id,entity_type,entity_id) do update set quantity=greatest(public.inventory_batch_balances.quantity,excluded.quantity),updated_at=now();
  end loop;
end $$;

create or replace function public.snacky_reconcile_machine_expiry_batches_v1()
returns jsonb language plpgsql security definer set search_path='' as $$
declare m record;r record;b record;tracked integer;diff integer;unknown_batch uuid;changed integer:=0;
begin
  for m in
    select machine_id,max(captured_at) captured_at
    from public.latest_vms_stock_by_slot group by machine_id
    having max(captured_at)>now()-interval '6 hours'
  loop
    for r in
      with actual as (
        select product_id,sum(current_qty)::integer qty
        from public.latest_vms_stock_by_slot
        where machine_id=m.machine_id and product_id is not null
        group by product_id
      ),tracked_products as (
        select distinct ib.product_id
        from public.inventory_batch_balances bal join public.inventory_batches ib on ib.id=bal.batch_id
        where bal.entity_type='machine' and bal.entity_id=m.machine_id and bal.quantity>0
      )
      select p.product_id,coalesce(a.qty,0)::integer actual_qty
      from (select product_id from actual union select product_id from tracked_products) p
      left join actual a using(product_id)
    loop
      select coalesce(sum(bal.quantity),0)::integer into tracked
      from public.inventory_batch_balances bal join public.inventory_batches ib on ib.id=bal.batch_id
      where bal.entity_type='machine' and bal.entity_id=m.machine_id and ib.product_id=r.product_id;
      diff:=tracked-r.actual_qty;
      if diff>0 then
        for b in
          select bal.batch_id,bal.quantity,ib.expiry_date,ib.created_at
          from public.inventory_batch_balances bal join public.inventory_batches ib on ib.id=bal.batch_id
          where bal.entity_type='machine' and bal.entity_id=m.machine_id and ib.product_id=r.product_id and bal.quantity>0
          order by (ib.expiry_date is null) desc,ib.expiry_date asc,ib.created_at asc
        loop
          exit when diff<=0;
          perform snacky_expiry_private.adjust_balance(b.batch_id,'machine',m.machine_id,-least(diff,b.quantity));
          diff:=diff-least(diff,b.quantity);
        end loop;
        changed:=changed+1;
      elsif diff<0 then
        unknown_batch:=snacky_expiry_private.ensure_unknown_batch(r.product_id);
        perform snacky_expiry_private.adjust_balance(unknown_batch,'machine',m.machine_id,-diff);
        changed:=changed+1;
      end if;
      if tracked<>r.actual_qty then
        insert into public.inventory_batch_reconciliations(machine_id,product_id,vms_quantity,tracked_before,adjustment,vms_captured_at)
        values(m.machine_id,r.product_id,r.actual_qty,tracked,r.actual_qty-tracked,m.captured_at);
      end if;
    end loop;
  end loop;
  return jsonb_build_object('reconciled',changed);
end $$;

-- Preserve the reviewed work-notification source/eligibility logic and extend only for expiry batches.
do $$begin
  if to_regprocedure('snacky_notice_private.source_base(text,uuid)') is null
     and to_regprocedure('snacky_notice_private.source(text,uuid)') is not null then
    alter function snacky_notice_private.source(text,uuid) rename to source_base;
  end if;
  if to_regprocedure('snacky_notice_private.eligible_base(public.notifications)') is null
     and to_regprocedure('snacky_notice_private.eligible(public.notifications)') is not null then
    alter function snacky_notice_private.eligible(public.notifications) rename to eligible_base;
  end if;
end$$;

create or replace function snacky_notice_private.source(k text,i uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare r jsonb;
begin
  if k='expiry_batch' then
    select jsonb_build_object(
      'row',jsonb_build_object('id',b.id,'product_id',b.product_id,'expiry_date',b.expiry_date,'source_kind',b.source_kind),
      'member',null,
      'active',coalesce((select sum(quantity)>0 from public.inventory_batch_balances where batch_id=b.id),false),
      'label',left(coalesce(p.name,'Product'),160),
      'href','/inventory/expiry?batch='||b.id::text
    ) into r
    from public.inventory_batches b join public.products p on p.id=b.product_id where b.id=i;
    return r;
  end if;
  if k='expiry_audit' then
    select jsonb_build_object(
      'row',jsonb_build_object('unknown_batches',count(distinct b.id),'unknown_units',coalesce(sum(bal.quantity),0)),
      'member',null,
      'active',coalesce(sum(bal.quantity),0)>0,
      'label','Expiry audit required',
      'href','/inventory/expiry'
    ) into r
    from public.inventory_batches b
    join public.inventory_batch_balances bal on bal.batch_id=b.id
    where b.expiry_date is null and bal.quantity>0;
    return r;
  end if;
  return snacky_notice_private.source_base(k,i);
end $$;

create or replace function snacky_notice_private.eligible(n public.notifications) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare s jsonb;roles text[];
begin
  if n.source_kind='expiry_batch' then
    if snacky_notice_private.member_user(n.recipient_member_id) is distinct from n.user_id then return false;end if;
    select array[p.role::text]||coalesce(p.roles::text[],'{}') into roles from public.profiles p where id=n.user_id;
    s:=snacky_notice_private.source('expiry_batch',n.source_id);
    return coalesce((s->>'active')::boolean,false)
      and roles&&array['owner','admin','supervisor','warehouse','purchasing'];
  end if;
  if n.source_kind='expiry_audit' then
    if snacky_notice_private.member_user(n.recipient_member_id) is distinct from n.user_id then return false;end if;
    select array[p.role::text]||coalesce(p.roles::text[],'{}') into roles from public.profiles p where id=n.user_id;
    s:=snacky_notice_private.source('expiry_audit',null);
    return coalesce((s->>'active')::boolean,false)
      and roles&&array['owner','admin','supervisor','warehouse','purchasing'];
  end if;
  return snacky_notice_private.eligible_base(n);
end $$;

create or replace function public.snacky_scan_expiry_safety_v1()
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record;person record;days_left integer;event_kind text;nid uuid;uid uuid;sent integer:=0;
begin
  perform public.snacky_reconcile_machine_expiry_batches_v1();
  for r in
    select b.id batch_id,b.expiry_date,p.name product_name,sum(bal.quantity)::integer remaining_qty
    from public.inventory_batches b
    join public.products p on p.id=b.product_id
    join public.inventory_batch_balances bal on bal.batch_id=b.id
    where b.expiry_date is not null
    group by b.id,b.expiry_date,p.name
    having sum(bal.quantity)>0
  loop
    days_left:=r.expiry_date-current_date;
    event_kind:=case
      when days_left<=0 then 'expired'
      when days_left<=1 then 'expiry_1d'
      when days_left<=3 then 'expiry_3d'
      when days_left<=7 then 'expiry_7d'
      when days_left<=14 then 'expiry_14d'
      when days_left<=30 then 'expiry_30d'
      else null end;
    if event_kind is null then continue;end if;
    for person in
      select distinct t.id
      from public.team_members t join public.profiles p on p.team_member_id=t.id
      where t.active is not false and t.active_status='active' and p.active_status='active'
        and (array[p.role::text]||coalesce(p.roles::text[],'{}'))&&array['owner','admin','supervisor','warehouse','purchasing']
    loop
      insert into snacky_expiry_private.alert_receipts(batch_id,event_kind,recipient_member_id)
      values(r.batch_id,event_kind,person.id) on conflict do nothing;
      if not found then continue;end if;
      uid:=snacky_notice_private.member_user(person.id);
      if uid is null then continue;end if;
      insert into public.notifications(
        user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar
      ) values(
        uid,
        case when event_kind='expired' then 'expired_stock' else 'expiry_warning' end,
        case when event_kind='expired' then 'Expired stock still remains' else 'Stock is nearing expiry' end,
        r.product_name||' — '||r.remaining_qty||' units remain; expiry '||r.expiry_date::text||'.',
        '/inventory/expiry?batch='||r.batch_id::text,
        'expiry:'||r.batch_id::text||':'||event_kind||':'||person.id::text,
        'expiry_batch',r.batch_id,person.id,event_kind,
        case when event_kind='expired' then 'يوجد مخزون منتهي الصلاحية' else 'مخزون يقترب من انتهاء الصلاحية' end,
        r.product_name||' — متبقي '||r.remaining_qty||' وحدة؛ الصلاحية '||r.expiry_date::text||'.'
      ) on conflict(event_key) where event_key is not null do nothing returning id into nid;
      if nid is not null then
        insert into snacky_notice_private.deliveries(notification_id,subscription_id)
        select nid,id from public.push_subscriptions where user_id=uid and is_active on conflict do nothing;
        sent:=sent+1;
      end if;
    end loop;
  end loop;
  -- Existing pre-feature stock has no trustworthy historical expiry date.
  -- Send one aggregate reminder per recipient/day until the physical audit is resolved;
  -- never emit one notification per legacy batch.
  if exists(
    select 1
    from public.inventory_batches b
    join public.inventory_batch_balances bal on bal.batch_id=b.id
    where b.expiry_date is null and bal.quantity>0
  ) then
    for person in
      select distinct t.id
      from public.team_members t join public.profiles p on p.team_member_id=t.id
      where t.active is not false and t.active_status='active' and p.active_status='active'
        and (array[p.role::text]||coalesce(p.roles::text[],'{}'))&&array['owner','admin','supervisor','warehouse','purchasing']
    loop
      uid:=snacky_notice_private.member_user(person.id);
      if uid is null then continue;end if;
      insert into public.notifications(
        user_id,type,title,message,action_url,event_key,source_kind,source_id,recipient_member_id,event_kind,title_ar,message_ar
      )
      select
        uid,'expiry_audit','Expiry audit required',
        count(distinct b.product_id)::text||' products still have stock with no recorded expiry date. Physically check them before sale.',
        '/inventory/expiry',
        'expiry_audit:'||((now() at time zone 'Africa/Tripoli')::date)::text||':'||person.id::text,
        'expiry_audit',null,person.id,'unknown_audit',
        'مراجعة الصلاحية مطلوبة',
        'يوجد '||count(distinct b.product_id)::text||' منتجاً بمخزون دون تاريخ صلاحية مسجل. تحقق منه فعلياً قبل البيع.'
      from public.inventory_batches b
      join public.inventory_batch_balances bal on bal.batch_id=b.id
      where b.expiry_date is null and bal.quantity>0
      on conflict(event_key) where event_key is not null do nothing
      returning id into nid;
      if nid is not null then
        insert into snacky_notice_private.deliveries(notification_id,subscription_id)
        select nid,id from public.push_subscriptions where user_id=uid and is_active on conflict do nothing;
        sent:=sent+1;
      end if;
    end loop;
  end if;

  if sent>0 then begin perform snacky_notice_private.wake();exception when others then null;end;end if;
  return jsonb_build_object('notifications_created',sent);
end $$;

create or replace view public.snacky_expiry_batch_status
with (security_invoker=true) as
select
  b.id batch_id,b.product_id,p.name product_name,p.sku,b.purchase_order_id,b.purchase_line_id,
  b.expiry_date,b.supplier_lot_code,b.source_kind,
  coalesce(sum(bal.quantity),0)::integer remaining_qty,
  coalesce(sum(bal.quantity) filter(where bal.entity_type='storage'),0)::integer storage_qty,
  coalesce(sum(bal.quantity) filter(where bal.entity_type='operator_bag'),0)::integer operator_bag_qty,
  coalesce(sum(bal.quantity) filter(where bal.entity_type='machine'),0)::integer machine_qty,
  case when b.expiry_date is null then null else b.expiry_date-(now() at time zone 'Africa/Tripoli')::date end days_left,
  case
    when b.expiry_date is null then 'unknown'
    when b.expiry_date<=(now() at time zone 'Africa/Tripoli')::date then 'expired'
    when b.expiry_date<=(now() at time zone 'Africa/Tripoli')::date+1 then '1_day'
    when b.expiry_date<=(now() at time zone 'Africa/Tripoli')::date+3 then '3_days'
    when b.expiry_date<=(now() at time zone 'Africa/Tripoli')::date+7 then '7_days'
    when b.expiry_date<=(now() at time zone 'Africa/Tripoli')::date+14 then '14_days'
    when b.expiry_date<=(now() at time zone 'Africa/Tripoli')::date+30 then '30_days'
    else 'safe' end risk
from public.inventory_batches b
join public.products p on p.id=b.product_id
left join public.inventory_batch_balances bal on bal.batch_id=b.id
group by b.id,p.name,p.sku;
grant select on public.snacky_expiry_batch_status to authenticated;

create or replace view public.snacky_safe_storage_expiry_by_product
with (security_invoker=true) as
select
  b.product_id,
  coalesce(sum(bal.quantity),0)::integer tracked_storage_qty,
  coalesce(sum(bal.quantity) filter(where b.expiry_date is null or b.expiry_date>(now() at time zone 'Africa/Tripoli')::date),0)::integer safe_or_unknown_qty,
  coalesce(sum(bal.quantity) filter(where b.expiry_date is not null and b.expiry_date<=(now() at time zone 'Africa/Tripoli')::date),0)::integer expired_qty,
  coalesce(sum(bal.quantity) filter(where b.expiry_date is null),0)::integer unknown_expiry_qty,
  min(b.expiry_date) filter(where b.expiry_date>(now() at time zone 'Africa/Tripoli')::date) earliest_safe_expiry
from public.inventory_batches b
join public.inventory_batch_balances bal on bal.batch_id=b.id
where bal.entity_type='storage' and bal.quantity>0
group by b.product_id;
grant select on public.snacky_safe_storage_expiry_by_product to authenticated;

-- Wrapper keeps existing heavily-tested purchase creation intact, adds expiry atomically,
-- then receives only after the expiry metadata exists.
create or replace function public.snacky_create_purchase_with_lines_v3(
  p_client_submission_id uuid,p_supplier_id uuid,p_order_date date,p_receipt_number text,p_payment_method text,
  p_payment_status text,p_receipt_url text,p_receipt_file_name text,p_receipt_content_type text,p_receipt_storage_path text,
  p_notes text,p_calculated_total_lyd numeric,p_manual_total_lyd numeric,p_total_adjustment_lyd numeric,p_total_source text,
  p_total_amount numeric,p_payment_account_id text,p_receiving_storage_location_id uuid,p_submit_action text,p_lines jsonb
) returns table(id uuid,receipt_number text,status text,total_amount numeric,payment_status text,movement_count integer,receiving_storage_location_id uuid)
language plpgsql security invoker set search_path='' as $$
declare base record;payload jsonb:=coalesce(p_lines,'[]'::jsonb);op public.purchase_expiry_operations%rowtype;receive_result jsonb;
begin
  select * into base from public.snacky_create_purchase_with_lines_v2(
    p_client_submission_id,p_supplier_id,p_order_date,p_receipt_number,p_payment_method,p_payment_status,
    p_receipt_url,p_receipt_file_name,p_receipt_content_type,p_receipt_storage_path,p_notes,p_calculated_total_lyd,
    p_manual_total_lyd,p_total_adjustment_lyd,p_total_source,p_total_amount,p_payment_account_id,
    p_receiving_storage_location_id,'draft',p_lines
  );
  insert into public.purchase_expiry_operations(action,client_submission_id,purchase_id,expiry_payload)
  values('create',p_client_submission_id::text,base.id,payload) on conflict do nothing;
  select * into op from public.purchase_expiry_operations where action='create' and client_submission_id=p_client_submission_id::text for update;
  if op.purchase_id is distinct from base.id or op.expiry_payload is distinct from payload then
    raise exception 'This purchase submission id was already used with different expiry data.' using errcode='23505';
  end if;
  update public.purchase_order_lines pol
  set expiry_date=x.expiry_date,supplier_lot_code=nullif(btrim(x.supplier_lot_code),''),
      short_expiry_confirmed=coalesce(x.short_expiry_confirmed,false)
  from jsonb_to_recordset(payload) as x(line_position integer,expiry_date date,supplier_lot_code text,short_expiry_confirmed boolean)
  where pol.purchase_order_id=base.id and pol.line_position=x.line_position;

  if lower(btrim(coalesce(p_submit_action,''))) in ('received','receive','submitted','submit') then
    if exists(select 1 from public.purchase_order_lines where purchase_order_id=base.id and expiry_date is null) then
      raise exception 'Expiry date is required for every received product batch.' using errcode='23514';
    end if;
    perform snacky_expiry_private.assert_receivable_line(line.id)
      from public.purchase_order_lines line where line.purchase_order_id=base.id;
    receive_result:=public.snacky_receive_purchase_v1(base.id,p_client_submission_id::text||':expiry-receive',p_receiving_storage_location_id);
  end if;

  return query
  select po.id,po.receipt_number,po.status,po.total_amount,po.payment_status,
    (select count(*)::integer from public.inventory_movements im where im.related_purchase_id=po.id),
    po.receiving_storage_location_id
  from public.purchase_orders po where po.id=base.id;
end $$;

create or replace function public.snacky_update_draft_purchase_v2(
  p_purchase_id uuid,p_client_submission_id text,p_expected_updated_at timestamptz,p_supplier_id uuid,p_order_date date,
  p_receiving_storage_location_id uuid,p_receipt_number text,p_payment_method text,p_receipt_url text,p_receipt_file_name text,
  p_receipt_content_type text,p_receipt_storage_path text,p_notes text,p_manual_total_lyd numeric,p_lines jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;payload jsonb:=coalesce(p_lines,'[]'::jsonb);op public.purchase_expiry_operations%rowtype;
begin
  result:=public.snacky_update_draft_purchase_v1(
    p_purchase_id,p_client_submission_id,p_expected_updated_at,p_supplier_id,p_order_date,p_receiving_storage_location_id,
    p_receipt_number,p_payment_method,p_receipt_url,p_receipt_file_name,p_receipt_content_type,p_receipt_storage_path,
    p_notes,p_manual_total_lyd,p_lines
  );
  insert into public.purchase_expiry_operations(action,client_submission_id,purchase_id,expiry_payload)
  values('update',p_client_submission_id,p_purchase_id,payload) on conflict do nothing;
  select * into op from public.purchase_expiry_operations where action='update' and client_submission_id=p_client_submission_id for update;
  if op.purchase_id is distinct from p_purchase_id or op.expiry_payload is distinct from payload then
    raise exception 'This draft submission id was already used with different expiry data.' using errcode='23505';
  end if;
  update public.purchase_order_lines pol
  set expiry_date=x.expiry_date,supplier_lot_code=nullif(btrim(x.supplier_lot_code),''),
      short_expiry_confirmed=coalesce(x.short_expiry_confirmed,false)
  from jsonb_to_recordset(payload) as x(line_position integer,expiry_date date,supplier_lot_code text,short_expiry_confirmed boolean)
  where pol.purchase_order_id=p_purchase_id and pol.line_position=x.line_position;
  return result;
end $$;

revoke all on function public.snacky_create_purchase_with_lines_v3(uuid,uuid,date,text,text,text,text,text,text,text,text,numeric,numeric,numeric,text,numeric,text,uuid,text,jsonb) from public,anon;
grant execute on function public.snacky_create_purchase_with_lines_v3(uuid,uuid,date,text,text,text,text,text,text,text,text,numeric,numeric,numeric,text,numeric,text,uuid,text,jsonb) to authenticated,service_role;
revoke all on function public.snacky_update_draft_purchase_v2(uuid,text,timestamptz,uuid,date,uuid,text,text,text,text,text,text,text,numeric,jsonb) from public,anon;
grant execute on function public.snacky_update_draft_purchase_v2(uuid,text,timestamptz,uuid,date,uuid,text,text,text,text,text,text,text,numeric,jsonb) to authenticated,service_role;
revoke all on function public.snacky_reconcile_machine_expiry_batches_v1(),public.snacky_scan_expiry_safety_v1() from public,anon,authenticated;
grant execute on function public.snacky_reconcile_machine_expiry_batches_v1(),public.snacky_scan_expiry_safety_v1() to service_role;

-- Seed existing stock as unknown expiry. No dates are guessed.
select snacky_expiry_private.seed_legacy_unknown_v1();

-- Reconcile fresh VMS machine quantities and scan for new expiry milestones hourly.
do $$begin
  if exists(select 1 from pg_extension where extname='pg_cron') then
    if exists(select 1 from cron.job where jobname='snacky-expiry-safety') then
      perform cron.unschedule('snacky-expiry-safety');
    end if;
    perform cron.schedule('snacky-expiry-safety','7 * * * *','select public.snacky_scan_expiry_safety_v1();');
  end if;
exception when others then
  raise warning 'Could not schedule expiry safety scan: %',sqlerrm;
end$$;

revoke all on all functions in schema snacky_expiry_private from public,anon,authenticated;
grant usage on schema snacky_expiry_private to service_role;
select pg_notify('pgrst','reload schema');
