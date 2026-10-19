begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

alter table public.cash_collection_machines add column if not exists manual_repair_cash_lyd numeric(12,2) not null default 0;
alter table public.cash_collections add column if not exists manual_repair_cash_lyd numeric(12,2) not null default 0;

-- Cash was deposited directly into the box, not fed through XY's bill reader.
-- Use exact half-open removal intervals: start < deposit <= end.
create or replace function snacky_private.repair_cashbox_interval_v1(p_machine uuid,p_start timestamptz,p_end timestamptz)
returns table(amount_lyd numeric,sale_count bigint)
language sql stable security definer set search_path='' as $fn$
  select coalesce(sum(s.total_amount_lyd),0),count(*)
  from public.route_manual_sales s
  where s.machine_id=p_machine and s.repair_task_id is not null
    and s.cash_destination='machine_cashbox' and s.payment_method='cash' and s.status='confirmed'
    and s.cash_deposited_at>p_start and s.cash_deposited_at<=p_end
$fn$;
revoke all on function snacky_private.repair_cashbox_interval_v1(uuid,timestamptz,timestamptz) from public,anon,authenticated;

-- Preserve the existing VMS coverage, partial-removal, permissions, custody
-- and reconciliation guards. Recalculation always rebuilds totals, never +=
-- to an old expected value. Repeated calculate/reconcile calls cannot double it.
do $patch$
declare v_def text;v_old text;v_new text;
begin
  v_def:=pg_get_functiondef('snacky_private.calculate_cash_expectation_impl(uuid,uuid)'::regprocedure);
  if position('manual_repair_cash_lyd' in v_def)=0 then
    if position('  v_result jsonb;' in v_def)=0 or position('    update public.cash_collection_machines' in v_def)=0 then
      raise exception 'Cash expectation definition changed. Review before patching.';
    end if;
    v_def:=replace(v_def,'  v_result jsonb;',E'  v_result jsonb;\n  v_manual_cash numeric(12,2):=0;\n  v_manual_count bigint:=0;\n  v_total_manual_cash numeric(12,2):=0;');
    v_old:='    update public.cash_collection_machines';
    v_new:=$addition$    -- Never treat missing VMS coverage as zero sales. We expose known manual
    -- cash separately even when the combined expectation still needs review.
    select amount_lyd,sale_count into v_manual_cash,v_manual_count
    from snacky_private.repair_cashbox_interval_v1(
      v_link.machine_id,v_interval_start,coalesce(v_link.interval_end_at,v_cash.collected_at)
    );
    v_total_manual_cash:=v_total_manual_cash+v_manual_cash;
    if v_expected is not null then
      v_expected:=v_expected+v_manual_cash;
      v_total_expected:=v_total_expected+v_manual_cash;
    end if;

    update public.cash_collection_machines$addition$;
    v_def:=replace(v_def,v_old,v_new);
    v_def:=replace(v_def,'    set interval_start_at = v_interval_start,',E'    set manual_repair_cash_lyd = v_manual_cash,\n        interval_start_at = v_interval_start,');
    v_def:=replace(v_def,'''cash_rows'', v_cash_count,',E'''manual_repair_cash_lyd'', v_manual_cash,\n          ''manual_repair_sale_count'', v_manual_count,\n          ''cash_rows'', v_cash_count,');
    v_def:=replace(v_def,'  set vms_expected_cash = case',E'  set manual_repair_cash_lyd = v_total_manual_cash,\n      vms_expected_cash = case');
    v_def:=replace(v_def,'''ready'', v_all_ready,',E'''ready'', v_all_ready,\n    ''manual_repair_cash_lyd'', v_total_manual_cash,');
    v_def:=replace(v_def,'''vms_sales_count'', ccm.vms_sales_count',E'''vms_sales_count'', ccm.vms_sales_count,\n      ''manual_repair_cash_lyd'', ccm.manual_repair_cash_lyd');
    if position('set manual_repair_cash_lyd = v_total_manual_cash' in v_def)=0
      or position('set manual_repair_cash_lyd = v_manual_cash' in v_def)=0 then
      raise exception 'Could not safely integrate repair cash into existing expectation totals';
    end if;
    execute v_def;
  end if;

  -- CRM can view a linked field task's sale history without raw sales-table
  -- access or inventory-cost disclosure. The workspace still enforces scope.
  v_def:=pg_get_functiondef('public.snacky_crm_api_request_guard()'::regprocedure);
  if position('/rpc/snacky_repair_sale_workspace_v1' in v_def)=0 then
    if position('''/rpc/snacky_report_machine_issue_v1''' in v_def)=0 then
      raise exception 'CRM API allowlist changed; review before adding repair sale read';
    end if;
    v_def:=replace(v_def,'''/rpc/snacky_report_machine_issue_v1''','''/rpc/snacky_report_machine_issue_v1'',''/rpc/snacky_repair_sale_workspace_v1''');
    execute v_def;
  end if;
end
$patch$;
comment on column public.cash_collections.manual_repair_cash_lyd is 'Cash deposited from manual repair sales in the linked exact removal intervals; included in vms_expected_cash when the combined expectation is ready.';
comment on column public.route_manual_sales.cash_destination is 'operator_custody for legacy route sales; machine_cashbox for repair sales. Never create operator debt for machine_cashbox.';
select pg_notify('pgrst','reload schema');
commit;
