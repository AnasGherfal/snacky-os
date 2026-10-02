"""Disposable integration environment. Never accepts a remote database target.
See docs/company-qa-environment.md for the original-schema bootstrap differences.
"""
import os
import re
import subprocess
from pathlib import Path
assert 'snacky-company-isolated' in Path('.qa/full/supabase/config.toml').read_text()
files = sorted(Path('supabase/migrations').glob('*.sql'))
bridge = next(p for p in files if p.name == '2026061300015_operator_pay_profiles_legacy_compat.sql')
files.remove(bridge)
engine = next(p for p in files if p.name == '202606130002_operator_payroll_engine.sql')
files.insert(files.index(engine) + 1, bridge)
env = {**os.environ, 'PGHOST': '127.0.0.1', 'PGPORT': '54322', 'PGUSER': 'postgres', 'PGDATABASE': 'postgres', 'PGPASSWORD': 'postgres'}
transactional = {'20260902150000_xy_vms_durable_scheduler.sql', '20260905095000_operator_route_custody_lease.sql', '20260909211000_allow_operator_multiple_route_custody.sql'}
Path('diagnostics').mkdir(exist_ok=True)
with open('diagnostics/migration-replay.log', 'w') as log:
    log.write('ISOLATED LOOPBACK ONLY. Original SQL is unmodified. Bootstrap exceptions and verified production permission baseline are documented in docs/company-qa-environment.md.\n')
    log.flush()
    def execute(args):
        r = subprocess.run(['psql', '-X', '-v', 'ON_ERROR_STOP=1'] + args, env=env, stdout=log, stderr=log)
        if r.returncode:
            log.flush()
            print('\n'.join(Path(log.name).read_text(errors='replace').splitlines()[-80:]))
            raise SystemExit(r.returncode)
    for p in files:
        log.write('\nAPPLY ' + p.name + '\n'); log.flush()
        if p.name == '202606180001_sales_dashboard_reconciliation_fix.sql':
            execute(['-c', 'drop view if exists public.vms_sales_clean cascade'])
        if p.name == '20260904082626_optimize_inventory_rls_reads.sql':
            execute(['-c', 'create policy snacky_team_members_self_read on public.team_members for select to authenticated using (auth_user_id = (select auth.uid()))'])
        if p.name == '20260916150634_company_hub.sql':
            # READ-ONLY production inspection on 2026-09-16 verified this grant
            # already exists there. Replaying old SQL alone removes it and
            # prevents the pre-existing SECURITY INVOKER finalizer from working.
            # Mirror that observed BASELINE before Company, not as a Company fix.
            # This is not a production migration and never grants browser writes.
            log.write('MIRROR VERIFIED PRODUCTION BASELINE: service_role UPDATE on route_stop_inventory_commits; no authenticated/anon writer grant.\n'); log.flush()
            execute(['-c', 'grant update on public.route_stop_inventory_commits to service_role'])
        execute((['--single-transaction'] if p.name in transactional else []) + ['-f', str(p)])
    original = Path('supabase/migrations/202606060001_vms_import_status_sources.sql').read_text()
    for name in ['kpi_machine_daily', 'kpi_machine_monthly', 'kpi_product_daily', 'kpi_product_monthly', 'kpi_location_monthly']:
        match = re.search(r'create or replace view public\.' + name + r' as\b.*?;', original, re.S | re.I)
        assert match, name
        execute(['-c', match.group() + f' alter view public.{name} set (security_invoker=true); revoke all on public.{name} from anon; grant select on public.{name} to authenticated;'])
    execute(['-c', "do $$begin if has_function_privilege('authenticated','public.snacky_finalize_route_stop_workflow_v1(uuid,uuid,uuid,timestamptz,text,text)','EXECUTE') or has_table_privilege('authenticated','public.route_stop_inventory_commits','UPDATE') or has_table_privilege('service_role','public.inventory_movements','INSERT') then raise exception 'Integration baseline exposed a protected ledger writer'; end if; end $$; notify pgrst,'reload schema';"])
print('Applied ' + str(len(files)) + ' original SQL files with the documented empty-bootstrap and observed-production-baseline differences.')
