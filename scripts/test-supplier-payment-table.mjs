import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as money from "../src/lib/supplier-payment-state.ts";
import * as authz from "../src/lib/authz.ts";
import * as operationId from "../src/lib/purchase-operation-id.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const P = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const TEAM = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const purchase = (extra = {}) => ({ id: P, status: "received", total_amount: "100.00", manual_total_lyd: null, calculated_total_lyd: "100.00", total_source: "calculated", ...extra });
const summary = (extra = {}) => ({ purchase_order_id: P, total_amount_lyd: "100.00", paid_amount_lyd: "0.00", remaining_amount_lyd: "100.00", payment_status: "unpaid", ...extra });
const fields = (extra = {}) => ({ purchase_order_id: P, client_submission_id: REQUEST, amount: "100.00", expected_remaining: "100.00", paid_at: "2026-09-15", payment_method: "cash", account_id: "snacky_lyd", reference: "", note: "", confirm_payment: "yes", ...extra });
const form = (extra = {}) => { const fd = new FormData(); for (const [key, value] of Object.entries(fields(extra))) fd.set(key, value); return fd; };

function load(file, imports, globals = {}) {
  const code = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  const context = vm.createContext({ exports, FormData, Date, URLSearchParams, console: { error() {} }, ...globals,
    require(id) { assert.ok(Object.hasOwn(imports, id), `Unexpected dependency: ${id}`); return imports[id]; },
  });
  vm.runInContext(code, context, { filename: file });
  return exports;
}

// Test doubles surround the real server action only. They never contact Supabase
// or modify production data. Existing SQL contract tests cover the RPC transaction.
function server(options = {}) {
  const state = {
    profile: { id: USER, team_member_id: TEAM, active_status: "active", role: "owner", roles: ["owner"] },
    purchase: purchase(), paid: 0, receipts: new Map(), finance: new Map(), reads: [], rpcCalls: [], commits: 0, refreshes: [],
    ...options,
  };
  const receipt = (args) => ({ id: OTHER, purchase_order_id: P, amount_lyd: args.p_amount, paid_at: args.p_paid_at,
    payment_method: args.p_payment_method, account_id: args.p_account_id, reference: args.p_reference, note: args.p_note,
    recorded_by: state.profile.team_member_id, voided_at: null, finance_transaction_id: USER });
  const commit = (args) => {
    const row = receipt(args);
    state.receipts.set(args.p_client_submission_id, row);
    state.finance.set(row.finance_transaction_id, { id: row.finance_transaction_id, source_type: "purchase_payment", source_id: row.id,
      amount: row.amount_lyd, signed_amount: -row.amount_lyd, account_id: row.account_id, transaction_status: "active", is_void: false });
    state.paid += args.p_amount;
    state.commits++;
    return row;
  };
  const client = {
    from(table) {
      assert.ok(["purchase_orders", "purchase_payment_summary", "purchase_payments", "financial_transactions"].includes(table), `Unexpected table: ${table}`);
      let key, value;
      return {
        select() { return this; },
        eq(k, v) { key = k; value = v; return this; },
        async maybeSingle() {
          state.reads.push(table);
          if (state.readError === table) return { data: null, error: { code: "57014" } };
          if (table === "purchase_payments") { assert.equal(key, "client_submission_id"); return { data: state.receipts.get(value) ?? null, error: null }; }
          if (table === "financial_transactions") return { data: state.finance.get(value) ?? null, error: null };
          if (table === "purchase_orders") return { data: value === P ? state.purchase : null, error: null };
          return { data: state.summary ?? summary({ paid_amount_lyd: state.paid, remaining_amount_lyd: 100 - state.paid,
            payment_status: state.paid === 100 ? "paid" : state.paid > 0 ? "partially_paid" : "unpaid" }), error: null };
        },
      };
    },
    async rpc(name, args) {
      assert.equal(name, "record_purchase_payment");
      state.rpcCalls.push(args);
      if (state.rpcError) return { data: null, error: state.rpcError };
      if (state.receipts.has(args.p_client_submission_id)) return { data: null, error: { code: "23505" } };
      if (args.p_amount > 100 - state.paid) return { data: null, error: { code: "23514" } };
      const row = commit(args);
      if (state.loseResponse) { state.loseResponse = false; throw new Error("Response lost after commit"); }
      if (state.uniqueAfterCommit) return { data: null, error: { code: "23505" } };
      if (state.badFinance) state.finance.get(USER).signed_amount = 1;
      return { data: row, error: null };
    },
  };
  const action = load("src/lib/supplier-payment-actions.ts", {
    "next/cache": { revalidatePath(value) { if (state.refreshError) throw new Error("Refresh unavailable"); state.refreshes.push(value); } },
    "@/lib/auth": { getCurrentProfile: async () => state.profile, getAuthAccessToken: async () => state.noToken ? null : "user-session" },
    "@/lib/authz": authz,
    "@/lib/activity-log": { logActivity: async () => { if (state.logError) throw new Error("Audit unavailable"); } },
    "@/lib/purchase-operation-id": operationId,
    "@/lib/supabase-server": { getSupabaseServerClient(token) { assert.equal(token, "user-session"); return client; } },
    "@/lib/supplier-payment-state": money,
  }).recordInlineSupplierPayment;
  return { state, action };
}

test("money validation does not invent zero balances or silently round payment amounts", () => {
  for (const value of [null, undefined, "", " ", "NaN", NaN, Infinity, "-1", -1, "1.001", 1.001, "1e3", {}, true]) assert.equal(money.supplierMoneyCents(value), null, String(value));
  for (const value of [0, "0.00", "100", 100, "100.00", " 100.00 "]) assert.equal(money.supplierMoneyCents(value), Number(value) * 100);
});

test("verified invoice and payment ledger determine unpaid/partial/paid readiness", () => {
  assert.equal(money.supplierPaymentState(purchase(), summary()).ready, true);
  const partial = money.supplierPaymentState(purchase(), summary({ paid_amount_lyd: 40, remaining_amount_lyd: 60, payment_status: "partially_paid" }));
  assert.equal(partial.ready, true); assert.equal(partial.remaining, 60);
  const paid = money.supplierPaymentState(purchase(), summary({ paid_amount_lyd: 100, remaining_amount_lyd: 0, payment_status: "paid" }));
  assert.equal(paid.ready, false); assert.equal(paid.remaining, 0);
});

test("manual invoice adjustments and legacy line-cost metadata do not block a balanced received invoice", () => {
  const manual = purchase({ manual_total_lyd: 100, total_source: "manual", calculated_total_lyd: 115 });
  assert.equal(money.supplierPaymentState(manual, summary()).ready, true);
  assert.equal(money.supplierPaymentState(purchase({ total_source: null, calculated_total_lyd: null }), summary()).ready, true);
  const legacy = purchase({ total_amount: 250, calculated_total_lyd: 250, lines: [{ units: 600, unitCost: 0.42, lineTotal: 250 }] });
  assert.equal(money.supplierPaymentState(legacy, summary({ total_amount_lyd: 250, remaining_amount_lyd: 250 })).ready, true);
});

test("genuine invoice conflicts and unknown/invalid ledger balances still fail closed", () => {
  const cases = [
    [purchase({ status: "draft" }), summary()], [purchase({ status: "voided" }), summary()],
    [purchase(), null], [purchase(), summary({ purchase_order_id: OTHER })],
    [purchase({ total_amount: 120 }), summary()], [purchase({ manual_total_lyd: 80 }), summary()],
    [purchase({ total_source: "manual" }), summary()], [purchase({ calculated_total_lyd: 99 }), summary()],
    [purchase({ total_amount: null, calculated_total_lyd: null }), summary()],
    [purchase(), summary({ total_amount_lyd: 99 })], [purchase(), summary({ paid_amount_lyd: null })],
    [purchase(), summary({ remaining_amount_lyd: NaN })], [purchase(), summary({ remaining_amount_lyd: 101 })],
    [purchase(), summary({ paid_amount_lyd: 101, remaining_amount_lyd: 0 })],
    [purchase(), summary({ payment_status: "paid" })], [purchase(), summary({ payment_status: "voided" })],
  ];
  for (const [p, s] of cases) { const result = money.supplierPaymentState(p, s); assert.equal(result.ready, false); assert.ok(result.reason); }
});

test("dates are real calendar days and the default follows Tripoli, not UTC", () => {
  assert.equal(money.supplierPaymentDate("2026-09-15"), "2026-09-15T12:00:00+02:00");
  for (const day of ["2026-02-30", "2026-02-29", "2026-13-01", "", "tomorrow", "2026-9-1"]) assert.equal(money.supplierPaymentDate(day), null);
  assert.ok(money.supplierPaymentDate("2024-02-29"));
  assert.equal(money.supplierPaymentToday(new Date("2026-09-14T22:30:00Z")), "2026-09-15");
});

for (const role of ["owner", "admin", "finance"]) test(`${role} can record a full payment and verify its matching Finance entry`, async () => {
  const h = server(); h.state.profile.role = role; h.state.profile.roles = [role];
  const result = await h.action(form());
  assert.equal(result.ok, true); assert.equal(h.state.commits, 1); assert.equal(h.state.paid, 100);
  assert.equal(h.state.finance.size, 1); assert.equal(h.state.finance.get(USER).signed_amount, -100);
  assert.ok(h.state.refreshes.includes("/purchases")); assert.ok(h.state.refreshes.includes("/finance/transactions"));
});

for (const role of ["operator", "crm", "warehouse", "purchasing", "supervisor", "viewer", "investor"]) test(`${role} cannot bypass payment authorization by calling the server action`, async () => {
  const h = server(); h.state.profile.role = role; h.state.profile.roles = [role];
  assert.equal((await h.action(form())).ok, false); assert.equal(h.state.rpcCalls.length, 0);
});

test("inactive/unlinked users and missing sessions never submit payment RPCs", async () => {
  for (const mode of ["inactive", "unlinked", "signed-out", "token"]) {
    const h = server();
    if (mode === "inactive") h.state.profile.active_status = "inactive";
    if (mode === "unlinked") h.state.profile.team_member_id = null;
    if (mode === "signed-out") h.state.profile = null;
    if (mode === "token") h.state.noToken = true;
    assert.equal((await h.action(form())).ok, false); assert.equal(h.state.rpcCalls.length, 0);
  }
});

test("partial payments preserve the chosen account, method, date and note", async () => {
  const h = server();
  assert.equal((await h.action(form({ amount: "40.00", account_id: "owner_lyd", payment_method: "bank_transfer", paid_at: "2026-09-13", note: "Supplier transfer", reference: "REF-1" }))).ok, true);
  assert.equal(h.state.paid, 40); assert.equal(h.state.rpcCalls[0].p_account_id, "owner_lyd");
  assert.equal(h.state.rpcCalls[0].p_paid_at, "2026-09-13T12:00:00+02:00");
  assert.equal(h.state.finance.get(USER).signed_amount, -40);
});

test("stale rows, overpayment, malformed requests and conflicting totals do not submit", async () => {
  for (const extra of [{ expected_remaining: "99.00" }, { amount: "101.00" }, { amount: "0.00" }, { amount: "1.234" }, { paid_at: "2026-02-30" }, { account_id: "owner_usd" }, { payment_method: "invented" }, { client_submission_id: "bad" }, { purchase_order_id: "bad" }, { confirm_payment: "no" }]) {
    const h = server(); assert.equal((await h.action(form(extra))).ok, false); assert.equal(h.state.rpcCalls.length, 0);
  }
  const h = server({ purchase: purchase({ total_amount: 200 }) });
  assert.equal((await h.action(form())).ok, false); assert.equal(h.state.rpcCalls.length, 0);
});

test("unreadable history or summaries are not assumed unpaid", async () => {
  for (const table of ["purchase_payments", "purchase_payment_summary", "purchase_orders"]) {
    const h = server({ readError: table });
    assert.equal((await h.action(form())).ok, false); assert.equal(h.state.rpcCalls.length, 0);
  }
});

test("a committed full payment can be retried before the already-paid balance check", async () => {
  const h = server({ loseResponse: true });
  const first = await h.action(form()); assert.equal(first.ok, false); assert.equal(first.retrySameRequest, true);
  assert.equal(h.state.paid, 100);
  const retry = await h.action(form()); assert.equal(retry.ok, true);
  assert.equal(h.state.commits, 1); assert.equal(h.state.rpcCalls.length, 1); assert.equal(h.state.finance.size, 1);
});

test("a recovered concurrent unique-submission response verifies the same receipt", async () => {
  const h = server({ uniqueAfterCommit: true });
  assert.equal((await h.action(form())).ok, true); assert.equal(h.state.commits, 1);
});

test("simultaneous retries share one stored receipt and one Finance money-out", async () => {
  const h = server();
  const results = await Promise.all([h.action(form()), h.action(form())]);
  assert.ok(results.every((result) => result.ok)); assert.equal(h.state.commits, 1); assert.equal(h.state.finance.size, 1);
});

test("an idempotency key cannot be reused for different payment details or actor", async () => {
  for (const extra of [{ amount: "90.00" }, { purchase_order_id: OTHER }, { paid_at: "2026-09-14" }, { account_id: "owner_lyd" }, { payment_method: "card" }, { reference: "changed" }, { note: "changed" }]) {
    const h = server(); assert.equal((await h.action(form())).ok, true);
    const retry = await h.action(form(extra)); assert.equal(retry.ok, false); assert.equal(retry.retrySameRequest, true);
    assert.equal(h.state.commits, 1);
  }
  const h = server(); await h.action(form()); h.state.profile.team_member_id = OTHER;
  assert.equal((await h.action(form())).ok, false); assert.equal(h.state.commits, 1);
});

test("voided or mismatched Finance receipts are not reported as success", async () => {
  const h = server({ badFinance: true });
  const first = await h.action(form()); assert.equal(first.ok, false); assert.equal(first.retrySameRequest, true);
  assert.equal(h.state.commits, 1);
  h.state.finance.get(USER).signed_amount = -100;
  assert.equal((await h.action(form())).ok, true); assert.equal(h.state.commits, 1);
  h.state.receipts.get(REQUEST).voided_at = "2026-09-15T14:00:00Z";
  assert.equal((await h.action(form())).ok, false); assert.equal(h.state.commits, 1);
});

test("activity/refresh errors after commit do not encourage another payment", async () => {
  const h = server({ logError: true, refreshError: true });
  assert.equal((await h.action(form())).ok, true); assert.equal(h.state.commits, 1);
});

test("unknown RPC results preserve the request for retry; known balance changes request refresh", async () => {
  const unavailable = server({ rpcError: { code: "PGRST202" } });
  const unknown = await unavailable.action(form()); assert.equal(unknown.ok, false); assert.equal(unknown.retrySameRequest, true);
  const stale = server({ rpcError: { code: "23514" } });
  const rejected = await stale.action(form()); assert.equal(rejected.ok, false); assert.equal(rejected.retrySameRequest, false);
});

test("both purchase list layouts use an in-place action, not a detail-page anchor", () => {
  const list = read("src/app/purchases/page.tsx");
  assert.match(list, /<PurchaseTablePayment/);
  assert.equal((list.match(/\{paymentAction\(purchase\)\}/g) ?? []).length, 2);
  assert.doesNotMatch(list, /#record-supplier-payment/);
  const component = read("src/components/PurchaseTablePayment.tsx");
  assert.match(component, /<dialog/); assert.match(component, /router\.refresh\(\)/);
  assert.doesNotMatch(component, /router\.(?:push|replace)\(/);
  const detail = read("src/app/purchases/[id]/page.tsx");
  assert.match(detail, /canAddPayment = canRecordPayment && supplierPayment\.ready/);
  assert.match(detail, /const canVoidPurchase =[\s\S]*?purchaseAccountingReady/);
  assert.match(detail, /disabled=\{[^}]*!purchaseAccountingReady\}/);
  assert.doesNotMatch(detail, /The purchase totals need accounting review before payment can be recorded/);
});
