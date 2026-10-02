import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page=fs.readFileSync('src/app/operations-health/page.tsx','utf8');
const button=fs.readFileSync('src/components/DataHealthActionButton.tsx','utf8');
const api=fs.readFileSync('src/app/api/data-health/action/route.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20261002174500_data_health_cleanup_controls.sql','utf8');

test('Data Health cleanup uses signed-in role-checked RPCs',()=>{
 assert.ok(page.includes('getAuthenticatedSupabaseServerClient'));
 assert.ok(!page.includes('getSupabaseAdminClient'));
 assert.ok(page.includes('snacky_data_health_workspace_v1'));
 assert.ok(migration.includes('Owner or admin access required'));
});

test('stale refill cancellation is guarded by age state inventory and route safety',()=>{
 for(const text of ["refill.status::text not in ('draft','assigned')","older than 48 hours","related_refill_order_id=refill.id","route_status not in ('completed','cancelled')"])assert.ok(migration.includes(text));
 assert.ok(page.includes('Picked stock requires manual inventory review'));
});

test('VMS cleanup is a soft archive of abandoned zero-import batches only',()=>{
 for(const text of ["batch.status not in ('draft','previewed','failed')","coalesce(batch.rows_imported,0)<>0","coalesce(batch.is_active,false)","set deleted_at=clock_timestamp(),deleted_by=me,delete_reason=reason_text,is_active=false"])assert.ok(migration.includes(text));
 assert.ok(page.includes('Archive abandoned batch'));
});

test('cash legacy classification does not reconcile or alter money',()=>{
 assert.ok(migration.includes('cash_classifications'));
 assert.ok(migration.includes('legacy_backlog'));
 assert.ok(!migration.includes("set reconciliation_status='matched'"));
 assert.ok(!migration.includes('set actual_cash_collected'));
 assert.ok(page.includes('Classification does not reconcile cash, change amounts, or post Finance'));
});

test('negative stock is tracked and cannot be closed while still negative',()=>{
 assert.ok(migration.includes('inventory_cases'));
 assert.ok(migration.includes('where i.quantity_on_hand<0'));
 assert.ok(migration.includes('Inventory is still negative. Correct the physical/ledger balance before resolving this case.'));
 assert.ok(page.includes('Snacky OS never invents stock'));
 assert.ok(page.includes('Close corrected case'));
});

test('cleanup API is owner admin same-origin and all UI actions require explicit server confirmation',()=>{
 assert.ok(api.includes("new URL(origin).origin!==new URL(request.url).origin"));
 assert.ok(api.includes("hasAnyRole(profile,['owner','admin'])"));
 assert.ok(api.includes('snacky_data_health_command_v1'));
 assert.ok(button.includes('/api/data-health/action'));
 assert.ok(button.includes('Reason / audit note'));
});
