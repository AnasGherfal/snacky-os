import assert from "node:assert/strict";
import { test } from "node:test";
import { navigationBreadcrumbItems } from "../src/lib/navigation-breadcrumbs.ts";
import { canAccessPath } from "../src/lib/authz.ts";
const owner = { id: "owner", role: "owner", activeStatus: "active" };

test("old CRM Machines breadcrumbs become CRM without losing the place name", () => {
  const result = navigationBreadcrumbItems([{ label: "Machines", href: "/machines" }, { label: "Locations Pipeline", href: "/locations-pipeline" }, { label: "مدرسة التجربة" }], owner, "/locations-pipeline/lead", "ar");
  assert.equal(result[0].label, "العلاقات وخدمة العملاء");
  assert.equal(result.at(-1).label, "مدرسة التجربة");
  assert.equal(result.some((item) => item.href === "/machines"), false);
});

test("purchase breadcrumbs never switch to Finance, including record edit ancestors", () => {
  const result = navigationBreadcrumbItems([{ label: "Finance", href: "/finance" }, { label: "Purchases", href: "/purchases?module=finance" }, { label: "Invoice 42", href: "/purchases/id" }, { label: "Edit invoice" }], owner, "/purchases/id/edit", "en");
  assert.equal(result[0].label, "Inventory & Purchasing");
  assert.ok(result.some((item) => item.label === "Invoice 42"));
  assert.equal(result.at(-1).label, "Edit invoice");
  assert.ok(!result.some((item) => item.href === "/finance"));
});

test("restricted purchase and cash users do not receive forbidden parent links", () => {
  for (const [role, path] of [["finance", "/purchases/id"], ["operator", "/cash-collections/id"]]) {
    const user = { id: "user", role, activeStatus: "active" };
    const result = navigationBreadcrumbItems([{ label: "Storage", href: "/inventory" }, { label: "Record" }], user, path, "en");
    for (const item of result) if (item.href) assert.ok(canAccessPath(user, item.href), item.href);
  }
});
