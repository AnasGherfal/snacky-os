import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { encodeReply, createTemporaryReferenceSet } from "../node_modules/next/dist/compiled/react-server-dom-webpack/client.node.js";
import {
  detectColumnMappingDetails,
  detectHeaderRowIndex,
  detectVmsReportTypeFromRows,
  parseVmsUpload,
  sheetRowsToRecords,
} from "../src/lib/vms-parser.ts";

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
    // Optional local file.
  }
}

loadEnvFile(".env.local");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const baseUrl = process.env.SNACKY_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";

assert.ok(supabaseUrl, "Missing NEXT_PUBLIC_SUPABASE_URL");
assert.ok(anonKey, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");

function routeTreeForLogin() {
  return ["", { children: ["login", { children: ["__PAGE__", {}] }] }];
}

function routeTreeForVmsImport() {
  return ["", { children: ["vms-import", { children: ["__PAGE__", {}] }] }];
}

function parseSetCookieHeader(header) {
  if (!header) return "";
  return header
    .split(/,(?=\s*[^;,=]+=[^;]+)/)
    .map((part) => part.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
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
  const html = await response.text();
  assert.equal(html.includes("Application error"), false, `${path} rendered an application error`);
  return html;
}

function extractActionId(html, actionName) {
  const markers = [`"name":"${actionName}"`, `\\"name\\":\\"${actionName}\\"`];
  const nameIndex = markers.map((marker) => html.indexOf(marker)).find((index) => index >= 0) ?? -1;
  assert.ok(nameIndex >= 0, `Could not find action ${actionName}`);
  const context = html.slice(Math.max(0, nameIndex - 500), Math.min(html.length, nameIndex + 500));
  const idMatch = context.match(/"id":"([a-f0-9]{32,})"/i) ?? context.match(/\\"id\\":\\"([a-f0-9]{32,})\\"/i);
  assert.ok(idMatch?.[1], `Could not find action id for ${actionName}`);
  return idMatch[1];
}

async function invokeServerAction({ urlPath, cookie, actionId, formData, routeTree }) {
  const body = await encodeReply([formData], { temporaryReferences: createTemporaryReferenceSet() });
  const response = await fetchApp(urlPath, cookie, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "next-action": actionId,
      "next-router-state-tree": encodeURIComponent(JSON.stringify(routeTree)),
    },
    body,
  });
  const text = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    redirect: response.headers.get("x-action-redirect"),
    contentType: response.headers.get("content-type"),
    setCookie: response.headers.get("set-cookie"),
    setCookies: typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [],
    text,
  };
}

function redirectPath(result) {
  const raw = result.redirect ?? result.location ?? "";
  assert.ok(raw, `Expected redirect header, got status ${result.status}`);
  return raw.split(";")[0];
}

function parseImportState(pathname) {
  const url = new URL(pathname, baseUrl);
  return {
    previewId: url.searchParams.get("previewId") ?? "",
    importBatchId: url.searchParams.get("importBatchId") ?? "",
    sheetName: url.searchParams.get("sheet") ?? "Machine transaction details",
    reportType: url.searchParams.get("reportType") ?? "",
  };
}

async function loginViaApp(email, password) {
  const loginPageHtml = await fetchHtml("/login?next=%2Fvms-import", null);
  const actionId = extractActionId(loginPageHtml, "login");
  const formData = new FormData();
  formData.set("email", email);
  formData.set("password", password);
  formData.set("next", "/vms-import");
  const result = await invokeServerAction({
    urlPath: "/login",
    cookie: null,
    actionId,
    formData,
    routeTree: routeTreeForLogin(),
  });
  assert.equal(result.status, 303, `Login should redirect. Body: ${result.text.slice(0, 500)}`);`r`n  console.log(JSON.stringify({ loginSetCookie: result.setCookie ?? null, loginSetCookies: result.setCookies ?? [] }, null, 2));
  const cookieHeader = (result.setCookies && result.setCookies.length ? result.setCookies.join("\n") : result.setCookie) ?? "";
  const cookie = parseSetCookieHeader(cookieHeader);
  assert.ok(cookie.includes("snacky-auth-access-token="), "Login did not set Snacky auth access token cookie");
  return cookie;
}

async function buildMappingForFile(file) {
  const parsed = await parseVmsUpload(file);
  const firstSheet = parsed.sheets[0];
  assert.ok(firstSheet, "Expected a parsed sheet");
  const reportType = detectVmsReportTypeFromRows(firstSheet.rows) ?? "monthly_transaction_details";
  const headerRowIndex = detectHeaderRowIndex(firstSheet.rows, reportType);
  const records = sheetRowsToRecords(firstSheet.rows, { reportType, headerRowIndex });
  const mapping = detectColumnMappingDetails(records.headers, reportType, records.columnSamples).mapping;
  return { parsed, reportType, headerRowIndex, mapping };
}

async function uploadMonthlyFile({ cookie, filePath }) {
  const fileBytes = readFileSync(filePath);
  const fileName = filePath.split(/[\\/]/).pop();
  const file = new File([fileBytes], fileName, { type: "application/vnd.ms-excel" });
  const { reportType } = await buildMappingForFile(file);

  const pageHtml = await fetchHtml("/vms-import", cookie);
  const actionId = extractActionId(pageHtml, "prepareVmsImport");
  const formData = new FormData();
  formData.set("report_type", reportType);
  formData.set("file", file);
  const uploadResult = await invokeServerAction({
    urlPath: "/vms-import",
    cookie,
    actionId,
    formData,
    routeTree: routeTreeForVmsImport(),
  });
  assert.equal(uploadResult.status, 303, `Upload should redirect for ${fileName}. Body: ${uploadResult.text.slice(0, 500)}`);

  const previewPath = redirectPath(uploadResult);
  const previewHtml = await fetchHtml(previewPath, cookie);
  const confirmActionId = extractActionId(previewHtml, "completeVmsImport");
  const previewState = parseImportState(previewPath);
  const { parsed, headerRowIndex, mapping } = await buildMappingForFile(file);

  const confirmForm = new FormData();
  confirmForm.set("preview_id", previewState.previewId);
  confirmForm.set("import_batch_id", previewState.importBatchId);
  confirmForm.set("sheet_name", previewState.sheetName);
  confirmForm.set("report_type", previewState.reportType);
  confirmForm.set("header_row", String(headerRowIndex));
  confirmForm.set("import_mode", "append");
  confirmForm.set("auto_create_products", "false");
  confirmForm.set("update_cost_from_vms", "false");
  for (const [field, header] of Object.entries(mapping)) {
    confirmForm.set(`map_${field}`, header);
  }

  const confirmResult = await invokeServerAction({
    urlPath: previewPath,
    cookie,
    actionId: confirmActionId,
    formData: confirmForm,
    routeTree: routeTreeForVmsImport(),
  });
  assert.equal(confirmResult.status, 303, `Confirm should redirect for ${fileName}. Body: ${confirmResult.text.slice(0, 500)}`);
  const detailPath = redirectPath(confirmResult);

  const detailHtml = await fetchHtml(detailPath, cookie);
  const salesHtml = await fetchHtml("/sales", cookie);
  const importIndexHtml = await fetchHtml("/vms-import", cookie);

  return {
    fileName,
    reportType,
    sheetName: parsed.sheets[0]?.name ?? null,
    rows: parsed.sheets[0]?.rows.length ?? 0,
    previewPath,
    detailPath,
    detailHtmlOk: !detailHtml.includes("Could not load this VMS file"),
    salesHtmlOk: !salesHtml.includes("Something did not load"),
    importIndexHtmlOk: !importIndexHtml.includes("Something did not load"),
    batchId: previewState.importBatchId,
  };
}

const cookie = await loginViaApp("anas@snacky.local", "12345678!");
const filePaths = process.argv.slice(2);
assert.ok(filePaths.length, "Provide one or more .xls files");

const results = [];
for (const filePath of filePaths) {
  results.push(await uploadMonthlyFile({ cookie, filePath }));
}

console.log(JSON.stringify({ baseUrl, results }, null, 2));

