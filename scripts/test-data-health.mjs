import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const health=fs.readFileSync('src/app/operations-health/page.tsx','utf8');
const setup=fs.readFileSync('src/app/machines/setup/page.tsx','utf8');
const sidebar=fs.readFileSync('src/components/Sidebar.tsx','utf8');
const machines=fs.readFileSync('src/app/machines/page.tsx','utf8');

test('owner data health separates current operational exceptions from safe cleanup queues',()=>{
  for(const label of [
    'Machines missing site',
    'Active sites missing distance',
    'Negative stock balances',
    'Safe stale refill cancellations',
    'Cash actions 3–30 days old',
    'Recent VMS failures / partial',
  ]) assert.ok(health.includes(label));

  assert.match(health,/snacky_data_health_workspace_v1/);
  assert.match(health,/Legacy unclassified/);
  assert.match(health,/Legacy classified/);
  assert.match(health,/Safe archive candidates/);
  assert.match(health,/picked orders remain review-only because physical custody may already exist/);
  assert.match(health,/bulk_cancel_stale_refills/);
  assert.match(health,/bulk_archive_vms_batches/);
  assert.match(health,/hasAnyRole\(profile,\["owner","admin"\]\)/);
  assert.doesNotMatch(health,/\["owner","admin","supervisor"\]/);
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
