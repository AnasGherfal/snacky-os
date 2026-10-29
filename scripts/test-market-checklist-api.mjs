import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { buyingRoles, buyingSameOrigin } from "../src/lib/buying-lists.ts";
import { validateMarketCommand, marketReceiptMatches } from "../src/lib/market-checklist.ts";
import { readCompanyBody, CompanyRequestTooLarge } from "../src/lib/company-request.ts";

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const command = () => ({
  request_id: uuid(1), list_id: uuid(2), revision: 3, action: "progress",
  payload: { item_id: uuid(3), acquired_quantity: 2, unavailable: false, note: "Another flavour" },
});
const source = fs.readFileSync("src/app/api/buying-lists/checklist/route.ts", "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function handler(options = {}) {
  const calls = [];
  const profile = options.profile === undefined ? { id: uuid(9), role: "owner", active_status: "active" } : options.profile;
  const db = {
    rpc: async (name, args) => {
      calls.push(["rpc", name, args]);
      if (options.rpcThrows) throw Error("network interrupted");
      if (options.rpcResult) return options.rpcResult;
      return { data: { request_id: args.p_command.request_id, list_id: args.p_command.list_id, revision: args.p_command.revision + 1 }, error: null };
    },
  };
  const modules = {
    "next/server": { NextResponse: { json: (body, init) => new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...init.headers } }) } },
    "@/lib/auth": {
      getCurrentProfile: async () => { calls.push(["profile"]); if (options.profileThrows) throw Error("auth unavailable"); return profile; },
      getAuthenticatedSupabaseServerClient: async () => { calls.push(["authenticated-client"]); if (options.clientThrows) throw Error("client unavailable"); return options.missingClient ? null : db; },
    },
    "@/lib/authz": { hasAnyRole: (p, allowed) => { calls.push(["roles"]); return [p.role, ...(p.roles ?? [])].some(role => allowed.includes(role)); } },
    "@/lib/buying-lists": { buyingRoles, buyingSameOrigin },
    "@/lib/market-checklist": { validateMarketCommand, marketReceiptMatches },
    "@/lib/company-request": { readCompanyBody, CompanyRequestTooLarge },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require: name => { assert.ok(Object.hasOwn(modules, name), `Unexpected dependency or privileged client: ${name}`); return modules[name]; },
    TextDecoder,
    console: { error: () => {} },
  });
  return { POST: exports.POST, calls };
}

function request(body = command(), headers = {}) {
  return new Request("https://snacky.example/api/buying-lists/checklist", {
    method: "POST",
    headers: { origin: "https://snacky.example", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function invoke(options, body = command(), headers = {}) {
  const endpoint = handler(options);
  const response = await endpoint.POST(request(body, headers));
  return { ...endpoint, response, data: await response.json() };
}
function assertPrivate(response) {
  assert.match(response.headers.get("cache-control"), /private/);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

test("the real handler sends only a shopping command after active purchasing authorization", async () => {
  const result = await invoke({});
  assert.equal(result.response.status, 200);
  assert.equal(result.data.ok, true);
  assert.deepEqual(result.calls.map(call => call[0]), ["profile", "roles", "authenticated-client", "rpc"]);
  const rpc = result.calls.at(-1);
  assert.equal(rpc[1], "snacky_buying_checklist_command_v1");
  assert.deepEqual(JSON.parse(JSON.stringify(rpc[2])), { p_command: command() });
  assertPrivate(result.response);
});

test("cross-site and missing origin requests are rejected before looking up any account or client", async () => {
  for (const headers of [{ origin: "https://unrelated.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }]) {
    const result = await invoke({}, command(), headers);
    assert.equal(result.response.status, 403);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.data, { ok: false, code: "denied", retryable: false });
    assertPrivate(result.response);
  }
});

test("inactive, signed-out and unrelated staff roles never obtain a database client", async () => {
  for (const profile of [null, { id: uuid(9), role: "owner", active_status: "inactive" }, { id: uuid(9), role: "operator", active_status: "active" }, { id: uuid(9), role: "viewer", active_status: "active" }]) {
    const result = await invoke({ profile });
    assert.equal(result.response.status, 403);
    assert.equal(result.calls.some(call => call[0] === "authenticated-client" || call[0] === "rpc"), false);
    assertPrivate(result.response);
  }
  const additive = await invoke({ profile: { id: uuid(9), role: "operator", roles: ["purchasing"], active_status: "active" } });
  assert.equal(additive.response.status, 200);
});

test("malformed commands and oversized bodies cannot reach the writer", async () => {
  for (const [body, headers, status] of [
    ["not JSON", {}, 400],
    [{ ...command(), payload: { ...command().payload, actual_product_id: uuid(6) } }, {}, 400],
    [{ ...command(), revision: 0 }, {}, 400],
    [command(), { "content-length": "400001" }, 413],
    [" ".repeat(400001), {}, 413],
  ]) {
    const result = await invoke({}, body, headers);
    assert.equal(result.response.status, status);
    assert.equal(result.calls.some(call => call[0] === "rpc"), false);
    assert.equal(result.data.retryable, false);
    assertPrivate(result.response);
  }
});

test("a missing database client or auth lookup outage returns a recoverable private response", async () => {
  for (const options of [{ missingClient: true }, { profileThrows: true }, { clientThrows: true }]) {
    const result = await invoke(options);
    assert.equal(result.response.status, 503);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.retryable, true);
    assert.equal(result.calls.some(call => call[0] === "rpc"), false);
    assertPrivate(result.response);
  }
});

test("success is withheld for an empty, unrelated or stale persistence receipt", async () => {
  const receipt = { request_id: uuid(1), list_id: uuid(2), revision: 4 };
  for (const data of [null, {}, { ...receipt, request_id: uuid(99) }, { ...receipt, list_id: uuid(99) }, { ...receipt, revision: 3 }]) {
    const result = await invoke({ rpcResult: { data, error: null } });
    assert.equal(result.response.status, 503);
    assert.deepEqual(result.data, { ok: false, code: "uncertain", retryable: true });
    assertPrivate(result.response);
  }
});

test("database denials, conflicts and invalid quantities stay distinct from uncertain network results", async () => {
  const cases = [
    ["42501", 403, "denied", false],
    ["40001", 409, "conflict", false],
    ["23505", 409, "conflict", false],
    ["23514", 400, "invalid", false],
    ["23503", 400, "invalid", false],
    ["22023", 400, "invalid", false],
    ["PGRST202", 503, "not_installed", true],
    ["57014", 503, "uncertain", true],
  ];
  for (const [code, status, expected, retryable] of cases) {
    const result = await invoke({ rpcResult: { data: null, error: { code, message: "Test-only database error" } } });
    assert.equal(result.response.status, status, code);
    assert.deepEqual(result.data, { ok: false, code: expected, retryable }, code);
    assertPrivate(result.response);
  }
  const interrupted = await invoke({ rpcThrows: true });
  assert.equal(interrupted.response.status, 503);
  assert.deepEqual(interrupted.data, { ok: false, code: "uncertain", retryable: true });
  assertPrivate(interrupted.response);
});
