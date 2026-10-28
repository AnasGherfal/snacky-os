import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const button=readFileSync("src/components/FormSubmitButton.tsx","utf8");
const draft=readFileSync("src/components/LocalDraft.tsx","utf8");

test("slow server actions never re-enable Save while the first write is unresolved",()=>{
  assert.match(button,/const activePending = pending \|\| optimisticPending/);
  assert.match(button,/disabled=\{disabled \|\| pending \|\| optimisticPending\}/);
  assert.match(button,/if \(disabled \|\| pending \|\| optimisticPending\)/);
  assert.match(button,/if \(duplicateGuardRef\.current\)/);
  assert.match(button,/setTimedOut\(true\)/);
  assert.match(button,/Still saving\. Do not submit again/);
  const timeout=button.slice(button.indexOf("}, timeoutMs)")-220,button.indexOf("}, timeoutMs)")+13);
  assert.doesNotMatch(timeout,/duplicateGuardRef\.current = false/);
  assert.doesNotMatch(timeout,/setOptimisticPending\(false\)/);
});

test("draft forms lock synchronously for Save, Apply and Add server actions",()=>{
  const block=draft.slice(draft.indexOf("export function LocalDraftForm("));
  assert.match(block,/const submissionInFlightRef = useRef\(false\)/);
  assert.match(block,/if \(submissionInFlightRef\.current\) return/);
  assert.match(block,/submissionInFlightRef\.current = true/);
  assert.match(block,/submissionInFlightRef\.current = false/);
  assert.match(block,/onSubmitCapture=\{handleSubmitCapture\}/);
  assert.match(block,/event\.preventDefault\(\)/);
  assert.match(block,/aria-busy=\{submitting\}/);
  assert.match(block,/<fieldset disabled=\{submitting\}/);
  assert.match(block,/role="status"/);
  assert.match(block,/await action\(formData\)/);
  assert.match(block,/draft\.saveNow\(nextSnapshot\)/);
});

test("critical purchase and CRM forms preserve their own submission IDs and locking",()=>{
  const purchase=readFileSync("src/components/PurchaseForm.tsx","utf8");
  const crm=readFileSync("src/components/CrmForm.tsx","utf8");
  assert.match(purchase,/if \(submittingRef\.current\) return/);
  assert.match(purchase,/if \(supplierSaveInFlightRef\.current\) return/);
  assert.match(purchase,/supplierSaveInFlightRef\.current = true/);
  assert.match(purchase,/supplierSaveInFlightRef\.current = false/);
  assert.match(purchase,/formData\.set\("client_submission_id", clientSubmissionId\)/);
  assert.match(crm,/if \(lock\.current \|\| !ready \|\| blocked \|\| done \|\| stale \|\| duplicateBlocked\) return/);
  assert.match(crm,/Retry this same request to avoid duplicates/);
});
