import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import {
  activeMobileShortcutIndex,
  getRoleMobileDestinations,
  mobileRoleKind,
  showRoleMobileNavigation,
} from "../src/lib/role-mobile-navigation.ts";
import { canAccessPath } from "../src/lib/authz.ts";
import { getAppModuleKey } from "../src/components/app-navigation.ts";

const source = (path) => readFileSync(path, "utf8");
const component = source("src/components/RoleMobileNavigation.tsx");
const shell = source("src/components/ShellChrome.tsx");
const sidebar = source("src/components/Sidebar.tsx");
const config = source("src/components/module-tabs-config.ts");
const appModules = source("src/components/app-navigation.ts");

function profile(role, roles = [role]) {
  return { id: "11111111-1111-4111-8111-111111111111",
    role, roles, active_status: "active", team_member_id: null, can_add_products: false };
}
function routes(role, roles) { return getRoleMobileDestinations(profile(role, roles)).map((x) => x.href); }

test("role shortcuts prioritize the correct daily workflow instead of an owner-only menu", () => {
  assert.deepEqual(routes("owner"), ["/dashboard", "/routes", "/inventory", "/machines"]);
  assert.deepEqual(routes("crm"), ["/my-work", "/issues", "/locations-pipeline", "/relationships"]);
  assert.deepEqual(routes("operator"), ["/operator/routes", "/operator/routes?view=available", "/operator/issues", "/cash-handling"]);
  assert.deepEqual(routes("warehouse"), ["/my-day", "/warehouse/pick-lists", "/inventory", "/buying-lists"]);
  assert.deepEqual(routes("purchasing"), ["/my-day", "/buying-lists", "/purchases", "/products"]);
  assert.deepEqual(routes("finance"), ["/finance", "/finance/transactions", "/cash-handling", "/buying-lists"]);
  assert.deepEqual(routes("investor"), ["/investor", "/account"]);
  assert.ok(routes("viewer").includes("/account"));
});

test("every displayed shortcut is authorized by the same application access rules", () => {
  const roles = ["owner", "admin", "supervisor", "crm", "operator", "warehouse", "purchasing", "finance", "investor", "viewer"];
  for (const role of roles) {
    const user = profile(role);
    const items = getRoleMobileDestinations(user);
    assert.ok(items.length >= 1 && items.length <= 4, `${role}: expected useful shortcuts`);
    assert.equal(new Set(items.map(x => x.href)).size, items.length, `${role}: duplicates`);
    for (const item of items) {
      assert.ok(canAccessPath({
        id: user.id, role: user.role, roles: user.roles, activeStatus: user.active_status,
        canAddProducts: user.can_add_products, teamMemberId: user.team_member_id,
      }, item.href.split("?")[0]), `${role}: unauthorized ${item.href}`);
      assert.ok(item.ar && item.en, `${role}: untranslated shortcut`);
    }
  }
  assert.equal(getRoleMobileDestinations({ ...profile("crm"), active_status: "inactive" }).length, 0);
  assert.equal(routes("operator").includes("/finance"), false);
  assert.equal(routes("crm").includes("/inventory/movements/new"), false);
  assert.equal(routes("investor").includes("/finance"), false);
});

test("multi-role users retain their primary work without accidentally gaining owner shortcuts", () => {
  assert.equal(mobileRoleKind(profile("warehouse", ["operator", "warehouse"])), "warehouse");
  assert.ok(routes("warehouse", ["operator", "warehouse"]).includes("/warehouse/pick-lists"));
  assert.equal(mobileRoleKind(profile("operator", ["operator", "crm"])), "operator");
  assert.deepEqual(routes("operator", ["operator", "crm"]).slice(0, 2), ["/operator/routes", "/operator/routes?view=available"]);
  assert.equal(mobileRoleKind(profile("crm", ["crm", "owner"])), "owner");
  assert.deepEqual(routes("crm", ["crm", "owner"]), routes("owner"));
});

test("current route execution does not get covered by the mobile bottom bar", () => {
  assert.equal(showRoleMobileNavigation(profile("operator"), "/operator/routes"), true);
  assert.equal(showRoleMobileNavigation(profile("operator"), "/operator/routes/route-id/stops/stop-id"), false);
  assert.equal(showRoleMobileNavigation(profile("warehouse", ["operator", "warehouse"]), "/operator/routes/id/stops/id"), false);
  assert.equal(showRoleMobileNavigation(profile("crm"), "/issues"), true);
  assert.equal(showRoleMobileNavigation({ ...profile("operator"), active_status: "inactive" }, "/operator/routes"), false);
});

test("active state differentiates Available routes and ledger from their parent modules", () => {
  const op = getRoleMobileDestinations(profile("operator"));
  assert.equal(activeMobileShortcutIndex(op, "/operator/routes", "", null), 0);
  assert.equal(activeMobileShortcutIndex(op, "/operator/routes", "view=available", null), 1);
  assert.equal(activeMobileShortcutIndex(op, "/operator/routes/abc", "", null), 0);
  const fin = getRoleMobileDestinations(profile("finance"));
  assert.equal(activeMobileShortcutIndex(fin, "/finance/transactions", "", "finance"), 1);
  assert.equal(activeMobileShortcutIndex(fin, "/finance", "", "finance"), 0);
  const mgr = getRoleMobileDestinations(profile("owner"));
  assert.equal(activeMobileShortcutIndex(mgr, "/restock-priority", "", "stock"), 2);
});

test("sidebar no longer duplicates CRM Notes, supervisor Cash, and warehouse stock active state", () => {
  assert.doesNotMatch(sidebar, /managementNotesItem/);
  assert.match(sidebar, /!hasAnyRole\(context, \["warehouse", "purchasing"\]\)/);
  assert.doesNotMatch(sidebar, /items: \[operationsItem, cashCustodyItem, cashHandlingItem, stockItem/);
  assert.match(sidebar, /canAccessPath\(context, pathWithoutQuery\(item.href\)\)/);
  assert.ok(!appModules.includes('"/products", "/warehouse"'));
  assert.match(config, /group: "Locations & contacts"/);
  assert.match(config, /group: "People & obligations"/);
});

function* walk(node) {
  if (Array.isArray(node)) { for (const child of node) yield* walk(child); return; }
  if (!node || typeof node !== "object") return;
  yield node;
  yield* walk(node.props?.children);
}
function render({ role = "crm", locale = "ar", pathname = "/issues", query = "" } = {}) {
  const transpiled = ts.transpileModule(component, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  let drawerOpened = 0;
  vm.runInNewContext(transpiled, {
    exports,
    require(name) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/link") return { default: "a" };
      if (name === "next/navigation") return { usePathname: () => pathname, useSearchParams: () => new URLSearchParams(query) };
      if (name === "lucide-react") return new Proxy({}, { get: (_, icon) => String(icon) });
      if (name === "@/components/I18nProvider") return { useLanguage: () => ({ locale }) };
      if (name === "@/components/app-navigation") return { getAppModuleKey };
      if (name === "@/lib/role-mobile-navigation") return { activeMobileShortcutIndex, getRoleMobileDestinations, mobileRoleKind, showRoleMobileNavigation };
      throw Error(`Unexpected import ${name}`);
    },
  });
  const tree = exports.RoleMobileNavigation({ profile: profile(role), onOpenMenu: () => { drawerOpened++; } });
  return { tree, nodes: [...walk(tree)], drawerOpened: () => drawerOpened };
}
test("real role navigation renders Arabic links and opens the existing More drawer", () => {
  const view = render();
  assert.equal(view.tree.props.dir, "rtl");
  const hrefs = view.nodes.filter(n => n.props?.href).map(n => n.props.href);
  assert.deepEqual(hrefs, routes("crm"));
  assert.equal(view.nodes.find(n => n.props?.href === "/issues").props["aria-current"], "page");
  const texts = view.nodes.map(n => n.props?.children).filter(x => typeof x === "string");
  for (const value of ["عملي", "البلاغات", "الجهات", "المواقع", "المزيد"]) assert.ok(texts.includes(value), value);
  const button = view.nodes.find(n => n.type === "button");
  assert.equal(button.props["aria-haspopup"], "dialog");
  button.props.onClick();
  assert.equal(view.drawerOpened(), 1);
});
test("investors have only authorized links, no duplicate More; operators keep stop actions unobstructed", () => {
  const view = render({ role: "investor", locale: "en", pathname: "/investor" });
  assert.deepEqual(view.nodes.filter(n => n.props?.href).map(n => n.props.href), routes("investor"));
  assert.equal(view.nodes.find(n => n.type === "button"), undefined);
  assert.equal(render({ role: "operator", pathname: "/operator/routes/a/stops/b" }).tree, null);
  assert.match(shell, /showRoleMobileNavigation\(profile, activePath\)/);
  assert.match(shell, /hasMobileNav \? "pb-24" : "pb-4"/);
});
