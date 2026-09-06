import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const migration = read(
  "supabase/migrations/20260831172000_purchase_payment_ledger.sql",
);
const purchaseInventoryMigration = read(
  "supabase/migrations/20260906153000_atomic_purchase_receive_void.sql",
);
const authz = read("src/lib/authz.ts");
const actions = read("src/lib/purchase-actions.ts");
const listPage = read("src/app/purchases/page.tsx");
const detailPage = read("src/app/purchases/[id]/page.tsx");

test("supplier payments are append-only, itemized, and idempotent", () => {
  assert.match(migration, /create table public\.purchase_payments/i);
  assert.match(migration, /purchase_order_id uuid not null/i);
  assert.match(migration, /amount_lyd numeric\(14,2\) not null check\(amount_lyd>0\)/i);
  assert.match(migration, /client_submission_id text not null unique/i);
  assert.match(migration, /finance_transaction_id uuid/i);
  assert.match(migration, /voided_at timestamptz/i);
  assert.match(
    migration,
    /revoke insert,update,delete on public\.purchase_payments from authenticated/i,
  );
});

test("paid, partial, unpaid, and remaining amounts are derived from the ledger", () => {
  assert.match(migration, /create or replace view public\.purchase_payment_summary/i);
  assert.match(migration, /with\(security_invoker=true\)/i);
  assert.match(migration, /paid_amount_lyd/i);
  assert.match(migration, /remaining_amount_lyd/i);
  assert.match(migration, /then 'partially_paid'/i);
  assert.match(migration, /else 'unpaid'/i);
  assert.match(migration, /payment_count/i);
});

test("recording a supplier payment is locked, authorized, and cannot overpay", () => {
  const paymentFunction =
    migration.match(
      /create or replace function public\.record_purchase_payment[\s\S]*?(?=create or replace function|$)/i,
    )?.[0] ?? "";

  assert.match(
    paymentFunction,
    /snacky_current_profile_has_any_role\(array\['owner','admin','finance'\]\)/i,
  );
  assert.match(
    paymentFunction,
    /select \* into po from public\.purchase_orders where id=p_purchase_order_id for update/i,
  );
  assert.match(
    paymentFunction,
    /Payment exceeds the remaining supplier balance/i,
  );
  assert.match(paymentFunction, /insert into public\.purchase_payments/i);
  assert.match(paymentFunction, /insert into public\.financial_transactions/i);
  assert.match(paymentFunction, /'purchase_payment',row\.id/i);
  assert.match(paymentFunction, /finance_transaction_id=v_finance_id/i);
  assert.match(
    paymentFunction,
    /v_status:=case when v_paid\+p_amount>=v_total then 'paid' else 'partially_paid' end/i,
  );
});

test("legacy paid purchases are backfilled and checked without duplicating cash-out", () => {
  assert.match(migration, /legacy-purchase-payment:/i);
  assert.match(migration, /on conflict\(client_submission_id\) do nothing/i);
  assert.match(migration, /Historical supplier-payment backfill count mismatch/i);
  assert.match(migration, /Historical supplier-payment backfill total mismatch/i);
  assert.match(
    migration,
    /create or replace function public\.finance_purchase_should_sync[\s\S]*select false/i,
  );
});

test("inventory void refuses paid purchases and never silently changes money history", () => {
  const voidFunction =
    purchaseInventoryMigration.match(
      /create or replace function public\.snacky_void_received_purchase_v1[\s\S]*?(?=revoke all on function public\.snacky_void_received_purchase_v1)/i,
    )?.[0] ?? "";

  assert.match(
    voidFunction,
    /payment_status in \('paid', 'partially_paid'\) or exists \([\s\S]*from public\.purchase_payments/i,
  );
  assert.match(
    voidFunction,
    /Record an explicit supplier return\/refund instead/i,
  );
  assert.doesNotMatch(voidFunction, /update public\.purchase_payments/i);
  assert.doesNotMatch(voidFunction, /update public\.financial_transactions/i);
});

test("only owner, admin, or finance can use the payment server action", () => {
  assert.match(authz, /canRecordPurchasePayments/i);
  assert.match(authz, /\["owner",\s*"admin",\s*"finance"\]/i);
  assert.match(actions, /export async function recordPurchasePayment/i);
  assert.match(actions, /canRecordPurchasePayments\(profile\)/i);
  assert.match(actions, /\.rpc\("record_purchase_payment"/i);
  assert.match(actions, /p_client_submission_id/i);
  assert.match(actions, /paymentRecorded/i);
});

test("purchase pages show ledger-derived status and fail closed when unavailable", () => {
  assert.match(listPage, /purchase_payment_summary/i);
  assert.match(listPage, /paid_amount_lyd/i);
  assert.match(listPage, /remaining_amount_lyd/i);
  assert.match(listPage, /unavailable/i);

  assert.match(detailPage, /purchase_payment_summary/i);
  assert.match(detailPage, /purchase_payments/i);
  assert.match(detailPage, /recordPurchasePayment/i);
  assert.match(detailPage, /remaining_amount_lyd/i);
  assert.match(detailPage, /unavailable/i);
  assert.doesNotMatch(detailPage, /markPurchasePaid/);
});
