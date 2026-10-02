import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const migration = read("supabase/migrations/20260906155600_purchase_payment_idempotency_v2.sql");
const actions = read("src/lib/purchase-actions.ts");
const financeActions = read("src/lib/finance-actions.ts");
const purchaseDetail = read("src/app/purchases/[id]/page.tsx");
const financeDetail = read("src/app/finance/transactions/[id]/page.tsx");
const financeEdit = read("src/app/finance/transactions/[id]/edit/page.tsx");
const financeList = read("src/app/finance/transactions/page.tsx");
const accountingMigration = read("supabase/migrations/20260906153000_atomic_purchase_receive_void.sql");

function functionBody(name, nextPattern) {
  const match = migration.match(
    new RegExp(`create or replace function public\\.${name}[\\s\\S]*?(?=${nextPattern})`, "i"),
  );
  assert.ok(match, `${name} function must exist`);
  return match[0];
}

const recordPayment = functionBody("record_purchase_payment", "create table if not exists public\\.purchase_payment_void_operations");
const voidPayment = functionBody("snacky_void_purchase_payment_v1", "revoke all on function public\\.snacky_void_purchase_payment_v1");
const financeGuard = functionBody("snacky_guard_purchase_payment_finance_row", "revoke all on function public\\.snacky_guard_purchase_payment_finance_row");
const parentVoid = functionBody("void_purchase_payment_rows", "revoke all on function public\\.void_purchase_payment_rows");

test("payment recording authenticates, normalizes money, then serializes on the purchase before idempotency", () => {
  assert.match(recordPayment, /security definer[\s\S]*set search_path = ''/i);
  assert.match(recordPayment, /v_actor_user_id uuid := auth\.uid\(\)/i);
  assert.match(recordPayment, /array\['owner', 'admin', 'finance'\]/i);
  assert.match(recordPayment, /v_amount := pg_catalog\.round\(p_amount, 2\)::numeric\(14,2\)/i);

  const purchaseLock = recordPayment.indexOf("from public.purchase_orders purchase");
  const submissionInsert = recordPayment.indexOf("insert into public.purchase_payment_submissions");
  const submissionLock = recordPayment.indexOf("from public.purchase_payment_submissions submission");
  assert.ok(purchaseLock > 0 && purchaseLock < submissionInsert && submissionInsert < submissionLock);
  assert.match(recordPayment.slice(purchaseLock, submissionInsert), /for update/i);
  assert.match(recordPayment, /on conflict \(client_submission_id\) do nothing/i);
  assert.match(recordPayment, /where submission\.client_submission_id = v_submission_id[\s\S]*for update/i);
  assert.match(recordPayment, /order by line\.product_id, line\.line_position, line\.id[\s\S]*for update/i);
});

test("payment retry is actor-bound to every normalized money input and preserves its immutable result", () => {
  for (const key of [
    "purchase_order_id",
    "amount_lyd",
    "paid_at",
    "payment_method",
    "account_id",
    "reference",
    "note",
    "actor_user_id",
    "actor_team_member_id",
  ]) {
    assert.match(recordPayment, new RegExp(`'${key}'`, "i"));
  }
  assert.match(recordPayment, /request_payload is distinct from v_request_payload/i);
  assert.match(recordPayment, /belongs to another actor or immutable request/i);
  assert.match(recordPayment, /result_payload[\s\S]*jsonb_populate_record/i);
  assert.match(recordPayment, /array\['voided_at', 'voided_by', 'void_reason'\]::text\[\]/i);
  assert.match(recordPayment, /v_payment\.voided_at is not null[\s\S]*transaction_status is distinct from 'voided'/i);
  assert.doesNotMatch(recordPayment, /coalesce\(v_purchase\.payment_method/);
});

test("canonical payment write owns one matching finance row behind an ALWAYS guard", () => {
  assert.match(migration, /create trigger snacky_purchase_payment_finance_row_guard[\s\S]*before insert or update or delete/i);
  assert.match(migration, /enable always trigger snacky_purchase_payment_finance_row_guard/i);
  assert.match(financeGuard, /purchase_payments payment[\s\S]*payment\.finance_transaction_id = old\.id/i);
  assert.match(financeGuard, /current_user::text is distinct from v_owner_name/i);
  assert.match(financeGuard, /'record:' \|\| v_payment\.id::text/i);
  assert.match(financeGuard, /'void:' \|\| v_payment\.id::text/i);
  assert.match(financeGuard, /Canonical supplier-payment finance insert does not match its payment row/i);
  assert.match(financeGuard, /Supplier-payment finance rows cannot be deleted/i);
  assert.match(recordPayment, /set_config\([\s\S]*'record:' \|\| v_payment\.id::text[\s\S]*insert into public\.financial_transactions/i);
  assert.match(recordPayment, /update public\.purchase_payments payment[\s\S]*finance_transaction_id = v_finance_id/i);
  for (const invariant of [
    /direction is distinct from 'money_out'/i,
    /transaction_kind is distinct from 'product_purchase'/i,
    /payment_method is distinct from v_payment\.payment_method/i,
    /created_by is distinct from v_payment\.recorded_by/i,
  ]) assert.match(recordPayment, invariant);
});

test("canonical payment void locks parent, payment, and finance and recomputes multiple-payment state", () => {
  assert.match(voidPayment, /security definer[\s\S]*set search_path = ''/i);
  assert.match(voidPayment, /array\['owner', 'admin', 'finance'\]/i);
  const purchaseLock = voidPayment.indexOf("from public.purchase_orders purchase");
  const paymentLock = voidPayment.indexOf("from public.purchase_payments payment", purchaseLock);
  const financeLock = voidPayment.indexOf("from public.financial_transactions finance", paymentLock);
  assert.ok(purchaseLock > 0 && paymentLock > purchaseLock && financeLock > paymentLock);
  assert.match(voidPayment.slice(purchaseLock, paymentLock), /for update/i);
  assert.match(voidPayment.slice(paymentLock, financeLock), /for update/i);
  assert.match(voidPayment.slice(financeLock), /for update/i);
  assert.match(voidPayment, /where payment\.purchase_order_id = v_purchase\.id[\s\S]*payment\.voided_at is null/i);
  assert.match(voidPayment, /order by payment\.paid_at desc, payment\.created_at desc, payment\.id desc/i);
  assert.match(voidPayment, /when v_paid <= 0 then 'unpaid'[\s\S]*then 'paid'[\s\S]*else 'partially_paid'/i);
  assert.match(voidPayment, /payment_method = case[\s\S]*payment_account_id = case/i);
  assert.match(voidPayment, /return v_operation\.result_payload/i);
  assert.match(voidPayment, /direction is distinct from 'money_out'/i);
  assert.match(voidPayment, /transaction_kind is distinct from 'product_purchase'/i);
  assert.match(voidPayment, /payment_method is distinct from v_payment\.payment_method/i);
  assert.match(voidPayment, /created_by is distinct from v_payment\.recorded_by/i);
  assert.match(voidPayment, /source_type = 'purchase_payment'[\s\S]*source_id = v_payment\.id[\s\S]*source_type = 'purchase'[\s\S]*source_id = v_purchase\.id/i);
});

test("legacy parent void fails closed on incomplete or inconsistent payment finance state", () => {
  assert.match(parentVoid, /order by payment\.id[\s\S]*for update/i);
  assert.match(parentVoid, /finance_transaction_id is null[\s\S]*cannot follow a parent void/i);
  assert.match(parentVoid, /from public\.financial_transactions finance[\s\S]*for update/i);
  assert.match(parentVoid, /transaction_status is distinct from 'active'/i);
  assert.match(parentVoid, /Supplier payment and finance rows must be consistent before a parent void/i);
  assert.match(parentVoid, /'void:' \|\| v_payment\.id::text/i);
  assert.match(parentVoid, /direction is distinct from 'money_out'/i);
  assert.match(parentVoid, /transaction_kind is distinct from 'product_purchase'/i);
  assert.match(parentVoid, /payment_method is distinct from v_payment\.payment_method/i);
  assert.match(parentVoid, /created_by is distinct from v_payment\.recorded_by/i);
  assert.match(parentVoid, /source_type = 'purchase'[\s\S]*source_id = new\.id/i);
});

test("payment tables and dangerous finance privileges have no client mutation grant", () => {
  assert.match(migration, /revoke all on table public\.purchase_payment_submissions[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all on table public\.purchase_payment_void_operations[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all on table public\.purchase_payments[\s\S]*from public, anon, authenticated, service_role[\s\S]*grant select on table public\.purchase_payments to authenticated/i);
  assert.match(migration, /revoke truncate, references, trigger on table public\.financial_transactions[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(migration, /revoke all on function public\.sync_purchase_to_financial_transaction\(uuid\)[\s\S]*from public, anon, authenticated, service_role/i);
});

test("application uses canonical payment record/void RPCs and blocks generic finance mutation", () => {
  assert.match(actions, /export async function voidPurchasePayment/i);
  assert.match(actions, /\.rpc\("snacky_void_purchase_payment_v1"/i);
  assert.match(actions, /paymentVoided: clientSubmissionId/i);
  assert.doesNotMatch(actions, /from\("purchase_payments"\)\.(?:insert|update|delete)/i);
  assert.doesNotMatch(financeActions, /createPurchaseFinancialTransaction/i);
  assert.match(purchaseDetail, /operation={`payment-void:\$\{payment\.id\}`}/i);
  assert.match(purchaseDetail, /action={voidPurchasePayment}/i);
  assert.match(purchaseDetail, /paymentFinanceIds[\s\S]*\.from\("financial_transactions"\)[\s\S]*\.in\("id", paymentFinanceIds\)/i);
  assert.match(financeActions, /assertFinanceTransactionIsNotSupplierPayment/g);
  assert.match(financeDetail, /isSupplierPayment[\s\S]*Correct or void it from the linked purchase payment history/i);
  assert.match(financeEdit, /Supplier-payment entries must be corrected from the linked purchase payment history/i);
  assert.match(financeList, /supplierPaymentFinanceIds\.has\(row\.id\)/i);
});

test("settlement model covers rounded partial payments and void recomputation", () => {
  const normalized = (amount) => Number(Number(amount).toFixed(2));
  const status = (total, payments) => {
    const paid = normalized(payments.filter((payment) => !payment.voided).reduce((sum, payment) => sum + payment.amount, 0));
    return {
      paid,
      remaining: normalized(Math.max(total - paid, 0)),
      status: paid <= 0 ? "unpaid" : paid >= total ? "paid" : "partially_paid",
    };
  };

  const payments = [
    { amount: normalized(30.005), voided: false },
    { amount: normalized(69.995), voided: false },
  ];
  assert.deepEqual(status(100, payments), { paid: 100, remaining: 0, status: "paid" });
  payments[1].voided = true;
  assert.deepEqual(status(100, payments), { paid: 30, remaining: 70, status: "partially_paid" });
  payments[0].voided = true;
  assert.deepEqual(status(100, payments), { paid: 0, remaining: 100, status: "unpaid" });
});

test("malformed or negative purchase accounting produces zero payment effects", () => {
  assert.match(accountingMigration, /create or replace function public\._snacky_assert_purchase_accounting_v1/i);
  assert.match(accountingMigration, /v_selected_total <= 0/i);
  assert.doesNotMatch(recordPayment, /(?:pg_catalog\.)?abs\s*\(/i);
  assert.doesNotMatch(voidPayment, /(?:pg_catalog\.)?abs\s*\(/i);

  const recordAssertion = recordPayment.indexOf("_snacky_assert_purchase_accounting_v1(");
  const recordEffect = recordPayment.indexOf("insert into public.purchase_payments");
  const voidAssertion = voidPayment.indexOf("_snacky_assert_purchase_accounting_v1(");
  const voidEffect = voidPayment.indexOf("update public.purchase_payments payment");
  assert.ok(recordAssertion > 0 && recordAssertion < recordEffect);
  assert.ok(voidAssertion > 0 && voidAssertion < voidEffect);

  const effects = { payments: [], finance: [], headers: [] };
  const assertCanonical = ({ lines, calculated, manual, total, source, adjustment }) => {
    const round = (value) => Number(Number(value).toFixed(2));
    const lineSum = round(lines.reduce((sum, line) => sum + line.total, 0));
    if (lines.some((line) => line.units <= 0 || line.cost < 0 || round(line.cost * line.units) !== round(line.total))) {
      throw new Error("line mismatch");
    }
    const selected = round(manual ?? calculated);
    if (calculated < 0 || total < 0 || (manual ?? 0) < 0 || round(calculated) !== lineSum) throw new Error("negative total");
    if (selected <= 0 || round(total) !== selected) throw new Error("invalid payable");
    if (manual == null && (source !== "calculated" || ![null, 0].includes(adjustment))) throw new Error("invalid header");
    if (manual != null && (source !== "manual" || round(adjustment) !== round(selected - lineSum))) throw new Error("invalid header");
    return selected;
  };
  const recordModel = (purchase) => {
    assertCanonical(purchase);
    effects.payments.push(1);
    effects.finance.push(1);
    effects.headers.push(1);
  };
  for (const purchase of [
    { lines: [{ units: 1, cost: -10, total: -10 }], calculated: -10, manual: null, total: -10, source: "calculated", adjustment: null },
    { lines: [{ units: 2, cost: 5, total: 9 }], calculated: 9, manual: null, total: 9, source: "calculated", adjustment: null },
    { lines: [{ units: 2, cost: 5, total: 10 }], calculated: 10, manual: 12, total: 12, source: "manual", adjustment: 1 },
  ]) assert.throws(() => recordModel(purchase));
  assert.deepEqual(effects, { payments: [], finance: [], headers: [] });
});
