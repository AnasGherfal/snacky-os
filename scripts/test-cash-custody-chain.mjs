import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { calculateDenominationTotal, combinedCashPosition, getCashCustodyAlerts, missingCashAmount } from "../src/lib/cash-custody.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("supabase/migrations/20260906235157_cash_custody_chain.sql");
const simplificationMigration = read("supabase/migrations/20260907144816_simplify_cash_reconciliation.sql");
const ownerSelfHandoffMigration = read("supabase/migrations/20260908120000_owner_admin_self_cash_handoff.sql");
const actions = read("src/lib/cash-actions.ts");
const removalForm = read("src/components/CashRemovalForm.tsx");
const custodyForms = read("src/components/CashCustodyForms.tsx");
const detailPage = read("src/app/cash-collections/[id]/page.tsx");
const editPage = read("src/app/cash-collections/[id]/edit/page.tsx");
const operatorActions = read("src/lib/operator-actions.ts");

function tableDefinition(tableName) {
  const start = migration.indexOf(`create table if not exists public.${tableName}`);
  assert.notEqual(start, -1, `${tableName} table is missing`);
  const end = migration.indexOf(";", start);
  return migration.slice(start, end + 1);
}

test("removal is sealed, evidenced, route-independent, and has no amount", () => {
  assert.match(migration, /record_standalone_cash_removal_impl/);
  assert.match(migration, /A unique tamper-evident bag or seal ID is required/);
  assert.match(migration, /A sealed-bag removal photo is required/);
  assert.match(migration, /route_id,[\s\S]*?values \(\s*null,/i);
  assert.match(migration, /actual_cash_collected,[\s\S]*?null,[\s\S]*?'collected_pending_count'/i);
  assert.match(removalForm, /name="cash_bag_id" required/);
  assert.match(removalForm, /name="compartments"/);
  assert.match(removalForm, /name="evidence_file"[\s\S]*?required/);
  assert.doesNotMatch(removalForm, /counted_amount_lyd|name="route_id"/);
});

test("storage handoff allows an audited owner/admin self-receipt but keeps operators independent", () => {
  assert.match(migration, /receive_cash_into_storage_impl/);
  assert.match(ownerSelfHandoffMigration, /v_is_self_receipt and not v_is_owner_admin/);
  assert.match(ownerSelfHandoffMigration, /array\['owner', 'admin'\]/);
  assert.match(ownerSelfHandoffMigration, /self_received_by_owner_admin/);
  assert.match(ownerSelfHandoffMigration, /all other collectors require an independent receiver/i);
  assert.match(migration, /A storage handoff photo is required/);
  assert.match(ownerSelfHandoffMigration, /custody_status = 'in_storage'/);
  assert.match(actions, /receiveCashIntoStorage/);
  assert.match(custodyForms, /Receive bag into storage/);
  assert.match(detailPage, /!isOwnCollection \|\| isOwnerOrAdmin/);
});

test("operational receipt tables contain no financial amounts", () => {
  const receipt = tableDefinition("cash_removal_receipts");
  const receiptMachines = tableDefinition("cash_removal_receipt_machines");
  assert.doesNotMatch(receipt, /numeric|actual_cash|expected_cash|variance|amount_lyd/);
  assert.doesNotMatch(receiptMachines, /numeric|actual_cash|expected_cash|variance|amount_lyd/);
  assert.match(migration, /revoke all on table public\.cash_collections from public, anon, authenticated/);
  assert.match(migration, /create policy "snacky_cash_collection_machines_manager_read"[\s\S]*?owner'[\s\S]*?'finance'[\s\S]*?\);/);
  const machineManagerPolicy = migration.match(/create policy "snacky_cash_collection_machines_manager_read"[\s\S]*?\);/)?.[0] ?? "";
  assert.doesNotMatch(machineManagerPolicy, /warehouse|operator/);
  assert.match(detailPage, /if \(!canSeeMoney\)[\s\S]*?from\("cash_removal_receipts"\)/);
});

test("cash count is denomination-based and remains one combined bag total", () => {
  assert.equal(calculateDenominationTotal({ "0.5": 2, "5": 3, "20": 4 }, 1.25), 97.25);
  assert.match(migration, /key not in \('0\.25', '0\.5', '1', '5', '10', '20', '50'\)/);
  assert.match(migration, /count_denominations = v_denominations/);
  assert.match(migration, /A second person must witness every cash count/);
  assert.match(migration, /person counting cash cannot also be the count witness/i);
  assert.doesNotMatch(migration, /v_cash\.operator_id = v_counter_id/);
  assert.match(migration, /count_witnessed_by = p_count_witness_id/);
  assert.match(migration, /review_status = 'counted_pending_reconciliation'/);
  assert.match(actions, /p_count_witness_id: countWitnessId/);
  assert.match(custodyForms, /name="count_witness_id" required/);
  assert.match(custodyForms, /One total for the whole sealed bag/);
  assert.doesNotMatch(custodyForms, /machine_expected|machine_counted/);
});

test("reconciliation uses exact intervals or one documented manual batch total", () => {
  assert.match(migration, /calculate_cash_expectation_impl/);
  assert.match(migration, /previous_cash\.custody_status in \('reconciled', 'banked'\)/);
  assert.match(migration, /coalesce\(tx\.payment_time, tx\.delivery_time\) > v_interval_start/);
  assert.match(migration, /duplicate_rank = 1/);
  assert.match(migration, /manual_batch_total_lyd/);
  assert.match(migration, /expected_source = 'manual_override'/);
  assert.match(migration, /abs\(v_variance\) >= 10/);
  assert.match(custodyForms, /never invent machine splits/i);
  assert.equal(missingCashAmount(6_000, 10_000), 4_000);
  assert.equal(missingCashAmount(11_000, 10_000), 0);
  assert.deepEqual(combinedCashPosition([
    { actual_cash_collected: 6_000, vms_expected_cash: 10_000 },
    { actual_cash_collected: 2_500, vms_expected_cash: 2_000 },
    { actual_cash_collected: null, vms_expected_cash: 1_000 },
  ]), {
    actualCash: 8_500,
    expectedCash: 12_000,
    difference: -3_500,
    missingCash: 3_500,
    overageCash: 0,
    batchCount: 2,
  });
});

test("counted cash is available without a bank-transfer stage", () => {
  assert.match(actions, /Count saved and added to Snacky LYD/);
  assert.doesNotMatch(actions, /recordCashBankDeposit|voidCashBankDeposit|cash-deposits/);
  assert.doesNotMatch(custodyForms, /CashBankDepositForm|release for banking/);
  assert.doesNotMatch(detailPage, /Bank deposits|Create bank deposit|Banked amount/);
  assert.equal(fs.existsSync(path.join(root, "src/app/cash-deposits/page.tsx")), false);
  assert.equal(fs.existsSync(path.join(root, "src/app/cash-deposits/new/page.tsx")), false);
  assert.match(simplificationMigration, /where custody_status = 'banked'/);
  assert.match(simplificationMigration, /revoke all on function public\.record_cash_bank_deposit[\s\S]*?authenticated, service_role/);
  assert.match(simplificationMigration, /revoke all on function public\.void_cash_bank_deposit[\s\S]*?authenticated, service_role/);
});

test("cash records are immutable and route completion cannot create them", () => {
  assert.match(migration, /cash_collection_events/);
  assert.match(migration, /revoke all on table public\.cash_collection_events from public, anon, authenticated/);
  assert.match(editPage, /Cash custody records are immutable/);
  assert.match(operatorActions, /Cash removal is not part of route completion/);
  assert.doesNotMatch(operatorActions, /\.from\("cash_collections"\)/);
  assert.match(migration, /Submission ID was already used for a different custody event/);
});

test("overdue controls stop after reconciliation", () => {
  const now = new Date("2026-09-07T12:00:00.000Z");
  assert.equal(getCashCustodyAlerts({ custody_status: "removed", collected_at: "2026-09-07T08:00:00.000Z" }, now)[0]?.label, "Storage handoff overdue");
  assert.equal(getCashCustodyAlerts({ custody_status: "in_storage", storage_received_at: "2026-09-05T12:00:00.000Z" }, now)[0]?.label, "Cash count overdue");
  assert.equal(getCashCustodyAlerts({ custody_status: "counted", counted_at: "2026-09-05T12:00:00.000Z" }, now)[0]?.label, "Reconciliation overdue");
  assert.equal(getCashCustodyAlerts({ custody_status: "reconciled", reconciled_at: "2026-09-04T12:00:00.000Z" }, now).length, 0);
  assert.equal(getCashCustodyAlerts({ custody_status: "banked", reconciled_at: "2026-01-01T00:00:00.000Z" }, now).length, 0);
});
