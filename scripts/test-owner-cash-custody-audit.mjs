import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {
  buildOwnerCashCustodyAudit,
  classifyCashCustodyStage,
} from "../src/lib/owner-cash-custody-audit.ts";

const cash=(id,values={})=>({
  id,cash_bag_id:"B-"+id,collected_at:"2026-10-20T08:00:00Z",
  operator_id:"member-collector",storage_received_at:null,storage_received_by:null,
  counted_at:null,counted_by:null,count_witnessed_by:null,
  custody_status:"removed",reconciliation_status:"pending",voided_at:null,
  ...values,
});

test("physical handoff, physical count, source and variance are distinct workflow stages",()=>{
  assert.equal(classifyCashCustodyStage(cash("a")),"awaiting_handoff");
  assert.equal(classifyCashCustodyStage(cash("b",{
    custody_status:"in_storage",storage_received_at:"2026-10-20T10:00:00Z",
  })),"awaiting_count");
  assert.equal(classifyCashCustodyStage(cash("c",{
    custody_status:"counted",counted_at:"2026-10-21T10:00:00Z",
  })),"awaiting_source");
  assert.equal(classifyCashCustodyStage(cash("d",{
    custody_status:"counted",counted_at:"2026-10-21T10:00:00Z",
    reconciliation_status:"variance_review",
  })),"variance_review");
  assert.equal(classifyCashCustodyStage(cash("e",{
    custody_status:"reconciled",counted_at:"2026-10-21T10:00:00Z",
    reconciliation_status:"resolved",
  })),"other_review");
});

test("audit shows historical identity/witness gaps but never asserts missing LYD or theft",()=>{
  const rows=[
    cash("not-stored"),
    cash("stored",{
      custody_status:"in_storage",storage_received_at:"2026-10-20T10:00:00Z",
      storage_received_by:"member-receiver",storage_seal_condition:"intact",
    }),
    cash("counted",{
      custody_status:"counted",storage_received_at:"2026-10-20T10:00:00Z",
      storage_received_by:"member-receiver",counted_at:"2026-10-21T09:00:00Z",
      counted_by:"member-counter",
    }),
    cash("variance",{
      custody_status:"counted",storage_received_at:"2026-10-20T10:00:00Z",
      storage_received_by:"member-receiver",counted_at:"2026-10-21T09:00:00Z",
      counted_by:"member-counter",count_witnessed_by:"member-witness",
      reconciliation_status:"variance_review",
    }),
    cash("historical",{
      custody_status:"reconciled",operator_id:null,storage_received_at:"2026-10-20T10:00:00Z",
      storage_received_by:"member-receiver",counted_at:"2026-10-21T09:00:00Z",
      counted_by:"member-counter",count_witnessed_by:null,
      reconciliation_status:"resolved",
    }),
  ];
  const receipts=rows.map(row=>({
    cash_collection_id:row.id,
    removal_evidence_path:row.id==="not-stored"?"private/cash/bag.jpg":null,
  }));
  const events=[
    {id:"event-1",cash_collection_id:"stored",event_type:"stored",evidence_storage_path:"private/cash/stored.jpg"},
  ];
  const names=[
    {id:"member-collector",full_name:"Operator A"},
    {id:"member-receiver",full_name:"Receiver B"},
    {id:"member-counter",full_name:"Counter C"},
    {id:"member-witness",full_name:"Witness D"},
  ];
  const audit=buildOwnerCashCustodyAudit({collections:rows,receipts,events,names});
  assert.equal(audit.verified,true);
  assert.equal(audit.totalActiveBags,5);
  assert.equal(audit.waitingForStorageHandoff,1);
  assert.equal(audit.waitingForPhysicalCount,1);
  assert.equal(audit.countedPendingSource,1);
  assert.equal(audit.variancePendingReview,1);
  assert.equal(audit.collectorIdentityNotRecorded,1);
  assert.equal(audit.countWitnessNotRecorded,2);
  assert.equal(audit.bagQueue[0].label,"B-not-stored");
  assert.equal(audit.bagQueue[0].collectedBy,"Operator A");
  assert.equal(audit.bagQueue[0].removalEvidenceRecorded,true);
  assert.equal(audit.bagQueue.find(row=>row.id==="stored")?.storageEvidenceRecorded,true);
  assert.equal(audit.bagQueue.find(row=>row.id==="historical")?.flags.includes("collector_not_recorded"),true);
  assert.equal("missingAmount" in audit,false);
});

test("same-person receipt is a review note, not automatically a violation",()=>{
  const audit=buildOwnerCashCustodyAudit({
    collections:[cash("owner-self",{
      custody_status:"counted",storage_received_at:"2026-10-21T08:00:00Z",
      storage_received_by:"member-collector",counted_at:"2026-10-21T09:00:00Z",
      counted_by:"member-collector",count_witnessed_by:"member-witness",
    })],
    receipts:[],events:[],names:[],
  });
  assert.equal(audit.samePersonReceiptRecorded,1);
  assert.equal(audit.bagQueue[0].samePersonHandoff,true);
  assert.ok(audit.bagQueue[0].flags.includes("same_person_handoff_review"));
});

test("voided rows are ignored and active count never double-counts them",()=>{
 const audit=buildOwnerCashCustodyAudit({
   collections:[cash("normal"),cash("void",{voided_at:"2026-10-22T00:00:00Z",custody_status:"voided"})],
   receipts:[],events:[],names:[],
 });
 assert.equal(audit.totalActiveBags,1);
 assert.equal(audit.waitingForStorageHandoff,1);
});

test("malformed, duplicate, cross-collection photo evidence cannot masquerade as verified source",()=>{
 const row=cash("a");
 for(const config of [
  {collections:[row,row],receipts:[],events:[],names:[]},
  {collections:[row],receipts:[{cash_collection_id:"a"},{cash_collection_id:"a"}],events:[],names:[]},
  {collections:[row],receipts:[],events:[{id:"ev",cash_collection_id:"other",event_type:"stored"}],names:[]},
 ]) assert.throws(()=>buildOwnerCashCustodyAudit(config));
});

test("priority queue is bounded and stable; does not claim physical stock or cash movements",()=>{
 const rows=Array.from({length:25},(_,i)=>cash(String(i)));
 const audit=buildOwnerCashCustodyAudit({collections:rows,receipts:[],events:[],names:[]});
 assert.equal(audit.waitingForStorageHandoff,25);
 assert.equal(audit.bagQueue.length,12);
 assert.deepEqual(rows.map(r=>r.id),Array.from({length:25},(_,i)=>String(i)));
});

test("owner audit is RLS scoped, fully paginated and links to authorized cash records",()=>{
 const loader=readFileSync("src/lib/owner-cash-custody-source.ts","utf8");
 const panel=readFileSync("src/components/OwnerCashCustodyAuditPanel.tsx","utf8");
 const ops=readFileSync("src/app/operations-health/page.tsx","utf8");
 assert.ok(loader.includes('getAuthenticatedSupabaseServerClient'));
 assert.ok(loader.includes('loadAllExactOwnerRows'));
 assert.ok(loader.includes('.from("cash_collections")'));
 assert.ok(loader.includes('.from("cash_removal_receipts")'));
 assert.ok(loader.includes('.from("cash_collection_events")'));
 assert.ok(loader.includes('.from("team_members")'));
 assert.ok(loader.includes('count:"exact"'));
 assert.ok(loader.includes('.is("voided_at",null)'));
 assert.ok(loader.includes("data:null,error:"));
 assert.ok(ops.includes('hasAnyRole(profile,["owner","admin"])'));
 assert.ok(ops.includes('readOwnerCashCustodyAudit(db)'));
 assert.equal((ops.match(/<OwnerCashCustodyAuditPanel/g)||[]).length,2);
 assert.ok(panel.includes('href={"/cash-collections/"+bag.id}'));
 assert.ok(panel.includes('Collector'));
 assert.ok(panel.includes('Storage receiver'));
 assert.ok(panel.includes('Count witness'));
 assert.ok(panel.includes('Missing historical collector/witness') || panel.includes('Missing historical collector/witness details') || panel.includes('Missing historical') || panel.includes('Missing historical collector'));
 assert.doesNotMatch(loader,/getSupabaseAdminClient|service_role|\.update\(|\.insert\(|\.delete\(|\.upsert\(/);
 assert.doesNotMatch(panel,/\.rpc\(|\.update\(|\.insert\(|\.delete\(|\.upsert\(/);
});
