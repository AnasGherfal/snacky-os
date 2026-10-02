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
const canRun = Boolean(supabaseUrl && anonKey && serviceRoleKey);

function supabaseClient(key) {
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function createQaUser({ service, id, role, roles, fullName }) {
  const email = `route-checklist-${role}-${id}-${randomUUID().slice(0, 8)}@snacky.test`;
  const password = `Route-checklist-${id}-${role}-pass-12345`;
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
      full_name: fullName,
      email,
      role,
      roles,
      active: true,
      active_status: "active",
      auth_user_id: authUser.user.id,
      can_add_products: roles.includes("admin") || roles.includes("warehouse"),
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
    can_add_products: roles.includes("admin") || roles.includes("warehouse"),
  });
  assert.ifError(profileError);

  const client = supabaseClient(anonKey);
  const { data: sessionData, error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  assert.ok(sessionData.session?.access_token);

  return {
    authUserId: authUser.user.id,
    teamMemberId: teamMember.id,
    client,
  };
}

async function cleanup(service, created) {
  if (created.routeId) {
    await service.from("route_pick_list_items").delete().eq("route_id", created.routeId);
    await service.from("route_stop_items").delete().eq("route_id", created.routeId);
    await service.from("route_stops").delete().eq("route_id", created.routeId);
    await service.from("routes").delete().eq("id", created.routeId);
  }
  if (created.machineId) await service.from("machines").delete().eq("id", created.machineId);
  if (created.locationId) await service.from("locations").delete().eq("id", created.locationId);
  if (created.productId) await service.from("products").delete().eq("id", created.productId);
  if (created.authUserIds.length) await service.from("profiles").delete().in("id", created.authUserIds);
  if (created.teamMemberIds.length) await service.from("team_members").delete().in("id", created.teamMemberIds);
  for (const authUserId of created.authUserIds) await service.auth.admin.deleteUser(authUserId);
}

function rpcChecklistRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

test("route pickup checklist save persists checked state and enforces route access", { skip: canRun ? false : "Supabase local env is not configured." }, async () => {
  const service = supabaseClient(serviceRoleKey);
  const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const created = {
    authUserIds: [],
    teamMemberIds: [],
    productId: null,
    locationId: null,
    machineId: null,
    routeId: null,
  };

  try {
    const admin = await createQaUser({ service, id, role: "admin", roles: ["admin"], fullName: `Checklist QA Admin ${id}` });
    created.authUserIds.push(admin.authUserId);
    created.teamMemberIds.push(admin.teamMemberId);
    const assignedOperator = await createQaUser({ service, id, role: "operator", roles: ["operator"], fullName: `Checklist QA Assigned ${id}` });
    created.authUserIds.push(assignedOperator.authUserId);
    created.teamMemberIds.push(assignedOperator.teamMemberId);
    const otherOperator = await createQaUser({ service, id, role: "operator", roles: ["operator"], fullName: `Checklist QA Other ${id}` });
    created.authUserIds.push(otherOperator.authUserId);
    created.teamMemberIds.push(otherOperator.teamMemberId);

    const { data: product, error: productError } = await service
      .from("products")
      .insert({
        sku: `CHK-${id}`,
        name: `Checklist QA Product ${id}`,
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
      .select("id")
      .single();
    assert.ifError(productError);
    created.productId = product.id;

    const { data: location, error: locationError } = await service
      .from("locations")
      .insert({ name: `Checklist QA Location ${id}`, location_type: "office", status: "active" })
      .select("id")
      .single();
    assert.ifError(locationError);
    created.locationId = location.id;

    const { data: machine, error: machineError } = await service
      .from("machines")
      .insert({ machine_code: `CHK-${id}`, name: `Checklist QA Machine ${id}`, location_id: location.id, status: "active" })
      .select("id")
      .single();
    assert.ifError(machineError);
    created.machineId = machine.id;

    const routeDate = new Date().toISOString().slice(0, 10);
    const { data: route, error: routeError } = await service
      .from("routes")
      .insert({
        route_date: routeDate,
        operator_id: assignedOperator.teamMemberId,
        status: "in_progress",
        created_by: admin.teamMemberId,
      })
      .select("id")
      .single();
    assert.ifError(routeError);
    created.routeId = route.id;

    const { data: stop, error: stopError } = await service
      .from("route_stops")
      .insert({ route_id: route.id, machine_id: machine.id, stop_order: 1, status: "pending" })
      .select("id")
      .single();
    assert.ifError(stopError);

    const { data: item, error: itemError } = await service
      .from("route_stop_items")
      .insert({
        route_id: route.id,
        route_stop_id: stop.id,
        machine_id: machine.id,
        product_id: product.id,
        planned_quantity: 3,
        source: "manual_admin_assignment",
      })
      .select("id")
      .single();
    assert.ifError(itemError);

    const savePayload = { p_is_checked: true, p_route_id: route.id, p_route_stop_item_id: item.id };
    const { data: checkedRows, error: checkedError } = await assignedOperator.client.rpc("save_route_pickup_checklist_item", savePayload);
    assert.ifError(checkedError);
    const checkedRow = rpcChecklistRow(checkedRows);
    assert.equal(checkedRow?.is_checked, true);
    assert.equal(checkedRow?.checked_by, assignedOperator.authUserId);
    assert.ok(checkedRow?.checked_at);

    const { data: refreshedChecked, error: refreshedCheckedError } = await assignedOperator.client
      .from("route_stop_items")
      .select("is_checked, checked_at, checked_by")
      .eq("id", item.id)
      .single();
    assert.ifError(refreshedCheckedError);
    assert.equal(refreshedChecked.is_checked, true);
    assert.equal(refreshedChecked.checked_by, assignedOperator.authUserId);

    const { data: uncheckedRows, error: uncheckedError } = await assignedOperator.client.rpc("save_route_pickup_checklist_item", {
      ...savePayload,
      p_is_checked: false,
    });
    assert.ifError(uncheckedError);
    const uncheckedRow = rpcChecklistRow(uncheckedRows);
    assert.equal(uncheckedRow?.is_checked, false);
    assert.equal(uncheckedRow?.checked_at, null);
    assert.equal(uncheckedRow?.checked_by, null);

    const { error: wrongRouteError } = await assignedOperator.client.rpc("save_route_pickup_checklist_item", {
      ...savePayload,
      p_route_id: randomUUID(),
    });
    assert.ok(wrongRouteError, "wrong route_id and item_id pair should fail");
    assert.match(`${wrongRouteError.code} ${wrongRouteError.message}`, /route not found|checklist item not found/i);

    const anonymousClient = supabaseClient(anonKey);
    const { error: anonymousError } = await anonymousClient.rpc("save_route_pickup_checklist_item", savePayload);
    assert.ok(anonymousError, "unauthenticated users should not update pickup checklist items");
    assert.match(`${anonymousError.code} ${anonymousError.message}`, /not authenticated|permission/i);

    const { data: adminCheckedRows, error: adminCheckedError } = await admin.client.rpc("save_route_pickup_checklist_item", savePayload);
    assert.ifError(adminCheckedError);
    const adminCheckedRow = rpcChecklistRow(adminCheckedRows);
    assert.equal(adminCheckedRow?.is_checked, true);
    assert.equal(adminCheckedRow?.checked_by, admin.authUserId);

    const { error: otherOperatorError } = await otherOperator.client.rpc("save_route_pickup_checklist_item", {
      ...savePayload,
      p_is_checked: false,
    });
    assert.ok(otherOperatorError, "non-assigned operator should not update another operator's route checklist");
    assert.match(`${otherOperatorError.code} ${otherOperatorError.message}`, /42501|permission/i);

    const { data: finalRow, error: finalRowError } = await service
      .from("route_stop_items")
      .select("is_checked, checked_by")
      .eq("id", item.id)
      .single();
    assert.ifError(finalRowError);
    assert.equal(finalRow.is_checked, true);
    assert.equal(finalRow.checked_by, admin.authUserId);
  } finally {
    await cleanup(service, created);
  }
});
