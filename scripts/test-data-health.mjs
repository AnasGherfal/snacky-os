
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const health=fs.readFileSync('src/app/operations-health/page.tsx','utf8');
const setup=fs.readFileSync('src/app/machines/setup/page.tsx','utf8');
const sidebar=fs.readFileSync('src/components/Sidebar.tsx','utf8');
const machines=fs.readFileSync('src/app/machines/page.tsx','utf8');

test('owner data health separates current operational exceptions from legacy cleanup',()=>{
  for(const label of ['Machines missing site','Active sites missing distance','Negative stock balances','Stale refill orders (>48h)','Cash actions 3–30 days old','Recent VMS failures / partial'])assert.ok(health.includes(label));
  assert.match(health,/Legacy: older than 30 days/);
  assert.match(health,/Old draft \/ preview batches/);
  assert.match(health,/current_inventory_by_location/);
  assert.match(health,/quantity_on_hand/);
});

test('machine setup assigns a real site and stores distance on the location',()=>{
  assert.match(setup,/from\("machines"\)\.update\(\{location_id/);
  assert.match(setup,/from\("locations"\)\.update\(\{distance_from_storage_km/);
  assert.match(setup,/Save one machine at a time/);
  assert.match(setup,/leaving distance blank will not overwrite an existing site distance/);
});

test('data health is reachable from owner navigation and machines',()=>{
  assert.match(sidebar,/Data Health/);
  assert.match(sidebar,/\/operations-health/);
  assert.match(machines,/\/machines\/setup/);
});
