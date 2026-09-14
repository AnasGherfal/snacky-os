import assert from "node:assert/strict";
import { test } from "node:test";
import { canAccessPath } from "../src/lib/authz.ts";
import { navigationContextForUser, pathnameFromHref } from "../src/components/module-tabs-config.ts";
const user = { id: "u", role: "operator", roles: ["operator"], teamMemberId: "self", activeStatus: "active" };

test("operator receipt deep links retain Cash without exposing the forbidden index", () => {
  assert.equal(canAccessPath(user, "/cash-collections"), false);
  for (const path of ["/cash-collections/receipt", "/cash-collections/receipt/edit"]) {
    const { location, modules } = navigationContextForUser(user, path);
    assert.equal(location?.module.id, "cash");
    assert.equal(location.tab.href, path);
    for (const module of modules) for (const group of module.sections) for (const tab of group.tabs) assert.ok(canAccessPath(user, pathnameFromHref(tab.href)), tab.href);
    assert.equal(location.module.sections.flatMap((s) => s.tabs).some((t) => t.href === "/cash-collections"), false);
  }
});

test("product-creation flag has a safe creation destination, not catalog access", () => {
  const creator = { ...user, canAddProducts: true };
  const { location, modules } = navigationContextForUser(creator, "/products/new");
  assert.equal(location?.module.id, "inventory");
  const inventory = modules.find((module) => module.id === "inventory");
  assert.equal(inventory.href, "/products/new");
  assert.equal(inventory.sections.flatMap((s) => s.tabs).some((t) => t.href === "/products"), false);
});

test("an unauthorized deep link never receives a fallback workspace", () => {
  assert.equal(navigationContextForUser(user, "/finance/transactions").location, null);
  assert.equal(navigationContextForUser({ ...user, activeStatus: "inactive" }, "/operator/routes").location, null);
});

test("the contextual current-record tab disappears when leaving that receipt", () => {
  assert.equal(navigationContextForUser(user, "/cash-collections/receipt").location?.tab.href, "/cash-collections/receipt");
  const next = navigationContextForUser(user, "/operator/routes");
  assert.equal(next.location.module.id, "operations");
  assert.ok(!next.modules.flatMap((m) => m.sections.flatMap((s) => s.tabs)).some((t) => t.href === "/cash-collections/receipt"));
});
