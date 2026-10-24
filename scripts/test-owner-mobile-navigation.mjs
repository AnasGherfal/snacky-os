import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
