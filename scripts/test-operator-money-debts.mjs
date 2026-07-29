import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const read=p=>fs.readFileSync(path.join(root,p),"utf8");
const migration=read("supabase/migrations/202607290003_operator_money_debts_ledger.sql");
const api=read("src/app/api/operator-money/route.ts");
const ui=read("src/app/operator-money/OperatorMoneyLedgerClient.tsx");
const operatorRoutes=read("src/app/operator/routes/page.tsx");
const personProfile=read("src/app/team/[id]/page.tsx");
const moduleTabs=read("src/components/module-tabs-config.ts");
const activity=read("src/app/reports/route-product-activity/page.tsx");

test("personal purchases create debt and dedicated inventory deductions",()=>{
 assert.match(migration,/operator_personal_purchases/); assert.match(migration,/operator_personal_purchase/);
 assert.match(migration,/current_selling_price_lyd/); assert.match(migration,/total_lyd numeric.*generated always/is);
 assert.match(migration,/Not enough genuinely available storage stock after route reservations/);
 assert.doesNotMatch(migration,/insert into public\.(finance_transactions|transactions|cash_collections|route_manual_sales)/i);
});
test("reserved stock is protected",()=>{assert.match(migration,/operator_money_reserved_qty/);assert.match(migration,/route_stop_items/);assert.match(migration,/planned_quantity/);});
test("debt supports partial payments and immutable audit history",()=>{assert.match(migration,/operator_debt_payments/);assert.match(migration,/Payment exceeds remaining debt/);assert.match(migration,/No direct insert\/update\/delete policies/);});
test("advances expenses approvals and returns remain separate",()=>{assert.match(migration,/operator_advances/);assert.match(migration,/operator_expenses/);assert.match(migration,/status in\('submitted','approved','rejected'\)/);assert.match(migration,/operator_advance_returns/);assert.match(migration,/unaccounted_advance_lyd/);});
test("permissions prevent self approval and cross-operator writes",()=>{assert.match(migration,/Only owner\/admin can review expenses/);assert.match(migration,/Operators can only buy for themselves/);assert.match(migration,/Operators can only submit their own expense/);assert.match(api,/manager \? requestedPersonId/);});
test("idempotency protects all submissions",()=>{for(const table of ["operator_personal_purchases","operator_debt_payments","operator_advances","operator_expenses","operator_advance_returns"])assert.match(migration,new RegExp(`${table}[\\s\\S]*client_submission_id text not null unique`));});
test("profile keeps personal purchases distinct from work expenses",()=>{assert.match(ui,/Personal purchase from storage/);assert.match(ui,/adds the total to this person's debt/);assert.match(ui,/Record work expense/);assert.match(ui,/Personal debt/);assert.match(ui,/Must account for/);});
test("each operator has one shared person profile",()=>{assert.match(personProfile,/viewingSelf/);assert.match(personProfile,/OperatorMoneyLedgerClient initialPersonId=\{id\} lockPerson/);assert.match(personProfile,/Money, debt, purchases, and expenses/);assert.match(operatorRoutes,/My profile/);assert.doesNotMatch(operatorRoutes,/OperatorMoneyLedgerClient|money-debts|Money & Debts/);assert.doesNotMatch(moduleTabs,/Operator Money & Debts|\/operator-money/);assert.match(api,/revalidatePath\(`\/team\/\$\{personId\}`\)/);});
test("manual sale totals remain sourced only from persisted manual sales",()=>{assert.match(activity,/from\("route_manual_sales"\)/);assert.doesNotMatch(api,/route_manual_sales|manual sale|cash collection/i);});
