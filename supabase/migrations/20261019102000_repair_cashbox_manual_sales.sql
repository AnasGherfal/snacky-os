-- Repair sales reuse the manual-sales ledger. Cash always stays in the machine.
-- Legacy route sales retain their existing route scope and custody semantics.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

alter table public.route_manual_sales alter column route_id drop not null;
alter table public.route_manual_sales alter column route_stop_id drop not null;
alter table public.route_manual_sales
  add column if not exists repair_task_id uuid references public.crm_tasks(id) on delete restrict,
  add column if not exists repair_source_route_id uuid references public.routes(id) on delete restrict,
  add column if not exists stock_source text,
  add column if not exists cash_destination text not null default 'operator_custody',
  add column if not exists cash_deposited_at timestamptz,
  add column if not exists repair_request jsonb;

alter table public.route_manual_sales add constraint manual_sale_route_or_repair_scope check (
  (repair_task_id is null and route_id is not null and route_stop_id is not null
    and cash_destination='operator_custody' and repair_request is null)
  or
  (repair_task_id is not null and route_id is null and route_stop_id is null
    and product_id is not null and payment_method='cash'
    and stock_source in ('machine','operator_bag')
    and cash_destination='machine_cashbox' and cash_deposited_at is not null
    and repair_request is not null
    and ((stock_source='machine' and repair_source_route_id is null)
      or (stock_source='operator_bag' and repair_source_route_id is not null)))
);
create index if not exists idx_manual_sales_repair_task on public.route_manual_sales(repair_task_id,sale_time desc) where repair_task_id is not null;
create index if not exists idx_manual_sales_cashbox_interval on public.route_manual_sales(machine_id,cash_deposited_at) where repair_task_id is not null and status='confirmed';

-- The repair RPC is the only writer: even an otherwise-authorized raw REST
-- insert/update may not fabricate or erase the cash-placement attestation.
create policy repair_sales_no_direct_insert on public.route_manual_sales as restrictive
  for insert to authenticated with check (repair_task_id is null);
create policy repair_sales_no_direct_update on public.route_manual_sales as restrictive
  for update to authenticated using (repair_task_id is null) with check (repair_task_id is null);
create policy repair_sales_read on public.route_manual_sales for select to authenticated using (
  repair_task_id is not null and (
    public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','finance'])
    or operator_id=public.snacky_current_team_member_id()
  )
);

create or replace function public.snacky_repair_sale_workspace_v1(p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $body$
declare
  v_me uuid:=public.snacky_current_team_member_id();
  v_task public.crm_tasks%rowtype;
  v_issue public.issues%rowtype;
  v_products jsonb;
  v_sales jsonb;
  v_machine_name text;
begin
  if auth.uid() is null or v_me is null or not public.snacky_current_profile_has_any_role(array['owner','admin','supervisor','crm','operator']) then
    raise exception 'Active staff sign-in required' using errcode='42501';
  end if;
  select * into v_task from public.crm_tasks where id=p_task_id;
  if not found or v_task.task_type<>'field_action' or v_task.issue_id is null
    or not public.snacky_crm_allowed('task',p_task_id,false) then
    raise exception 'This repair task is not available to you' using errcode='42501';
  end if;
  select * into v_issue from public.issues where id=v_task.issue_id;
  if not found or v_issue.machine_id is null then
    raise exception 'A machine must be linked to the repair before recording sales' using errcode='23514';
  end if;
  select name into v_machine_name from public.machines where id=v_issue.machine_id;
  with balances as (
    select product_id,
      sum(quantity_on_hand) filter(where location_type='machine' and location_id=v_issue.machine_id) as machine_qty,
      sum(quantity_on_hand) filter(where location_type='operator_bag' and location_id=v_task.assigned_to) as bag_qty
    from public.current_inventory_by_location
    where (location_type='machine' and location_id=v_issue.machine_id)
       or (location_type='operator_bag' and location_id=v_task.assigned_to)
    group by product_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',p.id,'name',p.name,'sku',p.sku,'barcode',p.barcode,
    'unit_price_lyd',coalesce(nullif(p.current_selling_price_lyd,0),nullif(p.vms_selling_price_lyd,0),nullif(p.selling_price,0)),
    'machine_qty',greatest(coalesce(b.machine_qty,0),0),
    'bag_qty',greatest(coalesce(b.bag_qty,0),0)
  ) order by p.name),'[]'::jsonb) into v_products
  from public.products p left join balances b on b.product_id=p.id
  where p.active;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'product_name',s.product_name,'quantity',s.quantity,
    'unit_price_lyd',s.unit_sale_price_lyd,'total_lyd',s.total_amount_lyd,
    'stock_source',s.stock_source,'cash_destination',s.cash_destination,
    'deposited_at',s.cash_deposited_at,'status',s.status,
    'stock_posted',s.inventory_movement_id is not null
  ) order by s.sale_time desc),'[]'::jsonb) into v_sales
  from public.route_manual_sales s where s.repair_task_id=p_task_id;
  return jsonb_build_object('ok',true,'task_id',p_task_id,'machine_name',v_machine_name,
    'machine_id',v_issue.machine_id,'products',v_products,'sales',v_sales,
    'can_sell',v_task.assigned_to=v_me and v_task.dispatch_state='working'
      and v_task.status<>'completed' and v_task.archived_at is null
      and v_issue.status::text not in ('resolved','closed') and v_issue.archived_at is null);
end
$body$;

create or replace function public.snacky_create_repair_manual_sale_v1(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $body$
declare
  v_actor uuid:=auth.uid();
  v_me uuid:=public.snacky_current_team_member_id();
  v_request_id uuid;
  v_task_id uuid;
  v_product_id uuid;
  v_quantity integer;
  v_price numeric;
  v_expected_price numeric;
  v_cost numeric;
  v_source text;
  v_source_id uuid;
  v_route_id uuid;
  v_lease_route_id uuid;
  v_route public.routes%rowtype;
  v_task public.crm_tasks%rowtype;
  v_issue public.issues%rowtype;
  v_product public.products%rowtype;
  v_sale public.route_manual_sales%rowtype;
  v_sale_id uuid:=gen_random_uuid();
  v_movement_id uuid;
  v_balance bigint;
  v_route_balance bigint;
  v_now timestamptz;
  v_key text;
  v_notes text;
begin
  if v_actor is null or v_me is null or not public.snacky_current_profile_has_any_role(array['operator','owner','admin','supervisor']) then
    raise exception 'Active operator sign-in required' using errcode='42501';
  end if;
  if p_command is null or jsonb_typeof(p_command)<>'object' or octet_length(p_command::text)>12000 then
    raise exception 'Invalid repair sale request' using errcode='22023';
  end if;
  begin
    v_request_id:=(p_command->>'request_id')::uuid;
    v_task_id:=(p_command->>'task_id')::uuid;
    v_product_id:=(p_command->>'product_id')::uuid;
    v_quantity:=(p_command->>'quantity')::integer;
    v_price:=(p_command->>'unit_price_lyd')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Check the product, whole quantity and price' using errcode='22023';
  end;
  v_source:=p_command->>'stock_source';
  v_notes:=nullif(btrim(p_command->>'notes'),'');
  if v_request_id is null or v_task_id is null or v_product_id is null
    or v_quantity is null or v_quantity<1 or v_quantity>500
    or (p_command->>'quantity')!~'^[0-9]+$'
    or v_price is null or v_price::text in ('NaN','Infinity','-Infinity')
    or v_price<=0 or v_price>1000 or v_price<>round(v_price,2)
    or v_source is null or v_source not in ('machine','operator_bag')
    or length(coalesce(v_notes,''))>2000 then
    raise exception 'Check the product, stock source, quantity and price' using errcode='22023';
  end if;
  if p_command->'cash_in_machine' is distinct from 'true'::jsonb
    or p_command->'new_unrecorded_payment' is distinct from 'true'::jsonb then
    raise exception 'Confirm a NEW payment not recorded in XY, and place the full cash in this machine cashbox' using errcode='23514';
  end if;
  v_key:='repair-sale:'||v_request_id::text;
  perform pg_advisory_xact_lock(hashtextextended(v_key,0));
  select * into v_sale from public.route_manual_sales where client_submission_id=v_key for update;
  if found then
    if v_sale.created_by_user_id is distinct from v_actor or v_sale.repair_request is distinct from p_command then
      raise exception 'Saved request does not match this repair sale; do not replace the request ID' using errcode='23505';
    end if;
    return jsonb_build_object('ok',true,'request_id',v_request_id,'sale_id',v_sale.id,
      'task_id',v_sale.repair_task_id,'total_lyd',v_sale.total_amount_lyd,
      'cash_destination',v_sale.cash_destination,'already_applied',true);
  end if;

  -- Maintain the route -> custody -> bag lock order used by existing route
  -- writers. A repair sale never books the machine cash to route custody.
  if v_source='operator_bag' then
    select route_id into v_route_id from public.operator_route_custody_leases where operator_id=v_me;
    if v_route_id is null then
      raise exception 'No active bag custody. Use the actual machine stock source or ask management to reconcile the bag' using errcode='23514';
    end if;
    select * into v_route from public.routes where id=v_route_id for update;
    if not found or v_route.operator_id is distinct from v_me
      or v_route.status::text in ('completed','cancelled','canceled','verified','paid','archived','reviewed','payroll_pending','deleted','disputed') then
      raise exception 'The bag route is closed or belongs to another operator' using errcode='23514';
    end if;
  end if;
  select * into v_task from public.crm_tasks where id=v_task_id for update;
  if not found or v_task.task_type<>'field_action' or v_task.assigned_to is distinct from v_me then
    raise exception 'Only the assigned repair operator may record this sale' using errcode='42501';
  end if;
  if v_task.dispatch_state<>'working' or v_task.status='completed' or v_task.archived_at is not null or v_task.is_practice then
    raise exception 'Start this repair before recording sales; completed or practice work cannot accept real sales' using errcode='23514';
  end if;
  select * into v_issue from public.issues where id=v_task.issue_id for share;
  if not found or v_issue.machine_id is null or v_issue.status::text in ('resolved','closed')
    or v_issue.archived_at is not null or v_issue.is_practice then
    raise exception 'The machine issue is not open' using errcode='23514';
  end if;
  select * into v_product from public.products where id=v_product_id and active for share;
  if not found then raise exception 'Choose an active product' using errcode='23514'; end if;
  v_expected_price:=round(coalesce(nullif(v_product.current_selling_price_lyd,0),nullif(v_product.vms_selling_price_lyd,0),nullif(v_product.selling_price,0)),2);
  if v_expected_price is null or v_expected_price<=0 then
    raise exception 'The product needs a configured selling price from management' using errcode='23514';
  end if;
  if v_price<>v_expected_price then
    raise exception 'The configured price changed. Reload the product and confirm the actual cash before saving' using errcode='40001';
  end if;
  v_cost:=coalesce(nullif(v_product.average_cost_lyd,0),nullif(v_product.current_cost_price_lyd,0),nullif(v_product.last_purchase_cost_lyd,0));

  if v_source='operator_bag' then
    perform pg_advisory_xact_lock(hashtextextended('snacky:operator-custody:'||v_me::text,0));
    select route_id into v_lease_route_id from public.operator_route_custody_leases where operator_id=v_me for update;
    if v_lease_route_id is distinct from v_route_id then raise exception 'Bag custody changed. Reload before selling' using errcode='40001'; end if;
    perform pg_advisory_xact_lock(hashtextextended('snacky:operator-bag:'||v_me::text||':'||v_product_id::text,0));
    v_source_id:=v_me;
    select coalesce(sum(case when to_entity_type::text='operator_bag' and to_entity_id=v_me then quantity else 0 end
      -case when from_entity_type::text='operator_bag' and from_entity_id=v_me then quantity else 0 end),0)
      into v_route_balance from public.inventory_movements where related_route_id=v_route_id and product_id=v_product_id;
    if v_route_balance<v_quantity then raise exception 'Insufficient recorded stock in this bag route; no sale was posted' using errcode='23514'; end if;
  else
    v_source_id:=v_issue.machine_id;
    perform pg_advisory_xact_lock(hashtextextended('snacky:machine-stock:'||v_source_id::text||':'||v_product_id::text,0));
  end if;
  select coalesce(sum(quantity_on_hand),0) into v_balance from public.current_inventory_by_location
    where location_type=v_source and location_id=v_source_id and product_id=v_product_id;
  if v_balance<v_quantity then
    raise exception 'Insufficient recorded stock at the selected source. Ask management to reconcile it; no sale was posted' using errcode='23514';
  end if;
  v_now:=clock_timestamp();
  insert into public.route_manual_sales(id,route_id,route_stop_id,repair_task_id,repair_source_route_id,
    machine_id,location_id,operator_id,product_id,product_name,quantity,unit_sale_price_lyd,
    payment_method,stock_source,cash_destination,cash_deposited_at,sale_time,notes,status,
    client_submission_id,repair_request,created_by_user_id,created_by_team_member_id)
  values(v_sale_id,null,null,v_task_id,v_route_id,v_issue.machine_id,v_issue.location_id,v_me,
    v_product_id,v_product.name,v_quantity,v_expected_price,'cash',v_source,'machine_cashbox',v_now,v_now,
    v_notes,'confirmed',v_key,p_command,v_actor,v_me);
  insert into public.inventory_movements(product_id,quantity,from_entity_type,from_entity_id,
    to_entity_type,to_entity_id,reason,related_machine_id,related_route_id,created_by,notes,
    unit_cost_lyd,line_total_lyd,source_type,source_id,idempotency_key,idempotency_payload,created_at)
  values(v_product_id,v_quantity,v_source::public.inventory_entity_type,v_source_id,
    'customer',null,'manual_sale',v_issue.machine_id,v_route_id,v_me,
    'Manual sale during repair; full cash left in machine cashbox',v_cost,v_cost*v_quantity,
    'repair_manual_sale',v_sale_id,v_key||':stock',p_command,v_now)
  returning id into v_movement_id;
  update public.route_manual_sales set inventory_movement_id=v_movement_id where id=v_sale_id;
  -- No operator debt, cash removal, office receipt, or financial income insert.
  -- Subsequent collection transfers existing money, not another sale.
  return jsonb_build_object('ok',true,'request_id',v_request_id,'sale_id',v_sale_id,'task_id',v_task_id,
    'total_lyd',v_expected_price*v_quantity,'cash_destination','machine_cashbox','already_applied',false);
end
$body$;
revoke all on function public.snacky_repair_sale_workspace_v1(uuid),public.snacky_create_repair_manual_sale_v1(jsonb) from public,anon;
grant execute on function public.snacky_repair_sale_workspace_v1(uuid),public.snacky_create_repair_manual_sale_v1(jsonb) to authenticated;

select pg_notify('pgrst','reload schema');
commit;
