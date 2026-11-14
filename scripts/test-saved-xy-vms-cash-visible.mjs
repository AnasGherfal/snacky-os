import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { savedOwnerVmsForCollection } from "../src/lib/cash-vms-window.ts";

const read = (path) => readFileSync(path,"utf8");
const snapshot = {
  start_collection_id:"start-removal",
  end_collection_id:"last-removal",
  start_at:"2026-11-01T12:00:00Z",
  end_at:"2026-11-08T08:18:13Z",
  included_collection_ids:["last-removal"],
  physical_cash_lyd:1297,
  vms_cash_lyd:1333,
  difference_lyd:-36,
  quality:"provisional",
  payment_scope:"cash_successful_only",
  source:"owner_entered_xy_vms",
  source_note:"XY VMS Order Management cash",
  saved_at:"2026-11-14T14:49:32Z",
  saved_by:"test-owner",
  submission_id:"some-id",
};

test("saved owner VMS cash total is read from persisted machine metadata",()=>{
  const row={id:"last-removal",machine_links:[{expectation_metadata:{manual_vms_group_comparison:snapshot}}]};
  assert.deepEqual(savedOwnerVmsForCollection(row),snapshot);
});

test("never show another removal's XY cash amount as saved for this removal",()=>{
  assert.equal(savedOwnerVmsForCollection({id:"different-removal",machine_links:[{expectation_metadata:{manual_vms_group_comparison:snapshot}}]}),null);
  assert.equal(savedOwnerVmsForCollection({id:"last-removal",machine_links:[]}),null);
  assert.equal(savedOwnerVmsForCollection({id:"last-removal",machine_links:[{},{}]}),null);
  assert.equal(savedOwnerVmsForCollection({id:"last-removal",machine_links:[{expectation_metadata:{}}]}),null);
});

test("the owner-entered XY amount is visibly displayed in the comparison page after refresh",()=>{
  const compare=read("src/app/cash-collections/compare/page.tsx");
  assert.match(compare,/Saved XY VMS cash amount/);
  assert.match(compare,/XY saved:/);
  assert.match(compare,/status\.vms_cash_lyd/);
  assert.match(compare,/status\.difference_lyd/);
  assert.match(compare,/status\.saved_at/);
  assert.match(compare,/Persisted XY VMS cash amount/);
  assert.match(compare,/No owner-entered XY cash total is saved/);
});

test("the original cash-removal record displays saved amount and time window",()=>{
  const detail=read("src/app/cash-collections/[id]/page.tsx");
  assert.match(detail,/expectation_metadata/);
  assert.match(detail,/ownerVms = savedOwnerVmsForCollection/);
  assert.match(detail,/XY VMS cash amount saved/);
  assert.match(detail,/ownerVms\.vms_cash_lyd/);
  assert.match(detail,/ownerVms\.start_at/);
  assert.match(detail,/ownerVms\.saved_at/);
  assert.match(detail,/Open or update saved XY comparison/);
});

test("mobile, desktop, and action queue show owner-entered VMS separately from formal reconciliation",()=>{
  const list=read("src/app/cash-collections/page.tsx");
  const actionQueue=read("src/app/cash-collections/action-queue/page.tsx");
  assert.match(list,/XY cash entered/);
  assert.match(list,/ownerVms\.vms_cash_lyd/);
  assert.match(list,/formal reconciliation is separate/);
  assert.match(actionQueue,/XY cash entered/);
  assert.match(actionQueue,/ownerXY\.vms_cash_lyd/);
  assert.match(actionQueue,/Not formally verified/);
  assert.match(actionQueue,/owner report, not proven shortage/);
});

test("green save confirmation is issued only after a persistent database read-back",()=>{
  const action=read("src/lib/cash-vms-manual-actions.ts");
  assert.match(action,/const \{data:check,error:checkError\}/);
  assert.match(action,/readManualCashComparison\(check\?\.expectation_metadata\?\.manual_vms_group_comparison\)/);
  assert.match(action,/confirmed\.submission_id!==submissionId/);
  assert.match(action,/confirmed\.vms_cash_lyd!==saved\.vms_cash_lyd/);
  assert.ok(action.indexOf("const {data:check,error:checkError}")<action.indexOf("await logActivity"));
  assert.match(action,/XY save could not be verified/);
  assert.doesNotMatch(action,/confirm_cash_count_auto_period|reconcile_cash_collection|financial_transactions/);
});
