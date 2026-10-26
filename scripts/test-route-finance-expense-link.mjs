import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const route=readFileSync("src/app/routes/[id]/page.tsx","utf8");
const form=readFileSync("src/app/finance/transactions/new/page.tsx","utf8");
const action=readFileSync("src/lib/finance-actions.ts","utf8");

test("only owner/admin sees finance expense shortcut on completed routes",()=>{
 assert.ok(route.includes('isOwnerAdminRole(profile) && routeRow.status === "completed"'));
 assert.ok(route.includes('href={`/finance/transactions/new?route=${id}`}'));
 assert.ok(route.includes('Record route expense'));
});

test("route link is a validated selector in existing authorized finance form",()=>{
 assert.ok(form.includes("canEditFinancialTransactions"));
 assert.ok(form.includes('selectedRouteId = /^[0-9a-f]'));
 assert.ok(form.includes("routeInList"));
 assert.ok(form.includes("prefilledRouteId"));
 assert.ok(form.includes('defaultValue={prefilledRouteId}'));
 assert.ok(form.includes("Recording an actual expense for the selected route"));
 assert.ok(form.includes("do not estimate fuel, split shared costs by stop"));
});

test("saved route expense uses the existing authenticated finance RPC and preserves link",()=>{
 assert.ok(action.includes('p_related_route_id: optionalUuid(formData.get("related_route_id"))'));
 assert.ok(action.includes('supabase.rpc("snacky_create_manual_finance_transaction_v1"'));
 assert.ok(action.includes("requireFinanceEdit(profile)"));
 assert.doesNotMatch(route,/\.from\("financial_transactions"\)\.insert\(/);
});
