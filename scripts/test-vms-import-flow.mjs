import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { encodeReply, createTemporaryReferenceSet } from "../node_modules/next/dist/compiled/react-server-dom-webpack/client.node.js";

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
const baseUrl = process.env.SNACKY_SMOKE_BASE_URL ?? "http://127.0.0.1:3001";
const canRun = Boolean(supabaseUrl && anonKey && serviceRoleKey);
const preserveDebugArtifacts = process.env.SNACKY_KEEP_VMS_DEBUG === "1";

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
      full_name: `VMS QA ${role}`,
      email,
      role,
      roles,
      active: true,
      auth_user_id: authUser.user.id,
      can_add_products: roles.includes("owner") || roles.includes("admin") || roles.includes("warehouse"),
    })
    .select("id")
    .single();
  assert.ifError(teamError);

  const { error: profileError } = await service.from("profiles").insert({
    id: authUser.user.id,
    full_name: `VMS QA ${role}`,
    email,
    role,
    roles,
    active_status: "active",
    team_member_id: teamMember.id,
    can_add_products: roles.includes("owner") || roles.includes("admin") || roles.includes("warehouse"),
  });
  assert.ifError(profileError);

  const authClient = client(anonKey);
  const { data: sessionData, error: signInError } = await authClient.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  assert.ok(sessionData.session?.access_token);
  assert.ok(sessionData.session?.refresh_token);

  return {
    authUserId: authUser.user.id,
    teamMemberId: teamMember.id,
    cookie: [
      `snacky-auth-access-token=${sessionData.session.access_token}`,
      `snacky-auth-refresh-token=${sessionData.session.refresh_token}`,
    ].join("; "),
  };
}

async function fetchApp(path, cookie, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...options,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(options.headers ?? {}),
    },
  });
}

async function fetchHtml(path, cookie) {
  const response = await fetchApp(path, cookie, { redirect: "follow" });
  assert.ok(response.status < 500, `${path} returned ${response.status}`);
  assert.equal(response.redirected && response.url.includes("/login"), false, `${path} redirected to login`);
  const html = await response.text();
  assert.equal(html.includes("Application error"), false, `${path} rendered an application error`);
  assert.equal(html.includes("Server Components render"), false, `${path} rendered a Server Components crash`);
  return html;
}

function extractActionId(html, actionName) {
  const markers = [`"name":"${actionName}"`, `\\"name\\":\\"${actionName}\\"`];
  const nameIndex = markers.map((marker) => html.indexOf(marker)).find((index) => index >= 0) ?? -1;
  if (nameIndex >= 0) {
    const context = html.slice(Math.max(0, nameIndex - 500), Math.min(html.length, nameIndex + 500));
    const idMatch = context.match(/"id":"([a-f0-9]{32,})"/i) ?? context.match(/\\"id\\":\\"([a-f0-9]{32,})\\"/i);
    if (idMatch?.[1]) return idMatch[1];
  }
  const context = nameIndex >= 0 ? html.slice(Math.max(0, nameIndex - 500), Math.min(html.length, nameIndex + 500)) : html.slice(0, 1000);
  assert.fail(`Could not find server action id for ${actionName}.\n${context}`);
}

function routeTreeForVmsImport() {
  return ["", { children: ["vms-import", { children: ["__PAGE__", {}] }] }];
}

async function invokeServerAction({ urlPath, cookie, actionId, formData }) {
  const body = await encodeReply([formData], { temporaryReferences: createTemporaryReferenceSet() });
  const response = await fetchApp(urlPath, cookie, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "next-action": actionId,
      "next-router-state-tree": encodeURIComponent(JSON.stringify(routeTreeForVmsImport())),
    },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    redirect: response.headers.get("x-action-redirect"),
    contentType: response.headers.get("content-type"),
    text,
  };
}

function redirectPath(result) {
  const raw = result.redirect ?? result.location ?? "";
  assert.ok(raw, `Expected redirect header for server action, got status ${result.status}`);
  return raw.split(";")[0];
}

function parseImportState(pathname) {
  const url = new URL(pathname, baseUrl);
  return {
    previewId: url.searchParams.get("previewId") ?? "",
    importBatchId: url.searchParams.get("importBatchId") ?? "",
    sheetName: url.searchParams.get("sheet") ?? "CSV",
    reportType: url.searchParams.get("reportType") ?? "",
  };
}

function stockMappings() {
  return {
    machine_identifier: "machine_id",
    machine_name: "machine_name",
    product_identifier: "vms_product_id",
    product_name: "vms_product_name",
    current_qty: "current_qty",
    slot_code: "slot_code",
    capacity: "capacity",
    updated_at: "last_updated",
  };
}

function machineStockSnapshotMappings() {
  return {
    machine_identifier: "Machine code",
    machine_name: "Machine name",
    point_name: "Point name",
    product_identifier: "Product Number",
    product_name: "Product name",
    current_qty: "Inventory quantity",
    out_of_stock_qty: "Out of stock quantity",
    capacity: "Inventory capacity",
  };
}

function salesMappings() {
  return {
    machine_identifier: "machine_id",
    machine_name: "machine_name",
    product_identifier: "vms_product_id",
    product_name: "vms_product_name",
    sold_qty: "sold_qty",
    total_sales_amount: "total_sales_lyd",
    sale_date: "date",
  };
}

function orderDetailsMappings() {
  return {
    machine_identifier: "Machine code",
    machine_name: "Machine Name",
    order_number: "Order Number",
    cargo_lane_number: "Cargo Lane Number",
    product_identifier: "Product Number",
    product_name: "Product Name",
    delivery_time: "Delivery Time",
    shipping_status: "Shipping Status",
    payment_amount: "Payment Amount",
    payment_time: "Payment Time",
    quantity: "Num",
  };
}

function buildStockCsv(machineIds, productIds) {
  return [
    "machine_id,machine_name,slot_code,vms_product_id,vms_product_name,current_qty,capacity,last_updated",
    `${machineIds[0]},Hospital Machine 01,A1,${productIds.water},Water 500ml,2,12,2026-05-09`,
    `${machineIds[0]},Hospital Machine 01,A2,${productIds.water},Water 500ml,6,12,2026-05-09`,
    `${machineIds[0]},Hospital Machine 01,A3,${productIds.pepsi},Pepsi Can 330ml,1,10,2026-05-09`,
    `${machineIds[0]},Hospital Machine 01,B3,${productIds.biscuit},Biscuit Pack,0,10,2026-05-09`,
    `${machineIds[1]},Mall Machine 01,A1,${productIds.water},Water 500ml,5,12,2026-05-09`,
    `${machineIds[1]},Mall Machine 01,B1,${productIds.chipsHot},Hot Chips,0,10,2026-05-09`,
    `${machineIds[1]},Mall Machine 01,C2,${productIds.snickers},Snickers,3,8,2026-05-09`,
    `${machineIds[2]},Mall Machine 02,A4,${productIds.energy},Energy Drink,2,8,2026-05-09`,
    `${machineIds[3]},Mixed Location Machine 01,B2,${productIds.chipsSalt},Salted Chips,1,10,2026-05-09`,
    `${machineIds[4]},School Machine 01,A1,${productIds.water},Water 500ml,0,12,2026-05-09`,
    `${machineIds[4]},School Machine 01,B1,${productIds.chipsHot},Hot Chips,2,10,2026-05-09`,
  ].join("\n");
}

function buildMachineStockSnapshotCsv(machineIds, productIds) {
  return [
    "Machine code,Machine name,Point name,Product Number,Product name,Inventory quantity,Inventory capacity,Out of stock quantity",
    `${machineIds[0]},Hospital Machine 01,Hospital,${productIds.water},Water 500ml,2,12,0`,
    `${machineIds[0]},Hospital Machine 01,Hospital,${productIds.water},Water 500ml,6,12,0`,
    `${machineIds[0]},Hospital Machine 01,Hospital,${productIds.pepsi},Pepsi Can 330ml,1,10,0`,
    `${machineIds[0]},Hospital Machine 01,Hospital,${productIds.biscuit},Biscuit Pack,0,10,10`,
    `${machineIds[1]},Mall Machine 01,Mall,${productIds.water},Water 500ml,5,12,0`,
    `${machineIds[1]},Mall Machine 01,Mall,${productIds.chipsHot},Hot Chips,0,10,10`,
    `${machineIds[1]},Mall Machine 01,Mall,${productIds.snickers},Snickers,3,8,0`,
    `${machineIds[2]},Mall Machine 02,Mall,${productIds.energy},Energy Drink,2,8,0`,
    `${machineIds[3]},Mixed Location Machine 01,Mixed Location,${productIds.chipsSalt},Salted Chips,1,10,0`,
    `${machineIds[4]},School Machine 01,School,${productIds.water},Water 500ml,0,12,12`,
    `${machineIds[4]},School Machine 01,School,${productIds.chipsHot},Hot Chips,2,10,0`,
  ].join("\n");
}

function buildSalesCsv(machineIds, productIds) {
  return [
    "machine_id,machine_name,vms_product_id,vms_product_name,sold_qty,total_sales_lyd,cash_sales_lyd,card_sales_lyd,date",
    `${machineIds[0]},Hospital Machine 01,${productIds.water},Water 500ml,24,48,30,18,2026-05-09`,
    `${machineIds[0]},Hospital Machine 01,${productIds.pepsi},Pepsi Can 330ml,12,36,26,10,2026-05-09`,
    `${machineIds[1]},Mall Machine 01,${productIds.chipsHot},Hot Chips,18,54,42,12,2026-05-09`,
    `${machineIds[1]},Mall Machine 01,${productIds.snickers},Snickers,8,40,30,10,2026-05-09`,
    `${machineIds[2]},Mall Machine 02,${productIds.energy},Energy Drink,6,36,24,12,2026-05-09`,
    `${machineIds[3]},Mixed Location Machine 01,${productIds.chipsSalt},Salted Chips,10,30,24,6,2026-05-09`,
    `${machineIds[4]},School Machine 01,${productIds.water},Water 500ml,30,60,50,10,2026-05-09`,
  ].join("\n");
}

function buildOrderDetailsCsv(machineIds, productIds) {
  return [
    "Machine code,Machine Name,Order Number,Cargo Lane Number,Product Number,Product Name,Delivery Time,Shipping Status,Payment Amount,Payment Time,Num",
    `${machineIds[0]},Hospital Machine 01,OD-001,A1,${productIds.water},Water 500ml,2026-05-09T09:00:00Z,Goods shipped,2,2026-05-09T08:59:00Z,1`,
    `${machineIds[1]},Mall Machine 01,OD-002,B1,${productIds.chipsHot},Hot Chips,2026-05-09T10:00:00Z,Goods shipped,3,2026-05-09T09:59:00Z,1`,
    `${machineIds[2]},Mall Machine 02,OD-003,A4,${productIds.energy},Energy Drink,2026-05-09T11:00:00Z,Goods shipped,6,2026-05-09T10:58:00Z,2`,
  ].join("\n");
}

async function confirmImport({
  cookie,
  previewPath,
  mapping,
  reportStartDate = "",
  reportEndDate = "",
}) {
  const state = parseImportState(previewPath);
  const confirmUrl = new URL("/vms-import", baseUrl);
  confirmUrl.searchParams.set("previewId", state.previewId);
  confirmUrl.searchParams.set("importBatchId", state.importBatchId);
  confirmUrl.searchParams.set("sheet", state.sheetName);
  confirmUrl.searchParams.set("reportType", state.reportType);
  confirmUrl.searchParams.set("headerRow", "0");
  confirmUrl.searchParams.set("step", "7");
  confirmUrl.searchParams.set("importMode", "append");
  if (reportStartDate) confirmUrl.searchParams.set("reportStartDate", reportStartDate);
  if (reportEndDate) confirmUrl.searchParams.set("reportEndDate", reportEndDate);
  for (const [field, header] of Object.entries(mapping)) {
    confirmUrl.searchParams.set(`map_${field}`, header);
  }
  const confirmPath = `${confirmUrl.pathname}${confirmUrl.search}`;
  const confirmHtml = await fetchHtml(confirmPath, cookie);
  const actionId = extractActionId(confirmHtml, "completeVmsImport");
  const formData = new FormData();
  formData.set("preview_id", state.previewId);
  formData.set("import_batch_id", state.importBatchId);
  formData.set("sheet_name", state.sheetName);
  formData.set("report_type", state.reportType);
  formData.set("header_row", "0");
  formData.set("import_mode", "append");
  if (reportStartDate) formData.set("report_start_date", reportStartDate);
  if (reportEndDate) formData.set("report_end_date", reportEndDate);
  formData.set("auto_create_products", "false");
  formData.set("update_cost_from_vms", "false");
  for (const [field, header] of Object.entries(mapping)) {
    formData.set(`map_${field}`, header);
  }
  const result = await invokeServerAction({
    urlPath: confirmPath,
    cookie,
    actionId,
    formData,
  });
  assert.equal(result.status, 303, `Confirm import should redirect for ${state.reportType}. Body: ${result.text.slice(0, 500)}`);
  return redirectPath(result);
}

async function uploadPreview({ cookie, fileName, fileType, reportType, contents }) {
  const pageHtml = await fetchHtml("/vms-import", cookie);
  const actionId = extractActionId(pageHtml, "prepareVmsImport");
  const formData = new FormData();
  formData.set("report_type", reportType);
  formData.set("file", new File([Buffer.from(contents, "utf8")], fileName, { type: fileType }));
  const result = await invokeServerAction({
    urlPath: "/vms-import",
    cookie,
    actionId,
    formData,
  });
  assert.equal(result.status, 303, `Upload should redirect for ${reportType}. Body: ${result.text.slice(0, 500)}`);
  return redirectPath(result);
}

async function assertImportBatch(service, batchId, expectations) {
  const { data: batch, error: batchError } = await service
    .from("vms_import_batches")
    .select("id, report_type, status, is_active, rows_imported, rows_found, rows_skipped_duplicate, latest_error")
    .eq("id", batchId)
    .single();
  assert.ifError(batchError);
  assert.equal(batch.report_type, expectations.reportType);
  assert.match(batch.status, /imported/, `Expected imported status for ${batchId}, got ${batch.status}`);
  assert.equal(batch.is_active, true, `Expected ${batchId} to be active after confirm import`);
  assert.ok(Number(batch.rows_imported ?? 0) >= expectations.minImportedRows, `Expected rows_imported >= ${expectations.minImportedRows} for ${batchId}`);
  assert.equal(batch.latest_error, null, `Expected no fatal batch error for ${batchId}`);

  for (const [table, minCount] of expectations.tableMinimums) {
    const { count, error } = await service
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("import_batch_id", batchId);
    assert.ifError(error);
    assert.ok(Number(count ?? 0) >= minCount, `Expected ${table} count >= ${minCount} for batch ${batchId}`);
  }
}

async function assertBatchInactive(service, batchId) {
  const { data: batch, error } = await service
    .from("vms_import_batches")
    .select("id, is_active, status")
    .eq("id", batchId)
    .single();
  assert.ifError(error);
  assert.equal(batch.is_active, false, `Expected ${batchId} to be inactive after a newer stock snapshot was confirmed`);
  assert.match(String(batch.status ?? ""), /imported/, `Expected ${batchId} to remain imported while inactive`);
}

async function assertRouteSourcesForBatch(service, batchId, minimums) {
  const { count: latestCount, error: latestError } = await service
    .from("latest_vms_stock_by_slot")
    .select("id", { count: "exact", head: true })
    .eq("import_batch_id", batchId);
  assert.ifError(latestError);
  assert.ok(Number(latestCount ?? 0) >= minimums.latestStockRows, `Expected latest_vms_stock_by_slot count >= ${minimums.latestStockRows} for batch ${batchId}`);

  const { count: recommendationCount, error: recommendationError } = await service
    .from("refill_recommendations")
    .select("recommendation_key", { count: "exact", head: true })
    .eq("import_batch_id", batchId);
  assert.ifError(recommendationError);
  assert.ok(Number(recommendationCount ?? 0) >= minimums.recommendationRows, `Expected refill_recommendations count >= ${minimums.recommendationRows} for batch ${batchId}`);
}

async function seedReferenceData(service, ownerTeamMemberId, id) {
  const { data: location, error: locationError } = await service
    .from("locations")
    .insert({ name: `VMS QA Location ${id}`, location_type: "office", status: "active" })
    .select("id")
    .single();
  assert.ifError(locationError);

  const machineRows = [
    { key: `QA_VMS_MACHINE_${id}_001`, name: "Hospital Machine 01", code: `VMS-QA-${id}-001` },
    { key: `QA_VMS_MACHINE_${id}_002`, name: "Mall Machine 01", code: `VMS-QA-${id}-002` },
    { key: `QA_VMS_MACHINE_${id}_003`, name: "Mall Machine 02", code: `VMS-QA-${id}-003` },
    { key: `QA_VMS_MACHINE_${id}_004`, name: "Mixed Location Machine 01", code: `VMS-QA-${id}-004` },
    { key: `QA_VMS_MACHINE_${id}_005`, name: "School Machine 01", code: `VMS-QA-${id}-005` },
  ];
  const { data: machines, error: machinesError } = await service
    .from("machines")
    .insert(machineRows.map((machine) => ({
      machine_code: machine.code,
      name: machine.name,
      location_id: location.id,
      status: "active",
    })))
    .select("id, name, machine_code, location_id");
  assert.ifError(machinesError);
  assert.equal(machines.length, machineRows.length);

  const machineIdByKey = Object.fromEntries(machineRows.map((machine, index) => [machine.key, machines[index].id]));

  const productRows = [
    { key: `QA_VMS_WATER_${id}`, sku: `VMS-QA-WATER-${id}`, name: "Water 500ml", category: "drink", selling: 2 },
    { key: `QA_VMS_PEPSI_${id}`, sku: `VMS-QA-PEPSI-${id}`, name: "Pepsi Can 330ml", category: "drink", selling: 3 },
    { key: `QA_VMS_BISCUIT_${id}`, sku: `VMS-QA-BISCUIT-${id}`, name: "Biscuit Pack", category: "snack", selling: 2 },
    { key: `QA_VMS_CHIPS_HOT_${id}`, sku: `VMS-QA-CHIPSHOT-${id}`, name: "Hot Chips", category: "snack", selling: 3 },
    { key: `QA_VMS_SNICKERS_${id}`, sku: `VMS-QA-SNICKERS-${id}`, name: "Snickers", category: "snack", selling: 5 },
    { key: `QA_VMS_ENERGY_${id}`, sku: `VMS-QA-ENERGY-${id}`, name: "Energy Drink", category: "drink", selling: 6 },
    { key: `QA_VMS_CHIPS_SALT_${id}`, sku: `VMS-QA-CHIPSSALT-${id}`, name: "Salted Chips", category: "snack", selling: 3 },
  ];
  const { data: products, error: productsError } = await service
    .from("products")
    .insert(productRows.map((product) => ({
      sku: product.sku,
      name: product.name,
      category: product.category,
      cost_price: 1,
      selling_price: product.selling,
      current_cost_price_lyd: 1,
      current_selling_price_lyd: product.selling,
      cost_price_source: "manual",
      selling_price_source: "manual",
      import_source: "qa",
      active: true,
    })))
    .select("id, name");
  assert.ifError(productsError);
  assert.equal(products.length, productRows.length);

  const productIdByKey = Object.fromEntries(productRows.map((product, index) => [product.key, products[index].id]));

  const machineMappings = await service
    .from("vms_machine_mappings")
    .insert(machineRows.map((machine) => ({
      vms_machine_key: machine.key,
      vms_machine_name: machine.name,
      machine_id: machineIdByKey[machine.key],
      location_id: location.id,
      confidence_score: 1,
      status: "confirmed",
      aliases: [machine.key, machine.name],
      created_by: ownerTeamMemberId,
      updated_by: ownerTeamMemberId,
    })));
  assert.ifError(machineMappings.error);

  const machineAliases = await service
    .from("vms_machine_aliases")
    .insert(machineRows.map((machine) => ({
      mapping_id: null,
      alias: machine.key,
      alias_key: machine.key.toLowerCase(),
    })));
  if (machineAliases.error && machineAliases.error.code !== "23502") {
    assert.ifError(machineAliases.error);
  }

  const now = new Date().toISOString();
  const productMappings = await service
    .from("vms_product_mappings")
    .insert(productRows.map((product) => ({
      vms_product_id: product.key,
      vms_product_name: product.name,
      product_id: productIdByKey[product.key],
      match_status: "confirmed",
      confidence_score: 1,
      latest_machine_id: machines[0].id,
      latest_vms_machine_id: machineRows[0].key,
      latest_machine_name: machines[0].name,
      last_seen_at: now,
      created_by: ownerTeamMemberId,
      updated_at: now,
    })));
  assert.ifError(productMappings.error);

  return {
    locationId: location.id,
    machineKeys: machineRows.map((machine) => machine.key),
    productKeys: {
      water: productRows[0].key,
      pepsi: productRows[1].key,
      biscuit: productRows[2].key,
      chipsHot: productRows[3].key,
      snickers: productRows[4].key,
      energy: productRows[5].key,
      chipsSalt: productRows[6].key,
    },
    machineIds: machineRows.map((machine) => machineIdByKey[machine.key]),
    productIds: productRows.map((product) => productIdByKey[product.key]),
    machineKeysForCleanup: machineRows.map((machine) => machine.key),
    productKeysForCleanup: productRows.map((product) => product.key),
  };
}

async function cleanupImportBatches(service, batchIds, previewIds) {
  for (const batchId of batchIds) {
    await service.from("vms_machine_stock_snapshots").delete().eq("import_batch_id", batchId);
    await service.from("vms_transactions_raw").delete().eq("import_batch_id", batchId);
    await service.from("vms_sales_raw").delete().eq("import_batch_id", batchId);
    await service.from("vms_sales_snapshots").delete().eq("import_batch_id", batchId);
    await service.from("vms_stock_snapshots").delete().eq("import_batch_id", batchId);
    await service.from("vms_import_rows").delete().eq("import_batch_id", batchId);
    await service.from("vms_import_preview_rows").delete().eq("import_batch_id", batchId);
    await service.from("vms_import_batches").delete().eq("id", batchId);
  }
  for (const previewId of previewIds) {
    await service.from("vms_import_preview_rows").delete().eq("preview_id", previewId);
    await service.from("vms_import_previews").delete().eq("id", previewId);
  }
}

test("local VMS import flows upload, preview, confirm, and render without crashing", { skip: canRun ? false : "Supabase local env is not configured." }, async () => {
  const service = client(serviceRoleKey);
  const id = randomUUID().slice(0, 8);
  const password = `VmsQa-${id}-pass-12345`;
  const created = {
    authUserIds: [],
    teamMemberIds: [],
    locationIds: [],
    machineIds: [],
    productIds: [],
    machineKeys: [],
    productKeys: [],
    batchIds: [],
    previewIds: [],
  };

  try {
    const owner = await createQaUser({
      service,
      email: `vms-owner-${id}@snacky.test`,
      password,
      role: "owner",
      roles: ["owner"],
    });
    created.authUserIds.push(owner.authUserId);
    created.teamMemberIds.push(owner.teamMemberId);

    const seeded = await seedReferenceData(service, owner.teamMemberId, id);
    created.locationIds.push(seeded.locationId);
    created.machineIds.push(...seeded.machineIds);
    created.productIds.push(...seeded.productIds);
    created.machineKeys.push(...seeded.machineKeysForCleanup);
    created.productKeys.push(...seeded.productKeysForCleanup);

    const stockPreviewPath = await uploadPreview({
      cookie: owner.cookie,
      fileName: `stock-${id}.csv`,
      fileType: "text/csv",
      reportType: "stock",
      contents: buildStockCsv(seeded.machineKeys, seeded.productKeys),
    });
    const stockPreviewState = parseImportState(stockPreviewPath);
    created.previewIds.push(stockPreviewState.previewId);
    created.batchIds.push(stockPreviewState.importBatchId);
    const stockDetailPath = await confirmImport({
      cookie: owner.cookie,
      previewPath: stockPreviewPath,
      mapping: stockMappings(),
    });
    assert.match(stockDetailPath, /^\/vms-import\/[0-9a-f-]+\?success=/);
    await assertImportBatch(service, stockPreviewState.importBatchId, {
      reportType: "stock",
      minImportedRows: 10,
      tableMinimums: [["vms_stock_snapshots", 10], ["vms_machine_stock_snapshots", 10]],
    });
    await fetchHtml(stockDetailPath, owner.cookie);

    const machineSnapshotPreviewPath = await uploadPreview({
      cookie: owner.cookie,
      fileName: `machine-stock-${id}.csv`,
      fileType: "text/csv",
      reportType: "machine_stock_snapshot",
      contents: buildMachineStockSnapshotCsv(seeded.machineKeys, seeded.productKeys),
    });
    const machineSnapshotPreviewState = parseImportState(machineSnapshotPreviewPath);
    created.previewIds.push(machineSnapshotPreviewState.previewId);
    created.batchIds.push(machineSnapshotPreviewState.importBatchId);
    const machineSnapshotDetailPath = await confirmImport({
      cookie: owner.cookie,
      previewPath: machineSnapshotPreviewPath,
      mapping: machineStockSnapshotMappings(),
    });
    assert.match(machineSnapshotDetailPath, /^\/vms-import\/[0-9a-f-]+\?success=/);
    await assertImportBatch(service, machineSnapshotPreviewState.importBatchId, {
      reportType: "machine_stock_snapshot",
      minImportedRows: 10,
      tableMinimums: [["vms_stock_snapshots", 10], ["vms_machine_stock_snapshots", 10]],
    });
    await assertBatchInactive(service, stockPreviewState.importBatchId);
    await assertRouteSourcesForBatch(service, machineSnapshotPreviewState.importBatchId, {
      latestStockRows: 10,
      recommendationRows: 1,
    });
    await fetchHtml(machineSnapshotDetailPath, owner.cookie);

    const salesPreviewPath = await uploadPreview({
      cookie: owner.cookie,
      fileName: `sales-${id}.csv`,
      fileType: "text/csv",
      reportType: "sales",
      contents: buildSalesCsv(seeded.machineKeys, seeded.productKeys),
    });
    const salesPreviewState = parseImportState(salesPreviewPath);
    created.previewIds.push(salesPreviewState.previewId);
    created.batchIds.push(salesPreviewState.importBatchId);
    const salesDetailPath = await confirmImport({
      cookie: owner.cookie,
      previewPath: salesPreviewPath,
      mapping: salesMappings(),
      reportStartDate: "2026-05-09",
      reportEndDate: "2026-05-09",
    });
    assert.match(salesDetailPath, /^\/vms-import\/[0-9a-f-]+\?success=/);
    await assertImportBatch(service, salesPreviewState.importBatchId, {
      reportType: "sales",
      minImportedRows: 7,
      tableMinimums: [["vms_sales_raw", 7], ["vms_sales_snapshots", 7]],
    });
    await fetchHtml(salesDetailPath, owner.cookie);

    const detailPreviewPath = await uploadPreview({
      cookie: owner.cookie,
      fileName: `order-details-${id}.csv`,
      fileType: "text/csv",
      reportType: "vms_order_details_weekly",
      contents: buildOrderDetailsCsv(seeded.machineKeys, seeded.productKeys),
    });
    const detailPreviewState = parseImportState(detailPreviewPath);
    created.previewIds.push(detailPreviewState.previewId);
    created.batchIds.push(detailPreviewState.importBatchId);
    const detailImportPath = await confirmImport({
      cookie: owner.cookie,
      previewPath: detailPreviewPath,
      mapping: orderDetailsMappings(),
      reportStartDate: "2026-05-09",
      reportEndDate: "2026-05-09",
    });
    assert.match(detailImportPath, /^\/vms-import\/[0-9a-f-]+\?success=/);
    await assertImportBatch(service, detailPreviewState.importBatchId, {
      reportType: "vms_order_details_weekly",
      minImportedRows: 3,
      tableMinimums: [["vms_transactions_raw", 3]],
    });
    await fetchHtml(detailImportPath, owner.cookie);

    const sourcesHtml = await fetchHtml("/vms-import/sources", owner.cookie);
    assert.equal(sourcesHtml.includes(`stock-${id}.csv`), true, "Stock import should appear in VMS Data Sources");
    assert.equal(sourcesHtml.includes(`sales-${id}.csv`), true, "Sales summary import should appear in VMS Data Sources");
    assert.equal(sourcesHtml.includes(`order-details-${id}.csv`), true, "Detailed sales import should appear in VMS Data Sources");
  } catch (error) {
    if (created.batchIds.length) {
      const { data: batches, error: batchesError } = await service
        .from("vms_import_batches")
        .select("id, report_type, status, latest_error, rows_found, rows_imported, rows_skipped, rows_skipped_duplicate, rows_needing_review, error_count, notes")
        .in("id", created.batchIds);
      if (!batchesError) {
        console.error("VMS_DEBUG_BATCHES", JSON.stringify(batches, null, 2));
      }
    }
    throw error;
  } finally {
    if (!preserveDebugArtifacts) {
      await cleanupImportBatches(service, created.batchIds, created.previewIds);
      if (created.productKeys.length) {
        await service.from("vms_product_mappings").delete().in("vms_product_id", created.productKeys);
      }
      if (created.machineKeys.length) {
        await service.from("vms_machine_aliases").delete().in("alias_key", created.machineKeys.map((key) => key.toLowerCase()));
        await service.from("vms_machine_mappings").delete().in("vms_machine_key", created.machineKeys);
      }
      if (created.productIds.length) await service.from("products").delete().in("id", created.productIds);
      if (created.machineIds.length) await service.from("machines").delete().in("id", created.machineIds);
      if (created.locationIds.length) await service.from("locations").delete().in("id", created.locationIds);
      if (created.authUserIds.length) await service.from("profiles").delete().in("id", created.authUserIds);
      if (created.teamMemberIds.length) await service.from("team_members").delete().in("id", created.teamMemberIds);
      for (const authUserId of created.authUserIds) {
        await service.auth.admin.deleteUser(authUserId);
      }
    }
  }
});
