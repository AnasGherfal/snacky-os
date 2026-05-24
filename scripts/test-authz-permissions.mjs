import assert from "node:assert/strict";
import test from "node:test";
import { appPermissions, canAccessPath, hasPermission } from "../src/lib/authz.ts";

function user(role, roles) {
  return {
    id: `${role}-user`,
    role,
    roles,
    activeStatus: "active",
    teamMemberId: `${role}-team-member`,
    canAddProducts: false,
  };
}

test("operator only can use assigned route workflow without inventory or finance", () => {
  const operator = user("operator", ["operator"]);

  assert.equal(hasPermission(operator, "assigned_machines.view"), true);
  assert.equal(hasPermission(operator, "refills.create"), true);
  assert.equal(hasPermission(operator, "products.view_limited"), true);
  assert.equal(hasPermission(operator, "inventory.view"), false);
  assert.equal(hasPermission(operator, "finance.view"), false);
  assert.equal(canAccessPath(operator, "/operator/routes"), true);
  assert.equal(canAccessPath(operator, "/inventory"), false);
  assert.equal(canAccessPath(operator, "/finance"), false);
});

test("warehouse only can view products and storage without finance or product delete", () => {
  const warehouse = user("warehouse", ["warehouse"]);

  assert.equal(hasPermission(warehouse, "products.view"), true);
  assert.equal(hasPermission(warehouse, "products.create"), true);
  assert.equal(hasPermission(warehouse, "products.edit"), true);
  assert.equal(hasPermission(warehouse, "inventory.view"), true);
  assert.equal(hasPermission(warehouse, "storage.adjust"), true);
  assert.equal(hasPermission(warehouse, "storage.movement.create"), true);
  assert.equal(hasPermission(warehouse, "finance.view"), false);
  assert.equal(hasPermission(warehouse, "products.delete"), false);
  assert.equal(canAccessPath(warehouse, "/products"), true);
  assert.equal(canAccessPath(warehouse, "/inventory"), true);
  assert.equal(canAccessPath(warehouse, "/inventory/movements/new"), true);
  assert.equal(canAccessPath(warehouse, "/finance"), false);
});

test("operator and warehouse roles combine", () => {
  const operatorWarehouse = user("warehouse", ["operator", "warehouse"]);

  assert.equal(hasPermission(operatorWarehouse, "products.view"), true);
  assert.equal(hasPermission(operatorWarehouse, "products.create"), true);
  assert.equal(hasPermission(operatorWarehouse, "products.edit"), true);
  assert.equal(hasPermission(operatorWarehouse, "inventory.view"), true);
  assert.equal(hasPermission(operatorWarehouse, "storage.adjust"), true);
  assert.equal(hasPermission(operatorWarehouse, "refills.create"), true);
  assert.equal(hasPermission(operatorWarehouse, "finance.view"), false);
  assert.equal(canAccessPath(operatorWarehouse, "/products"), true);
  assert.equal(canAccessPath(operatorWarehouse, "/inventory"), true);
  assert.equal(canAccessPath(operatorWarehouse, "/operator/routes"), true);
  assert.equal(canAccessPath(operatorWarehouse, "/finance"), false);
});

test("finance only can see finance but cannot edit products", () => {
  const finance = user("finance", ["finance"]);

  assert.equal(hasPermission(finance, "finance.view"), true);
  assert.equal(hasPermission(finance, "finance.edit"), true);
  assert.equal(hasPermission(finance, "products.edit"), false);
  assert.equal(canAccessPath(finance, "/finance"), true);
  assert.equal(canAccessPath(finance, "/products/abc/edit"), false);
});

test("admin has full permission set", () => {
  const admin = user("admin", ["admin"]);

  for (const permission of appPermissions) {
    assert.equal(hasPermission(admin, permission), true, permission);
  }
});
