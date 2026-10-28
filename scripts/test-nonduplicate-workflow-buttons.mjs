import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const source=(path)=>readFileSync(path,"utf8");

test("CRM rent schedules block fast double saves and repeated identical confirmed inputs",()=>{
  const s=source("src/components/CrmLocationPaymentScheduleForm.tsx");
  assert.match(s,/const inFlight=useRef\(false\)/);
  assert.match(s,/if\(inFlight\.current\)return/);
  assert.match(s,/inFlight\.current=true;setBusy\(true\)/);
  assert.match(s,/inFlight\.current=false;setBusy\(false\)/);
  assert.match(s,/lastConfirmedPayload\.current===signature/);
  assert.match(s,/lastConfirmedPayload\.current=signature/);
  assert.match(s,/aria-busy=\{busy\}/);
  assert.match(s,/disabled=\{busy\}/);
  assert.match(s,/snacky_location_payment_schedule_v1|location-payment-schedule/);
});

test("CRM existing obligations cannot replay the same confirmed update",()=>{
  const s=source("src/components/CrmObligationAdminForm.tsx");
  assert.match(s,/const inFlight=useRef\(false\)/);
  assert.match(s,/if\(inFlight\.current\)return/);
  assert.match(s,/inFlight\.current=true;setBusy\(true\)/);
  assert.match(s,/inFlight\.current=false;setBusy\(false\)/);
  assert.match(s,/lastConfirmedPayload\.current===signature/);
  assert.match(s,/version:props\.version/);
  assert.match(s,/aria-busy=\{busy\}/);
  const api=source("src/app/api/crm/obligation-admin/route.ts");
  assert.match(api,/p_version:version/);
  assert.match(api,/error\.code==='40001'/);
});

test("buyer store instructions lock during the existing durable command; save failure is not a success",()=>{
  const editor=source("src/components/BuyingSourceEditor.tsx");
  const parent=source("src/components/BuyingListClient.tsx");
  assert.match(editor,/const submitInFlightRef = useRef\(false\)/);
  assert.match(editor,/if \(submitInFlightRef\.current \|\| disabled \|\| !primary\) return/);
  assert.match(editor,/submitInFlightRef\.current = true/);
  assert.match(editor,/submitInFlightRef\.current = false/);
  assert.match(editor,/aria-busy=\{saving\}/);
  assert.match(editor,/disabled=\{disabled \|\| saving\}/);
  assert.match(editor,/disabled=\{disabled \|\| saving \|\| !primary\}/);
  assert.match(parent,/sessionStorage\.setItem\(key,JSON\.stringify\(command\)\)/);
  assert.match(parent,/buyingReceiptMatches\(command,result\)/);
  assert.doesNotMatch(editor,/setSaved\(true\)/);
});

test("new team user and role changes show a pending Save rather than accepting repeat taps",()=>{
  const team=source("src/components/TeamMemberForm.tsx");
  const pending=source("src/components/FormSubmitButton.tsx");
  assert.match(team,/<FormSubmitButton pendingLabel="Saving team member/);
  assert.match(team,/Still processing the first request/);
  assert.match(pending,/disabled=\{disabled \|\| pending \|\| optimisticPending\}/);
  assert.match(pending,/duplicateGuardRef\.current = true/);
});
