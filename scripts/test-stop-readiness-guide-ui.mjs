import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const page = fs.readFileSync("src/app/operator/routes/[id]/stops/[stopId]/page.tsx", "utf8");
const guide = fs.readFileSync("src/components/operator/StopReadinessGuide.tsx", "utf8");

test("readiness guide uses existing actual operator state without changing route writers", () => {
  assert.match(page, /<StopReadinessGuide/);
  for (const prop of [
    "filledUnits={stopExecutionSummary.filledUnits}",
    "assignedUnits={stopExecutionSummary.assignedUnits}",
    "cleaningDone={cleaningDone}",
    "compressorRequired={compressorSafetyInstalled}",
    "compressorReady={compressorProofReady}",
    "photoSaved={persistedMachinePhotoReady || Boolean(stopData.hasCompletionPhoto)}",
    "photoSaving={finalPhotoSaving}",
    "xyEvidenceStatus={quantityVerificationStatus}",
    "smartReturnsPending={unresolvedSmartReturnRequirements.length}",
    "smartXyPending={unresolvedSmartXyRequirements.length}",
  ]) assert(page.includes(prop), prop);
  assert.match(page, /const canSubmitStop = !submitting && !finalPhotoSaving && cleaningDone && compressorReadyForSubmit/);
  assert.match(page, /<button onClick=\{handleCompleteStop\} disabled=\{!canSubmitStop\}/);
  assert.match(page, /const handleCompleteStop = async/);
});

test("each readiness jump points to an existing section without removing canonical ids", () => {
  const targets = [
    "stop-refill","stop-xy-evidence","stop-compressor",
    "stop-proof-photo","stop-cleaning","smart-route-changes",
  ];
  for (const id of targets) {
    assert.match(guide, new RegExp(`#${id}`));
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /document\.getElementById\("smart-route-changes"\)/);
});

test("component cannot save, bypass checks or change inventory/XY/cash", () => {
  assert.doesNotMatch(guide, /fetch\(|\.rpc\(|supabase|\.insert\(|\.update\(|onClick=|setFilledQtys|setXySlotProduct/);
  assert.match(guide, /Informational guidance only/);
  assert.match(guide, /photoSaved \? "done" : "needed"/);
  assert.match(guide, /xyEvidenceStatus === "offline_pending" \? "needed"/);
  assert.match(guide, /smartReturnsPending > 0 \|\| smartXyPending > 0/);
  assert.match(guide, /compressorRequired \? compressorReady \? "done" : "needed" : "optional"/);
  assert.match(guide, /aria-labelledby="stop-readiness-title"/);
});

test("disabled Complete Stop has actionable feedback; original validation remains", () => {
  assert.match(page, /Finish the cleaning checklist to enable Complete Stop/);
  assert.match(page, /Save the compressor proof to enable Complete Stop/);
  assert.match(page, /href=\{!cleaningDone \? "#stop-cleaning" : "#stop-compressor"\}/);
  assert.match(page, /Please take or upload the final machine photo before completing the stop/);
  assert.match(page, /Update and verify every executed Smart Route product change in XY/);
  assert.match(page, /Record every required old-product return/);
  assert.match(page, /uploadRefillProofPhoto/);
});

test("mobile and Arabic interface guidance is explicit", () => {
  assert.match(guide, /"إنهاء الموقع خطوة بخطوة"/);
  assert.match(guide, /"كمية"/);
  assert.match(guide, /"مطلوبة"/);
  assert.match(guide, /"تم التحقق"/);
  assert.match(guide, /className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3"/);
});
