import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {weeklyImportRow} from '../src/lib/vms-weekly-import-row.ts';
import {createVmsOrderDetailsDuplicateHash} from '../src/lib/vms-order-details.ts';
const row={machine_identifier:'QA-M1',machine_name:'Test machine',order_number:'QA-ORDER',cargo_lane_number:'A1',product_identifier:'000123',product_name:'مياه',payment_amount:'6',payment_time:'2026-05-09T11:00:00Z',delivery_time:'2026-05-09T11:01:00Z',shipping_status:'Goods shipped',quantity:'2'};
function build(r=row){return weeklyImportRow({row:r,originalRow:r,batchId:'test-batch',rowNumber:2,machineId:'machine',productId:'product'});}
test('weekly row uses payment amount as paid, preserves textual lane/IDs and uses existing duplicate identity',()=>{
 const r=build();assert.equal(r.payment_amount,6);assert.equal(r.quantity,2);assert.equal(r.cargo_lane_number,'A1');assert.equal(r.product_number,'000123');assert.equal(r.transaction_status,'successful_sale');assert.equal(r.business_date,'2026-05-09');assert.equal(r.duplicate_hash,createVmsOrderDetailsDuplicateHash(row));assert.equal(r.raw_row,row);assert.equal('slot_code' in r,false);assert.equal('capacity' in r,false);
});
test('failed/refunded/unknown outcomes retain existing weekly classification rather than inventing sales',()=>{
 for(const [patch,status] of [[{shipping_status:'Failed'},'failed_vend'],[{payment_amount:'0'},'failed_payment'],[{shipping_status:'Pending'},'needs_review'],[{refund_status:'Refunded'},'refunded']])assert.equal(build({...row,...patch}).transaction_status,status);
 const unmapped=weeklyImportRow({row,originalRow:row,batchId:'test',rowNumber:2,machineId:null,productId:null});assert.equal(unmapped.mapped_machine_id,null);assert.equal(unmapped.mapped_product_id,null);
});
test('weekly dispatch never upserts planogram rows; only planogram reports change layout',()=>{
 const source=readFileSync('src/lib/vms-import-actions.ts','utf8');
 const start=source.indexOf('if (reportType === "vms_order_details_weekly") {');
 const end=source.indexOf('if (reportType === "planogram") {',start);
 assert.ok(start>0&&end>start,'Dedicated weekly and planogram branches required');
 const weekly=source.slice(start,end);assert.match(weekly,/weeklyImportRow/);assert.match(weekly,/transactionRawRows\.push/);assert.doesNotMatch(weekly,/planogramRows\.push|machine_slots|slotCode/);
 assert.match(source.slice(end,end+1600),/planogramRows\.push/);
});
