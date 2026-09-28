import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import {
  emptyTotals, moneyValue, readAllPurchaseRows, resolvePurchasePerson,
  summarizePurchases, tripoliMonth, verifyPurchaseStock,
} from "../src/lib/operator-purchase-overview.ts";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const P = "00000000-0000-4000-8000-000000000003";
const S = "00000000-0000-4000-8000-000000000004";
const purchase = (extra = {}) => ({ id: "purchase-a", person_id: A, product_id: P, product_name: "Test snack",
  storage_location_id: S, quantity: 4, total_lyd: 20, paid_amount_lyd: 0, remaining_amount_lyd: 20,
  purchased_at: "2026-09-27T10:00:00Z", inventory_movement_id: "movement-a", ...extra });
const movement = (extra = {}) => ({ id: "movement-a", product_id: P, quantity: 4,
  from_entity_type: "storage", from_entity_id: S, to_entity_type: "operator_personal_purchase",
  to_entity_id: A, reason: "operator_personal_purchase", created_at: "2026-09-27T10:00:01Z",
  reversed_movement_id: null, source_id: "purchase-a", source_type: "operator_personal_purchase", ...extra });
const team = [ { id: A, full_name: "Operator A", role: "operator", active: true },
  { id: B, full_name: "Operator B", roles: ["operator"], active: false } ];

test("all-period debt includes older purchases, partial payments and inactive operators", () => {
  const rows = [purchase(), purchase({ id: "old", quantity: 1, total_lyd: 7, paid_amount_lyd: 2,
    remaining_amount_lyd: 5, purchased_at: "2026-07-30T12:00:00Z" }),
    purchase({ id: "b", person_id: B, quantity: 2, total_lyd: 3, remaining_amount_lyd: 3 })];
  const [a, b] = summarizePurchases(rows, team, "2026-09");
  assert.deepEqual([a.units, a.charged, a.paid, a.outstanding, a.currentMonthOutstanding, a.earlierOutstanding], [5, 27, 2, 25, 20, 5]);
  assert.equal(b.active, false);
  assert.equal(b.outstanding, 3);
  assert.equal(a.outstanding, a.currentMonthOutstanding + a.earlierOutstanding + a.otherOutstanding);
});
test("changing calendar month reclassifies, rather than hides, older outstanding debt", () => {
  const [a] = summarizePurchases([purchase()], team, "2026-10");
  assert.equal(a.outstanding, 20); assert.equal(a.currentMonthOutstanding, 0); assert.equal(a.earlierOutstanding, 20);
});
test("Tripoli midnight, year boundary and future-dated rows are handled explicitly", () => {
  assert.equal(tripoliMonth("2026-08-31T22:00:00Z"), "2026-09");
  assert.equal(tripoliMonth("2026-12-31T22:00:00Z"), "2027-01");
  const [a] = summarizePurchases([purchase({ purchased_at: "2026-10-01T00:00:00Z" })], team, "2026-09");
  assert.equal(a.otherOutstanding, 20); assert.equal(a.outstanding, 20);
});
test("amounts are not multiplied by 100; decimal sums reconcile", () => {
  assert.equal(moneyValue("2.50"), 2.5);
  const [a] = summarizePurchases([0.1, 0.2].map((v) => purchase({ total_lyd: v, remaining_amount_lyd: v })), team, "2026-09");
  assert.equal(a.outstanding, 0.3);
});
test("bad or inconsistent amounts fail instead of becoming a misleading zero", () => {
  for (const value of [null, undefined, "", "invalid", -1, Infinity]) assert.throws(() => moneyValue(value));
  assert.throws(() => summarizePurchases([purchase({ paid_amount_lyd: 2 })], team, "2026-09"));
  assert.throws(() => summarizePurchases([purchase({ quantity: 0 })], team, "2026-09"));
  assert.throws(() => tripoliMonth("not a date"));
  assert.equal(emptyTotals(A).outstanding, 0);
});
test("stock proof is independent of payment status", () => {
  const p = purchase(); const m = movement();
  const unpaidProof = verifyPurchaseStock(p, m, new Set(), "Main storage");
  assert.equal(unpaidProof.status, "deducted"); assert.equal(unpaidProof.quantity, 4);
  assert.deepEqual(verifyPurchaseStock({ ...p, paid_amount_lyd: 20, remaining_amount_lyd: 0 }, m, new Set(), "Main storage"), unpaidProof);
});
test("an ID without a matching movement is never enough", () => {
  assert.equal(verifyPurchaseStock(purchase(), undefined, new Set()).status, "missing");
  assert.equal(verifyPurchaseStock(purchase({ inventory_movement_id: null }), movement(), new Set()).status, "missing");
  for (const patch of [{ quantity: 5 }, { product_id: "other" }, { from_entity_type: "machine" },
    { from_entity_id: "other" }, { to_entity_type: "operator_bag" }, { to_entity_id: B },
    { reason: "route_pickup" }, { source_id: "other" }, { source_type: "other" }, { created_at: "invalid" }]) {
    const result = verifyPurchaseStock(purchase(), movement(patch), new Set());
    assert.equal(result.status, "mismatch"); assert.equal(result.quantity, null); assert.equal(result.storageName, null);
  }
});
test("reversed stock movements require review", () => {
  assert.equal(verifyPurchaseStock(purchase(), movement(), new Set(["movement-a"])).status, "reversed");
  assert.equal(verifyPurchaseStock(purchase(), movement({ reversed_movement_id: "earlier" }), new Set()).status, "reversed");
});
test("legacy matching movements need not contain newer source metadata", () => {
  assert.equal(verifyPurchaseStock(purchase(), movement({ source_id: null, source_type: null }), new Set()).status, "deducted");
});
test("operator scope cannot be expanded by a requested person", () => {
  assert.equal(resolvePurchasePerson(false, A, ""), A);
  assert.equal(resolvePurchasePerson(false, A, A), A);
  assert.throws(() => resolvePurchasePerson(false, A, B));
  assert.throws(() => resolvePurchasePerson(false, "", A));
  assert.equal(resolvePurchasePerson(true, A, B), B);
});
test("paging includes more than 1000 rows, even with a smaller server response cap", async () => {
  const all = Array.from({ length: 1203 }, (_, id) => ({ id }));
  const result = await readAllPurchaseRows(async (from, to) => ({
    data: all.slice(from, Math.min(to + 1, from + 137)), error: null, count: all.length,
  }));
  assert.deepEqual(result, all);
});
test("empty results are valid, but truncated, failed or changing reads are not", async () => {
  assert.deepEqual(await readAllPurchaseRows(async () => ({ data: [], count: 0, error: null })), []);
  await assert.rejects(readAllPurchaseRows(async () => ({ data: [], count: 1, error: null })));
  await assert.rejects(readAllPurchaseRows(async () => ({ data: [], count: null, error: null })));
  await assert.rejects(readAllPurchaseRows(async () => ({ data: [], count: 0, error: new Error("denied") })));
  let call = 0;
  await assert.rejects(readAllPurchaseRows(async () => ({ data: [{ id: ++call }], count: call === 1 ? 3 : 4, error: null })));
});

// Execute the real route body with fake authenticated clients. These fakes do
// NOT enforce RLS, so the tests independently verify the route's own scoping.
let env;
function client(kind) {
  return { from(table) {
    const filters = []; let columns = "*";
    const query = {
      select(value) { columns = value; return query; },
      eq(column, value) { filters.push(["eq", column, value]); return query; },
      in(column, values) { filters.push(["in", column, values]); return query; },
      order() { return query; },
      async range(from, to) {
        env.calls.push({ kind, table, filters: [...filters], columns });
        if (env.fail === table) return { data: null, count: null, error: { message: "failed" } };
        const filtered = (env.tables[table] || []).filter((row) => filters.every(([op, column, value]) =>
          op === "eq" ? row[column] === value : value.includes(row[column])));
        return { data: filtered.slice(from, to + 1).map((row) => Object.fromEntries(columns.split(",").map((key) => [key, row[key]]))), count: filtered.length, error: null };
      },
    };
    return query;
  } };
}
globalThis.__purchaseOverviewTest = {
  getCurrentProfile: async () => env.profile,
  getAuthAccessToken: async () => "test-token",
  isOwnerAdminRole: (profile) => profile.role === "owner" || profile.role === "admin",
  getSupabaseServerClient: () => client("user"),
  getSupabaseAdminClient: () => env.noProofClient ? null : client("proof"),
  NextResponse: { json(body, options = {}) { return { status: options.status || 200, body, headers: options.headers }; } },
};
const routeUrl = new URL("../src/app/api/operator-money/overview/route.ts", import.meta.url);
const source = readFileSync(routeUrl, "utf8");
let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
code = code.replace(/import \{([^}]+)\} from "(?:next\/server|@\/lib\/auth|@\/lib\/authz|@\/lib\/supabase-server)";/g,
  (_, names) => `const {${names}} = globalThis.__purchaseOverviewTest;`);
code = code.replace('"@/lib/operator-purchase-overview"', JSON.stringify(new URL("../src/lib/operator-purchase-overview.ts", import.meta.url).href));
const { GET } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
function reset(role = "operator") {
  env = { profile: { role, team_member_id: A }, calls: [], tables: {
    team_members: team, operator_personal_purchase_status: [purchase(), purchase({ id: "purchase-b", person_id: B, inventory_movement_id: "movement-b" })],
    inventory_movements: [movement({ unit_cost_lyd: 999, notes: "must not leak" }), movement({ id: "movement-b", to_entity_id: B, source_id: "purchase-b" })],
    storage_locations: [{ id: S, name: "Main storage" }],
  } };
}
const request = (query = "") => new Request(`https://example.test/api/operator-money/overview?${query}`);

test("route: unauthenticated and forged operator requests never reach database reads", async () => {
  reset(); env.profile = null;
  assert.equal((await GET(request())).status, 401); assert.equal(env.calls.length, 0);
  reset(); assert.equal((await GET(request(`personId=${B}`))).status, 403); assert.equal(env.calls.length, 0);
});
test("route: an operator receives only own totals, history and sanitized movement proof", async () => {
  reset(); const result = await GET(request(`personId=${A}`));
  assert.equal(result.status, 200); assert.deepEqual(result.body.people, []);
  assert.equal(result.body.historyCount, 1); assert.equal(result.body.selected.units, 4);
  assert.equal(result.body.history[0].proof.status, "deducted");
  assert.match(result.headers["Cache-Control"], /no-store/);
  assert.doesNotMatch(JSON.stringify(result.body), /must not leak|unit_cost_lyd|purchase-b|movement-b|Operator B/);
  for (const call of env.calls.filter((call) => call.kind === "proof" && call.table === "inventory_movements")) {
    assert.deepEqual(call.filters[0][2], ["movement-a"]);
  }
});
test("route: owners get the team summary, but only selected-person movement details", async () => {
  reset("owner"); const result = await GET(request(`personId=${B}`));
  assert.equal(result.status, 200); assert.equal(result.body.people.length, 2);
  assert.equal(result.body.personId, B); assert.equal(result.body.history[0].id, "purchase-b");
});
test("route: self-service owners do not receive the team summary", async () => {
  reset("owner");
  assert.equal((await GET(request(`personId=${B}&selfOnly=1`))).status, 403);
  const result = await GET(request(`personId=${A}&selfOnly=1`));
  assert.equal(result.status, 200); assert.equal(result.body.manager, false); assert.deepEqual(result.body.people, []);
});
test("route: failed reads never return zero totals and failed proof reads never claim a deduction", async () => {
  reset(); env.fail = "operator_personal_purchase_status";
  const failed = await GET(request(`personId=${A}`)); assert.equal(failed.status, 503); assert.equal(failed.body.selected, undefined);
  reset(); env.fail = "inventory_movements";
  const result = await GET(request(`personId=${A}`));
  assert.equal(result.status, 200); assert.equal(result.body.history[0].proof.status, "unavailable");
});
test("route: reversed evidence is flagged; paying does not change the proof or write inventory", async () => {
  reset(); env.tables.inventory_movements.push({ id: "reverse", reversed_movement_id: "movement-a" });
  assert.equal((await GET(request(`personId=${A}`))).body.history[0].proof.status, "reversed");
  reset(); Object.assign(env.tables.operator_personal_purchase_status[0], { paid_amount_lyd: 20, remaining_amount_lyd: 0 });
  const result = await GET(request(`personId=${A}`));
  assert.equal(result.body.selected.outstanding, 0); assert.equal(result.body.history[0].proof.status, "deducted");
  assert.doesNotMatch(source, /\.(insert|update|delete|upsert|rpc)\(/);
});
test("route: invalid pages are rejected and a page beyond the end is clamped", async () => {
  reset(); assert.equal((await GET(request(`personId=${A}&page=-1`))).status, 400);
  assert.equal((await GET(request(`personId=${A}&page=99`))).body.page, 1);
});
test("existing entry pages use the workspace while the working ledger remains separate", () => {
  for (const file of ["../src/app/operator/money/page.tsx", "../src/app/team/[id]/money/page.tsx"]) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), /OperatorMoneyWorkspace/);
  }
  const ui = readFileSync(new URL("../src/app/operator-money/OperatorMoneyWorkspace.tsx", import.meta.url), "utf8");
  assert.match(ui, /<OperatorMoneyLedgerClient \{\.\.\.props\}/);
  assert.match(ui, /earlierOutstanding/); assert.match(ui, /View linked stock movement/);
  assert.match(ui, /data\.manager && !selfServiceOnly/);
  assert.doesNotMatch(ui, /method:\s*["']POST/);
  const compiled = ts.transpileModule(ui, { reportDiagnostics: true, compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } });
  assert.equal(compiled.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length, 0);
});
