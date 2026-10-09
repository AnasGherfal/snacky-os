import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const admin=fs.readFileSync('src/app/admin/vms-api/page.tsx','utf8');
const bg=fs.readFileSync('src/components/XyBackgroundSync.tsx','utf8');

test('XY admin shows connection health without triggering a sync',()=>{
 assert.match(admin,/Live XY Connection Health/);
 assert.match(admin,/mappedMachinesResult/);
 assert.match(admin,/liveStockMachinesResult/);
 assert.match(admin,/machinesMissingLiveStock/);
 assert.match(admin,/Live stock coverage/);
 assert.match(admin,/This does not trigger a sync/);
});

test('XY admin exposes unmapped products and missing stock machines',()=>{
 assert.match(admin,/XY products need mapping/);
 assert.match(admin,/\/vms-mappings/);
 assert.match(admin,/Machines without usable stock in the active XY snapshot/);
});

test('browser XY refresh uses a shared cooldown across tabs to reduce Vercel calls',()=>{
 assert.match(bg,/XY_SHARED_COOLDOWN_MS = 20 \* 60 \* 1000/);
 assert.match(bg,/window\.localStorage\.getItem\(XY_SHARED_ATTEMPT_KEY\)/);
 assert.match(bg,/window\.localStorage\.setItem\(XY_SHARED_ATTEMPT_KEY/);
 assert.match(bg,/if \(!waitingForAnotherRun && sharedCooldownActive\(\)\) return/);
});

test('admin copy reflects the real cooldown and route freshness behavior',()=>{
 assert.match(admin,/shared 20-minute browser cooldown across tabs/);
 assert.match(admin,/Route creation still performs its own freshness check/);
});

test('owner XY health distinguishes saved queue entries from verified vendor writes',()=>{
 assert.match(admin,/XY Route Write Verification/);
 assert.match(admin,/xy_stop_quantity_syncs/);
 assert.match(admin,/xy_pending_slot_changes/);
 assert.match(admin,/Verified by XY read-back/);
 assert.match(admin,/Bidirectional XY writes are implemented but not production-verified/);
 assert.match(admin,/Conflicts \/ rejected/);
});

test('owner can test direct XY vendor stock safely without sending writes',()=>{
 const route=fs.readFileSync('src/app/api/admin/xy-live-layout/route.ts','utf8');
 const page=fs.readFileSync('src/app/admin/vms-api/page.tsx','utf8');
 const component=fs.readFileSync('src/components/XyAdminLiveProbe.tsx','utf8');
 assert.match(route,/getCurrentProfile/);
 assert.match(route,/isOwnerAdminRole/);
 assert.match(route,/readXyMachineLayout/);
 assert.doesNotMatch(route,/setXySlotProduct|verifyXySlot|update\(/);
 assert.match(route,/xy_live_direct/);
 assert.match(route,/Cache-Control.*private, no-store/);
 assert.match(page,/XyAdminLiveProbe/);
 assert.match(component,/Check Live XY/);
 assert.match(component,/Quantity exceeds capacity|problematicSelections/);
});
