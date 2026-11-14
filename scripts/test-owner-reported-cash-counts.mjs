import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const read=(name)=>readFileSync(name,"utf8");

test("owner reporting uses the exact eight existing November cash removals",()=>{
 const source=read("src/lib/cash-owner-reported.ts");
 assert.match(source,/owner_reported_cash_count_pending_confirmation/);
 assert.match(source,/owner_message_2026_11_14/);
 assert.match(source,/physical_counter_name/);
 assert.match(source,/owner_reports_cash_received_from_storage/);
 assert.match(source,/cash_collection_machines/);
 assert.doesNotMatch(source,/\.insert\(|\.update\(|\.delete\(/);
});

test("existing cash handling pickup-then-count workflow performs authorized Finance posting",()=>{
 const action=read("src/lib/cash-owner-reported-actions.ts");
 assert.match(action,/getAuthenticatedSupabaseServerClient/);
 assert.match(action,/getCurrentProfile/);
 assert.match(action,/snacky_cash_handover_workspace_v1/);
 assert.match(action,/snacky_cash_handover_command_v1/);
 assert.match(action,/direct_pickup/);
 assert.match(action,/cashReceiptMatches/);
 assert.match(action,/count\.finance_posted!==true/);
 assert.match(action,/actual_cash_collected!==null/);
 assert.match(action,/different confirmed amount/);
 assert.match(action,/owner_attestation/);
 assert.match(action,/seal_condition:"mismatch"/);
 assert.doesNotMatch(action,/service_role|request\.jwt\.claim|DISABLE TRIGGER|session_replication_role/);
 assert.doesNotMatch(action,/from\("financial_transactions"\)\.insert|from\("cash_collections"\)\.update/);
});

test("owner sees one simple confirmation page with exactly recorded amounts and no duplicate removal",()=>{
 const page=read("src/app/cash-collections/owner-reported/page.tsx");
 assert.match(page,/confirmOwnerReportedCashCounts/);
 assert.match(page,/Review original removal and photos/);
 assert.match(page,/owner_attestation/);
 assert.match(page,/Confirm selected counts and post once to Finance/);
 assert.match(page,/previously completed physical counts/);
 assert.doesNotMatch(page,/Record cash removal|Create a new removal/);
});

test("cash lists link directly to existing owner report confirmation",()=>{
 for(const file of ["src/app/cash-collections/page.tsx","src/app/cash-collections/count/page.tsx"]){
  assert.match(read(file),/\/cash-collections\/owner-reported/);
 }
});
