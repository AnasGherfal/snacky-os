import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {classifyMachineOperatingExpense,summarizeDirectMachineExpenses} from "../src/lib/machine-direct-operating-costs.ts";

const page=readFileSync("src/app/finance/growth-decisions/page.tsx","utf8");
const base={direction:"money_out",transaction_date:"2026-09-18",currency:"LYD",amount:50,
  final_bucket:"Maintenance",related_machine_id:"machine-a"};
test("only direct, dated LYD service costs get machine attribution",()=>{
 assert.equal(classifyMachineOperatingExpense(base),"machine_direct");
 assert.equal(classifyMachineOperatingExpense({...base,related_route_id:"route-1"}),"route_unallocated");
 assert.equal(classifyMachineOperatingExpense({...base,related_machine_id:null}),"unverified");
 assert.equal(classifyMachineOperatingExpense({...base,currency:"USD"}),"unverified");
 assert.equal(classifyMachineOperatingExpense({...base,amount:null}),"unverified");
});
test("exclude purchases, rent, salaries, transfers and revenue from service cost totals",()=>{
 for(const category of ["Rent","Product Restocking","Inventory Purchase","Salary","Owner Transfer","Revenue"]){
  assert.equal(classifyMachineOperatingExpense({...base,final_bucket:category}),"not_operating_cost");
 }
 assert.equal(classifyMachineOperatingExpense({...base,direction:"money_in"}),"not_operating_cost");
 assert.equal(classifyMachineOperatingExpense({...base,voided_at:"2026-10-01"}),"not_operating_cost");
});
test("direct expenses summarize only requested month; shared route cost stays unallocated",()=>{
 const data=summarizeDirectMachineExpenses([
  base,{...base,amount:20},{...base,related_route_id:"route-1",amount:35},
  {...base,amount:100,transaction_date:"2026-08-01"},
 ],"2026-09-01","2026-09-30");
 assert.equal(data.machineAmounts.get("machine-a"),70);
 assert.equal(data.unallocatedRouteAmount,35);
 assert.equal(data.unallocatedRouteCount,1);
});
test("existing growth page shows attribution separately, never guesses route allocation",()=>{
 assert.ok(page.includes("summarizeDirectMachineExpenses(ledgerRows, latestStart, latestEnd)"));
 assert.ok(page.includes("directRecordedServiceCost"));
 assert.ok(page.includes("Unallocated route operating expenses"));
 assert.ok(page.includes("product purchases are not deducted again"));
 assert.ok(page.includes("Unrecorded or unattributed costs are unknown"));
 assert.ok(page.includes('href="/finance/expenses"'));
});
