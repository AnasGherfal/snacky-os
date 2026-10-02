import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const cron=fs.readFileSync('src/app/api/cron/xy-vms/route.ts','utf8');
const list=fs.readFileSync('src/app/machines/page.tsx','utf8');
const detail=fs.readFileSync('src/app/machines/[id]/page.tsx','utf8');
const dashboard=fs.readFileSync('src/app/machines-dashboard/page.tsx','utf8');

test('hourly XY scheduler refreshes machine status in the same invocation',()=>{
 assert.match(cron,/syncXyMachineStatus/);
 assert.match(cron,/machineStatusSync/);
 assert.doesNotMatch(cron,/setInterval|new cron|schedule/);
});

test('machine list shows XY online offline and last contact separately from Snacky status',()=>{
 assert.match(list,/XY status/);
 assert.match(list,/XY Online/);
 assert.match(list,/XY Offline/);
 assert.match(list,/last_vms_status_at/);
});

test('machine detail surfaces current XY connection health',()=>{
 assert.match(detail,/XY connection/);
 assert.match(detail,/Machine is reporting online to XY/);
 assert.match(detail,/Machine is currently reported offline by XY/);
 assert.match(detail,/vms_temperature_raw/);
});

test('machine dashboard includes XY health while hiding zero health cards',()=>{
 assert.match(dashboard,/XY machine health/);
 assert.match(dashboard,/XY online/);
 assert.match(dashboard,/XY offline/);
 assert.match(dashboard,/filter\(\(\[,value\]\)=>Number\(value\)>0\)/);
});
