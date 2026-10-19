begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
alter table public.route_manual_sales add constraint repair_sale_requires_stock_source check (repair_task_id is null or stock_source is not null);
do $patch$
declare v_def text;
begin
 v_def:=pg_get_functiondef('public.snacky_create_repair_manual_sale_v1(jsonb)'::regprocedure);
 v_def:=replace(v_def,'v_task.dispatch_state<>''working''','v_task.dispatch_state is distinct from ''working''');
 execute v_def;
 v_def:=pg_get_functiondef('public.snacky_repair_sale_workspace_v1(uuid)'::regprocedure);
 if position('and not v_task.is_practice' in v_def)=0 then
   v_def:=replace(v_def,'v_task.assigned_to=v_me and v_task.dispatch_state=''working''',
     'v_task.assigned_to=v_me and not v_task.is_practice and not v_issue.is_practice and v_task.dispatch_state=''working''');
   execute v_def;
 end if;
end $patch$;
select pg_notify('pgrst','reload schema');
commit;
