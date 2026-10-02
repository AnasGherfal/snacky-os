import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const control=fs.readFileSync('src/lib/xy-vms-control.ts','utf8');
const productRoute=fs.readFileSync('src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-product/route.ts','utf8');
const swapRoute=fs.readFileSync('src/app/api/operator/routes/[id]/stops/[stopId]/xy-slot-swap/route.ts','utf8');
const probe=fs.readFileSync('src/app/api/internal/xy-write-contract/route.ts','utf8');

test('XY slot product writes use the Swagger slot-product/price endpoint',()=>{
 assert.match(control,/addInstructionSpxxByApi/);
 assert.doesNotMatch(control,/fetch\(\`\$\{config\.baseUrl\}\/addInstructionByApi/);
 assert.match(control,/shbh: config\.merchantId/);
 assert.match(control,/jqbh: args\.vmsMachineId/);
 assert.match(control,/hdbh: args\.slotCode/);
 assert.match(control,/spbh: args\.vmsProductId/);
 assert.match(control,/spmc: args\.productName/);
 assert.match(control,/spjg: toMinorUnits\(args\.priceLyd\)/);
});

test('product change and swap both share the corrected fail-closed writer',()=>{
 assert.match(productRoute,/setXySlotProduct/);
 assert.match(productRoute,/XY_WRITE_REJECTED/);
 assert.match(swapRoute,/setXySlotProduct/);
 assert.match(swapRoute,/rollback/);
});

test('safe contract probe no longer treats generic instruction endpoint as equivalent',()=>{
 assert.match(probe,/\/api\/addInstructionSpxxByApi/);
 assert.doesNotMatch(probe,/\/api\/addInstructionByApi/);
});
