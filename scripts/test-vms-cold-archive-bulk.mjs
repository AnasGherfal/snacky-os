import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  PREVIOUSLY_VERIFIED, REMAINING, PROJECT_REF, bundleApproval,
  validateInspection, parseBulkArgs, runBulk, runSingle
} from "./vms-cold-archive-bulk.mjs";

const hash = x => createHash("sha256").update(x).digest("hex");
const inspected = b => ({ ok: true, mode: "inspect", batchId: b.id,
  rows: b.expectedRows, bytes: b.expectedRows * 1200,
  chunkCount: Math.ceil(b.expectedRows / 250),
  approvalSha256: hash(b.id), originalsDeleted: 0,
  sourceRowsRetained: true });
const copy = b => ({ ok: true, mode: "copy_only", batchId: b.id,
  rows: b.expectedRows, bytes: b.expectedRows * 1200,
  approvalSha256: hash(b.id), archiveVerified: true,
  originalsDeleted: 0, sourceRowsRetained: true });
const verify = b => ({ ok: true, batchId: b.id, rowCount: b.expectedRows,
  totalBytes: b.expectedRows * 1200, manifestSha256: hash(b.id),
  archiveVerified: true, sourceRowsRetained: true });

test("fixed production reviewed batch list excludes active/draft/failed and the already archived canary", () => {
  assert.equal(PROJECT_REF, "thrthmeyhuhxnmizjhqx");
  assert.equal(PREVIOUSLY_VERIFIED.expectedRows, 183);
  assert.equal(REMAINING.length, 7);
  assert.equal(new Set(REMAINING.map(b => b.id)).size, 7);
  assert.ok(!REMAINING.some(b => b.id === PREVIOUSLY_VERIFIED.id));
  assert.equal(REMAINING.reduce((n,b) => n+b.expectedRows,0),15951);
});

test("bulk arguments require a precise copy approval and never allow deletion flags", () => {
  assert.deepEqual(parseBulkArgs(["--mode","inspect"]),{mode:"inspect",approval:""});
  assert.deepEqual(parseBulkArgs(["--mode","verify"]),{mode:"verify",approval:""});
  assert.throws(()=>parseBulkArgs(["--mode","copy"]),/invalid_approval/);
  assert.throws(()=>parseBulkArgs(["--mode","copy","--approve-sha256","not-a-sha"]),/invalid_approval/);
  assert.throws(()=>parseBulkArgs(["--mode","delete"]),/invalid_mode/);
  assert.throws(()=>parseBulkArgs(["--mode","copy","--purge","true"]),/invalid_arguments/);
});

test("inspect checks every fixed batch without R2 and prints one deterministic bundle approval", async () => {
  const calls=[],out=[];
  const res=await runBulk({mode:"inspect",approval:""},{
    runSingle:async (b,mode) => {calls.push([b.id,mode]);return inspected(b);},
    output:x=>out.push(x)
  });
  assert.equal(res.rowCount,15951);
  assert.equal(res.batches,7);
  assert.match(res.bundleApprovalSha256,/^[a-f0-9]{64}$/);
  assert.equal(res.originalsDeleted,0);
  assert.ok(calls.every(x=>x[1]==="inspect"));
  assert.deepEqual(out,[res]);
  const rows=REMAINING.map(b=>validateInspection(b,inspected(b)));
  assert.equal(bundleApproval(rows),res.bundleApprovalSha256);
});

test("copy rejects mismatched bundle before calling a single R2 write", async () => {
  const calls=[];
  await assert.rejects(runBulk({mode:"copy",approval:hash("wrong")},{
    runSingle:async(b,mode)=>{calls.push(mode);return inspected(b);},
    output:()=>{}
  }),/bundle_approval_mismatch/);
  assert.equal(calls.length,7);
  assert.ok(calls.every(m=>m==="inspect"));
});

test("copy uses each inspected batch's exact SHA and verifies each copy, source retained", async () => {
  const calls=[],out=[];
  const basis=REMAINING.map(b=>validateInspection(b,inspected(b)));
  const approval=bundleApproval(basis);
  const result=await runBulk({mode:"copy",approval},{
    runSingle:async(b,mode,sha)=>{
      calls.push([b.id,mode,sha]);
      return mode==="inspect"?inspected(b):copy(REMAINING.find(x=>x.id===b.id));
    },
    output:x=>out.push(x)
  });
  assert.equal(result.rowsCopied,15951);
  assert.equal(result.batchesCopied,7);
  assert.equal(result.archiveVerified,true);
  assert.equal(result.originalsDeleted,0);
  assert.equal(calls.length,14);
  assert.ok(calls.slice(0,7).every(x=>x[1]==="inspect"));
  assert.ok(calls.slice(7).every(x=>x[1]==="copy" && x[2]===hash(x[0])));
  assert.equal(out.length,9); // inspection receipt, 7 per-batch receipts, final receipt
});

test("copy fails closed if a single source row count changed and does not call R2", async () => {
  const calls=[];
  await assert.rejects(runBulk({mode:"copy",approval:hash("anything")},{
    runSingle:async(b,mode)=>{
      calls.push(mode);
      return b.id===REMAINING[1].id?{...inspected(b),rows:9999}:inspected(b);
    },
    output:()=>{}
  }),/inspection_row_count_or_size_changed/);
  assert.ok(calls.every(m=>m==="inspect"));
  assert.equal(calls.length,2);
});

test("independent verify checks the already archived 183 rows plus all seven batches", async () => {
  const calls=[],out=[];
  const r=await runBulk({mode:"verify",approval:""},{
    runSingle:async(b,mode)=>{calls.push([b.id,mode]);return verify(b);},
    output:x=>out.push(x)
  });
  assert.equal(r.batchesVerified,8);
  assert.equal(r.totalRowsVerified,16134);
  assert.equal(r.archiveVerified,undefined);
  assert.equal(r.originalsDeleted,0);
  assert.ok(calls.every(x=>x[1]==="verify"));
  assert.equal(calls[0][0],PREVIOUSLY_VERIFIED.id);
  assert.equal(out.length,9);
});

test("bad archive receipt fails verification rather than counting success", async () => {
  await assert.rejects(runBulk({mode:"verify",approval:""},{
    runSingle:async(b)=>b.id===REMAINING[3].id?{...verify(b),archiveVerified:false}:verify(b),
    output:()=>{}
  }),/verification_failed_for_batch_/);
});

test("existing single-batch runner still requires exact per-batch hash", () => {
  const calls=[];
  const fakeSpawn=(command,argv,opts)=>{
    calls.push({command,argv});
    return {status:0,stdout:JSON.stringify(inspected(REMAINING[0]))+"\n"};
  };
  assert.equal(runSingle(REMAINING[0],"inspect","",fakeSpawn).rows,249);
  assert.ok(calls[0].argv.includes("vms-cold-archive.mjs")===false);
  assert.ok(calls[0].argv.some(x=>String(x).endsWith("vms-cold-archive.mjs")));
  assert.throws(()=>runSingle(REMAINING[0],"copy","not-a-sha",fakeSpawn),/invalid_child_approval/);
});

test("bulk scripts and owner-only manual workflow contain no destructive data operation", () => {
  const script=fs.readFileSync("scripts/vms-cold-archive-bulk.mjs","utf8");
  const single=fs.readFileSync("scripts/vms-cold-archive.mjs","utf8");
  const workflow=fs.readFileSync(".github/workflows/vms-cold-archive-bulk-manual.yml","utf8");
  for(const file of [script,single,workflow]) {
    assert.doesNotMatch(file,/\bDELETE\s+FROM\b|\bTRUNCATE\b\s+TABLE\b|\.delete\s*\(|\.remove\s*\(/i);
  }
  assert.match(workflow,/^\s+environment: Production$/m);
  assert.match(workflow,/github\.actor == 'AnasGherfal'/);
  assert.match(workflow,/workflow_dispatch:/);
  assert.doesNotMatch(workflow,/^\s*(push|pull_request|schedule):/m);
  assert.match(workflow,/COPY ONLY - RETAIN SOURCE/);
  assert.match(workflow,/SNACKY_R2_SECRET_ACCESS_KEY/);
});
