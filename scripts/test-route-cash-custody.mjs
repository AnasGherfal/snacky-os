import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
const root=process.cwd();
const read=p=>fs.readFileSync(path.join(root,p),"utf8");

test("cash collected at a machine is tied to the stop, route, operator and original timestamp",()=>{
 const api=read("src/app/api/operator/routes/[id]/stops/[stopId]/cash/route.ts");
 const panel=read("src/components/cash/RouteCashPanel.tsx");
 assert.match(api,/route_stop_cash_receipts/);
 assert.match(api,/operator_id: ctx\.profile\.team_member_id/);
 assert.match(api,/p_removed_at:/);
 assert.match(panel,/\.eq\("route_id",routeId\)/);
 assert.match(panel,/cash\.get\(receipt\.collection_id\)/);
 assert.match(panel,/collection\.collected_at/);
});

test("deposit is only an operator claim, requires matching bag number and independent receipt",()=>{
 const api=read("src/app/api/cash-handling/deposit/route.ts");
 const screen=read("src/components/cash/CashDepositWorkspace.tsx");
 assert.match(api,/box\.bag\?\.trim\(\)\.toUpperCase\(\)!==bag/);
 assert.match(api,/box\.actions\.includes\("dropoff"\)/);
 assert.match(api,/uploadCashEvidence\(photo/);
 assert.match(api,/snacky_cash_handover_receipt_v1/);
 assert.match(api,/snacky_cash_handover_command_v1/);
 assert.match(api,/independent_receipt:false/);
 assert.match(screen,/type="checkbox" required checked=\{confirmed\}/);
 assert.match(screen,/prepareCashPhoto\(photo\)/);
 assert.doesNotMatch(screen,/expected_cash_amount/);
});

test("owner must physically receive the bag before independently counting cash",()=>{
 const owner=read("src/components/cash/CashReceiveWorkspace.tsx");
 assert.match(owner,/actions\.includes\("pickup"\)/);
 assert.match(owner,/actions\.includes\("count"\)/);
 assert.match(owner,/bagId\.trim\(\)\.toUpperCase\(\)!==box\.bag/);
 assert.match(owner,/if\(!physical\)/);
 assert.match(owner,/cashReceiptMatches\(command,result\)/);
 assert.match(owner,/amount:amount\.trim\(\)/);
});

test("cash route physically closes only after verified count and independent custody",()=>{
 const db=read("supabase/migrations/20261102114500_cash_route_physical_closure.sql");
 const route=read("src/components/cash/RouteCashPanel.tsx");
 assert.match(db,/cash_route_closures/);
 assert.match(db,/h\.deposited_at is null or h\.picked_up_at is null/);
 assert.match(db,/h\.deposited_by=h\.picked_up_by/);
 assert.match(db,/c\.counted_by=c\.operator_id/);
 assert.match(db,/c\.storage_seal_condition/);
 assert.match(db,/v_exception_count>0 and length/);
 assert.match(db,/xy_reconciliation','separate_unverified_until_exact_cash_transactions/);
 assert.match(route,/snacky_close_route_cash_v1/);
 assert.match(route,/route-cash/);
});

test("an unsupported XY payment method and collection gap never becomes cash shortage",()=>{
 const db=read("supabase/migrations/20261102133000_cash_expectation_verified_baseline.sql");
 assert.match(db,/payment_method_unverified/);
 assert.match(db,/intervening_partial_cash_removal/);
 assert.match(db,/cash_compartments_unverified/);
 assert.match(db,/from_verified_refill/);
 assert.doesNotMatch(db,/v_expected := v_total_amount;/);
});

test("owner has a queue of missing and delayed custody events rather than assuming deposit",()=>{
 const audit=read("src/app/cash-collections/refills/page.tsx");
 assert.match(audit,/awaitingDeposit/);
 assert.match(audit,/awaitingReceipt/);
 assert.match(audit,/overdueCount/);
 assert.match(audit,/cash-handling\/receive/);
 assert.match(audit,/routes\/\$\{row.route_id\}/);
});

test("pre-pilot completed routes are not falsely shown as missing cash",()=>{
 const activation=read("supabase/migrations/20261102141500_cash_pilot_activation_time.sql");
 const scope=read("supabase/migrations/20261102143500_route_cash_close_activation_scope.sql");
 const owner=read("src/app/cash-collections/pilot/page.tsx");
 const route=read("src/components/cash/RouteCashPanel.tsx");
 assert.match(activation,/activated_at/);
 assert.match(scope,/s\.completed_at>=v_policy\.activated_at/);
 assert.match(owner,/activated_at: activatedAt/);
 assert.match(route,/activationMs/);
 assert.match(route,/pilotStop\(stop\)/);
});

test("the cash-bag detail links to its exact route and stop, with removal evidence",()=>{
 const detail=read("src/app/cash-collections/[id]/page.tsx");
 assert.match(detail,/route_stop_cash_receipts/);
 assert.match(detail,/eq\("collection_id",id\)/);
 assert.match(detail,/linkedStop\.route_stop_id/);
 assert.match(detail,/linkedStop\.route_id/);
 assert.match(detail,/Open sealed-bag photo/);
});
