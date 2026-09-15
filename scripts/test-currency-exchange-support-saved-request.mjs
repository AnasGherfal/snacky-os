import assert from 'node:assert/strict';
import test from 'node:test';
import { readSavedBusinessRecord, businessDate } from '../src/lib/business-record-validation.ts';
const id='11111111-1111-4111-8111-111111111111';
test('a surviving command UUID never makes a truncated exchange request safe to discard',()=>{
  const valid={kind:'exchange',client_submission_id:id,source_account_id:'snacky_lyd',destination_account_id:'snacky_usd',source_amount:'9000',destination_amount:'1000',transaction_date:businessDate()};
  assert.deepEqual(readSavedBusinessRecord(JSON.stringify(valid),'exchange'),valid);
  for(const field of ['source_account_id','destination_account_id','source_amount','destination_amount','transaction_date']) {
    const corrupt={...valid};delete corrupt[field];assert.throws(()=>readSavedBusinessRecord(JSON.stringify(corrupt),'exchange'));
  }
  assert.throws(()=>readSavedBusinessRecord(JSON.stringify({kind:'exchange',client_submission_id:id}),'exchange'));
});
test('a support request missing the original description fails closed',()=>{
  const valid={kind:'issue',client_submission_id:id,issue_type:'other',priority:'normal',contact_channel:'phone',description:'Fixture'};
  assert.deepEqual(readSavedBusinessRecord(JSON.stringify(valid),'issue'),valid);
  assert.throws(()=>readSavedBusinessRecord(JSON.stringify({...valid,description:''}),'issue'));
});
