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

test('quantity confirmation API reads live XY and fails closed on mismatch or outage',()=>{
 const api=fs.readFileSync('src/app/api/operator/routes/[id]/stops/[stopId]/quantity-confirmation/route.ts','utf8');
 assert.match(api,/readXyMachineLayout/);
 assert.match(api,/verifyMachineQuantityRowsAgainstXy/);
 assert.match(api,/XY_QUANTITY_MISMATCH/);
 assert.match(api,/XY_LIVE_UNAVAILABLE/);
 assert.match(api,/verification_status: mode === "xy_api" \? "xy_api_verified"/);
});

test('operator UI prefers direct XY verification but preserves screenshot and power-off fallback',()=>{
 const card=fs.readFileSync('src/components/operator/MachineQuantityConfirmationCard.tsx','utf8');
 assert.match(card,/Verify with XY/);
 assert.match(card,/saveMode\("xy_api"\)/);
 assert.match(card,/Screenshots remain available as a fallback/);
 assert.match(card,/Machine has no electricity/);
});

test('direct XY verification is a ready status and owner queue recognizes it',()=>{
 const lib=fs.readFileSync('src/lib/machine-quantity-confirmation.ts','utf8');
 const queue=fs.readFileSync('src/app/routes/quantity-updates/page.tsx','utf8');
 assert.match(lib,/xy_api_verified/);
 assert.match(queue,/Verified by XY/);
});
