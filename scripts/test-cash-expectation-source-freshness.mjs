import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const queue = readFileSync("src/app/cash-collections/action-queue/page.tsx", "utf8");
const custody = readFileSync("src/lib/cash-custody.ts", "utf8");

test("owner cash queue checks both transaction timestamps without fetching transaction details", () => {
  assert.ok(queue.includes('db.from("vms_transactions_raw").select("id")'));
  assert.ok(queue.includes('.eq("transaction_status","successful_sale").not("mapped_machine_id","is",null)'));
  assert.ok(queue.includes('.gte("payment_time",cutoff).limit(1)'));
  assert.ok(queue.includes('.gte("delivery_time",cutoff).limit(1)'));
  assert.ok(queue.includes('rawCashSourceFreshness === "stale"'));
  assert.ok(queue.includes('rawCashSourceFreshness === "unverified"'));
  assert.ok(queue.includes('No recent raw sales for automatic cash reconciliation'));
  assert.ok(queue.includes('This does not mean machines had no sales'));
  assert.ok(queue.includes('href="/vms-import"'));
});

test("a dated cash-only assumption cannot be counted as verified shortage", () => {
  assert.ok(custody.includes('["vms_exact", "manual_override"]'));
  assert.ok(custody.includes('A cash-only payment-method assumption is not a verified comparison'));
  assert.ok(queue.includes('Variance and source reviews'));
});

test("source-freshness checks cannot mutate financial or raw VMS records", () => {
  assert.doesNotMatch(queue, /db\.from\("vms_transactions_raw"\)\.\s*(?:insert|update|delete|upsert)\(/);
  assert.doesNotMatch(queue, /db\.rpc\(/);
});
