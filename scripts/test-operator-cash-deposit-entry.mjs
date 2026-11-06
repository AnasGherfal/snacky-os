import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = p => readFileSync(p, "utf8");

test("operator mobile tab opens sealed-bag deposit directly", () => {
  const source = read("src/lib/role-mobile-navigation.ts");
  assert.match(source, /href: "\/cash-handling\/deposit", en: "Deposit", ar: "إيداع الأكياس"/);
});

test("operator desktop sidebar and home have explicit deposit bag entry", () => {
  const sidebar = read("src/components/Sidebar.tsx");
  const home = read("src/app/operator/page.tsx");
  assert.match(sidebar, /href: "\/cash-handling\/deposit", icon: HandCoins/);
  assert.match(home, /href="\/cash-handling\/deposit"/);
});

test("unnumbered cash pickups use a server-generated electronic reference, not an invented physical number", () => {
  const screen = read("src/components/operator/RouteStopCashCard.tsx");
  const api = read("src/app/api/operator/routes/[id]/stops/[stopId]/cash/route.ts");
  const handover = read("src/lib/cash-handover.ts");
  assert.match(screen, /useState<"unnumbered" \| "printed">\("unnumbered"\)/);
  assert.match(screen, /form\.set\("bag_mode", bagMode\)/);
  assert.match(screen, /if \(bagMode === "printed"\) form\.set\("bag_id"/);
  assert.match(screen, /prepareCashPhoto\(photo\)/);
  assert.match(api, /systemUnnumberedCashReference\(requestId\)/);
  assert.match(api, /bagMode === "unnumbered" && enteredBagId/);
  assert.match(api, /p_client_submission_id: requestId/);
  assert.match(api, /unnumberedCashWarning/);
  assert.match(handover, /UNNUMBERED_/);
  assert.match(handover, /NOT a printed bag ID/);
});

test("operator deposits unnumbered bags by existing collection, photo and safe location, without retyping a fictitious seal", () => {
  const deposit = read("src/components/cash/CashDepositWorkspace.tsx");
  const api = read("src/app/api/cash-handling/deposit/route.ts");
  assert.match(deposit, /useState<"unnumbered"\|"printed">\("unnumbered"\)/);
  assert.match(deposit, /referenceMode==="printed"&&cleanNumber!==box\.bag/);
  assert.match(deposit, /bagId:box\.bag\.trim\(\)\.toUpperCase\(\)/);
  assert.match(deposit, /form\.set\("reference_mode"/);
  assert.match(deposit, /prepareCashPhoto\(photo\)/);
  assert.match(api, /box\.bag\?\.trim\(\)\.toUpperCase\(\)!==bag/);
  assert.match(api, /box\.actions\.includes\("dropoff"\)/);
  assert.match(api, /seal_condition: unnumbered \? "mismatch" : "intact"/);
  assert.match(api, /UNNUMBERED CASH BAG/);
  assert.match(api, /uploadCashEvidence\(photo/);
  assert.match(api, /snacky_cash_handover_receipt_v1/);
  assert.doesNotMatch(api, /\.from\("financial_transactions"\)/);
});

test("physical printed serials still require exact matching; owner handles unnumbered arrivals as exceptions", () => {
  const screen = read("src/components/operator/RouteStopCashCard.tsx");
  const owner = read("src/components/cash/CashReceiveWorkspace.tsx");
  assert.match(screen, /الرقم المطبوع على الكيس الأمني أو الختم/);
  assert.match(screen, /\/cash-handling\/deposit\?id=/);
  assert.match(owner, /!unnumbered && bagId\.trim\(\)\.toUpperCase\(\)!==box\.bag/);
  assert.match(owner, /confirm_bag_id:box\.bag\.trim\(\)/);
  assert.match(owner, /seal_condition:"mismatch"/);
  assert.match(owner, /cashReceiptMatches\(command,result\)/);
  assert.match(owner, /if\(!physical\)/);
});
