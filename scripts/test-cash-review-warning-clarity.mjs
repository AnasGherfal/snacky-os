import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (file) => readFileSync(file,"utf8");

test("Historical unsourced variance flags remain distinct from verified shortages",()=>{
 const custody=read("src/lib/cash-custody.ts");
 assert.match(custody,/unnumberedReferenceOnly/);
 assert.match(custody,/unsourcedLegacyReview/);
 assert.match(custody,/verifiedCashExpectation\(row\) === null/);
 assert.match(custody,/Cash counted — VMS\/source not verified/);
 assert.match(custody,/No missing-cash amount can be concluded/);
 assert.match(custody,/physicalSealException/);
 assert.match(custody,/Owner review required/);
 assert.match(custody,/severity: "critical"/);
});

test("Old bagless removal is flagged as archived ledger uncertainty, not an urgent missing cash bag",()=>{
 const custody=read("src/lib/cash-custody.ts");
 assert.match(custody,/unlinkedHistoricalRemoval/);
 assert.match(custody,/age >= 24 \* 30 && !row\.cash_bag_id/);
 assert.match(custody,/Historical removal — final count not linked/);
 assert.match(custody,/do not treat it as current physical cash/);
});

test("Cash Custody does not paint amber evidence warnings as red on mobile or desktop",()=>{
 const cash=read("src/app/cash-collections/page.tsx");
 assert.match(cash,/alerts\.some\(\(alert\) => alert\.severity === "critical"\) \? "text-rose-700" : "text-amber-800"/);
 assert.match(cash,/counted cash record/);
 assert.match(cash,/does NOT prove a shortage/);
 assert.match(cash,/Historical cash evidence review/);
 assert.match(cash,/Formal VMS review pending/);
 assert.match(cash,/needsCheckCount \? "text-amber-700"/);
});

test("Chat owner-reported physical amount displays as DRAFT and never posts Finance silently",()=>{
 const cash=read("src/app/cash-collections/page.tsx");
 const count=read("src/app/cash-collections/count/page.tsx");
 const receive=read("src/components/cash/CashReceiveWorkspace.tsx");
 assert.match(cash,/owner_reported_cash_count_pending_confirmation/);
 assert.match(cash,/Reported \{money\(reportedDraft\)\} · not posted to Finance/);
 assert.match(count,/reported_amount/);
 assert.match(count,/Confirm receipt and count this bag/);
 assert.match(receive,/params\.get\("reported_amount"\)/);
 assert.match(receive,/if\(!physical\)/);
 assert.match(receive,/\/api\/cash-handling/);
 assert.doesNotMatch(cash,/\.insert\(|\.update\(|\.delete\(/);
});

test("Owner action queue separates counted pending source from real verified variance",()=>{
 const queue=read("src/app/cash-collections/action-queue/page.tsx");
 assert.match(queue,/key:"source"/);
 assert.match(queue,/Counted cash · XY source\/bag evidence pending/);
 assert.match(queue,/key:"variance",label:"Owner variance decision"/);
 assert.match(queue,/buckets\.source/);
 assert.match(queue,/Already counted · source or bag-ID evidence still to verify/);
 assert.match(queue,/Do not count the same cash a second time/);
 assert.match(queue,/Verified variance or material custody exception/);
});
