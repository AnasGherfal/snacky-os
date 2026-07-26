import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(path) {
  try {
    const rows = readFileSync(path, "utf8").split(/\r?\n/);
    for (const row of rows) {
      const trimmed = row.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index);
      const value = trimmed.slice(index + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {
    // Optional local file; CI can provide env vars directly.
  }
}

loadEnvFile(".env.local");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(supabaseUrl && anonKey && serviceRoleKey);

function client(key) {
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function createQaUser({ service, email, password, role, roles }) {
  const { data: authUser, error: authError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(authError);
  assert.ok(authUser.user?.id);

  const { data: teamMember, error: teamError } = await service
    .from("team_members")
    .insert({
      full_name: `QA ${role}`,
      email,
      role,
      roles,
      active: true,
      auth_user_id: authUser.user.id,
      can_add_products: roles.includes("warehouse"),
    })
    .select("id")
    .single();
  assert.ifError(teamError);

  const { error: profileError } = await service.from("profiles").insert({
    id: authUser.user.id,
    full_name: `QA ${role}`,
    email,
    role,
    roles,
    active_status: "active",
    team_member_id: teamMember.id,
    can_add_products: roles.includes("warehouse"),
  });
  assert.ifError(profileError);

  const userClient = client(anonKey);
  const { error: signInError } = await userClient.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);

  return { authUserId: authUser.user.id, teamMemberId: teamMember.id, client: userClient };
}

test("warehouse purchase flow creates ledger inventory and viewer is denied", { skip: canRun ? false : "Supabase local env is not configured." }, async () => {
  const service = client(serviceRoleKey);
  const id = randomUUID().slice(0, 8);
  const password = `Qa-${id}-pass-12345`;
  const created = {
    authUserIds: [],
    teamMemberIds: [],
    productIds: [],
    supplierIds: [],
    storageIds: [],
    purchaseIds: [],
  };

  try {
    const warehouse = await createQaUser({
      service,
      email: `qa-warehouse-${id}@snacky.test`,
      password,
      role: "warehouse",
      roles: ["warehouse"],
    });
    created.authUserIds.push(warehouse.authUserId);
    created.teamMemberIds.push(warehouse.teamMemberId);

    const operatorWarehouse = await createQaUser({
      service,
      email: `qa-operator-warehouse-${id}@snacky.test`,
      password,
      role: "warehouse",
      roles: ["operator", "warehouse"],
    });
    created.authUserIds.push(operatorWarehouse.authUserId);
    created.teamMemberIds.push(operatorWarehouse.teamMemberId);

    const viewer = await createQaUser({
      service,
      email: `qa-viewer-${id}@snacky.test`,
      password,
      role: "viewer",
      roles: ["viewer"],
    });
    created.authUserIds.push(viewer.authUserId);
    created.teamMemberIds.push(viewer.teamMemberId);

    const [{ data: isWarehouse }, { data: isOperator }, { data: canAddProducts }, { data: additiveIsWarehouse }, { data: additiveIsOperator }] = await Promise.all([
      warehouse.client.rpc("snacky_current_profile_has_any_role", { allowed_roles: ["warehouse"] }),
      warehouse.client.rpc("snacky_current_profile_has_any_role", { allowed_roles: ["operator"] }),
      warehouse.client.rpc("snacky_current_profile_can_add_products"),
      operatorWarehouse.client.rpc("snacky_current_profile_has_any_role", { allowed_roles: ["warehouse"] }),
      operatorWarehouse.client.rpc("snacky_current_profile_has_any_role", { allowed_roles: ["operator"] }),
    ]);
    assert.equal(isWarehouse, true);
    assert.equal(isOperator, false);
    assert.equal(canAddProducts, true);
    assert.equal(additiveIsWarehouse, true);
    assert.equal(additiveIsOperator, true);

    const { data: storage, error: storageError } = await service
      .from("storage_locations")
      .insert({ name: `QA Main Storage ${id}`, location_type: "main_storage", active: true })
      .select("id")
      .single();
    assert.ifError(storageError);
    created.storageIds.push(storage.id);

    const { data: supplier, error: supplierError } = await service
      .from("suppliers")
      .insert({ name: `QA Supplier ${id}` })
      .select("id")
      .single();
    assert.ifError(supplierError);
    created.supplierIds.push(supplier.id);

    const { data: product, error: productError } = await warehouse.client
      .from("products")
      .insert({
        sku: `QA-${id}`,
        name: `QA Product ${id}`,
        category: "snack",
        cost_price: 0,
        selling_price: 1,
        current_cost_price_lyd: 0,
        current_selling_price_lyd: 1,
        cost_price_source: "manual",
        selling_price_source: "manual",
        import_source: "qa",
        active: true,
      })
      .select("id, sku, name")
      .single();
    assert.ifError(productError);
    created.productIds.push(product.id);

    const { data: secondProduct, error: secondProductError } = await warehouse.client
      .from("products")
      .insert({
        sku: `QA-${id}-B`,
        name: `QA Product ${id} B`,
        category: "drink",
        cost_price: 0,
        selling_price: 2,
        current_cost_price_lyd: 0,
        current_selling_price_lyd: 2,
        cost_price_source: "manual",
        selling_price_source: "manual",
        import_source: "qa",
        active: true,
      })
      .select("id, sku, name")
      .single();
    assert.ifError(secondProductError);
    created.productIds.push(secondProduct.id);

    const { error: viewerProductError } = await viewer.client
      .from("products")
      .insert({ sku: `QA-DENIED-${id}`, name: "Denied product", category: "snack", cost_price: 0, selling_price: 1 });
    assert.ok(viewerProductError, "viewer product insert should be denied by RLS");

    const totalUnits = 15;
    const secondTotalUnits = 8;
    const { data: purchaseRows, error: purchaseError } = await warehouse.client.rpc("snacky_create_purchase_with_lines", {
      p_supplier_id: supplier.id,
      p_order_date: new Date().toISOString().slice(0, 10),
      p_receipt_number: `QA-RCPT-${id}`,
      p_payment_method: "cash",
      p_payment_status: "paid",
      p_receipt_url: null,
      p_receipt_file_name: null,
      p_receipt_content_type: null,
      p_receipt_storage_path: null,
      p_notes: "QA purchase regression test",
      p_calculated_total_lyd: 18,
      p_manual_total_lyd: null,
      p_total_adjustment_lyd: null,
      p_total_source: "calculated",
      p_total_amount: 18,
      p_created_by: warehouse.teamMemberId,
      p_submit_action: "received",
      p_lines: [
        {
          product_id: product.id,
          line_position: 0,
          boxes_qty: 2,
          units_per_box: 6,
          loose_units_qty: 3,
          total_units: totalUnits,
          unit_cost: 1.2,
          unit_cost_lyd: 1.2,
          line_total: 18,
          line_total_lyd: 18,
        },
        {
          product_id: secondProduct.id,
          line_position: 1,
          boxes_qty: 1,
          units_per_box: 6,
          loose_units_qty: 2,
          total_units: secondTotalUnits,
          unit_cost: 1.5,
          unit_cost_lyd: 1.5,
          line_total: 12,
          line_total_lyd: 12,
        },
      ],
    });
    assert.ifError(purchaseError);
    const purchase = Array.isArray(purchaseRows) ? purchaseRows[0] : purchaseRows;
    assert.equal(purchase.status, "received");
    assert.equal(purchase.movement_count, 2);
    created.purchaseIds.push(purchase.id);

    const { data: movements, error: movementsError } = await warehouse.client
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, to_entity_type, reason, related_purchase_id")
      .eq("related_purchase_id", purchase.id)
      .in("product_id", [product.id, secondProduct.id]);
    assert.ifError(movementsError);
    assert.equal(movements.length, 2);
    const movementByProductId = new Map(movements.map((movement) => [movement.product_id, movement]));
    assert.equal(Number(movementByProductId.get(product.id)?.quantity), totalUnits);
    assert.equal(Number(movementByProductId.get(secondProduct.id)?.quantity), secondTotalUnits);
    for (const movement of movements) {
      assert.equal(movement.from_entity_type, "supplier");
      assert.equal(movement.to_entity_type, "storage");
      assert.equal(movement.reason, "purchase_received");
    }

    const { data: inventoryRows, error: inventoryError } = await warehouse.client
      .from("current_inventory_by_location")
      .select("quantity_on_hand")
      .eq("product_id", product.id)
      .eq("location_type", "storage");
    assert.ifError(inventoryError);
    const storageQty = inventoryRows.reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);
    assert.equal(storageQty, totalUnits);

    const { data: secondInventoryRows, error: secondInventoryError } = await warehouse.client
      .from("current_inventory_by_location")
      .select("quantity_on_hand")
      .eq("product_id", secondProduct.id)
      .eq("location_type", "storage");
    assert.ifError(secondInventoryError);
    const secondStorageQty = secondInventoryRows.reduce((sum, row) => sum + Number(row.quantity_on_hand ?? 0), 0);
    assert.equal(secondStorageQty, secondTotalUnits);

    const additiveTotalUnits = 4;
    const { data: additivePurchaseRows, error: additivePurchaseError } = await operatorWarehouse.client.rpc("snacky_create_purchase_with_lines", {
      p_supplier_id: supplier.id,
      p_order_date: new Date().toISOString().slice(0, 10),
      p_receipt_number: `QA-ADD-RCPT-${id}`,
      p_payment_method: "cash",
      p_payment_status: "paid",
      p_receipt_url: null,
      p_receipt_file_name: null,
      p_receipt_content_type: null,
      p_receipt_storage_path: null,
      p_notes: "QA additive-role purchase regression test",
      p_calculated_total_lyd: 8,
      p_manual_total_lyd: null,
      p_total_adjustment_lyd: null,
      p_total_source: "calculated",
      p_total_amount: 8,
      p_created_by: operatorWarehouse.teamMemberId,
      p_submit_action: "received",
      p_lines: [
        {
          product_id: product.id,
          line_position: 0,
          boxes_qty: 1,
          units_per_box: 4,
          loose_units_qty: 0,
          total_units: additiveTotalUnits,
          unit_cost: 2,
          unit_cost_lyd: 2,
          line_total: 8,
          line_total_lyd: 8,
        },
      ],
    });
    assert.ifError(additivePurchaseError);
    const additivePurchase = Array.isArray(additivePurchaseRows) ? additivePurchaseRows[0] : additivePurchaseRows;
    assert.equal(additivePurchase.status, "received");
    assert.equal(additivePurchase.movement_count, 1);
    created.purchaseIds.push(additivePurchase.id);

    const { data: additiveMovements, error: additiveMovementsError } = await operatorWarehouse.client
      .from("inventory_movements")
      .select("id, product_id, quantity, from_entity_type, to_entity_type, reason, related_purchase_id")
      .eq("related_purchase_id", additivePurchase.id);
    assert.ifError(additiveMovementsError);
    assert.equal(additiveMovements.length, 1);
    assert.equal(Number(additiveMovements[0].quantity), additiveTotalUnits);
    assert.equal(additiveMovements[0].from_entity_type, "supplier");
    assert.equal(additiveMovements[0].to_entity_type, "storage");
    assert.equal(additiveMovements[0].reason, "purchase_received");

    const { error: viewerPurchaseError } = await viewer.client.rpc("snacky_create_purchase_with_lines", {
      p_supplier_id: supplier.id,
      p_order_date: new Date().toISOString().slice(0, 10),
      p_receipt_number: `QA-DENIED-${id}`,
      p_payment_method: "cash",
      p_payment_status: "paid",
      p_receipt_url: null,
      p_receipt_file_name: null,
      p_receipt_content_type: null,
      p_receipt_storage_path: null,
      p_notes: null,
      p_calculated_total_lyd: 1,
      p_manual_total_lyd: null,
      p_total_adjustment_lyd: null,
      p_total_source: "calculated",
      p_total_amount: 1,
      p_created_by: viewer.teamMemberId,
      p_submit_action: "received",
      p_lines: [{ product_id: product.id, line_position: 0, boxes_qty: 1, units_per_box: 1, loose_units_qty: 0, total_units: 1, unit_cost: 1, unit_cost_lyd: 1, line_total: 1, line_total_lyd: 1 }],
    });
    assert.ok(viewerPurchaseError, "viewer purchase RPC should be denied");
  } finally {
    for (const purchaseId of created.purchaseIds) {
      await service.from("inventory_movements").delete().eq("related_purchase_id", purchaseId);
      await service.from("purchase_order_lines").delete().eq("purchase_order_id", purchaseId);
      await service.from("purchase_orders").delete().eq("id", purchaseId);
    }
    if (created.productIds.length) await service.from("products").delete().in("id", created.productIds);
    if (created.supplierIds.length) await service.from("suppliers").delete().in("id", created.supplierIds);
    if (created.storageIds.length) await service.from("storage_locations").delete().in("id", created.storageIds);
    if (created.authUserIds.length) await service.from("profiles").delete().in("id", created.authUserIds);
    if (created.teamMemberIds.length) await service.from("team_members").delete().in("id", created.teamMemberIds);
    for (const authUserId of created.authUserIds) {
      await service.auth.admin.deleteUser(authUserId);
    }
  }
});

test("route stops can be planned before products and starting stays locked", () => {
  const routeForm = readFileSync("src/app/routes/new/RouteCreateForm.tsx", "utf8");
  const routeApi = readFileSync("src/app/api/routes/route.ts", "utf8");
  const adminRoute = readFileSync("src/app/routes/[id]/page.tsx", "utf8");
  const operatorRoute = readFileSync("src/app/operator/routes/[id]/page.tsx", "utf8");
  const operatorActions = readFileSync("src/lib/operator-actions.ts", "utf8");
  const editPage = readFileSync("src/app/routes/[id]/edit/page.tsx", "utf8");
  const editor = readFileSync("src/app/routes/[id]/edit/RouteItemEditor.tsx", "utf8");

  assert.match(routeForm, /creationMode: "full" \| "stops_only"/);
  assert.match(routeForm, /Math\\.max\\(0, recommendationTarget\\(row\\) - unitQuantity\\(row\\.current_qty\\)\\)/);
  assert.match(routeApi, /Math\\.max\\(0, recommendationTarget\\(row\\) - planQuantity\\(row\\.current_qty\\)\\)/);
  assert.match(routeForm, /Plan machine stops only/);
  assert.match(routeForm, /products added later at storage/);
  assert.match(routeApi, /stopsOnly && !manualMachineIds\.length/);
  assert.match(routeApi, /productsDeferred: stopsOnly/);
  assert.match(routeApi, /if \(!stopsOnly\) \{[\s\S]*route_stock_lines/);
  assert.match(adminRoute, /Prepare products at storage/);
  assert.match(operatorRoute, /waiting for storage quantities/i);
  assert.match(operatorRoute, /routeProductsPrepared/);
  assert.match(operatorActions, /Route products have not been prepared yet/);
  assert.match(editPage, /Prepare route products at storage/);
  assert.match(editor, /Save products and build pick list/);
});


test("completed route outcomes and machine/operator histories stay visible without raw logs", () => {
  const routeDetail = readFileSync("src/app/routes/[id]/page.tsx", "utf8");
  const routesPage = readFileSync("src/app/routes/page.tsx", "utf8");
  const machinePage = readFileSync("src/app/machines/[id]/page.tsx", "utf8");
  const teamPage = readFileSync("src/app/team/[id]/page.tsx", "utf8");
  assert.match(routeDetail, /Completed route outcome/);
  assert.match(routeDetail, /route_manual_sales/);
  assert.match(routeDetail, /returned_from_machine/);
  assert.match(routeDetail, /extra_stock_left_at_machine/);
  assert.doesNotMatch(routeDetail, />Pickup batches</);
  assert.doesNotMatch(routeDetail, />Inventory movements</);
  assert.match(routesPage, /created_at/);
  assert.match(routesPage, /Machine stops/);
  assert.match(machinePage, /Route history/);
  assert.match(machinePage, /Manual sales/);
  assert.match(teamPage, /Machines visited/);
  assert.match(teamPage, /Damaged, returned, and machine storage/);
});


test("machine storage and history use explicit storage records and schema-safe route links", () => {
  const routeDetail = readFileSync("src/app/routes/[id]/page.tsx", "utf8");
  const routesPage = readFileSync("src/app/routes/page.tsx", "utf8");
  const machinePage = readFileSync("src/app/machines/[id]/page.tsx", "utf8");
  const teamPage = readFileSync("src/app/team/[id]/page.tsx", "utf8");

  for (const source of [routeDetail, machinePage, teamPage]) {
    assert.match(source, /route_to_machine_storage/);
    assert.match(source, /to_entity_type === "machine_storage"/);
    assert.doesNotMatch(source, /from_entity_type === "operator_bag" && .*to_entity_type === "machine"/);
  }

  assert.doesNotMatch(routesPage, /machine_display_name/);
  assert.match(routesPage, /location:locations\(id, name\)/);
  assert.match(machinePage, /route_stop_items/);
  assert.match(machinePage, /refill_orders/);
  assert.equal(machinePage.includes('.from("route_stops").select("id, route_id, stop_order, status").eq("machine_id", id).order("created_at"'), false);
  assert.doesNotMatch(teamPage, /machine_display_name/);
});


test("restock planning is sales-ranked with a persistent costed buying list", () => {
  const page = readFileSync("src/app/restock-priority/page.tsx", "utf8");
  const shoppingList = readFileSync("src/lib/restock-shopping-list.ts", "utf8");
  const buyingList = readFileSync("src/components/RestockBuyingList.tsx", "utf8");

  assert.match(page, /right\.unitsSold - left\.unitsSold/);
  assert.match(page, /Sold this month/);
  assert.match(page, /Storage left/);
  assert.match(page, /Recommended buy/);
  assert.match(page, /Estimated cost/);
  assert.match(page, /\[&_thead\]:sticky/);
  assert.match(page, /restock-priority\/shopping-list/);
  assert.match(shoppingList, /lastPurchaseCost/);
  assert.match(shoppingList, /updateRestockShoppingListQuantity/);
  assert.match(buyingList, /Estimated total/);
  assert.match(buyingList, /Create purchase draft/);
});
