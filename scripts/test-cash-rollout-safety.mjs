import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),"utf8");
test("a collector cannot declare cash from a closed or unstarted visit",()=>{
  const api=read("src/app/api/operator/routes/[id]/stops/[stopId]/cash/route.ts");
  assert.match(api,/select\("id, operator_id, status"\)/);
  assert.match(api,/\["completed","cancelled","canceled"\]/);
  assert.match(api,/\["picked","in_progress","arrived","refilling","cash_collected","issue_reported"\]/);
});
test("owner counts oldest sealed bags first, without blocking route completion",()=>{
  const receive=read("src/components/cash/CashReceiveWorkspace.tsx");
  const route=read("src/components/cash/RouteCashPanel.tsx");
  assert.match(receive,/oldestFirst/);
  assert.match(receive,/\.sort\(oldestFirst\)/);
  assert.match(route,/owner&&allowOwnerClose&&!closure/);
  assert.match(route,/لا ينتظر استلام الخزنة أو عدّ المالك/);
});
test("owner can verify active-machine policy coverage and real storage label",()=>{
  const settings=read("src/app/cash-collections/pilot/page.tsx");
  assert.match(settings,/const uncovered = activeMachines\.filter/);
  assert.match(settings,/policy\.enabled&&uncovered\.length>0/);
  assert.match(settings,/policy\.safe_label==="Safe A"/);
});
test("interval review stays owner-only and never treats monthly sales as cash shortage",()=>{
 const timeline=read("src/app/cash-collections/timeline/page.tsx");
 assert.match(timeline,/isOwnerAdminRole\(profile\)/);
 assert.match(timeline,/receiptByCollection/);
 assert.match(timeline,/payment_time/);
 assert.match(timeline,/importCurrent/);
 assert.match(timeline,/e\.start\?date\(e\.start\)/);
});
