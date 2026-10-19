begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $patch$
declare v_def text;v_old text;v_new text;
begin
 v_def:=pg_get_functiondef('public.snacky_create_repair_manual_sale_v1(jsonb)'::regprocedure);
 v_old:='select route_id into v_route_id from public.operator_route_custody_leases where operator_id=v_me;';
 v_new:=$new$begin
    v_route_id:=nullif(p_command->>'stock_route_id','')::uuid;
  exception when invalid_text_representation then
    raise exception 'Choose a valid bag route' using errcode='22023';
  end;
  if v_route_id is null then
    if (select count(*) from public.operator_route_custody_leases where operator_id=v_me)>1 then
      raise exception 'Select the bag route: you currently hold stock for more than one route' using errcode='23514';
    end if;
    select route_id into v_route_id from public.operator_route_custody_leases where operator_id=v_me;
  elsif not exists(select 1 from public.operator_route_custody_leases where operator_id=v_me and route_id=v_route_id) then
    raise exception 'The selected bag route is not held by this operator' using errcode='42501';
  end if;$new$;
 if position('Select the bag route' in v_def)=0 then
  if position(v_old in v_def)=0 then raise exception 'Bag route selector changed; review before patch';end if;
  v_def:=replace(v_def,v_old,v_new);
  v_def:=replace(v_def,'where operator_id=v_me for update;','where operator_id=v_me and route_id=v_route_id for update;');
  execute v_def;
 end if;
 v_def:=pg_get_functiondef('public.snacky_repair_sale_workspace_v1(uuid)'::regprocedure);
 if position('''bag_routes''' in v_def)=0 then
  v_old:='return jsonb_build_object(''ok'',true,';
  v_new:=$new$return jsonb_build_object('bag_routes',(
    select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'date',r.route_date,'status',r.status) order by r.route_date,r.id),'[]'::jsonb)
    from public.operator_route_custody_leases l join public.routes r on r.id=l.route_id
    where l.operator_id=v_task.assigned_to
      and r.status::text not in ('completed','cancelled','canceled','verified','paid','archived','reviewed','payroll_pending','deleted','disputed')
  ),'ok',true,$new$;
  if position(v_old in v_def)=0 then raise exception 'Repair workspace changed; review before patch';end if;
  v_def:=replace(v_def,v_old,v_new);execute v_def;
 end if;
end $patch$;
select pg_notify('pgrst','reload schema');
commit;
