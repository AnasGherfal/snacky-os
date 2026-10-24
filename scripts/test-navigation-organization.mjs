import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (name) => readFileSync(path.join(root, name), "utf8");
const config = source("src/components/module-tabs-config.ts");
const tabs = source("src/components/ModuleTabs.tsx");
const modules = source("src/components/app-navigation.ts");
const sidebar = source("src/components/Sidebar.tsx");
const storage = source("src/app/inventory/page.tsx");

function moduleItems(name) {
  const start = `const ${name}: ModuleTab[] = [`;
  const from = config.indexOf(start);
  assert.ok(from >= 0, `Missing ${name}`);
  const until = config.indexOf("\n];", from);
  assert.ok(until > from, `Missing close of ${name}`);
  const raw = config.slice(from + start.length, until);
  return [...raw.matchAll(/href: "([^"]+)"/g)].map((match) => match[1]);
}

test("daily workflows have consistent primary tab order", () => {
  const expected = {
    stockTabs: ["/inventory", "/restock-priority/purchase-list", "/purchases", "/products"],
    crmTabs: ["/my-work", "/issues", "/locations-pipeline", "/relationships"],
    financeTabs: ["/finance", "/finance/transactions", "/finance/expenses", "/finance/rent"],
    adminTabs: ["/admin", "/team", "/settings", "/vms-import"],
    reportsTabs: ["/reports", "/sales", "/reports/cash-reconciliation", "/reports/route-performance"],
  };
  for (const [name, firstFour] of Object.entries(expected)) {
    const items = moduleItems(name);
    assert.deepEqual(items.slice(0, 4), firstFour, name);
    assert.equal(new Set(items).size, items.length, `${name} has duplicate destinations`);
    assert.ok(items.length > 4, `${name} should retain its advanced tools`);
  }
});

test("secondary tabs are reachable through More and do not prefetch everything", () => {
  assert.match(tabs, /const primaryTabs = tabs\.slice\(0, 4\)/);
  assert.match(tabs, /const extraTabs = tabs\.slice\(primaryTabs\.length\)/);
  assert.match(tabs, /extraTabs\.map/);
  assert.match(tabs, /aria-current=\{active \? "page"/);
  assert.doesNotMatch(tabs, /tabs\.forEach\(\(tab\) => router\.prefetch/);
});

test("cash handling and health stay discoverable when sidebar is simplified", () => {
  assert.match(modules, /"\/cash-handling"/);
  assert.match(modules, /"\/operations-health"/);
  assert.ok(moduleItems("cashTabs").includes("/cash-handling"));
  assert.ok(moduleItems("adminTabs").includes("/operations-health"));
  assert.ok(moduleItems("adminTabs").includes("/admin/testing-lab"));
  assert.ok(moduleItems("crmTabs").includes("/issues/new"));
  assert.match(sidebar, /items: \[operationsItem, cashCustodyItem, stockItem, machinesItem, crmItem/);
});

test("daily Stock navigation contains no duplicated diagnostic or buying screens", () => {
  const items = moduleItems("stockTabs");
  assert.deepEqual(items, [
    "/inventory", "/restock-priority/purchase-list", "/purchases", "/products",
    "/buying-lists", "/inventory/stocktake", "/inventory/movements",
    "/inventory/reconciliation", "/suppliers",
  ]);
  for (const retiredShortcut of [
    "/restock-priority", "/inventory/stock-check", "/inventory/machine-storage",
    "/inventory/movements/new", "/product-planning", "/storage-locations",
  ]) assert.equal(items.includes(retiredShortcut), false, `redundant shortcut: ${retiredShortcut}`);
  assert.match(storage, /href="\/restock-priority\/purchase-list"/);
  assert.match(storage, /href="\/inventory\/stocktake"/);
  assert.match(config, /group: "Stock controls", groupAr: "مراجعة المخزون"/);
  assert.match(tabs, /extraTabs\.map/);
});

test("CRM and Reports show only decision-making pages", () => {
  assert.deepEqual(moduleItems("crmTabs").slice(0, 4), [
    "/my-work", "/issues", "/locations-pipeline", "/relationships",
  ]);
  assert.equal(moduleItems("crmTabs").includes("/my-work/search"), false);
  assert.equal(moduleItems("crmTabs").includes("/my-work/notes"), false);
  assert.deepEqual(moduleItems("reportsTabs"), [
    "/reports", "/sales", "/reports/cash-reconciliation",
    "/reports/route-performance", "/reports/route-product-activity",
  ]);
});
