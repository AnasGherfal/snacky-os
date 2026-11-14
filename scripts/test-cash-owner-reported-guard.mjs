import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const page = read("src/app/cash-collections/count/page.tsx");
const detail = read("src/app/cash-collections/[id]/page.tsx");
const receive = read("src/components/cash/CashReceiveWorkspace.tsx");
const alerts = read("src/lib/cash-custody.ts");

test("owner-reported counts are visibly provisional until a separate authenticated physical confirmation", () => {
  assert.match(page, /owner_reported_cash_count_pending_confirmation/);
  assert.match(page, /This figure is saved as a draft reference only/);
  assert.match(page, /not yet been posted as a counted Finance transaction/);
  assert.match(page, /reported_amount/);
  assert.match(page, /confirmCashCollectionCount/);
});

test("enrolled unnumbered bags are routed through the protected pickup and count, never the blocked direct form", () => {
  assert.match(page, /isUnnumberedEnrolledBag \? \(/);
  assert.match(page, /cash-handling\/receive\?id/);
  assert.match(detail, /Use the protected Cash Handling receipt-and-count workflow/);
  assert.match(receive, /params\.get\("reported_amount"\)/);
  assert.match(receive, /if\(wasCounted\) \{/);
  assert.match(receive, /setSelected\(box\.id\);setPhysical\(false\)/);
  assert.match(receive, /I compared the actual bag with machine/);
  assert.match(receive, /if\(!physical\)/);
});

test("owner review for counted unnumbered bags is described as identity evidence, not a certified cash shortage", () => {
  assert.match(alerts, /unnumberedReferenceOnly/);
  assert.match(alerts, /verifiedCashExpectation\(row\) === null/);
  assert.match(alerts, /row\.storage_seal_condition !== "broken"/);
  assert.match(alerts, /Cash counted — unnumbered bag needs evidence review/);
  assert.match(alerts, /Owner review required/);
  assert.match(detail, /this flag alone does not prove missing cash/);
});
