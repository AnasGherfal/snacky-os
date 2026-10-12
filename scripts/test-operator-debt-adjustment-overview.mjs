import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { summarizeAdjustedPurchases, debtAdjustmentHistory } from '../src/lib/operator-debt-adjustment-overview.ts';

const team = [{ id:'person-a', full_name:'Example operator', role:'operator', active:true }];
const purchase = (id, date, charged, paid=0) => ({ id, person_id:'person-a', purchased_at:date,
  quantity:1, total_lyd:charged, paid_amount_lyd:paid, remaining_amount_lyd:charged-paid });
const adjustment = (id, kind, amount, date='2026-09-30') => ({ id, person_id:'person-a', kind,
  amount_lyd:amount, effective_date:date, note:'Audited historical balance entry' });

test('settled September and historical balance do not change October purchases or physical units', () => {
  const purchases = [purchase('aug','2026-08-31T10:00:00Z',100),
    purchase('sep','2026-09-30T10:00:00Z',240,240),purchase('oct','2026-10-04T10:00:00Z',80)];
  const original = structuredClone(purchases);
  const adjustments = [adjustment('opening','opening_balance',200),adjustment('waiver','waiver',-50)];
  const [result] = summarizeAdjustedPurchases(purchases,team,adjustments,'2026-10');
  assert.equal(result.earlierOutstanding,250);
  assert.equal(result.currentMonthOutstanding,80);
  assert.equal(result.outstanding,330);
  assert.equal(result.paid,240);
  assert.equal(result.charged,420);
  assert.equal(result.units,3);
  assert.equal(result.records,3);
  assert.deepEqual(purchases,original);
});

test('historical balance portion of later repayment is paid once and reduces the old period only', () => {
  const purchases=[purchase('aug','2026-08-31T10:00:00Z',100,100),purchase('oct','2026-10-04T10:00:00Z',80)];
  const adjustments=[adjustment('opening','opening_balance',200),adjustment('waiver','waiver',-50),
    adjustment('repayment','repayment',-150,'2026-08-31')];
  const [result]=summarizeAdjustedPurchases(purchases,team,adjustments,'2026-10');
  assert.equal(result.outstanding,80);
  assert.equal(result.earlierOutstanding,0);
  assert.equal(result.currentMonthOutstanding,80);
  assert.equal(result.paid,250);
});

test('waiver is not a cash payment and can precede its opening entry in query order', () => {
  const purchases=[purchase('aug','2026-08-31T10:00:00Z',100)];
  const [result]=summarizeAdjustedPurchases(purchases,team,
    [adjustment('waiver','waiver',-50),adjustment('opening','opening_balance',200)],'2026-10');
  assert.equal(result.paid,0);
  assert.equal(result.outstanding,250);
});

test('other operators remain unchanged and malformed adjustments fail closed', () => {
  const purchases=[purchase('aug','2026-08-31T10:00:00Z',100)];
  const members=[...team,{id:'person-b',full_name:'Other operator',role:'operator',active:true}];
  const results=summarizeAdjustedPurchases(purchases,members,[adjustment('open','opening_balance',20)],'2026-10');
  assert.equal(results.find(row=>row.personId==='person-b').outstanding,0);
  assert.throws(()=>debtAdjustmentHistory(adjustment('bad','waiver',25)),/sign/);
  assert.throws(()=>summarizeAdjustedPurchases(purchases,team,[adjustment('waive','waiver',-200)],'2026-10'),/exceed/);
  const a=adjustment('same','opening_balance',20);
  assert.throws(()=>summarizeAdjustedPurchases(purchases,team,[a,a],'2026-10'),/Duplicate/);
});

test('adjustment data and display are scoped and separate from purchase evidence',()=>{
 const api=fs.readFileSync('src/app/api/operator-money/overview/route.ts','utf8');
 const ui=fs.readFileSync('src/app/operator-money/OperatorMoneyWorkspace.tsx','utf8');
 assert.match(api,/summarizeAdjustedPurchases/);
 assert.match(api,/operator_personal_debt_adjustments/);
 assert.match(api,/adjustments\.filter\(row => text\(row\.person_id\) === personId\)/);
 assert.match(ui,/Historical balance adjustments — not stock purchases/);
 assert.match(ui,/تسويات الرصيد السابق/);
 assert.doesNotMatch(api,/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
});
