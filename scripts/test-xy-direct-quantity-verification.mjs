import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {verifyMachineQuantityRowsAgainstXy} from '../src/lib/xy-quantity-verification.ts';

test('live XY verification requires exact slot quantities',()=>{
 const rows=[{productId:'p',productName:'Water',machineSlotId:'s',slotCode:'011',previousQty:2,addedQty:3,finalQty:5}];
 assert.equal(verifyMachineQuantityRowsAgainstXy(rows,[{slotCode:'011',vmsProductId:'1',productName:'Water',priceLyd:3,currentQty:5,capacity:8}]).verified,true);
 const bad=verifyMachineQuantityRowsAgainstXy(rows,[{slotCode:'011',vmsProductId:'1',productName:'Water',priceLyd:3,currentQty:4,capacity:8}]);
 assert.equal(bad.verified,false);
 assert.equal(bad.mismatches[0].reason,'quantity_mismatch');
});

test('generic legacy VMS rows never auto-verify',()=>{
 const rows=[{productId:'p',productName:'Water',machineSlotId:null,slotCode:'VMS',previousQty:0,addedQty:3,finalQty:3}];
 const result=verifyMachineQuantityRowsAgainstXy(rows,[]);
 assert.equal(result.verified,false);
 assert.equal(result.mismatches[0].reason,'generic_slot');
});

test('quantity confirmation API writes through the durable verified XY sync path',()=>{
 const api=fs.readFileSync('src/app/api/operator/routes/[id]/stops/[stopId]/quantity-confirmation/route.ts','utf8');
 const sync=fs.readFileSync('src/lib/xy-refill-quantity-sync.ts','utf8');
 assert.match(api,/syncMachineQuantityRowsToXy/);
 assert.match(api,/provisionalRecord/);
 assert.match(api,/quantity_rows: preparedRows/);
 assert.match(api,/verification_status: syncVerified \? "xy_api_verified"/);
 assert.match(sync,/readXyMachineLayout/);
 assert.match(sync,/setXySlotProduct/);
 assert.match(sync,/verifyXySlot/);
 assert.match(sync,/xySyncTargetQty/);
 assert.match(sync,/persistPrepared/);
});

test('operator UI sends refill quantities from Snacky OS and preserves the power-off queue',()=>{
 const card=fs.readFileSync('src/components/operator/MachineQuantityConfirmationCard.tsx','utf8');
 assert.match(card,/Update XY from Snacky/);
 assert.match(card,/saveMode\("xy_api"\)/);
 assert.match(card,/You do not need to open the machine settings or take screenshots/);
 assert.match(card,/Machine has no electricity/);
 assert.match(card,/Retry after fixing setup/);
 assert.doesNotMatch(card,/Screenshots remain available as a fallback/);
});

test('direct XY verification is a ready status and owner queue recognizes it',()=>{
 const lib=fs.readFileSync('src/lib/machine-quantity-confirmation.ts','utf8');
 const queue=fs.readFileSync('src/app/routes/quantity-updates/page.tsx','utf8');
 assert.match(lib,/xy_api_verified/);
 assert.match(queue,/Verified by XY/);
});
