import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appRoles, canAccessPath } from "../src/lib/authz.ts";
import { activeTabForPath, getModuleTabGroupForPath, navigationForUser, navigationModules, pathnameFromHref, resolveNavigation } from "../src/components/module-tabs-config.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const actor = (role, roles = [role]) => ({ id: "auth-user", role, roles, teamMemberId: "self-member", activeStatus: "active" });
const destinations = (modules) => modules.flatMap((module) => module.sections.flatMap((section) => section.tabs));
const locate = (href, role = "owner") => resolveNavigation(href, "", navigationForUser(actor(role)));

test("every registered destination belongs to its displayed workspace", () => {
  for (const module of navigationModules) for (const section of module.sections) for (const tab of section.tabs) {
    const location = resolveNavigation(tab.href);
    assert.equal(location?.module.id, module.id, tab.href);
    assert.equal(location?.section.id, section.id, tab.href);
    assert.equal(location?.tab.href, tab.href, tab.href);
  }
});

test("CRM list, records and support never change to the Machines workspace", () => {
  for (const path of ["/locations-pipeline", "/locations-pipeline/new", "/locations-pipeline/lead-1", "/issues", "/issues/issue-1", "/issues/issue-1/edit"]) {
    assert.equal(locate(path)?.module.id, "crm", path);
  }
  assert.equal(locate("/locations-pipeline/lead-1")?.section.id, "leads");
  assert.equal(locate("/issues/issue-1")?.section.id, "support");
  assert.equal(locate("/machines/machine-1")?.module.id, "machines");
});

test("purchase ownership ignores legacy module hints, filters and entry roles", () => {
  for (const role of ["owner", "admin", "supervisor", "finance", "warehouse", "purchasing"]) {
    for (const path of ["/purchases", "/purchases/record", "/purchases/record/edit", "/purchases/?module=finance", "/purchases/record?module=finance&page=2"]) {
      assert.equal(locate(path, role)?.module.id, "inventory", `${role} ${path}`);
      assert.equal(locate(path, role)?.section.id, "purchasing", `${role} ${path}`);
    }
  }
  assert.equal(getModuleTabGroupForPath("/purchases", "finance")?.name, "Inventory & Purchasing");
});

test("all shown links and each workspace landing respect existing permissions", () => {
  const users = [...appRoles.map((role) => actor(role)), actor("operator", ["operator", "warehouse"]), actor("crm", ["crm", "finance"]), actor("owner", ["owner", "investor"])];
  for (const user of users) {
    const modules = navigationForUser(user);
    assert.equal(new Set(modules.map((module) => module.id)).size, modules.length);
    for (const module of modules) {
      assert.ok(canAccessPath(user, pathnameFromHref(module.href)), `${user.role}: landing ${module.href}`);
      assert.equal(resolveNavigation(module.href, "", modules)?.module.id, module.id);
      for (const item of destinations([module])) assert.ok(canAccessPath(user, pathnameFromHref(item.href)), `${user.role}: ${item.href}`);
    }
  }
  assert.equal(navigationForUser(actor("purchasing")).find((module) => module.id === "inventory")?.href, "/purchases");
  assert.equal(navigationForUser(actor("finance")).find((module) => module.id === "inventory")?.href, "/purchases");
  assert.equal(navigationForUser(actor("supervisor")).find((module) => module.id === "admin")?.href, "/vms-import");
});

test("CRM and field roles do not inherit financial or administrative navigation", () => {
  assert.deepEqual(navigationForUser(actor("crm")).map((module) => module.id), ["crm", "machines", "account"]);
  assert.deepEqual(navigationForUser(actor("operator")).map((module) => module.id), ["operations", "cash", "account"]);
  assert.deepEqual(navigationForUser(actor("investor")).map((module) => module.id), ["investor", "account"]);
  assert.deepEqual(navigationForUser(null), []);
  assert.deepEqual(navigationForUser({ ...actor("owner"), activeStatus: "inactive" }), []);
});

test("multi-role navigation is a deduplicated union, not a fallback viewer menu", () => {
  const modules = navigationForUser(actor("crm", ["crm", "warehouse", "operator"]));
  assert.ok(modules.some((module) => module.id === "crm"));
  assert.ok(modules.some((module) => module.id === "operations"));
  assert.ok(modules.some((module) => module.id === "inventory"));
  assert.equal(modules.some((module) => module.id === "finance"), false);
  const hrefs = destinations(modules).map((item) => item.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
});

test("one most-specific tab is selected on nested paths, edits and query views", () => {
  const cases = [
    ["/vms-import/sources", "admin", "integrations", "/vms-import/sources"],
    ["/vms-import/monthly-profit-repair", "admin", "integrations", "/vms-import/monthly-profit-repair"],
    ["/admin/finance-health", "finance", "review", "/admin/finance-health"],
    ["/admin/stop-override", "operations", "recovery", "/admin/stop-override"],
    ["/machines/record/edit", "machines", "machines", "/machines"],
    ["/machines/status", "machines", "health", "/machines/status"],
    ["/inventory/movements/new", "inventory", "stock", "/inventory/movements"],
    ["/operator/routes?view=available", "operations", "field", "/operator/routes?view=available"],
    ["/operator/routes/record?view=available", "operations", "field", "/operator/routes"],
    ["/operator/routes?view=completed", "operations", "field", "/operator/routes"],
    ["/operator/issues", "operations", "field", "/operator/issues"],
    ["/cash-collections/new", "cash", "removal", "/cash-collections/new"],
    ["/cash-collections/record", "cash", "collections", "/cash-collections"],
    ["/products-dashboard", "reports", "analytics", "/products-dashboard"],
    ["/finance/transactions/record/edit", "finance", "ledger", "/finance/transactions"],
  ];
  for (const [path, moduleId, sectionId, href] of cases) {
    const location = locate(path);
    assert.equal(location?.module.id, moduleId, path);
    assert.equal(location?.section.id, sectionId, path);
    assert.equal(location?.tab.href, href, path);
    assert.equal(activeTabForPath(location.section.tabs, path)?.href, href, path);
  }
});

test("deep-link back/forward resolution has no dependence on the previous page", () => {
  const pages = ["/locations-pipeline/a", "/issues/b", "/machines/c", "/purchases/d?module=finance", "/locations-pipeline/a"];
  const forward = pages.map((page) => locate(page)?.module.id);
  assert.deepEqual(forward, ["crm", "crm", "machines", "inventory", "crm"]);
  assert.deepEqual([...pages].reverse().map((page) => locate(page)?.module.id), [...forward].reverse());
});

test("personal profiles do not activate Administration for restricted users", () => {
  assert.equal(locate("/team/self-member", "operator")?.module.id, "account");
  assert.equal(locate("/team/self-member/money", "operator")?.tab.href, "/team/self-member/money");
  assert.equal(locate("/team/other-member", "operator"), null);
  assert.equal(locate("/team/self-member/edit", "owner")?.module.id, "admin");
});

test("path boundaries and trailing slashes cannot select unrelated workspaces", () => {
  for (const path of ["/finances", "/products-other", "/locations-pipeline-old", "/unknown"]) assert.equal(resolveNavigation(path), null, path);
  assert.equal(locate("/locations-pipeline/?page=2#notes")?.module.id, "crm");
});

test("menus remain bilingual and grouped rather than exposing a 15-tab strip", () => {
  const arabic = /[\u0600-\u06ff]/;
  for (const module of navigationModules) {
    assert.ok(arabic.test(module.nameAr), module.id);
    assert.ok(module.sections.length <= 6, module.id);
    for (const section of module.sections) {
      assert.ok(arabic.test(section.labelAr), section.id);
      assert.ok(section.tabs.length <= 6, section.id);
      for (const tab of section.tabs) assert.ok(arabic.test(tab.labelAr), tab.href);
    }
  }
});

test("registered navigation links point to real page files", () => {
  for (const item of destinations(navigationModules)) {
    const path = pathnameFromHref(item.href);
    assert.ok(existsSync(join(root, "src/app", path, "page.tsx")), `Missing navigation destination: ${path}`);
  }
});

test("every application page has a canonical workspace", () => {
  const app = join(root, "src/app");
  function walk(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name === "page.tsx" ? [join(directory, entry.name)] : []);
  }
  for (const file of walk(app)) {
    const path = `/${relative(app, file).replaceAll("\\", "/").replace(/\/?page\.tsx$/, "").replace(/\([^/]+\)\//g, "").replace(/\[.*?\]/g, "record")}`;
    if (["/", "/login", "/unauthorized"].some((publicPath) => path === publicPath || (publicPath !== "/" && path.startsWith(`${publicPath}/`)))) continue;
    assert.ok(resolveNavigation(path), `No navigation owner: ${path}`);
  }
});

test("all navigation surfaces use the shared state; auth and session protection stay present", () => {
  for (const component of ["Sidebar", "Topbar", "ModuleTabsLayout"]) {
    const source = readFileSync(join(root, `src/components/${component}.tsx`), "utf8");
    assert.ok(source.includes("useAppNavigation"), component);
    assert.ok(!source.includes("sectionsForRoles") && !source.includes("titleKeys"), component);
    assert.ok(!source.includes("router.prefetch("), component);
  }
  const shell = readFileSync(join(root, "src/components/ShellChrome.tsx"), "utf8");
  assert.ok(shell.includes("<NavigationProvider"));
  assert.ok(shell.includes("<SessionGuard"));
  assert.ok(shell.includes("<XyBackgroundSync"));
  const server = readFileSync(join(root, "src/components/AppShell.tsx"), "utf8");
  assert.ok(server.includes("requireShellProfile") && server.includes("canAccessPath"));
});
