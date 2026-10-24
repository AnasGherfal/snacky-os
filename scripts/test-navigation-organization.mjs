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

test("Storage keeps its main actions and bilingual accessible detail sections", () => {
  assert.match(storage, /href="\/restock-priority\/purchase-list"/);
  assert.match(storage, /href="\/inventory\/stocktake"/);
  assert.match(storage, /href="\/inventory\/movements\/new"/);
  for (const label of ["What to buy", "Count storage", "Manual adjustment", "More storage tools and help", "Operator bag stock", "Recent stock movements"]) {
    assert.ok(storage.includes(`tr("${label}",`), `Missing bilingual label: ${label}`);
  }
  assert.match(storage, /<details className="mt-6 rounded-xl border border-slate-200 bg-white p-4"/);
});
