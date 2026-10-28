import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import * as market from "../src/lib/market-checklist.ts";
import * as buying from "../src/lib/buying-lists.ts";
import { marketUnitLabel, marketFlexibilityLabel } from "../src/lib/market-checklist-labels.ts";

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = changes => ({ id: uuid(1), product_id: null, label: "Chips", quantity: 6, unit: "boxes", flexibility: "any_brand", acquired_quantity: 0, unavailable: false, note: "", ...changes });
const command = changes => ({ request_id: uuid(10), list_id: uuid(20), revision: 3, action: "progress", payload: { item_id: uuid(1), acquired_quantity: 6, unavailable: false, note: "Available flavour" }, ...changes });
const settle = () => new Promise(resolve => setImmediate(resolve));

function memoryStorage() {
  const values = new Map();
  let failing = false;
  return {
    values,
    failWrites(value) { failing = value; },
    getItem: key => values.get(key) ?? null,
    setItem(key, value) { if (failing) throw Error("storage unavailable"); values.set(key, value); },
    removeItem(key) { if (failing) throw Error("storage unavailable"); values.delete(key); },
  };
}
function nodes(tree) {
  const result = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    result.push(node);
    walk(node.props?.children);
  }
  walk(tree);
  return result;
}
const text = tree => JSON.stringify(tree);
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);

/** Run the real compiled callback code with deterministic hooks, storage and delayed network responses. */
function componentModule(path, options = {}) {
  let active = null;
  let refreshed = 0;
  const navigations = [];
  const local = options.local ?? memoryStorage();
  const session = options.session ?? memoryStorage();
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const hooks = {
    useState(initial) {
      const fiber = active, index = fiber.cursor++;
      if (!fiber.hooks[index]) fiber.hooks[index] = { value: typeof initial === "function" ? initial() : initial };
      return [fiber.hooks[index].value, value => { fiber.hooks[index].value = typeof value === "function" ? value(fiber.hooks[index].value) : value; }];
    },
    useRef(initial) {
      const fiber = active, index = fiber.cursor++;
      if (!fiber.hooks[index]) fiber.hooks[index] = { current: initial };
      return fiber.hooks[index];
    },
    useEffect(callback, deps) {
      const fiber = active, index = fiber.cursor++;
      const previous = fiber.hooks[index];
      if (previous && sameDeps(previous.deps, deps)) return;
      fiber.hooks[index] = { deps, cleanup: previous?.cleanup };
      fiber.effects.push(() => { previous?.cleanup?.(); fiber.hooks[index].cleanup = callback(); });
    },
    useCallback(callback, deps) {
      const fiber = active, index = fiber.cursor++;
      if (fiber.hooks[index] && sameDeps(fiber.hooks[index].deps, deps)) return fiber.hooks[index].callback;
      fiber.hooks[index] = { deps, callback };
      return callback;
    },
  };
  const modules = {
    react: hooks,
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" },
    "next/link": { __esModule: true, default: "a" },
    "next/navigation": { useRouter: () => ({ refresh() { refreshed++; }, push(path) { navigations.push(path); } }) },
    "@/components/I18nProvider": { useLanguage: () => ({ locale: options.locale ?? "en" }) },
    "@/components/MarketChecklist": { MarketChecklist: "market-checklist" },
    "@/lib/market-checklist": market,
    "@/lib/buying-lists": buying,
    "@/lib/market-checklist-labels": { marketUnitLabel, marketFlexibilityLabel },
    "@/lib/restock-shopping-list": { readRestockShoppingListStrict: () => options.legacy ?? [] },
    ...options.imports,
  };
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports,
    require(name) {
      if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
      assert.ok(Object.hasOwn(modules, name), `Unexpected component dependency: ${name}`);
      return modules[name];
    },
    localStorage: local, sessionStorage: session,
    window: { confirm: () => true, prompt: () => "Changed plans", location: { reload() {} } },
    crypto: { randomUUID }, AbortController, queueMicrotask,
    setTimeout: () => 1, clearTimeout() {},
    fetch: options.fetch,
    console,
  }, { filename: path });
  function mount(fn, initialProps) {
    const fiber = { hooks: [], effects: [], cursor: 0 };
    let props = initialProps;
    const component = typeof fn === "string" ? exports[fn] : fn;
    return {
      render(changes) {
        if (changes) props = { ...props, ...changes };
        active = fiber; fiber.cursor = 0;
        try { return component(props); } finally { active = null; }
      },
      async effects() { for (const run of fiber.effects.splice(0)) run(); await Promise.resolve(); },
    };
  }
  return { exports, mount, local, session, navigations, get refreshed() { return refreshed; } };
}

test("the market checkbox prevents rapid duplicate progress writes and never shows an unconfirmed acquisition", async () => {
  let finish;
  const progress = [];
  const harness = componentModule("src/components/MarketChecklist.tsx");
  const view = harness.mount("MarketChecklist", {
    items: [item()], ar: false, draftKey: "test-checklist", allowEdit: true,
    onAdd: async () => true, onEdit: async () => true, onRemove: async () => true,
    onProgress: payload => { progress.push(payload); return new Promise(resolve => { finish = resolve; }); },
  });
  const checkbox = nodes(view.render()).find(node => node.type === "input" && node.props["aria-label"] === "Got Chips");
  checkbox.props.onChange({ target: { checked: true } });
  checkbox.props.onChange({ target: { checked: true } });
  assert.equal(progress.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(progress[0])), { item_id: uuid(1), acquired_quantity: 6, unavailable: false, note: "" });
  const pending = nodes(view.render()).find(node => node.props?.["aria-label"] === "Got Chips");
  assert.equal(pending.props.checked, false);
  assert.equal(pending.props.disabled, true);
  finish(false); await settle();
  const failed = nodes(view.render()).find(node => node.props?.["aria-label"] === "Got Chips");
  assert.equal(failed.props.checked, false);
  assert.equal(failed.props.disabled, false);
  assert.match(text(view.render()), /1.*left to get/);
});

test("Remaining keeps partial and unavailable needs visible and Got shows only fulfilled needs", () => {
  const harness = componentModule("src/components/MarketChecklist.tsx", { locale: "ar" });
  const rows = [item({ acquired_quantity: 2 }), item({ id: uuid(2), label: "Bebeto", unavailable: true }), item({ id: uuid(3), label: "Water", acquired_quantity: 6 })];
  const view = harness.mount("MarketChecklist", { items: rows, ar: true, draftKey: "arabic", allowEdit: false, onAdd: async () => true, onEdit: async () => true, onProgress: async () => true, onRemove: async () => true });
  const remaining = view.render();
  assert.equal(remaining.props.dir, "rtl");
  const remainingChecks = nodes(remaining).filter(node => node.type === "input" && node.props.type === "checkbox");
  assert.equal(remainingChecks.length, 2);
  assert.ok(remainingChecks.every(node => node.props.checked === false));
  const gotFilter = nodes(remaining).find(node => node.type === "button" && node.props.children === "حصلت عليه");
  gotFilter.props.onClick();
  const gotChecks = nodes(view.render()).filter(node => node.type === "input" && node.props.type === "checkbox");
  assert.equal(gotChecks.length, 1);
  assert.equal(gotChecks[0].props.checked, true);
  assert.match(gotChecks[0].props["aria-label"], /Water/);
  assert.ok(gotChecks.every(node => node.props.disabled), "Read-only viewers cannot tick progress");
});

test("market search filters by label or note without changing progress", () => {
  const changes = [];
  const rows = [item({ label: "Chips" }), item({ id: uuid(2), label: "Bebeto", note: "Orange available" }), item({ id: uuid(3), label: "Water", acquired_quantity: 6 })];
  const harness = componentModule("src/components/MarketChecklist.tsx");
  const view = harness.mount("MarketChecklist", { items: rows, ar: false, draftKey: "search", allowEdit: true,
    onAdd: async () => true, onEdit: async () => true, onRemove: async () => true, onProgress: async payload => { changes.push(payload); return true; } });
  const search = nodes(view.render()).find(node => node.type === "input" && node.props.type === "search");
  assert.ok(search);
  search.props.onChange({ target: { value: "orange" } });
  const matching = nodes(view.render()).filter(node => node.type === "input" && node.props["aria-label"]?.startsWith("Got "));
  assert.deepEqual(matching.map(node => node.props["aria-label"]), ["Got Bebeto"]);
  assert.match(text(view.render()), /Showing 1 of 2/);
  nodes(view.render()).find(node => node.type === "button" && node.props.children === "Clear search").props.onClick();
  assert.equal(nodes(view.render()).filter(node => node.type === "input" && node.props["aria-label"]?.startsWith("Got ")).length, 2);
  assert.equal(changes.length, 0);
});

test("unsaved quantity or note blocks quick checking until saved", () => {
  const store = memoryStorage(), saved = [];
  const key = `cart:${uuid(1)}:progress`;
  store.setItem(key, JSON.stringify({ acquired: "0", unavailable: false, note: "Found another flavour" }));
  const harness = componentModule("src/components/MarketChecklist.tsx", { local: store });
  const view = harness.mount("MarketChecklist", { items: [item()], ar: false, draftKey: "cart", allowEdit: true,
    onAdd: async () => true, onEdit: async () => true, onRemove: async () => true, onProgress: async payload => { saved.push(payload); return true; } });
  nodes(view.render()).find(node => node.props?.["aria-label"] === "Got Chips").props.onChange({ target: { checked: true } });
  assert.equal(saved.length, 0);
  assert.match(text(view.render()), /Save them before ticking it off/);
  store.removeItem(key);
  store.setItem(`cart:${uuid(1)}:edit`, JSON.stringify({ id: uuid(1), label: "Different chips", quantity: "6", unit: "boxes", flexibility: "any_brand", note: "" }));
  nodes(view.render()).find(node => node.props?.["aria-label"] === "Got Chips").props.onChange({ target: { checked: true } });
  assert.equal(saved.length, 0);
  store.removeItem(`cart:${uuid(1)}:edit`);
  nodes(view.render()).find(node => node.props?.["aria-label"] === "Got Chips").props.onChange({ target: { checked: true } });
  assert.equal(saved.length, 1);
});

test("editing need cannot overwrite a fresher progress note", async () => {
  const harness = componentModule("src/components/MarketChecklist.tsx");
  const parent = harness.mount("MarketChecklist", { items: [item({ note: "Original note" })], ar: false, draftKey: "notes", allowEdit: true,
    onAdd: async () => true, onEdit: async () => true, onRemove: async () => true, onProgress: async () => true });
  const edit = nodes(parent.render()).find(node => typeof node.type === "function" && node.type.name === "ItemForm" && node.props.item);
  const saves = [];
  const form = harness.mount(edit.type, { ...edit.props, onSave: async value => { saves.push(value); return true; } });
  form.render(); await form.effects();
  assert.equal(nodes(form.render()).filter(node => node.type === "textarea").length, 0, "Note editing should have one location");
  form.render({ item: { ...edit.props.item, note: "Updated in progress" } });
  await nodes(form.render()).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(saves[0].note, "Updated in progress");
});

test("adding a generic need preserves its stable row identity and draft until the save is confirmed", async () => {
  const submitted = [];
  let success = false;
  const harness = componentModule("src/components/MarketChecklist.tsx");
  const parent = harness.mount("MarketChecklist", { items: [], ar: false, draftKey: "generic", onAdd: async () => true, onEdit: async () => true, onProgress: async () => true, onRemove: async () => true });
  const add = nodes(parent.render()).find(node => typeof node.type === "function" && node.type.name === "ItemForm" && !node.props.item);
  const formView = harness.mount(add.type, { ...add.props, onSave: async next => { submitted.push(next); return success; } });
  formView.render(); await formView.effects();
  function edit(name, value) {
    const field = nodes(formView.render()).find(node => node.props?.name === name);
    assert.ok(field, name);
    field.props.onChange({ target: { value } });
  }
  edit("label", "Bebeto"); edit("quantity", "3"); edit("flexibility", "any_flavour");
  const firstForm = nodes(formView.render()).find(node => node.type === "form");
  await firstForm.props.onSubmit({ preventDefault() {} });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].product_id, null);
  assert.equal(submitted[0].flexibility, "any_flavour");
  assert.equal(submitted[0].quantity, 3);
  assert.equal(submitted[0].acquired_quantity, 0);
  const backup = JSON.parse(harness.local.getItem(add.props.draftKey));
  assert.equal(backup.label, "Bebeto");
  assert.equal(backup.id, submitted[0].id);
  success = true;
  await nodes(formView.render()).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(submitted[1].id, submitted[0].id, "Retry uses the original row ID");
  assert.equal(harness.local.getItem(add.props.draftKey), null, "Only confirmed save clears the draft");
});

test("an edit cannot silently relabel previously acquired boxes as packs", async () => {
  const harness = componentModule("src/components/MarketChecklist.tsx");
  const parent = harness.mount("MarketChecklist", { items: [item({ acquired_quantity: 2 })], ar: false, draftKey: "edit", onAdd: async () => true, onEdit: async () => true, onProgress: async () => true, onRemove: async () => true });
  const edit = nodes(parent.render()).find(node => typeof node.type === "function" && node.type.name === "ItemForm" && node.props.item);
  const form = harness.mount(edit.type, edit.props);
  form.render(); await form.effects();
  const unit = nodes(form.render()).find(node => node.type === "select" && node.props.name === "unit");
  assert.equal(unit.props.disabled, true);
  assert.match(text(form.render()), /Reset acquired quantity before changing/);
});

test("the actual shared command hook persists before sending, rejects rapid duplicates and waits for a fresh revision", async () => {
  let finish;
  const requests = [];
  const harness = componentModule("src/components/SharedMarketChecklist.tsx", {
    fetch: async (url, options) => { requests.push([url, JSON.parse(options.body)]); return new Promise(resolve => { finish = resolve; }); },
  });
  const view = harness.mount("useMarketCommand", { userId: uuid(9), identity: uuid(20), revision: 3 });
  view.render(); await view.effects();
  const ready = view.render();
  assert.equal(ready.locked, false);
  const c = command();
  const first = ready.send(c);
  const duplicate = ready.send(c);
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(harness.session.getItem(`snacky:market-command:v1:${uuid(9)}:${uuid(20)}`)), c);
  assert.equal(await duplicate, false);
  finish({ ok: true, json: async () => ({ ok: true, request_id: c.request_id, list_id: c.list_id, revision: 4 }) });
  assert.equal(await first, true);
  assert.equal(harness.refreshed, 1);
  assert.equal(view.render().locked, true, "No edit may use the old revision after a successful response");
  assert.equal(view.render({ revision: 4 }).locked, false);
  assert.equal(harness.session.values.size, 0);
  assert.equal(requests[0][0], "/api/buying-lists/checklist", "Checking a need never calls a receipt or inventory endpoint");
});

test("an interrupted request survives reload and retries its original payload, never an edited replacement", async () => {
  const session = memoryStorage();
  const sent = [];
  const initial = componentModule("src/components/SharedMarketChecklist.tsx", { session, fetch: async (_, options) => { sent.push(JSON.parse(options.body)); throw Error("connection lost"); } });
  const firstView = initial.mount("useMarketCommand", { userId: uuid(9), identity: uuid(20), revision: 3 });
  firstView.render(); await firstView.effects();
  const original = command();
  assert.equal(await firstView.render().send(original), false);
  assert.equal(firstView.render().locked, true);
  assert.equal(await firstView.render().send(command({ request_id: uuid(11), payload: { ...original.payload, acquired_quantity: 5 } })), false);
  assert.equal(sent.length, 1);
  const restored = componentModule("src/components/SharedMarketChecklist.tsx", { session, fetch: async (_, options) => { const c = JSON.parse(options.body); sent.push(c); return { ok: true, json: async () => ({ ok: true, request_id: c.request_id, list_id: c.list_id, revision: c.revision + 1 }) }; } });
  const restoredView = restored.mount("useMarketCommand", { userId: uuid(9), identity: uuid(20), revision: 3 });
  restoredView.render(); await restoredView.effects();
  assert.equal(restoredView.render().locked, true);
  assert.equal(await restoredView.render().send(original), true);
  assert.deepEqual(sent, [original, original]);
  assert.equal(session.values.size, 0);
});

test("failed device backup sends nothing and does not leave the synchronous lock stuck", async () => {
  const session = memoryStorage();
  let calls = 0;
  const harness = componentModule("src/components/SharedMarketChecklist.tsx", { session, fetch: async (_, options) => { calls++; const c = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true, request_id: c.request_id, list_id: c.list_id, revision: c.revision + 1 }) }; } });
  const view = harness.mount("useMarketCommand", { userId: uuid(9), identity: uuid(20), revision: 3 });
  view.render(); await view.effects();
  session.failWrites(true);
  assert.equal(await view.render().send(command()), false);
  assert.equal(calls, 0);
  session.failWrites(false);
  assert.equal(await view.render().send(command()), true);
  assert.equal(calls, 1);
});

test("a wrong success receipt retains recovery; a confirmed conflict blocks further edits", async () => {
  let result = { ok: true, request_id: uuid(99), list_id: uuid(20), revision: 4 };
  let calls = 0;
  const harness = componentModule("src/components/SharedMarketChecklist.tsx", { fetch: async () => { calls++; return { ok: result.ok, json: async () => result }; } });
  const view = harness.mount("useMarketCommand", { userId: uuid(9), identity: uuid(20), revision: 3 });
  view.render(); await view.effects();
  assert.equal(await view.render().send(command()), false);
  assert.equal(view.render().locked, true);
  assert.equal(harness.session.values.size, 1);
  result = { ok: false, code: "conflict", retryable: false };
  assert.equal(await view.render().send(command()), false);
  assert.equal(harness.session.values.size, 0);
  assert.equal(view.render().locked, true);
  assert.equal(await view.render().send(command({ request_id: uuid(11) })), false);
  assert.equal(calls, 2);
});

test("the shopping detail page opens a separate exact-product receipt; legacy lists retain their linked receipt route", async () => {
  const source = fs.readFileSync("src/app/buying-lists/[id]/page.tsx", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  async function render(shopping_mode) {
    const list = { id: uuid(20), title: "Market run", buyer_name: "Buyer", creator_name: "Planner", due_on: "2026-10-28", status: "open", revision: 3, assigned_to: uuid(9), shopping_mode, checklist_items: [item()], items: [] };
    const jsx = (type, props) => ({ type, props });
    const modules = {
      "react/jsx-runtime": { jsx, jsxs: jsx }, "next/link": { __esModule: true, default: "a" },
      "next/navigation": { unstable_rethrow() {}, notFound() { throw Error("not found"); } },
      "@/lib/buying-sources": { sourceAwareItems: rows => rows },
      "@/lib/buying-server": { buyingWorkspace: async () => ({ profile: { id: uuid(9) }, data: { record: list, me: uuid(9), planner: true, people: [] }, sources: null, sourcesStatus: "available" }) },
      "@/lib/authz": { hasAnyRole: () => true }, "@/lib/buying-purchase": { buyingPurchaseRoles: ["owner"] },
      "@/lib/buying-lists": buying, "@/lib/i18n/server": { getServerI18n: async () => ({ locale: "en" }) },
      "@/components/BuyingListClient": { BuyingProgress: "legacy-progress", BuyingCopyLink: "copy-link" },
      "@/components/BuyingListTable": { BuyingListTable: "legacy-table" },
      "@/components/SharedMarketChecklist": { SharedMarketChecklist: "market-checklist" },
      "@/components/BuyingLists.module.css": { __esModule: true, default: {} },
    };
    const exports = {};
    vm.runInNewContext(compiled, { exports, require: name => { assert.ok(Object.hasOwn(modules, name), name); return modules[name]; } });
    return exports.default({ params: Promise.resolve({ id: uuid(20) }) });
  }
  const shopping = await render(true);
  const links = nodes(shopping).filter(node => node.type === "a").map(node => node.props.href);
  assert.ok(links.includes("/purchases/new"));
  assert.equal(links.some(link => link.includes("source=restock") || link.endsWith("/purchases")), false);
  assert.ok(nodes(shopping).some(node => node.type === "market-checklist"));
  assert.match(text(shopping), /exact products, flavours, quantities and prices/);
  const legacyLinks = nodes(await render(false)).filter(node => node.type === "a").map(node => node.props.href);
  assert.ok(legacyLinks.includes(`/buying-lists/${uuid(20)}/purchases`));
});

async function draftPlanner({ local = memoryStorage(), userId = uuid(9), fromSuggestions = false } = {}) {
  const network = [], published = [];
  const harness = componentModule("src/components/DraftMarketChecklist.tsx", {
    local,
    fetch: async (url, options) => {
      network.push({ url, method: options?.method ?? "GET" });
      assert.equal(url, "/api/buying-lists", "The planner only loads staff context; ticks must not post a purchase");
      return { ok: true, json: async () => ({ ok: true, data: { planner: true, me: uuid(90), people: [{ id: uuid(90), name: "Current buyer" }] } }) };
    },
    imports: {
      "@/components/SharedMarketChecklist": {
        // The actual durability/retry hook is exercised above. Here the confirmed callback
        // isolates the planner's reuse-versus-duplicate decision after a completed save.
        useMarketCommand: ({ onSaved }) => ({ locked: false, busy: false, status: null, send: async c => { market.validateMarketCommand(c); published.push(c); onSaved(c); return true; } }),
      },
    },
  });
  const view = harness.mount("DraftMarketChecklist", { userId, today: "2026-10-28", fromSuggestions });
  view.render(); await view.effects();
  view.render(); await view.effects(); await settle();
  const checklist = () => nodes(view.render()).find(node => node.type === "market-checklist");
  assert.ok(checklist(), "Draft hydration must expose the saved shopping needs");
  return { harness, view, checklist, network, published, local };
}

test("the local planner restores manual needs and ticks; newer sales are merged only after an explicit action", async () => {
  const local = memoryStorage();
  const manual = item({ label: "Chips — any suitable brand", acquired_quantity: 6 });
  const edited = item({ id: uuid(2), product_id: uuid(202), label: "Bebeto — any flavour", quantity: 8, acquired_quantity: 2, flexibility: "any_flavour" });
  const original = [manual, edited];
  const suggested = [item({ id: uuid(50), product_id: uuid(202), label: "Bebeto original", quantity: 1 }), item({ id: uuid(51), product_id: uuid(203), label: "Water", quantity: 2, unit: "packs" })];
  const key = market.marketDraftKey(uuid(9));
  const raw = JSON.stringify({ version: 1, items: original });
  local.setItem(key, raw);
  local.setItem(market.marketSuggestionsKey(uuid(9)), JSON.stringify({ version: 1, items: suggested }));
  const planner = await draftPlanner({ local, fromSuggestions: true });
  assert.deepEqual(JSON.parse(JSON.stringify(planner.checklist().props.items)), original);
  assert.equal(local.getItem(key), raw, "Opening refreshed suggestions must not replace an existing draft");
  const merge = nodes(planner.view.render()).find(node => node.type === "button" && node.props.children === "Add new suggestions");
  assert.ok(merge);
  merge.props.onClick(); await settle();
  const merged = market.parseMarketDraft(local.getItem(key)).items;
  assert.equal(merged.length, 3);
  assert.deepEqual(merged.slice(0, 2), original, "Names, quantities, flexibility and progress must survive the explicit merge");
  assert.equal(merged[2].product_id, uuid(203));
  assert.equal(planner.published.length, 0);
});

test("malformed optional caches preserve a usable checklist and unreadable details wait for an explicit edit", async () => {
  for (const cache of ["suggestions", "details", "published"]) {
    const local = memoryStorage();
    const key = market.marketDraftKey(uuid(9));
    const original = [item({ acquired_quantity: 6 }), item({ id: uuid(2), label: "Bebeto", quantity: 2, flexibility: "any_flavour" })];
    const raw = JSON.stringify({ version: 1, items: original });
    const corruptKey = cache === "suggestions" ? market.marketSuggestionsKey(uuid(9)) : `${key}:${cache}`;
    const malformed = "{unreadable optional cache";
    local.setItem(key, raw);
    local.setItem(corruptKey, malformed);
    const planner = await draftPlanner({ local, fromSuggestions: true });

    assert.deepEqual(JSON.parse(JSON.stringify(planner.checklist().props.items)), original, cache);
    assert.equal(planner.checklist().props.disabled, false, `${cache} must not disable shopping`);
    assert.equal(local.getItem(key), raw, `${cache} must not replace the saved checklist`);
    assert.equal(local.getItem(corruptKey), malformed, `${cache} must not be silently overwritten by hydration or buyer defaults`);
    assert.doesNotMatch(text(planner.view.render()), /Your saved draft could not be read/);
    assert.equal(await planner.checklist().props.onProgress({ item_id: uuid(2), acquired_quantity: 2, unavailable: false, note: "Found another flavour" }), true);
    assert.equal(market.parseMarketDraft(local.getItem(key)).items[1].acquired_quantity, 2);
    assert.equal(local.getItem(corruptKey), malformed, "Shopping progress must leave unrelated recovery data intact");

    if (cache === "suggestions") {
      assert.match(text(planner.view.render()), /New suggestions could not be opened/);
    } else {
      const form = nodes(planner.view.render()).find(node => node.type === "form");
      await form.props.onSubmit({ preventDefault() {} });
      assert.equal(planner.published.length, 0, "Unreviewed sharing metadata must not create a duplicate shared list");
    }
    if (cache === "details") {
      const title = nodes(planner.view.render()).find(node => node.type === "input" && node.props.maxLength === 160);
      title.props.onChange({ target: { value: "Reviewed market run" } });
      assert.equal(JSON.parse(local.getItem(corruptKey)).title, "Reviewed market run");
      assert.doesNotMatch(text(planner.view.render()), /List details could not be restored/);
    }
    assert.ok(planner.network.every(call => call.method === "GET"));
  }
});

test("a failed local progress write leaves both confirmed items and the saved checklist unchanged", async () => {
  const local = memoryStorage();
  const key = market.marketDraftKey(uuid(9));
  local.setItem(key, JSON.stringify({ version: 1, items: [item()] }));
  const planner = await draftPlanner({ local });
  const before = local.getItem(key);
  local.failWrites(true);
  assert.equal(await planner.checklist().props.onProgress({ item_id: uuid(1), acquired_quantity: 6, unavailable: false, note: "Found chips" }), false);
  assert.equal(local.getItem(key), before);
  assert.equal(planner.checklist().props.items[0].acquired_quantity, 0);
  assert.match(text(planner.view.render()), /draft change was not saved/);
  assert.equal(planner.published.length, 0);
  assert.ok(planner.network.every(call => call.method === "GET"));
  local.failWrites(false);
  assert.equal(await planner.checklist().props.onProgress({ item_id: uuid(1), acquired_quantity: 6, unavailable: false, note: "Found chips" }), true);
  assert.equal(market.parseMarketDraft(local.getItem(key)).items[0].acquired_quantity, 6);
});

test("a new local draft is account-scoped and generic checkbox progress never creates receipt lines", async () => {
  const local = memoryStorage();
  const otherKey = market.marketDraftKey(uuid(88));
  const otherDraft = JSON.stringify({ version: 1, items: [item({ label: "Other account's draft" })] });
  local.setItem(otherKey, otherDraft);
  const planner = await draftPlanner({ local });
  const key = market.marketDraftKey(uuid(9));
  assert.deepEqual(market.parseMarketDraft(local.getItem(key)).items, []);
  assert.equal(await planner.checklist().props.onAdd(item({ label: "Mr Crunch", flexibility: "any_flavour" })), true);
  assert.equal(await planner.checklist().props.onProgress({ item_id: uuid(1), acquired_quantity: 6, unavailable: false, note: "Found another flavour" }), true);
  const saved = market.parseMarketDraft(local.getItem(key)).items[0];
  assert.equal(saved.product_id, null);
  assert.equal(saved.acquired_quantity, 6);
  assert.equal(local.getItem(otherKey), otherDraft);
  assert.equal(planner.published.length, 0);
  assert.ok(planner.network.every(call => call.method === "GET"));
  const receipt = nodes(planner.view.render()).find(node => node.type === "a" && node.props.children === "Record receipt");
  assert.equal(receipt.props.href, "/purchases/new");
  assert.equal(receipt.props.href.includes("source="), false, "The generic need is never seeded as the product actually bought");
});

test("a confirmed unchanged shared publication opens its existing list, including after draft reload", async () => {
  const local = memoryStorage();
  const key = market.marketDraftKey(uuid(9));
  local.setItem(key, JSON.stringify({ version: 1, items: [item()] }));
  local.setItem(`${key}:details`, JSON.stringify({ title: "Market run", buyer: uuid(90), due: "2026-10-28", instructions: "Any flavour is fine" }));
  const planner = await draftPlanner({ local });
  const submit = () => nodes(planner.view.render()).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  await submit();
  assert.equal(planner.published.length, 1);
  const listId = planner.published[0].list_id;
  assert.equal(planner.harness.navigations.at(-1), `/buying-lists/${listId}`);
  await submit();
  assert.equal(planner.published.length, 1, "The same confirmed draft must not create a second shared list");
  assert.equal(planner.harness.navigations.at(-1), `/buying-lists/${listId}`);
  const reloaded = await draftPlanner({ local });
  await nodes(reloaded.view.render()).find(node => node.type === "form").props.onSubmit({ preventDefault() {} });
  assert.equal(reloaded.published.length, 0, "The persisted publication receipt remains authoritative after reload");
  assert.deepEqual(reloaded.harness.navigations, [`/buying-lists/${listId}`]);
});
