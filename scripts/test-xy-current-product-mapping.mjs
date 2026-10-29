import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const list=fs.readFileSync('src/app/vms-mappings/page.tsx','utf8');
const admin=fs.readFileSync('src/app/admin/vms-api/page.tsx','utf8');

test('XY mapping attention is based on current machine lanes not catalogue last-seen time',()=>{
 assert.match(list,/latest_vms_stock_by_slot/);
 assert.match(list,/currentXyProductIds/);
 assert.match(list,/isCurrentXyProduct/);
 assert.match(list,/Catalog-only products can stay unmapped until they are used again/);
});

test('catalog-only unmapped products do not get urgent match suggestions',()=>{
 assert.match(list,/normalized\.status==="needs_review"&&isCurrentXyProduct&&!isPlaceholder/);
 assert.match(list,/Not in current machine lanes/);
 assert.match(list,/XY placeholder — ignore/);
});

test('admin health counts only unmapped products that are in active XY lanes',()=>{
 assert.match(admin,/currentXyProductIds/);
 assert.match(admin,/currentUnmappedCount/);
 assert.match(admin,/current XY lane product/);
 assert.match(admin,/catalog-only\/unused mapping entries are not blocking current operations/);
});

// The production table has unlinked XY products whose generic status reads
// "confirmed" while their actual match_status is "needs_review". Never hide
// these from the buyer's mapping-review queue.
test('VMS mapping review uses the authoritative match_status for filters, counts and the edit form',()=>{
 const edit=fs.readFileSync('src/app/vms-mappings/[id]/edit/page.tsx','utf8');
 assert.match(list,/const status = row\.match_status \?\? row\.status \?\? "needs_review"/);
 assert.match(list,/\.eq\("match_status", statusValue\)/);
 assert.match(list,/query\.eq\("match_status", activeStatus\)/);
 assert.match(edit,/defaultValue=\{mapping\.match_status \?\? mapping\.status \?\? "needs_review"\}/);
});
