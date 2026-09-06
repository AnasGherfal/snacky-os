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
    // CI can provide env vars directly.
  }
}

loadEnvFile(".env.local");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const baseUrl = process.env.SNACKY_SMOKE_BASE_URL ?? "http://127.0.0.1:3001";

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

// Canonical inventory commands leave immutable receipts and ledger history.
// Keep these fixtures on the disposable local stack; cleanup is a local
// `supabase db reset`, never privileged deletion from a shared ledger.
const hasFixtureEnv = Boolean(supabaseUrl && anonKey && serviceRoleKey);
const usesDisposableLocalStack = isLoopbackUrl(supabaseUrl) && isLoopbackUrl(baseUrl);
const canRun = hasFixtureEnv && usesDisposableLocalStack;
const skipReason = hasFixtureEnv && !usesDisposableLocalStack
  ? "Route inventory fixtures are restricted to the disposable local Supabase and app."
  : "Supabase local env is not configured.";

function supabaseClient(key) {
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function createQaUser({ service, id, role, roles, fullName }) {
  const email = `route-${role}-${id}@snacky.test`;
  const password = `Route-${id}-${role}-pass-12345`;
  const { data: authUser, error: authError } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(authError);
  assert.ok(authUser.user?.id);

  const canAddProducts = roles.includes("warehouse") || roles.includes("owner") || roles.includes("admin");
  const { data: teamMember, error: teamError } = await service
    .from("team_members")
    .insert({
      full_name: fullName,
      email,
      role,
      roles,
      active: true,
      active_status: "active",
      auth_user_id: authUser.user.id,
      can_add_products: canAddProducts,
    })
    .select("id")
    .single();
  assert.ifError(teamError);

  const { error: profileError } = await service.from("profiles").insert({
    id: authUser.user.id,
    full_name: fullName,
    email,
    role,
    roles,
    active_status: "active",
    team_member_id: teamMember.id,
    can_add_products: canAddProducts,
  });
  assert.ifError(profileError);

  const client = supabaseClient(anonKey);
  const { data: sessionData, error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  assert.ok(sessionData.session?.access_token);
  assert.ok(sessionData.session?.refresh_token);

  return {
    authUserId: authUser.user.id,
    teamMemberId: teamMember.id,
    client,
    cookie: [
      `snacky-auth-access-token=${sessionData.session.access_token}`,
      `snacky-auth-refresh-token=${sessionData.session.refresh_token}`,
    ].join("; "),
  };
}

async function fetchApp(path, cookie, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: options.redirect ?? "follow",
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function assertPageOk(path, cookie, label = path) {
  const response = await fetchApp(path, cookie);
  assert.ok(response.status < 500, `${label} returned ${response.status}`);
  assert.equal(response.redirected && response.url.includes("/login"), false, `${label} redirected to login`);
  const body = await response.text();
  assert.equal(body.includes("Application error"), false, `${label} rendered an application error`);
  assert.equal(body.includes("Server Components render"), false, `${label} rendered a Server Components crash`);
  return body;
}

async function createProduct(client, payload) {
  const { data, error } = await client
    .from("products")
    .insert({
      category: "snack",
      cost_price: 0,
      selling_price: 1,
      current_cost_price_lyd: 0,
      current_selling_price_lyd: 1,
      cost_price_source: "manual",
      selling_price_source: "manual",
      import_source: "qa",
      active: true,
      ...payload,
    })
    .select("id, sku, name")
    .single();
  assert.ifError(error);
  return data;
}

async function createRoute(cookie, payload) {
  const response = await fetchApp("/api/routes", cookie, {
    method: "POST",
    body: payload,
  });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `route create failed: ${JSON.stringify(body)}`);
  assert.ok(body.routeId, "route create should return routeId");
  return body.routeId;
}

async function confirmedStorageLocationForProduct(service, productId) {
  const { data, error } = await service
    .from("current_inventory_by_location")
    .select("location_id, quantity_on_hand")
    .eq("product_id", productId)
    .eq("location_type", "storage")
    .gt("quantity_on_hand", 0)
    .limit(1);
  assert.ifError(error);
  assert.ok(data?.[0]?.location_id, `expected storage stock for product ${productId}`);
  return data[0].location_id;
}

async function recordAdminPickup({ owner, routeId, operatorId, productRows }) {
  const pickupBatchId = randomUUID();
  const confirmedAt = new Date().toISOString();
  const { data: plannedItems, error: plannedItemsError } = await owner.client
    .from("route_stop_items")
    .select("id, route_stop_id, machine_id, product_id, planned_quantity")
    .eq("route_id", routeId);
  assert.ifError(plannedItemsError);

  for (const row of productRows.filter((entry) => entry.plannedQuantity > 0)) {
    const plannedTotal = (plannedItems ?? [])
      .filter((item) => item.product_id === row.productId)
      .reduce((sum, item) => sum + Number(item.planned_quantity ?? 0), 0);
    assert.equal(plannedTotal, row.plannedQuantity, "fixture pickup must match the persisted route plan");
  }

  const productSummary = productRows.map((row) => ({
    product_id: row.productId,
    product_name: row.productName,
    quantity: row.quantity,
  }));
  const plannedPickListRows = (plannedItems ?? []).map((item) => ({
    id: randomUUID(),
    route_id: routeId,
    route_stop_id: item.route_stop_id,
    route_stop_item_id: item.id,
    machine_id: item.machine_id,
    product_id: item.product_id,
    planned_qty: Number(item.planned_quantity ?? 0),
    picked_qty: Number(item.planned_quantity ?? 0),
    action_type: "planned_pick",
    pickup_batch_id: pickupBatchId,
    reason: null,
    notes: "Local route regression fixture",
    needs_review: false,
    is_checked: true,
    checked_at: confirmedAt,
    checked_by: owner.authUserId,
    created_by: owner.teamMemberId,
  }));
  const extraPickListRows = productRows
    .filter((row) => row.plannedQuantity === 0)
    .map((row) => ({
      id: randomUUID(),
      route_id: routeId,
      route_stop_id: null,
      route_stop_item_id: null,
      machine_id: null,
      product_id: row.productId,
      planned_qty: 0,
      picked_qty: row.quantity,
      action_type: "extra_product",
      pickup_batch_id: pickupBatchId,
      reason: "QA additive inventory fixture",
      notes: "Local route regression fixture",
      needs_review: true,
      is_checked: true,
      checked_at: confirmedAt,
      checked_by: owner.authUserId,
      created_by: owner.teamMemberId,
    }));
  const pickListRows = [...plannedPickListRows, ...extraPickListRows];
  const inventoryMovements = productRows.map((row) => ({
    product_id: row.productId,
    quantity: row.quantity,
    from_entity_type: "storage",
    from_entity_id: row.storageLocationId,
    to_entity_type: "operator_bag",
    to_entity_id: operatorId,
    reason: "storage_to_operator_bag",
  }));
  const stockLineRows = productRows.map((row) => ({
    route_id: routeId,
    product_id: row.productId,
    planned_qty: row.plannedQuantity,
    picked_qty: row.quantity,
    updated_at: confirmedAt,
  }));

  const { data, error } = await owner.client.rpc("snacky_confirm_route_pickup_batch_v3", {
    p_route_id: routeId,
    p_expected_route_status: "in_progress",
    p_next_route_status: "in_progress",
    p_started_at: confirmedAt,
    p_replace_pick_list: false,
    p_pickup_batch: {
      id: pickupBatchId,
      route_id: routeId,
      operator_id: operatorId,
      status: "confirmed",
      workflow_kind: "admin_missed_pickup",
      selected_stop_ids: [],
      product_summary: productSummary,
      storage_deducted: true,
      confirmed_at: confirmedAt,
    },
    p_batch_stop_ids: [],
    p_new_stop_item_rows: [],
    p_inventory_movements: inventoryMovements,
    p_pick_list_rows: pickListRows,
    p_stock_line_rows: stockLineRows,
    p_stop_item_picks: [],
    p_refill_line_picks: [],
    p_selected_stop_ids: [],
    p_acknowledged_pickup_line_ids: [],
    p_selected_machine_ids: [],
  });
  assert.ifError(error);
  const result = Array.isArray(data) ? data[0] : data;
  assert.equal(result?.pickup_batch_id, pickupBatchId);
  assert.equal(result?.route_status, "in_progress");
  return pickupBatchId;
}

async function commitStopInventory({ operator, service, routeId, stop, fillLines, machineStorageLines = [] }) {
  const submissionId = `qa-route-stop:${randomUUID()}`;
  const { data: commitData, error: commitError } = await operator.client.rpc(
    "snacky_commit_route_stop_inventory_v1",
    {
      p_route_id: routeId,
      p_route_stop_id: stop.id,
      p_machine_id: stop.machine_id,
      p_submission_id: submissionId,
      p_fill_lines: fillLines,
      p_machine_storage_lines: machineStorageLines,
    },
  );
  assert.ifError(commitError);
  const commit = Array.isArray(commitData) ? commitData[0] : commitData;
  assert.equal(commit?.inventory_committed, true);
  assert.equal(commit?.route_stop_id, stop.id);

  const completedAt = String(commit?.inventory_committed_at ?? "");
  assert.ok(Number.isFinite(Date.parse(completedAt)), "stop inventory commit should return its event timestamp");
  const { data: finalizedData, error: finalizedError } = await service.rpc(
    "snacky_finalize_route_stop_workflow_v1",
    {
      p_route_id: routeId,
      p_route_stop_id: stop.id,
      p_machine_id: stop.machine_id,
      p_completed_at: completedAt,
      p_notes: "Local route regression fixture",
      p_client_submission_id: submissionId,
    },
  );
  assert.ifError(finalizedError);
  const finalized = Array.isArray(finalizedData) ? finalizedData[0] : finalizedData;
  assert.equal(finalized?.stop_status, "completed");
}

test("route inventory regression fixtures stay local and use canonical ledger writers", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.from\(["']inventory_movements["']\)\s*\.insert\(/);
  assert.doesNotMatch(source, /\.from\(["']inventory_movements["']\)\s*\.delete\(/);
  assert.match(source, /snacky_confirm_route_pickup_batch_v3/);
  assert.match(source, /snacky_commit_route_stop_inventory_v1/);
  assert.match(source, /snacky_finalize_route_stop_workflow_v1/);
  assert.match(source, /usesDisposableLocalStack/);
});

test("route, inventory, purchase, and additive role regression flow", { skip: canRun ? false : skipReason }, async () => {
  const service = supabaseClient(serviceRoleKey);
  const id = randomUUID().slice(0, 8);
  const routeDate = new Date().toISOString().slice(0, 10);
  const created = {
    authUserIds: [],
    teamMemberIds: [],
    productIds: [],
    supplierIds: [],
    storageIds: [],
    purchaseIds: [],
    locationIds: [],
    machineIds: [],
    routeIds: [],
  };

  {
    const owner = await createQaUser({ service, id, role: "owner", roles: ["owner"], fullName: `Route QA Owner ${id}` });
    const operatorWarehouse = await createQaUser({ service, id, role: "warehouse", roles: ["operator", "warehouse"], fullName: `Route QA Operator Warehouse ${id}` });
    created.authUserIds.push(owner.authUserId, operatorWarehouse.authUserId);
    created.teamMemberIds.push(owner.teamMemberId, operatorWarehouse.teamMemberId);

    const [{ data: hasWarehouseRole }, { data: hasOperatorRole }, { data: canAddProducts }] = await Promise.all([
      operatorWarehouse.client.rpc("snacky_current_profile_has_any_role", { allowed_roles: ["warehouse"] }),
      operatorWarehouse.client.rpc("snacky_current_profile_has_any_role", { allowed_roles: ["operator"] }),
      operatorWarehouse.client.rpc("snacky_current_profile_can_add_products"),
    ]);
    assert.equal(hasWarehouseRole, true);
    assert.equal(hasOperatorRole, true);
    assert.equal(canAddProducts, true);

    const { data: storage, error: storageError } = await service
      .from("storage_locations")
      .insert({ name: `Route QA Storage ${id}`, location_type: "main_storage", active: true })
      .select("id")
      .single();
    assert.ifError(storageError);
    created.storageIds.push(storage.id);

    const { data: supplier, error: supplierError } = await service
      .from("suppliers")
      .insert({ name: `Route QA Supplier ${id}` })
      .select("id")
      .single();
    assert.ifError(supplierError);
    created.supplierIds.push(supplier.id);

    const product = await createProduct(operatorWarehouse.client, {
      sku: `ROUTE-QA-${id}`,
      name: `Route QA Product ${id}`,
      selling_price: 2,
      current_selling_price_lyd: 2,
    });
    const extraProduct = await createProduct(operatorWarehouse.client, {
      sku: `ROUTE-QA-EXTRA-${id}`,
      name: `Route QA Extra Product ${id}`,
      selling_price: 3,
      current_selling_price_lyd: 3,
    });
    created.productIds.push(product.id, extraProduct.id);

    const { data: purchaseRows, error: purchaseError } = await operatorWarehouse.client.rpc("snacky_create_purchase_with_lines_v2", {
      p_client_submission_id: randomUUID(),
      p_supplier_id: supplier.id,
      p_order_date: routeDate,
      p_receipt_number: `ROUTE-QA-RCPT-${id}`,
      p_payment_method: "cash",
      p_payment_status: "unpaid",
      p_receipt_url: null,
      p_receipt_file_name: null,
      p_receipt_content_type: null,
      p_receipt_storage_path: null,
      p_notes: "Route regression purchase",
      p_calculated_total_lyd: 70,
      p_manual_total_lyd: null,
      p_total_adjustment_lyd: null,
      p_total_source: "calculated",
      p_total_amount: 70,
      p_payment_account_id: null,
      p_receiving_storage_location_id: storage.id,
      p_submit_action: "received",
      p_lines: [
        { product_id: product.id, line_position: 0, boxes_qty: 5, units_per_box: 10, loose_units_qty: 0, total_units: 50, unit_cost: 1, unit_cost_lyd: 1, line_total: 50, line_total_lyd: 50 },
        { product_id: extraProduct.id, line_position: 1, boxes_qty: 2, units_per_box: 10, loose_units_qty: 0, total_units: 20, unit_cost: 1, unit_cost_lyd: 1, line_total: 20, line_total_lyd: 20 },
      ],
    });
    assert.ifError(purchaseError);
    const purchase = Array.isArray(purchaseRows) ? purchaseRows[0] : purchaseRows;
    assert.equal(purchase.status, "received");
    assert.equal(purchase.movement_count, 2);
    created.purchaseIds.push(purchase.id);

    const storageLocationId = await confirmedStorageLocationForProduct(service, product.id);
    const extraStorageLocationId = await confirmedStorageLocationForProduct(service, extraProduct.id);

    const { data: location, error: locationError } = await service
      .from("locations")
      .insert({ name: `Route QA Location ${id}`, location_type: "office", status: "active" })
      .select("id")
      .single();
    assert.ifError(locationError);
    created.locationIds.push(location.id);

    const { data: machines, error: machinesError } = await service
      .from("machines")
      .insert([
        { machine_code: `RQA-${id}-1`, name: `Route QA Machine 1 ${id}`, location_id: location.id, status: "active" },
        { machine_code: `RQA-${id}-2`, name: `Route QA Machine 2 ${id}`, location_id: location.id, status: "active" },
      ])
      .select("id, machine_code");
    assert.ifError(machinesError);
    assert.equal(machines.length, 2);
    machines.sort((a, b) => String(a.machine_code).localeCompare(String(b.machine_code)));
    created.machineIds.push(...machines.map((machine) => machine.id));

    const routesPage = await assertPageOk("/routes", owner.cookie, "/routes before route creation");
    assert.match(routesPage, /Create route/i);

    const newRoutePage = await assertPageOk("/routes/new", owner.cookie, "/routes/new before route creation");
    assert.match(newRoutePage, /Create route/i);
    assert.equal(newRoutePage.includes("Could not load route reservations"), false);
    assert.equal(newRoutePage.includes("invalid input value for enum route_status"), false);

    const oneMachineRouteId = await createRoute(owner.cookie, {
      routeDate,
      assignmentMode: "unassigned",
      machineIds: [],
      manualStopItems: [{ machineId: machines[0].id, productId: product.id, quantity: 2 }],
    });
    created.routeIds.push(oneMachineRouteId);

    const { data: oneMachineRoute, error: oneMachineRouteError } = await service
      .from("routes")
      .select("id, status, operator_id")
      .eq("id", oneMachineRouteId)
      .single();
    assert.ifError(oneMachineRouteError);
    assert.equal(oneMachineRoute.status, "draft");
    assert.equal(oneMachineRoute.operator_id, null);

    const multiMachineRouteId = await createRoute(owner.cookie, {
      routeDate,
      assignmentMode: "assigned",
      operatorId: operatorWarehouse.teamMemberId,
      machineIds: [],
      manualStopItems: [
        { machineId: machines[0].id, productId: product.id, quantity: 2 },
        { machineId: machines[1].id, productId: product.id, quantity: 2 },
      ],
    });
    created.routeIds.push(multiMachineRouteId);

    const mistakeRouteId = await createRoute(owner.cookie, {
      routeDate,
      assignmentMode: "unassigned",
      machineIds: [],
      manualStopItems: [{ machineId: machines[0].id, productId: extraProduct.id, quantity: 1 }],
    });
    created.routeIds.push(mistakeRouteId);

    const { data: deletedMistake, error: deleteMistakeError } = await owner.client
      .from("routes")
      .delete()
      .eq("id", mistakeRouteId)
      .eq("status", "draft")
      .select("id")
      .single();
    assert.ifError(deleteMistakeError);
    assert.equal(deletedMistake.id, mistakeRouteId);
    created.routeIds = created.routeIds.filter((routeId) => routeId !== mistakeRouteId);

    const routesAfterCreate = await assertPageOk("/routes", owner.cookie, "/routes after route creation");
    assert.equal(routesAfterCreate.includes("Application error"), false);

    const newRouteAfterReservations = await assertPageOk("/routes/new", owner.cookie, "/routes/new with reservations");
    assert.equal(newRouteAfterReservations.includes("Could not load route reservations"), false);
    assert.equal(newRouteAfterReservations.includes("invalid input value for enum route_status"), false);

    const operatorRoutes = await assertPageOk("/operator/routes", operatorWarehouse.cookie, "operator assigned routes");
    assert.equal(operatorRoutes.includes("Server Components render"), false);
    await assertPageOk("/operator/routes?view=available", operatorWarehouse.cookie, "operator available routes");
    await assertPageOk(`/operator/routes/${multiMachineRouteId}`, operatorWarehouse.cookie, "operator opens assigned route");

    const { data: claimedRoute, error: claimError } = await operatorWarehouse.client
      .from("routes")
      .update({ operator_id: operatorWarehouse.teamMemberId, status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", oneMachineRouteId)
      .is("operator_id", null)
      .eq("status", "draft")
      .select("id, operator_id, status")
      .single();
    assert.ifError(claimError);
    assert.equal(claimedRoute.status, "in_progress");
    assert.equal(claimedRoute.operator_id, operatorWarehouse.teamMemberId);

    const { data: startedRoute, error: startError } = await operatorWarehouse.client
      .from("routes")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", multiMachineRouteId)
      .eq("operator_id", operatorWarehouse.teamMemberId)
      .eq("status", "assigned")
      .select("id, status")
      .single();
    assert.ifError(startError);
    assert.equal(startedRoute.status, "in_progress");

    const { data: routeStops, error: stopsError } = await service
      .from("route_stops")
      .select("id, machine_id, stop_order")
      .eq("route_id", multiMachineRouteId)
      .order("stop_order");
    assert.ifError(stopsError);
    assert.equal(routeStops.length, 2);

    await recordAdminPickup({
      owner,
      routeId: multiMachineRouteId,
      operatorId: operatorWarehouse.teamMemberId,
      productRows: [
        { productId: product.id, productName: product.name, quantity: 4, plannedQuantity: 4, storageLocationId },
        { productId: extraProduct.id, productName: extraProduct.name, quantity: 1, plannedQuantity: 0, storageLocationId: extraStorageLocationId },
      ],
    });

    const { error: pickedStopsError } = await operatorWarehouse.client
      .from("route_stops")
      .update({ status: "picked" })
      .in("id", routeStops.map((stop) => stop.id));
    assert.ifError(pickedStopsError);

    const pickListResponse = await fetchApp(`/api/operator/routes/${multiMachineRouteId}/pick-list`, operatorWarehouse.cookie);
    const pickListText = await pickListResponse.text();
    assert.equal(pickListResponse.ok, true, pickListText);
    const pickListBody = JSON.parse(pickListText);
    assert.equal(pickListBody.confirmed, true);
    assert.equal(pickListBody.extraItems.some((item) => item.productId === extraProduct.id), true);
    assert.equal(Array.isArray(pickListBody.stopGroups), true);
    assert.equal(pickListBody.stopGroups.length, 2);
    const groupedProductRows = pickListBody.stopGroups.flatMap((group) => group.items.filter((item) => item.product_id === product.id));
    assert.equal(groupedProductRows.length, 2);
    assert.deepEqual(groupedProductRows.map((item) => item.planned_qty).sort(), [2, 2]);
    assert.deepEqual(groupedProductRows.map((item) => item.picked_qty).sort(), [2, 2]);

    await assertPageOk(`/operator/routes/${multiMachineRouteId}/pick-list`, operatorWarehouse.cookie, "operator pick-list page after pickup");

    const [firstStop, secondStop] = routeStops;
    await commitStopInventory({
      operator: operatorWarehouse,
      service,
      routeId: multiMachineRouteId,
      stop: firstStop,
      fillLines: [
        { product_id: product.id, actual_qty: 2, assigned_quantity: 2, action_type: "assigned_fill", unavailable: false },
      ],
      machineStorageLines: [
        { product_id: extraProduct.id, actual_qty: 1, reason: "other", notes: "QA extra product fill" },
      ],
    });

    const { error: firstCashError } = await operatorWarehouse.client.from("cash_collections").insert({
      route_id: multiMachineRouteId,
      machine_id: firstStop.machine_id,
      operator_id: operatorWarehouse.teamMemberId,
      vms_expected_cash: 0,
      actual_cash_collected: 0,
      review_status: "collected_pending_count",
      cash_bag_id: `QA-${id}-1`,
      notes: "QA cash collection",
    });
    assert.ifError(firstCashError);

    await assertPageOk(`/operator/routes/${multiMachineRouteId}`, operatorWarehouse.cookie, "operator continues route after first stop");
    const secondStopResponse = await fetchApp(`/api/operator/routes/${multiMachineRouteId}/stops/${secondStop.id}`, operatorWarehouse.cookie);
    const secondStopText = await secondStopResponse.text();
    assert.equal(secondStopResponse.ok, true, secondStopText);

    await commitStopInventory({
      operator: operatorWarehouse,
      service,
      routeId: multiMachineRouteId,
      stop: secondStop,
      fillLines: [
        { product_id: product.id, actual_qty: 2, assigned_quantity: 2, action_type: "assigned_fill", unavailable: false },
      ],
    });

    const { error: secondCashError } = await operatorWarehouse.client.from("cash_collections").insert({
      route_id: multiMachineRouteId,
      machine_id: secondStop.machine_id,
      operator_id: operatorWarehouse.teamMemberId,
      vms_expected_cash: 0,
      actual_cash_collected: 0,
      review_status: "collected_pending_count",
      cash_bag_id: `QA-${id}-2`,
      notes: "QA cash collection",
    });
    assert.ifError(secondCashError);

    const leftoversResponse = await fetchApp(`/api/operator/routes/${multiMachineRouteId}/picked-items`, operatorWarehouse.cookie);
    const leftoversText = await leftoversResponse.text();
    assert.equal(leftoversResponse.ok, true, leftoversText);
    const leftoversBody = JSON.parse(leftoversText);
    assert.deepEqual(leftoversBody.items, []);

    await assertPageOk(`/operator/routes/${multiMachineRouteId}`, operatorWarehouse.cookie, "operator route detail after completed stops");
    await assertPageOk("/inventory", operatorWarehouse.cookie, "warehouse inventory");
    await assertPageOk("/inventory/movements", operatorWarehouse.cookie, "warehouse movements");
    await assertPageOk("/products/new", operatorWarehouse.cookie, "warehouse add product page");
    await assertPageOk("/purchases/new", operatorWarehouse.cookie, "warehouse add purchase page");

    const { data: routeReservations, error: reservationError } = await operatorWarehouse.client
      .from("route_stock_lines")
      .select("route_id, product_id, planned_qty, picked_qty, routes!inner(status)")
      .in("route_id", [oneMachineRouteId, multiMachineRouteId]);
    assert.ifError(reservationError);
    assert.ok(routeReservations.length >= 2);
  }
});
