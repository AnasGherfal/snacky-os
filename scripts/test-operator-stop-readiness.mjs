import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getStopCompletionReadiness } from "../src/lib/operator-stop-readiness.ts";

const base = {
  cleaningDone: false,
  savedPhoto: false,
  selectedPhoto: false,
  photoSaving: false,
  smartReturnRequired: 0,
  smartReturnOutstanding: 0,
  smartXyRequired: 0,
  smartXyOutstanding: 0,
  compressorInstalled: false,
  compressorProofReady: false,
  submitting: false,
};

test("new stop shows only existing cleaning/photo checks; no extra XY screenshot step", () => {
  const result = getStopCompletionReadiness(base);
  assert.deepEqual(result.missing.map(x => x.kind), ["cleaning", "photo"]);
  assert.equal(result.remainingCount, 2);
  assert.equal(result.canComplete, false);
  assert.deepEqual(result.steps.map(x => x.anchor), ["cleaning-checklist", "refill-proof"]);
});

test("an existing or locally selected final photo permits existing completion upload path", () => {
  for (const flags of [{savedPhoto:true}, {selectedPhoto:true}]) {
    const result = getStopCompletionReadiness({...base,cleaningDone:true,...flags});
    assert.equal(result.canComplete, true);
    assert.equal(result.remainingCount, 0);
  }
  const saving = getStopCompletionReadiness({...base,cleaningDone:true,selectedPhoto:true,photoSaving:true});
  assert.equal(saving.canComplete,false);
  assert.equal(saving.next?.kind,"photo");
  assert.equal(saving.busy,true);
  assert.equal(getStopCompletionReadiness({...base,cleaningDone:true,savedPhoto:true,submitting:true}).canComplete,false);
});

test("Smart Route returns and queued/saved XY product changes follow existing completion rules",()=>{
  const ready = getStopCompletionReadiness({
    ...base, cleaningDone:true, savedPhoto:true,
    smartReturnRequired:2, smartReturnOutstanding:0,
    smartXyRequired:2, smartXyOutstanding:0,
  });
  assert.equal(ready.canComplete,true);
  assert.deepEqual(ready.steps.map(x=>x.kind),["cleaning","photo","smart-return","smart-xy"]);
  const blocked = getStopCompletionReadiness({
    ...base, cleaningDone:true, savedPhoto:true,
    smartReturnRequired:2, smartReturnOutstanding:1,
    smartXyRequired:2, smartXyOutstanding:1,
  });
  assert.equal(blocked.canComplete,false);
  assert.deepEqual(blocked.missing.map(x=>x.kind),["smart-return","smart-xy"]);
  assert.ok(blocked.missing.every(x=>x.anchor==="smart-route-changes"));
});

test("compressor proof is required only when machine configuration installs the safety check",()=>{
  const noCompressor = getStopCompletionReadiness({...base,cleaningDone:true,savedPhoto:true});
  assert.equal(noCompressor.canComplete,true);
  assert.ok(noCompressor.steps.every(s=>s.kind!=="compressor"));
  const installed = getStopCompletionReadiness({...base,cleaningDone:true,savedPhoto:true,compressorInstalled:true});
  assert.deepEqual(installed.missing.map(x=>x.kind),["compressor"]);
  assert.equal(installed.next?.anchor,"compressor-safety");
  assert.equal(getStopCompletionReadiness({
    ...base,cleaningDone:true,savedPhoto:true,compressorInstalled:true,compressorProofReady:true
  }).canComplete,true);
});

test("operator UI offers action links, accessible progress, and keeps quantity auto-save unchanged",()=>{
  const stop = readFileSync("src/app/operator/routes/[id]/stops/[stopId]/page.tsx","utf8");
  const card = readFileSync("src/components/operator/StopCompletionReadinessCard.tsx","utf8");
  assert.ok(stop.includes("const stopReadiness = getStopCompletionReadiness({"));
  assert.ok(stop.includes("const canSubmitStop = stopReadiness.canComplete;"));
  assert.ok(stop.includes("<StopCompletionReadinessCard"));
  assert.ok(stop.includes('id="refill-proof"'));
  assert.ok(stop.includes('id="cleaning-checklist"'));
  assert.ok(stop.includes('stopReadiness.next.kind === "cleaning"'));
  assert.ok(stop.includes("onClick={handleCompleteStop}"));
  assert.ok(stop.includes('mode: "sync_pending"'));
  assert.ok(stop.includes("const actualFilledLines = stopData.refillItems.map"));
  assert.ok(card.includes('aria-labelledby="stop-ready-title"'));
  assert.ok(card.includes('aria-live="polite"'));
  assert.ok(card.includes('href={`#${step.anchor}`}'));
  assert.ok(card.includes("selectedPhoto && !savedPhoto"));
  assert.ok(card.includes("صور XY اختيارية"));
  assert.ok(card.includes("onOpenCleaning"));
});

test("operator readiness contains no new network or inventory mutations",()=>{
  for(const file of ["src/lib/operator-stop-readiness.ts","src/components/operator/StopCompletionReadinessCard.tsx"]){
    const src=readFileSync(file,"utf8");
    assert.doesNotMatch(src,/\bfetch\(|\.rpc\(|\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
  }
});
