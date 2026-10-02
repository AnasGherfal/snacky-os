import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";

const directPickupSource = readFileSync("src/lib/direct-pickup-actions.ts", "utf8");
const actionSource = readFileSync("src/lib/operator-actions.ts", "utf8");

// Test the current merged checklist contract, not an obsolete isChecked:true mapping.
function pickupFixture(reply) {
  const calls = [];
  const exports = {};
  const imports = {
    "@/lib/action-result": { actionFailure: message => ({ success: false, message }) },
    "@/lib/operator-actions": { confirmPickList: async (...args) => {
      calls.push(args);
      return reply ? reply(args, calls.length) : { success: true, pickupBatchId: "batch-fixture" };
    } },
  };
  const code = ts.transpileModule(directPickupSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, crypto: { randomUUID: () => "request-fixture" }, require(name) {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  }});
  return { calls, confirm: exports.confirmPickupDirect };
}

const rows = [
  { routeStopItemId: "line-b", productId: "product-b", quantity: 2 },
  { routeStopItemId: "line-a", productId: "product-a", quantity: 1 },
];

test("direct pickup carries the same canonical acknowledged payload into prepare and confirm", async () => {
  const fixture = pickupFixture();
  const result = await fixture.confirm("route", rows, [], {
    clientSubmissionId: "request", stopIds: ["stop-b", "stop-a", "stop-b"],
    acknowledgedPickupLineIds: [" line-b ", "line-a", "line-b", ""],
  });
  assert.equal(result.success, true);
  assert.equal(fixture.calls.length, 2);
  const [prepare, confirm] = fixture.calls;
  assert.equal(prepare[1], confirm[1], "Both stages must use exactly the same item payload");
  assert.deepEqual(Array.from(prepare[1], item => item.isChecked), [true, true]);
  for (const call of fixture.calls) {
    assert.deepEqual(Array.from(call[3].acknowledgedPickupLineIds), ["line-a", "line-b"]);
    assert.deepEqual(Array.from(call[3].stopIds), ["stop-a", "stop-b"]);
    assert.equal(call[3].clientSubmissionId, "request");
  }
  assert.equal(prepare[3].stage, "prepare");
  assert.equal(confirm[3].stage, "confirm");
  assert.equal(confirm[3].preparedBatchId, "batch-fixture");
});

test("pickup never manufactures acknowledgement of unchecked rows", async () => {
  for (const acknowledgedPickupLineIds of [[], ["line-a"]]) {
    const fixture = pickupFixture();
    const result = await fixture.confirm("route", rows, [], { acknowledgedPickupLineIds });
    assert.equal(result.success, false);
    assert.equal(fixture.calls.length, 0, "Unchecked rows must fail before either database call");
  }
  const fixture = pickupFixture();
  await fixture.confirm("route", [{ productId: "extra", quantity: 1 }]);
  assert.equal(fixture.calls[0][1][0].isChecked, false, "An absent line id cannot be marked acknowledged");
});

test("pickup does not finalize a failed or unconfirmed preparation", async () => {
  for (const reply of [{ success: false, message: "Blocked" }, { success: true }]) {
    const fixture = pickupFixture(() => reply);
    const result = await fixture.confirm("route", rows, [], { acknowledgedPickupLineIds: ["line-a", "line-b"] });
    assert.equal(result.success, false);
    assert.equal(fixture.calls.length, 1);
  }
});

test("pickup action exposes checklist validation failures instead of hiding them behind the generic fallback", () => {
  assert.match(actionSource, /pickup checklist acknowledgements do not match the submitted checked lines/);
  assert.match(actionSource, /every required pickup line must be checked/);
  assert.match(actionSource, /pickupPublicError\(error\)/);
});
