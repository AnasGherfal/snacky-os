import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const page=fs.readFileSync('src/app/operations-health/page.tsx','utf8');
const button=fs.readFileSync('src/components/DataHealthActionButton.tsx','utf8');
const api=fs.readFileSync('src/app/api/data-health/action/route.ts','utf8');
const migration=fs.readFileSync('supabase/migrations/20261002211500_data_health_bulk_cleanup.sql','utf8');

test('zero exception cards are hidden rather than rendered as 0',()=>{
 assert.match(page,/const activeCards=cards\.filter\(\(\[,value\]\)=>value>0\)/);
 assert.match(page,/No active data-health exceptions/);
 assert.match(page,/currentCashCount>0/);
 assert.match(page,/vms_recent_attention.*>0/);
});

test('bulk stale-refill cleanup repeats the exact safety filters',()=>{
 assert.match(migration,/bulk_cancel_stale_refills/);
 assert.match(migration,/r\.status::text in \('draft','assigned'\)/);
 assert.match(migration,/r\.generated_at<clock_timestamp\(\)-interval '48 hours'/);
 assert.match(migration,/related_refill_order_id=r\.id/);
 assert.match(migration,/rt\.status::text in \('completed','cancelled'\)/);
 assert.match(page,/Cancel all/);
});

test('bulk VMS cleanup only soft-archives abandoned zero-import inactive batches',()=>{
 assert.match(migration,/bulk_archive_vms_batches/);
 assert.match(migration,/b\.status in \('draft','previewed','failed'\)/);
 assert.match(migration,/coalesce\(b\.rows_imported,0\)=0/);
 assert.match(migration,/not coalesce\(b\.is_active,false\)/);
 assert.match(migration,/deleted_at=clock_timestamp\(\)/);
 assert.match(page,/Archive all/);
});

test('bulk commands remain inaccessible through the owner-only single-command API',()=>{
 assert.match(button,/bulk_cancel_stale_refills/);
 assert.match(button,/bulk_archive_vms_batches/);
 assert.match(api,/snacky_data_health_command_v1/);
 assert.doesNotMatch(api,/'bulk_cancel_stale_refills'|'bulk_archive_vms_batches'/);
 assert.match(api,/hasAnyRole\(profile,\['owner','admin'\]\)/);
});
