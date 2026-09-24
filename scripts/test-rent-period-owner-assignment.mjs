import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration=fs.readFileSync('supabase/migrations/20260924121500_rent_period_and_owner_assignment.sql','utf8');
const workspace=fs.readFileSync('src/components/CrmWorkspace.tsx','utf8');
const component=fs.readFileSync('src/components/CrmObligationAdminForm.tsx','utf8');
const api=fs.readFileSync('src/app/api/crm/obligation-admin/route.ts','utf8');

test('every rent obligation gets an explicit month period',()=>{
  assert.match(migration,/add column if not exists rent_period_start_month date/);
  assert.match(migration,/add column if not exists rent_period_end_month date/);
  assert.match(migration,/date_trunc\('month', due_date\)::date/);
  assert.match(migration,/location_admin_obligations_fill_rent_period_v1/);
  assert.match(migration,/when 'quarterly' then interval '2 months'/);
  assert.match(migration,/when 'yearly' then interval '11 months'/);
  assert.match(migration,/rent_period_end_month >= rent_period_start_month/);
});

test('owner admin may reassign a current obligation and edit its rent period safely',()=>{
  assert.match(migration,/snacky_obligation_admin_update_v1/);
  assert.match(migration,/snacky_current_profile_has_any_role\(array\['owner','admin'\]\)/);
  assert.match(migration,/Choose an active responsible employee/);
  assert.match(migration,/Historical payment ownership is preserved as recorded/);
  assert.match(migration,/Location payment changed\. Reload before saving/);
  assert.match(migration,/set assigned_to=p_assigned_to/);
  assert.match(migration,/rent_period_start_month=p_period_start_month/);
  assert.match(migration,/rent_period_end_month=p_period_end_month/);
  assert.doesNotMatch(migration,/insert\s+into\s+public\.financial_transactions/i);
  assert.doesNotMatch(migration,/update\s+public\.financial_transactions/i);
});

test('rent period is clear in lists and detail pages',()=>{
  assert.match(workspace,/function rentPeriodLabel/);
  assert.match(workspace,/Rent period','فترة الإيجار/);
  assert.match(workspace,/rentPeriodLabel\(row\.data,ar\)/);
  assert.match(workspace,/rentPeriodLabel\(d,ar\)/);
  assert.match(workspace,/Due \/ payment month','شهر الاستحقاق \/ الدفع/);
});

test('owner admin sees a dedicated assignment and period editor',()=>{
  assert.match(workspace,/CrmObligationAdminForm/);
  assert.match(workspace,/context\.owner_admin&&!d\.is_historical&&d\.status!=='cancelled'/);
  assert.match(component,/name="assigned_to"/);
  assert.match(component,/name="period_start" type="month"/);
  assert.match(component,/name="period_end" type="month"/);
  assert.match(component,/does not create or change a Finance transaction/);
});

test('admin update endpoint is same-origin and owner/admin only',()=>{
  assert.match(api,/sec-fetch-site/);
  assert.match(api,/hasAnyRole\(profile,\['owner','admin'\]\)/);
  assert.match(api,/snacky_obligation_admin_update_v1/);
  assert.match(api,/Date\.parse\(version\)/);
  assert.match(api,/\/relationships\/obligations/);
});
