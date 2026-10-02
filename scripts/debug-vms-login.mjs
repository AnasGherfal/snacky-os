import { readFileSync } from "node:fs";
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
  } catch {}
}

loadEnvFile(".env.local");

const baseUrl = process.env.SNACKY_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";

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

function routeTreeForLogin() {
  return ["", { children: ["login", { children: ["__PAGE__", {}] }] }];
}

function extractActionId(html, actionName) {
  const marker = `"name":"${actionName}"`;
  const idx = html.indexOf(marker);
  if (idx < 0) throw new Error(`missing ${actionName}`);
  const ctx = html.slice(Math.max(0, idx - 500), idx + 500);
  const match = ctx.match(/"id":"([a-f0-9]{32,})"/i);
  if (!match?.[1]) throw new Error(`missing action id for ${actionName}`);
  return match[1];
}

async function main() {
  const page = await fetchApp("/login?next=%2Fvms-import", null, { redirect: "follow" });
  const html = await page.text();
  const loginId = extractActionId(html, "login");
  const formData = new FormData();
  formData.set("email", "anas@snacky.local");
  formData.set("password", "12345678!");
  formData.set("next", "/vms-import");
  const body = await encodeReply([formData], { temporaryReferences: createTemporaryReferenceSet() });
  const response = await fetchApp("/login", null, {
    method: "POST",
    headers: {
      accept: "text/x-component",
      "next-action": loginId,
      "next-router-state-tree": encodeURIComponent(JSON.stringify(routeTreeForLogin())),
    },
    body,
  });
  const cookieHeader = response.headers.get("set-cookie");
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  console.log(JSON.stringify({ status: response.status, location: response.headers.get("location"), redirect: response.headers.get("x-action-redirect"), cookieHeader, setCookies }, null, 2));
  const cookie = (setCookies.length ? setCookies.join("\n") : cookieHeader) ?? "";
  const pair = cookie.split(/,(?=\s*[^;,=]+=[^;]+)/).map((part) => part.split(";")[0].trim()).filter(Boolean).join("; ");
  console.log(JSON.stringify({ cookie }, null, 2));
  console.log(JSON.stringify({ pair }, null, 2));
  const importResp = await fetchApp("/vms-import", pair, { redirect: "follow" });
  console.log(JSON.stringify({ importStatus: importResp.status, importUrl: importResp.url, redirected: importResp.redirected }, null, 2));
  const importHtml = await importResp.text();
  console.log(importHtml.slice(0, 2000));
}

await main();
