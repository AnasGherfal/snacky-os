"""Disposable local schema bootstrap. Never accepts a remote database target."""
import os, subprocess
from pathlib import Path

assert Path('.qa/full/supabase/config.toml').read_text().find('snacky-company-isolated') >= 0
files=sorted(Path('supabase/migrations').glob('*.sql'))
bridge=next(p for p in files if p.name=='2026061300015_operator_pay_profiles_legacy_compat.sql')
files.remove(bridge)
engine=next(p for p in files if p.name=='202606130002_operator_payroll_engine.sql')
files.insert(files.index(engine)+1,bridge)
env={**os.environ,'PGHOST':'127.0.0.1','PGPORT':'54322','PGUSER':'postgres','PGDATABASE':'postgres','PGPASSWORD':'postgres'}
Path('diagnostics').mkdir(exist_ok=True)
with open('diagnostics/migration-replay.log','w') as log:
 log.write('ISOLATED LOOPBACK ONLY. Historical bootstrap exceptions: payroll bridge follows engine; incompatible June sales view is rebuilt in the empty fixture. Production migration files remain unchanged.\n');log.flush()
 for p in files:
  log.write('\nAPPLY '+p.name+'\n');log.flush()
  if p.name=='202606180001_sales_dashboard_reconciliation_fix.sql':
   result=subprocess.run(['psql','-X','-v','ON_ERROR_STOP=1','-c','drop view if exists public.vms_sales_clean cascade'],env=env,stdout=log,stderr=log)
   if result.returncode:raise SystemExit(result.returncode)
  result=subprocess.run(['psql','-X','-v','ON_ERROR_STOP=1','-f',str(p)],env=env,stdout=log,stderr=log)
  if result.returncode:
   log.flush();print('\n'.join(Path(log.name).read_text(errors='replace').splitlines()[-80:]));raise SystemExit(result.returncode)
print('Applied '+str(len(files))+' original SQL files in disposable services with the documented fresh-bootstrap exceptions.')
