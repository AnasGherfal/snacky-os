import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const migration=read('supabase/migrations/20260923154301_assigned_storage_stocktake_v1.sql');
const api=read('src/app/api/storage-stocktake/route.ts');
const client=read('src/components/StorageStocktakeWorkspace.tsx');
const lib=read('src/lib/storage-stocktake.ts');
const page=read('src/app/inventory/stocktake/page.tsx');
const tabs=read('src/components/module-tabs-config.ts');

test('stocktake lives in private schema with no raw browser table access',()=>{
 assert.match(migration,/create schema if not exists stocktake_private/i);
 for(const table of ['assignments','lines','events','requests'])assert.match(migration,new RegExp('alter table stocktake_private\\.'+table+' enable row level security','i'));
 assert.match(migration,/revoke all on all tables in schema stocktake_private from public, anon, authenticated/i);
 assert.match(migration,/security invoker/i);
});

test('employee count is blind and only manager gets ledger quantities',()=>{
 assert.match(migration,/case when v_manager then[\s\S]*expected_at_count/i);
 assert.match(client,/System quantity is intentionally hidden/i);
 assert.doesNotMatch(client,/baseline_qty[^?]/);
});

test('assignment is one employee and one active physical storage',()=>{
 assert.match(migration,/assigned_to uuid not null references public\.profiles/i);
 assert.match(migration,/storage_location_id uuid not null references public\.storage_locations/i);
 assert.match(migration,/unique index assigned_storage_stocktake_one_active_location/i);
 assert.match(migration,/status in \('assigned','counting','submitted','needs_recount'\)/i);
});

test('counter saves product timestamps and submission never changes stock',()=>{
 assert.match(migration,/counted_at=v_now,counted_by=v_actor/i);
 const submit=migration.slice(migration.indexOf("elsif v_action='submit'"),migration.indexOf("elsif v_action='recount'"));
 assert.doesNotMatch(submit,/inventory_movements|snacky_create_storage_adjustment_v1/i);
});

test('approval compares ledger at count time and applies only variance delta',()=>{
 assert.match(migration,/ledger_quantity_at\(v_assignment\.storage_location_id,v_product,\(v_item->>'counted_at'\)::timestamptz\)/i);
 assert.match(migration,/v_delta:=v_count-v_expected/i);
 assert.match(migration,/case when v_delta>0 then 'add' else 'remove' end/i);
 assert.match(migration,/abs\(v_delta\),'stock_count_correction'/i);
 assert.doesNotMatch(migration,/set_exact[^']*stock_count/i);
});

test('approval reuses protected storage adjustment RPC instead of editing balances',()=>{
 assert.match(migration,/public\.snacky_create_storage_adjustment_v1/i);
 assert.doesNotMatch(migration,/update\s+public\.current_inventory_by_location/i);
 assert.doesNotMatch(migration,/insert into public\.inventory_movements/i);
});

test('only owner admin can review while assignee can count only own assignment',()=>{
 assert.match(migration,/stocktake_private\.manager\(\)/i);
 assert.match(migration,/v_assignment\.assigned_to is distinct from v_actor/i);
 assert.match(migration,/if not stocktake_private\.manager\(\) then raise exception 'Owner or admin required'/i);
});

test('same request recovery and stale revision protection exist',()=>{
 assert.match(migration,/pg_advisory_xact_lock/i);
 assert.match(migration,/v_existing\.command is distinct from p_command/i);
 assert.match(migration,/if v_existing\.result is not null then return v_existing\.result/i);
 assert.match(migration,/if v_revision <> v_assignment\.revision/i);
 assert.match(client,/Retry saved action/i);
});

test('found products can be added but system quantities stay hidden from assignee',()=>{
 assert.match(migration,/added_during_count/i);
 assert.match(client,/Found a product not listed/i);
 assert.match(client,/Add to count/i);
});

test('page is mobile reachable inside Stock and Purchasing',()=>{
 assert.match(page,/StorageStocktakeWorkspace/);
 assert.match(tabs,/Storage Count/);
 assert.match(tabs,/\/inventory\/stocktake/);
 assert.match(tabs,/جرد المخزن/);
});

test('API validates access, same origin, bounded body, and receipt identity',()=>{
 assert.match(api,/canAccessPath\(context,'\/inventory\/stocktake'\)/);
 assert.match(api,/stocktakeSameOrigin/);
 assert.match(api,/readCompanyBody\(request,100000\)/);
 assert.match(api,/stocktakeReceiptMatches/);
 assert.match(lib,/request_id/);
});
