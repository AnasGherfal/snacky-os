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
    stockTabs: ["/inventory", "/restock-priority", "/purchases", "/products"],
    crmTabs: ["/issues/new", "/my-work", "/locations-pipeline", "/issues"],
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
  assert.ok(moduleItems("crmTabs").includes("/my-work/notes"));
  assert.match(sidebar, /items: \[operationsItem, cashCustodyItem, stockItem, machinesItem, crmItem/);
});

test("Storage keeps only daily actions while advanced tools live in grouped More", () => {
  assert.match(storage, /href="\/restock-priority\/purchase-list"/);
  assert.match(storage, /href="\/inventory\/stocktake"/);
  assert.match(storage, /tr\("What to buy",/);
  assert.match(storage, /tr\("Count storage",/);
  assert.doesNotMatch(storage, /More storage tools and help/);
  assert.doesNotMatch(storage, /href="\/inventory\/movements\/new"/);
  for (const href of [
    "/restock-priority/purchase-list", "/inventory/stocktake", "/inventory/stock-check",
    "/inventory/machine-storage", "/inventory/movements", "/inventory/movements/new",
    "/storage-locations", "/product-planning", "/suppliers",
  ]) {
    assert.ok(moduleItems("stockTabs").includes(href), `Missing advanced stock destination: ${href}`);
  }
  assert.match(config, /group: "Buying", groupAr: "الشراء"/);
  assert.match(config, /group: "Stock checks", groupAr: "الجرد ومراجعة المخزون"/);
  assert.match(tabs, /tab\.group/);
  assert.match(tabs, /tab\.groupAr/);
});
