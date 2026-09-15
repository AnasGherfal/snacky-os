import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import * as money from "../src/lib/supplier-payment-state.ts";
import * as operationId from "../src/lib/purchase-operation-id.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "src/components/PurchaseTablePayment.tsx"), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const P = "11111111-1111-4111-8111-111111111111";
const U = "44444444-4444-4444-8444-444444444444";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const key = `snacky:supplier-payment:table:v1:${U}:${P}`;
const accepted = { ok: true, message: "Recorded", paymentId: REQUEST };

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== "object") return;
  yield node;
  yield* walk(node.props?.children);
}

// Lightweight hook/event harness around the actual component. This exercises
// handlers and payload persistence, not a claim of browser/layout or live-DB E2E.
function dialogHarness({ stored, storageFails = false, respond = async () => accepted, locale = "en" } = {}) {
  const slots = []; let cursor = 0;
  const state = { calls: [], refreshes: 0, uuidCalls: 0, storage: new Map(stored === undefined ? [] : [[key, stored]]), modalOpen: false };
  const hooks = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useId() { return `test-heading-${cursor++}`; },
  };
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next/navigation": { useRouter: () => ({ refresh() { state.refreshes++; } }) },
    "@/components/I18nProvider": { useLanguage: () => ({ locale }) },
    "@/lib/supplier-payment-actions": { recordInlineSupplierPayment: async (fd) => { const values = Object.fromEntries(fd); state.calls.push(values); return respond(values, state.calls.length); } },
    "@/lib/purchase-operation-id": operationId,
    "@/lib/supplier-payment-state": money,
  };
  const exports = {};
  vm.runInNewContext(code, { exports, FormData, console, crypto: { randomUUID() { state.uuidCalls++; return REQUEST; } },
    window: { localStorage: {
      getItem(k) { if (storageFails) throw new Error("Unavailable"); return state.storage.get(k) ?? null; },
      setItem(k, value) { if (storageFails) throw new Error("Unavailable"); state.storage.set(k, value); },
      removeItem(k) { if (storageFails) throw new Error("Unavailable"); state.storage.delete(k); },
    } },
    require(id) { assert.ok(Object.hasOwn(imports, id), id); return imports[id]; },
  });
  const props = { purchaseId: P, userId: U, supplier: "Test supplier", receipt: "TEST-1", paymentState: { ready: true, reason: "", total: 100, paid: 0, remaining: 100 } };
  const render = () => {
    cursor = 0;
    const nodes = [...walk(exports.PurchaseTablePayment(props))];
    const modal = nodes.find((node) => node.type === "dialog");
    modal.props.ref.current = { showModal() { state.modalOpen = true; }, close() { state.modalOpen = false; } };
    return nodes;
  };
  const find = (predicate) => { const result = render().find(predicate); assert.ok(result); return result; };
  const open = () => find((node) => node.type === "button" && node.props.onClick && node.props.className === "btn-primary").props.onClick();
  const submit = () => find((node) => node.type === "form").props.action();
  const change = (name, value) => find((node) => node.props?.name === name).props.onChange({ target: { value } });
  const close = () => find((node) => node.type === "button" && node.props.type === "button" && node.props.className === "btn-secondary").props.onClick();
  return { state, props, render, find, open, submit, change, close };
}

test("opening/cancelling never records money; confirmation sends editable amount/date/account", async () => {
  const h = dialogHarness(); h.open(); assert.equal(h.state.calls.length, 0); assert.equal(h.state.modalOpen, true);
  assert.equal(h.find((node) => node.props?.name === "amount").props.value, "100.00");
  h.close(); assert.equal(h.state.calls.length, 0);
  h.open(); h.change("amount", "40.00"); h.change("account_id", "owner_lyd"); h.change("paid_at", "2026-09-13"); h.change("payment_method", "bank_transfer");
  await h.submit(); assert.equal(h.state.calls.length, 1);
  assert.equal(h.state.calls[0].amount, "40.00"); assert.equal(h.state.calls[0].account_id, "owner_lyd");
  assert.equal(h.state.calls[0].paid_at, "2026-09-13"); assert.equal(h.state.calls[0].confirm_payment, "yes");
  assert.equal(h.state.modalOpen, false); assert.equal(h.state.storage.has(key), false); assert.equal(h.state.refreshes, 1);
});

test("lost responses preserve identical payload/UUID after close, reopen and reload", async () => {
  const h = dialogHarness({ respond: async () => { throw new Error("Network lost"); } });
  h.open(); h.change("amount", "40.00"); await h.submit();
  const stored = h.state.storage.get(key); assert.ok(stored); h.close(); h.open();
  assert.equal(h.find((node) => node.type === "fieldset").props.disabled, true);
  await h.submit(); assert.deepEqual(h.state.calls[0], h.state.calls[1]); assert.equal(h.state.uuidCalls, 1);
  const reloaded = dialogHarness({ stored }); reloaded.open(); await reloaded.submit();
  assert.deepEqual(reloaded.state.calls[0], h.state.calls[0]); assert.equal(reloaded.state.uuidCalls, 0);
});

test("unavailable storage still retains the request in memory across dialog reopen", async () => {
  const h = dialogHarness({ storageFails: true, respond: async () => { throw new Error("Network lost"); } });
  h.open(); await h.submit(); h.close(); h.open(); await h.submit();
  assert.equal(h.state.uuidCalls, 1); assert.deepEqual(h.state.calls[0], h.state.calls[1]);
});

test("malformed or unrelated saved payloads fail closed instead of minting another ID", async () => {
  for (const stored of ["not-json", "{}", "null", "[]", JSON.stringify({ client_submission_id: REQUEST, purchase_order_id: U })]) {
    const h = dialogHarness({ stored }); h.open(); await h.submit();
    assert.equal(h.state.calls.length, 0); assert.equal(h.state.uuidCalls, 0); assert.equal(h.state.storage.get(key), stored);
    assert.equal(h.find((node) => node.type === "button" && node.props.type === "submit").props.disabled, true);
  }
});

test("pending double clicks and Escape do not submit or close a second time", async () => {
  let finish; const h = dialogHarness({ respond: () => new Promise((resolve) => { finish = resolve; }) });
  h.open(); const first = h.submit(); await h.submit(); assert.equal(h.state.calls.length, 1);
  let prevented = false;
  h.find((node) => node.type === "dialog").props.onCancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.state.modalOpen, true);
  finish(accepted); await first; assert.equal(h.state.modalOpen, false);
});

test("definitive stale balance failure requires reviewing refreshed amounts", async () => {
  const h = dialogHarness({ respond: async () => ({ ok: false, retrySameRequest: false, message: "Balance changed; refresh" }) });
  h.open(); await h.submit(); assert.equal(h.state.storage.has(key), false);
  assert.equal(h.find((node) => node.type === "button" && node.props.type === "submit").props.disabled, true);
  h.props.paymentState = { ready: true, reason: "", total: 100, paid: 40, remaining: 60 };
  h.close(); h.open(); assert.equal(h.find((node) => node.props?.name === "amount").props.value, "60.00");
});

test("Arabic dialog labels and RTL direction are present", () => {
  const h = dialogHarness({ locale: "ar" }); h.open();
  assert.equal(h.find((node) => node.type === "dialog").props.dir, "rtl");
  assert.equal(h.find((node) => node.type === "button" && node.props.type === "submit").props.children, "تأكيد الدفع");
});
