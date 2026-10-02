import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const queue=fs.readFileSync('src/app/cash-collections/action-queue/page.tsx','utf8');
const health=fs.readFileSync('src/app/operations-health/page.tsx','utf8');
const cash=fs.readFileSync('src/app/cash-collections/page.tsx','utf8');

test('cash action queue contains current unresolved work only',()=>{
 assert.match(queue,/gte\("collected_at",cutoff\)/);
 assert.match(queue,/voided_at/);
 assert.match(queue,/custody_status\.in\.\(removed,in_storage,counted\)/);
 assert.match(queue,/reconciliation_status\.eq\.variance_review/);
 assert.match(queue,/Current cash only/);
});

test('cash queue derives the next action from the existing custody workflow',()=>{
 for(const label of ['Owner variance decision','Receive into storage','Count stored cash','Compare with VMS'])assert.ok(queue.includes(label));
 assert.match(queue,/\/cash-collections\/"/);
 assert.match(queue,/Open & complete/);
});

test('zero cash action buckets are hidden',()=>{
 assert.match(queue,/filter\(\(\[,count\]\)=>Number\(count\)>0\)/);
 assert.match(queue,/No current cash actions need attention/);
});

test('Data Health and Cash Custody link to the action queue',()=>{
 assert.match(health,/\/cash-collections\/action-queue/);
 assert.match(cash,/Action queue/);
 assert.match(cash,/\/cash-collections\/action-queue/);
});
