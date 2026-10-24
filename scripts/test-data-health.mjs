
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const health=fs.readFileSync('src/app/operations-health/page.tsx','utf8');
const setup=fs.readFileSync('src/app/machines/setup/page.tsx','utf8');
const sidebar=fs.readFileSync('src/components/Sidebar.tsx','utf8');
const machines=fs.readFileSync('src/app/machines/page.tsx','utf8');

test('owner Data Health keeps operational exceptions separate from legacy cleanup',()=>{
  for(const label of ['Machines missing site','Active sites missing distance','Negative stock balances','Safe stale refill cancellations','Cash actions 3–30 days old','Recent VMS failures / partial'])assert.ok(health.includes(label),label);
  // Safe counts and legacy classification are supplied by the audited workspace RPC,
  // rather than duplicating its SQL business rules on the page.
  assert.match(health,/snacky_data_health_workspace_v1/);
  assert.match(health,/Legacy unclassified/);
  assert.match(health,/Current 3–30 day actions/);
  assert.match(health,/old, inactive batches with zero imported rows/);
  assert.match(health,/hasAnyRole\(profile,\["owner","admin"\]\)/);
  assert.doesNotMatch(health,/\["owner", "admin", "supervisor"\]/);
  assert.match(health,/const activeCards=cards\.filter\(\(\[,value\]\)=>value>0\)/);
});

test('machine setup assigns a real site and stores distance on the location',()=>{
  assert.match(setup,/from\("machines"\)\.update\(\{location_id/);
  assert.match(setup,/from\("locations"\)\.update\(\{distance_from_storage_km/);
  assert.match(setup,/Save one machine at a time/);
  assert.match(setup,/leaving distance blank will not overwrite an existing site distance/);
});

test('data health is reachable from owner navigation and machines',()=>{
  const moduleTabs = fs.readFileSync('src/components/module-tabs-config.ts','utf8');
  assert.ok(sidebar.includes('/operations-health') || moduleTabs.includes('href: "/operations-health"'));
  assert.match(health,/owner","admin/);
  assert.match(machines,/\/machines\/setup/);
});
