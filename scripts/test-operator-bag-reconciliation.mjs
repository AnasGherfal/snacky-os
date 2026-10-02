import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page=fs.readFileSync('src/app/operations-health/page.tsx','utf8');
const control=fs.readFileSync('src/components/OperatorBagReconcileControl.tsx','utf8');
const api=fs.readFileSync('src/app/api/data-health/operator-bag-reconcile/route.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20261002205000_operator_bag_reconciliation.sql','utf8');

test('negative operator bag case requires a physical count rather than silent zeroing',()=>{
 assert.match(page,/OperatorBagReconcileControl/);
 assert.match(control,/Enter what is physically in the operator bag/);
 assert.match(control,/Physical count/);
 assert.match(migration,/stock_count_adjustment/);
 assert.match(migration,/data_health_operator_bag_reconciliation/);
 assert.doesNotMatch(migration,/update public\.current_inventory_by_location/);
});

test('operator bag reconciliation is owner admin only idempotent and ledger-backed',()=>{
 assert.match(api,/hasAnyRole\(profile,\['owner','admin'\]\)/);
 assert.match(api,/snacky_data_health_operator_bag_reconcile_v1/);
 assert.match(migration,/operator_bag_reconciliation_receipts/);
 assert.match(migration,/where request_id=p_request_id/);
 assert.match(migration,/already_applied/);
 assert.match(migration,/inventory_movements/);
 assert.match(migration,/after_qty<>p_counted_qty/);
});

test('uncertain client response retries the exact same reconciliation request',()=>{
 assert.match(control,/sessionStorage\.setItem/);
 assert.match(control,/request_id:crypto\.randomUUID\(\)/);
 assert.match(control,/Result uncertain\. Retry the exact same count and reason/);
});

test('public reconciliation RPC stays invoker and privileged logic stays private',()=>{
 const lower=migration.toLowerCase();
 const start=lower.indexOf('create or replace function public.snacky_data_health_operator_bag_reconcile_v1');
 const end=lower.indexOf('revoke all on function public.snacky_data_health_operator_bag_reconcile_v1',start);
 assert.ok(start>=0&&end>start);
 assert.doesNotMatch(migration.slice(start,end),/security definer/i);
 assert.match(migration,/create or replace function data_health_private\.reconcile_operator_bag/i);
});
