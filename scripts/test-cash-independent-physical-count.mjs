import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const read = path => readFileSync(path, "utf8");
const handling = read("src/components/CashHandlingWorkspace.tsx");
const countForm = read("src/components/CashCustodyForms.tsx");
const actions = read("src/lib/cash-actions.ts");
const detail = read("src/app/cash-collections/[id]/page.tsx");

test("cash handling never turns declared machine amounts into a physical count",()=>{
  assert.match(handling, /action === 'count' \? \{ amount: get\('amount'\), cash_location: get\('cash_location'\) \}/);
  assert.match(handling, /name="amount"[\s\S]*?required placeholder="0\.00"/);
  assert.match(handling, /I physically counted this box/);
  assert.match(handling, /Amounts recorded at removal · NOT counted/);
  assert.doesNotMatch(handling,/machineCountRows|machineCountTotal|machine_counts: JSON\.stringify/);
});
test("legacy cash count always asks for independently measured money, even when removal sums exist",()=>{
  assert.match(countForm, /Earlier removal declarations — NOT a physical count/);
  assert.match(countForm, /name="total_amount_lyd"/);
  assert.match(countForm, /Cash physically counted \(LYD\)/);
  assert.doesNotMatch(countForm,/name="use_recorded_machine_total"|No second cash amount is required|Confirm recorded cash total/);
  assert.match(detail,/Earlier per-machine removal declarations remain reference values, not a cash count/);
});
test("server action rejects forged or stale declared-total shortcut before it can post Finance money",()=>{
  const action=actions.slice(actions.indexOf("export async function confirmCashCollectionCount"),actions.indexOf("export async function calculateCashExpectation"));
  assert.match(action, /if \(formData\.has\("use_recorded_machine_total"\)\)/);
  assert.match(action, /const totalRaw = clean\(formData\.get\("total_amount_lyd"\)\)/);
  assert.match(action, /const totalAmount = optionalAmount\(formData\.get\("total_amount_lyd"\)\)/);
  assert.match(action, /if \(!totalRaw \|\| totalAmount === null \|\| totalAmount < 0\)/);
  assert.match(action, /amount_source: "independent_physical_count"/);
  assert.match(action, /confirm_cash_count_auto_period_v1/);
  assert.doesNotMatch(action,/rows\.reduce\([\s\S]*removed_amount_lyd|useRecordedMachineTotal|amount_source: "recorded_machine_amounts"/);
});
