import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as authz from "../src/lib/authz.ts";
import { getAppModuleKey } from "../src/components/app-navigation.ts";

const source = (p) => readFileSync(p, "utf8");
const mobile = source("src/components/OwnerMobileNavigation.tsx");
const chrome = source("src/components/ShellChrome.tsx");
const storage = source("src/app/inventory/page.tsx");
const nav = source("src/components/ModuleTabs.tsx");

test("owner mobile navigation is role-gated and respects individual link permissions", () => {
  assert.match(mobile, /!isOwnerAdminRole\(profile\) && !isSupervisorRole\(profile\)/);
  assert.match(mobile, /primaryDestinations\.filter\(\(item\) => canAccessPath\(context, item\.href\)\)/);
  assert.match(mobile, /href: "\/dashboard"/);
  assert.match(mobile, /href: "\/routes"/);
  assert.match(mobile, /href: "\/inventory"/);
  assert.match(mobile, /href: "\/machines"/);
  assert.match(mobile, /aria-current=\{active \? "page" : undefined\}/);
});

test("More opens the existing permission-scoped sidebar, not a second menu", () => {
  assert.match(mobile, /onClick=\{onOpenMenu\}/);
  assert.match(mobile, /aria-haspopup="dialog"/);
  assert.match(chrome, /onOpenMenu=\{\(\) => setMobileNavOpen\(true\)\}/);
  assert.match(chrome, /hasManagementMobileNav \? <OwnerMobileNavigation/);
  assert.match(chrome, /hasManagementMobileNav \? "pb-24" : "pb-4"/);
  assert.doesNotMatch(mobile, /getSupabaseAdminClient|service_role|\bfetch\(/);
});

test("mobile navigation is RTL-aware and has a bottom safe-area offset", () => {
  assert.match(mobile, /dir=\{locale === "ar" \? "rtl" : "ltr"\}/);
  assert.match(mobile, /env\(safe-area-inset-bottom, 0px\)/);
  assert.match(mobile, /className="fixed inset-x-0 bottom-0 z-30/);
  for (const label of ["الرئيسية", "الجولات", "المخزون", "الماكينات", "المزيد"]) assert.ok(mobile.includes(label), label);
});

test("Storage mobile overview is bilingual, compact and does not duplicate basic availability notices", () => {
  assert.match(storage, /getServerI18n/);
  assert.match(storage, /<div dir=\{direction\}>/);
  assert.match(storage, /grid grid-cols-2 gap-2 sm:gap-3 xl:grid-cols-4/);
  assert.match(storage, /inventoryFilterNamesAr/);
  assert.match(storage, /tr\("In storage", "في المخزن"\)/);
  assert.match(storage, /tr\("What to buy",/);
  assert.match(storage, /tr\("Count storage",/);
  assert.match(storage, /<details className="mt-3 rounded-xl border border-amber-200/);
  assert.doesNotMatch(storage, /Available units have no route attached\./);
});

test("Existing secondary module tools remain reachable through More", () => {
  assert.match(nav, /extraTabs\.map/);
  assert.match(nav, /href=\{tab\.href\}/);
});

function* walk(node) {
  if (Array.isArray(node)) { for (const item of node) yield* walk(item); return; }
  if (!node || typeof node !== "object") return;
  yield node;
  yield* walk(node.props?.children);
}

function renderMobile({ role = "owner", locale = "en", pathname = "/inventory" } = {}) {
  const transpiled = ts.transpileModule(mobile, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  let openCount = 0;
  vm.runInNewContext(transpiled, {
    exports,
    require(name) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/link") return { default: "a" };
      if (name === "next/navigation") return { usePathname: () => pathname };
      if (name === "lucide-react") return { Boxes: "Boxes", ClipboardList: "ClipboardList", House: "House", Menu: "Menu", Warehouse: "Warehouse" };
      if (name === "@/components/I18nProvider") return { useLanguage: () => ({ locale }) };
      if (name === "@/components/app-navigation") return { getAppModuleKey };
      if (name === "@/lib/authz") return authz;
      throw Error(`Unexpected import: ${name}`);
    },
  });
  const profile = {
    id: "11111111-1111-4111-8111-111111111111",
    role,
    roles: [role],
    active_status: "active",
    team_member_id: null,
    can_add_products: role === "owner",
  };
  const tree = exports.OwnerMobileNavigation({ profile, onOpenMenu: () => { openCount += 1; } });
  return { tree, nodes: [...walk(tree)], opened: () => openCount };
}

test("real owner navigation renders four permitted destinations and opens More", () => {
  const ui = renderMobile();
  const links = ui.nodes.filter((node) => node.type === "a");
  assert.deepEqual(links.map((node) => node.props.href), ["/dashboard", "/routes", "/inventory", "/machines"]);
  assert.equal(links.find((node) => node.props.href === "/inventory").props["aria-current"], "page");
  const more = ui.nodes.find((node) => node.type === "button");
  assert.equal(more.props["aria-haspopup"], "dialog");
  more.props.onClick();
  assert.equal(ui.opened(), 1);
});

test("Arabic mobile navigation changes direction and labels, but not destinations", () => {
  const ui = renderMobile({ locale: "ar", pathname: "/routes" });
  assert.equal(ui.tree.props.dir, "rtl");
  const labels = ui.nodes.flatMap((node) => typeof node.props?.children === "string" ? [node.props.children] : []);
  for (const label of ["الرئيسية", "الجولات", "المخزون", "الماكينات", "المزيد"]) assert.ok(labels.includes(label), label);
  assert.equal(ui.nodes.find((node) => node.type === "a" && node.props.href === "/routes").props["aria-current"], "page");
});

test("operator sessions never receive management shortcuts", () => {
  assert.equal(renderMobile({ role: "operator" }).tree, null);
  assert.equal(renderMobile({ role: "investor" }).tree, null);
});
