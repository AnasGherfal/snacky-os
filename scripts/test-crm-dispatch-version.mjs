import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {crmDispatchVersion,validateCrmDispatchCommand} from '../src/lib/crm-dispatch.ts';
const canonical='2026-09-24 12:34:56.123456+00';
const iso='2026-09-24T12:34:56.123456+00:00';
test('dispatch sends canonical token even when the row also includes ISO updated_at',()=>{
 assert.notEqual(canonical,iso);
 assert.equal(crmDispatchVersion({version:canonical,updated_at:iso}),canonical);
});
test('canonical token preserves microseconds and timezone text without Date round-trip',()=>{
 const exact='2026-09-24 14:34:56.123456+02';
 assert.equal(crmDispatchVersion({version:exact}),exact);
});
test('missing canonical token fails closed instead of inventing a value',()=>{
 for(const version of [undefined,null,'',' ',42])assert.throws(()=>crmDispatchVersion({version}));
});
test('new request and persisted exact retry keep identical version bytes',()=>{
 const command={request_id:'61111111-1111-4111-8111-111111111111',task_id:'62222222-2222-4222-8222-222222222222',action:'accept',version:crmDispatchVersion({version:canonical})};
 assert.deepEqual(validateCrmDispatchCommand(JSON.parse(JSON.stringify(command))),command);
});
test('operator panel uses canonical token and never sends display updated_at',()=>{
 const s=readFileSync(new URL('../src/components/CrmDispatchPanel.tsx',import.meta.url),'utf8');
 assert.ok(s.includes('version:crmDispatchVersion(task)'));
 assert.ok(!s.includes('version:task.updated_at'));
});
