import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const planner=fs.readFileSync("src/components/CashRemovalBoxPlanner.tsx","utf8");
const form=fs.readFileSync("src/components/CashRemovalForm.tsx","utf8");
const operatorPage=fs.readFileSync("src/app/cash-handling/page.tsx","utf8");
const actions=fs.readFileSync("src/lib/cash-actions.ts","utf8");
const workflow=fs.readFileSync("src/components/CashHandlingWorkspace.tsx","utf8");
const cashCount=fs.readFileSync("src/components/CashCustodyForms.tsx","utf8");
const sql=fs.readFileSync("supabase/migrations/20261011110000_sealed_cash_removal_without_machine_amounts.sql","utf8");

test("operator does not see or need a cash amount at removal",()=>{
  assert.match(operatorPage, /requiresAmounts=\{!isOperatorRole\(context\)\}/);
  assert.match(form, /<CashRemovalBoxPlanner[\s\S]*requiresAmounts=\{requiresAmounts\}/);
  assert.match(planner, /\{requiresAmounts \? <label[\s\S]*Amount removed · LYD/);
  assert.match(planner, /requiresAmounts \? row\.amountLyd\.trim\(\) : null/);
  assert.match(form, /Confirm cash box removed/);
  assert.match(planner, /No amount is entered now/);
  assert.match(planner, /Box \/ seal ID/);
  assert.match(planner, /Photo of sealed box/);
});

test("server rejects operator-declared cash amounts, keeps unknown as null",()=>{
  assert.match(actions, /const requiresAmounts = !isOperatorRole\(profileContext\(profile\)\)/);
  assert.match(actions, /if \(!requiresAmounts && amount\)/);
  assert.match(actions, /removed_amount_lyd: requiresAmounts \? Number\(amount\)\.toFixed\(2\) : null/);
  assert.match(actions, /const amountsRecorded = plan\.boxes\.every/);
  assert.match(actions, /declared_total_lyd: declaredTotal === null \? null/);
  assert.match(actions, /No amounts were entered; the sealed cash will be counted later/);
  assert.doesNotMatch(actions, /removed_amount_lyd: requiresAmounts \? Number\(amount\)\.toFixed\(2\) : 0/);
});

test("cash SQL stores NULL when nobody counted cash; idempotent retries compare amounts null-safely",()=>{
  assert.match(sql, /create or replace function snacky_private\.record_standalone_cash_removal_group_v1_impl/);
  assert.match(sql, /jsonb_typeof\(m\.value->'removed_amount_lyd'\) <> 'null'/);
  assert.match(sql, /cm\.removed_amount_lyd is not distinct from/);
  assert.match(sql, /round\(nullif\(m\.value->>'removed_amount_lyd',''\)::numeric,2\)/);
  assert.match(sql, /sum\(cm\.removed_amount_lyd\)::text/);
  assert.match(sql, /'declared_box_total_lyd',v_declared_total/);
  assert.match(sql, /cash_removal_receipt_machines/);
  assert.match(sql, /cash_collection_machines/);
  assert.match(sql, /receipt_machines/);
  assert.doesNotMatch(sql, /coalesce\(sum\(cm\.removed_amount_lyd\),0\)/);
  assert.match(sql, /replayed',true/);
});

test("later cash counter enters the real physical amount and XY reconciliation remains separate",()=>{
  assert.match(workflow, /This sealed cash box has no declared amount/);
  assert.match(workflow, /Total counted · LYD/);
  assert.match(workflow, /cash_location/);
  assert.match(cashCount, /actual amount counted from this cash box once/);
  assert.match(actions, /confirm_cash_count_auto_period_v1/);
  assert.match(actions, /calculate_cash_collection_expectation/);
});
