import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { organizeModuleNavigation, moduleTabMatchScore } from "../src/components/module-navigation-organization.ts";
import { getAppModuleKey } from "../src/components/app-navigation.ts";
import { canAccessPath } from "../src/lib/authz.ts";

const makeTabs = (number = 12) => Array.from({ length: number }, (_, n) => ({
  href: `/sample/${n}`,
  label: `Section ${n}`,
  labelAr: `قسم ${n}`,
  primary: [1, 3, 5, 7, 9].includes(n),
}));

test("12-tab modules show at most five everyday choices and keep every old href accessible", () => {
  const tabs = makeTabs();
  const { primary, overflow } = organizeModuleNavigation(tabs, "/sample/1");
  assert.equal(primary.length, 5);
  assert.equal(overflow.length, 7);
  assert.equal(new Set([...primary, ...overflow].map((x) => x.href)).size, 12);
  assert.deepEqual(new Set([...primary, ...overflow].map((x) => x.href)), new Set(tabs.map((x) => x.href)));
  assert.deepEqual(primary.map((x) => x.href), ["/sample/1","/sample/3","/sample/5","/sample/7","/sample/9"]);
});

test("deep linked active section is always visible without dropping the replaced shortcut", () => {
  const tabs = makeTabs();
  const { primary, overflow, activeTab } = organizeModuleNavigation(tabs, "/sample/11/edit");
  assert.equal(activeTab?.href, "/sample/11");
  assert(primary.some((tab) => tab.href === activeTab?.href));
  assert(overflow.some((tab) => tab.href === "/sample/9"));
  assert.equal([...primary, ...overflow].length, tabs.length);
  // pure helper must not reorder/mutate the original module configuration
  assert.equal(tabs[9].href, "/sample/9");
});

test("short menus stay untouched; boundary matching never activates unrelated routes", () => {
  const tabs = [{href:"/products",label:"Products"}, {href:"/products/new",label:"New",exact:true},{href:"/purchases",label:"Purchases"}];
  const result = organizeModuleNavigation(tabs, "/products/abc");
  assert.equal(result.overflow.length, 0);
  assert.deepEqual(result.primary, tabs);
  assert.equal(result.activeTab?.href, "/products");
  assert.equal(moduleTabMatchScore("/products-dashboard", tabs[0]), -1);
  assert.equal(moduleTabMatchScore("/products/new/edit", tabs[1]), -1);
});

test("Cash handling now belongs in the Cash menu while role authorization is unchanged", () => {
  const owner = {id:"owner",role:"owner",roles:["owner"],activeStatus:"active",teamMemberId:"owner-team"};
  const operator = {id:"operator",role:"operator",roles:["operator"],activeStatus:"active",teamMemberId:"operator-team"};
  assert.equal(getAppModuleKey("/cash-handling"),"cash");
  assert.equal(getAppModuleKey("/cash-collections/new"),"cash");
  assert.equal(canAccessPath(owner, "/cash-handling"),true);
  assert.equal(canAccessPath(operator,"/cash-handling"),true);
  assert.equal(canAccessPath(operator,"/finance"),false);
  const tabs = fs.readFileSync("src/components/module-tabs-config.ts","utf8");
  assert.match(tabs, /label: "Cash Handling", href: "\/cash-handling"/);
});

test("No full-section prefetch storm: prefetch only on user hover/focus", () => {
  const source = fs.readFileSync("src/components/ModuleTabs.tsx","utf8");
  assert.doesNotMatch(source,/tabs\.forEach\(\(tab\) => router\.prefetch\(tab.href\)\)/);
  assert.doesNotMatch(source,/prefetch=\{true\}/);
  assert.match(source,/prefetch=\{false\}/);
  assert.match(source,/onMouseEnter=\{\(\) => prefetchOnIntent\(tab.href\)\}/);
  assert.match(source,/onFocus=\{\(\) => prefetchOnIntent\(tab.href\)\}/);
});

test("Navigation remains semantic links with accessible More menu and Arabic copy", () => {
  const source=fs.readFileSync("src/components/ModuleTabs.tsx","utf8");
  assert.match(source, /<nav aria-label=/);
  assert.match(source, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(source, /<details ref=\{overflowRef\}/);
  assert.match(source, /<summary/);
  assert.match(source, /"المزيد"/);
  assert.match(source, /event.key === "Escape"/);
  assert.doesNotMatch(source, /role="tablist"|role="tab"/);
});

test("owner/supervisor have only one Cash entry in sidebar, other role navigation preserved", () => {
  const sidebar=fs.readFileSync("src/components/Sidebar.tsx","utf8");
  assert.match(sidebar,/ownerAdminNav/);
  assert.match(sidebar,/supervisorNav/);
  assert.match(sidebar,/work\.push\(cashHandlingItem\)/);
  assert.match(sidebar,/work\.push\(cashCustodyItem\)/);
  const branch=sidebar.slice(sidebar.indexOf("const ownerAdminNav:"),sidebar.indexOf("const operatorNavItems:"));
  assert.doesNotMatch(branch,/cashCustodyItem, cashHandlingItem/);
});
