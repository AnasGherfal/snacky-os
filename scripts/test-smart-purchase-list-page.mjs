import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = fs.readFileSync(new URL("../src/app/restock-priority/purchase-list/page.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const previousPeriod = { start: "2026-08-01", end: "2026-08-31", coveredDays: 31, daysInMonth: 31 };
const currentPeriod = { start: "2026-09-01", end: "2026-09-16", coveredDays: 16, daysInMonth: 30 };
const item = { productId: "fast", name: "Fast", sku: "F", previousMonthUnits: 310, currentMonthUnits: 240,
  currentMonthProjectedUnits: 450, previousDailyRate: 10, currentDailyRate: 15, demandDailyRate: 15,
  storageQty: 5, stockCoverageDays: 0.3, coverageTargetDays: 7, targetStockQty: 105, suggestedBuyQty: 100,
  lastPurchaseCost: 2, estimatedBuyCost: 200, demandBasis: "current" };

async function render(overrides = {}, locale = "en", authorize = true) {
  const result = { items: [item], previousPeriod, currentPeriod, errors: {}, storageLoaded: true,
    unmappedSalesRows: 0, unmappedSalesUnits: 0, productCount: 1, ...overrides };
  const events = [];
  const jsx = (type, props) => typeof type === "function" ? type(props) : ({ type, props });
  const widgets = Object.fromEntries(["DataTable", "EmptyState", "ErrorState", "MobileCardList", "MobileField", "MobileRecordCard", "PageHeader"].map(name => [name, name]));
  const imports = {
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/link": { default: "a" },
    "@/components/CreatePurchaseListButton": { CreatePurchaseListButton: "purchase-draft-button" },
    "@/components/ui": widgets,
    "@/lib/auth": {
      requireCurrentProfileForPath: async path => { events.push(path); if (!authorize) throw new Error("unauthorized"); },
      getAuthenticatedSupabaseServerClient: async () => ({}),
    },
    "@/lib/i18n/server": { getServerI18n: async () => ({ locale, direction: locale === "ar" ? "rtl" : "ltr" }) },
    "@/lib/purchase-list-data": { loadPurchaseListData: async () => { events.push("load"); return result; } },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) { assert.ok(name in imports, name); return imports[name]; } });
  const tree = await exports.default({ searchParams: Promise.resolve({ days: "7" }) });
  const nodes = [];
  function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    nodes.push(node); walk(node.props?.children); walk(node.props?.action);
  }
  walk(tree);
  return { tree, nodes, text: JSON.stringify(tree), events };
}

for (const key of ["sales", "salesBatches", "products"]) {
  test(`failed ${key} read cannot claim covered stock or create a purchase`, async () => {
    const { nodes, text } = await render({ errors: { [key]: "query timeout" }, items: [] });
    assert.ok(nodes.some(node => node.type === "ErrorState"));
    assert.equal(nodes.some(node => node.type === "purchase-draft-button"), false);
    assert.doesNotMatch(text, /Nothing to buy|already covers|Products to buy/);
    assert.match(text, /No zero sales/);
  });
}

test("storage failure hides buy quantities and draft actions instead of treating stock as zero", async () => {
  const { nodes, text } = await render({ errors: { storage: "timeout" }, storageLoaded: false });
  assert.match(text, /Current storage could not be verified/);
  assert.equal(nodes.some(node => node.type === "purchase-draft-button"), false);
  assert.doesNotMatch(text, /Nothing to buy/);
});

test("missing current report is not displayed as zero sales or a slowing trend", async () => {
  const { text, nodes } = await render({ currentPeriod: null, items: [{ ...item, currentMonthUnits: 0, currentMonthProjectedUnits: 0, currentDailyRate: 0 }] });
  assert.match(text, /use last month only/);
  assert.doesNotMatch(text, /Slower this month|Faster this month/);
  const field = nodes.find(node => node.type === "MobileField" && node.props.label === "This month");
  assert.equal(field.props.children[0].props.children, "—");
});

test("unmapped or absent eligible sellers never imply adequate storage", async () => {
  const { text } = await render({ items: [], unmappedSalesUnits: 80, unmappedSalesRows: 2 });
  assert.match(text, /No mapped recent sellers/);
  assert.doesNotMatch(text, /Nothing to buy|already covers/);
});

test("verified empty buying gap remains distinct from a loading failure", async () => {
  const { text } = await render({ items: [{ ...item, suggestedBuyQty: 0, estimatedBuyCost: 0 }] });
  assert.match(text, /Nothing to buy for this coverage window/);
  assert.doesNotMatch(text, /could not be verified/);
});

test("valid data offers only actionable draft quantities after page authorization", async () => {
  const { nodes, events } = await render();
  assert.deepEqual(events, ["/restock-priority/purchase-list", "load"]);
  const buttons = nodes.filter(node => node.type === "purchase-draft-button");
  assert.ok(buttons.length > 0);
  assert.equal(buttons[0].props.items[0].suggestedQty, 100);
  await assert.rejects(render({}, "en", false), /unauthorized/);
});

test("Arabic error rendering retains RTL and cannot offer a draft", async () => {
  const { tree, nodes, text } = await render({ errors: { sales: "timeout" } }, "ar");
  assert.equal(tree.props.dir, "rtl");
  assert.match(text, /تعذر التحقق/);
  assert.equal(nodes.some(node => node.type === "purchase-draft-button"), false);
});
