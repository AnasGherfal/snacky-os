import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ENV_FILES = [
  ".env.production.local",
  ".vercel/.env.production.local",
  ".env.local",
];

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const rows = {};
  for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\\n/g, "\n");
    rows[match[1]] = value;
  }
  return rows;
}

let fileEnv = {};
for (const file of ENV_FILES) {
  fileEnv = { ...fileEnv, ...parseEnvFile(path.resolve(file)) };
}

const env = { ...fileEnv, ...process.env };
const baseUrl = String(env.XY_VMS_BASE_URL || "https://xcx.xynetweb.com/service-api/api").replace(/\/+$/, "");
const merchantId = String(env.XY_VMS_MERCHANT_ID || "").trim();
const key = String(env.XY_VMS_KEY || "").trim();
const secret = String(env.XY_VMS_SECRET || "").trim();

if (!merchantId || !key || !secret) {
  console.error("Missing XY production env. Run: vercel env pull .env.production.local --environment=production");
  process.exit(2);
}

const machineId = "2509000370";
const impossibleSlot = "SNACKY_DIAG_NO_SLOT";
const impossibleProduct = "SNACKY_DIAG_NO_PRODUCT";
const impossiblePrice = 1;

function md5(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function sortedReqData(params) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${String(value)}`)
    .join("&");
}

function signReadStyle(timestamp, params) {
  return md5(`${secret}${timestamp}${sortedReqData(params)}`);
}

async function jsonPost(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; }
  catch { parsed = { raw: text.slice(0, 160) }; }
  const nested = parsed?.data && typeof parsed.data === "object" && !Array.isArray(parsed.data) ? parsed.data : {};
  return {
    http: response.status,
    code: parsed?.code ?? parsed?.status ?? null,
    innerCode: nested?.code ?? null,
    message: String(parsed?.message ?? parsed?.msg ?? nested?.message ?? nested?.msg ?? "").trim() || null,
  };
}

async function testSignatureEndpoint(label, signFactory) {
  const timestamp = Date.now();
  const params = { merchantCode: merchantId };
  const sign = signFactory(timestamp, params);
  const url = new URL(`${baseUrl}/test`);
  url.searchParams.set("key", key);
  url.searchParams.set("merchantCode", merchantId);
  url.searchParams.set("sign", sign);
  url.searchParams.set("timestamp", String(timestamp));
  const response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch {}
  const nested = parsed?.data && typeof parsed.data === "object" ? parsed.data : {};
  const message = String(nested?.msg ?? parsed?.message ?? "").trim() || null;
  const failed = /signature verification failed/i.test(message || "");
  console.log(`test/${label}: ${failed ? "REJECTED" : "PASSED_OR_DIFFERENT"} | ${message ?? "no message"}`);
  return !failed;
}

console.log("XY write-signature diagnostic");
console.log("Safety: real machine ID, but impossible lane/product only. No credentials or signatures are printed.");

const formulaCandidates = [
  ["read-style", (timestamp, params) => signReadStyle(timestamp, params)],
  ["secret+timestamp", (timestamp) => md5(`${secret}${timestamp}`)],
  ["timestamp+secret+params", (timestamp, params) => md5(`${timestamp}${secret}${sortedReqData(params)}`)],
  ["params+secret+timestamp", (timestamp, params) => md5(`${sortedReqData(params)}${secret}${timestamp}`)],
  ["secret+timestamp+merchant-value", (timestamp) => md5(`${secret}${timestamp}${merchantId}`)],
  ["secret+merchant-value+timestamp", (timestamp) => md5(`${secret}${merchantId}${timestamp}`)],
];

const validFormulaIndexes = [];
for (let i = 0; i < formulaCandidates.length; i++) {
  const [label, factory] = formulaCandidates[i];
  if (await testSignatureEndpoint(label, factory)) validFormulaIndexes.push(i);
}

if (!validFormulaIndexes.length) {
  console.error("No candidate passed XY /api/test. Stop here; write probing was NOT attempted.");
  process.exit(3);
}

const fields = {
  shbh: merchantId,
  jqbh: machineId,
  hdbh: impossibleSlot,
  spbh: impossibleProduct,
  spjg: impossiblePrice,
};

const fieldNames = Object.keys(fields);
const subsets = [];
for (let mask = 1; mask < (1 << fieldNames.length); mask++) {
  const names = fieldNames.filter((_, index) => mask & (1 << index));
  subsets.push(names);
}
subsets.sort((a, b) => b.length - a.length || a.join(",").localeCompare(b.join(",")));

for (const formulaIndex of validFormulaIndexes) {
  const [formulaLabel, formula] = formulaCandidates[formulaIndex];
  for (const names of subsets) {
    const timestamp = Date.now();
    const signedParams = Object.fromEntries(names.map((name) => [name, fields[name]]));
    const sign = formula(timestamp, signedParams);
    const body = {
      key: Number.isFinite(Number(key)) ? Number(key) : key,
      timestamp,
      sign,
      ...fields,
    };
    const result = await jsonPost(`${baseUrl}/addInstructionByApi`, body);
    const signatureRejected = /signature verification failed/i.test(result.message || "");
    console.log(`write/${formulaLabel}/[${names.join(",")}]: ${signatureRejected ? "SIGNATURE_REJECTED" : "SIGNATURE_STAGE_PASSED"} | ${result.code ?? "?"}/${result.innerCode ?? "?"} | ${result.message ?? "no message"}`);
    if (!signatureRejected) {
      console.log("FOUND_WRITE_SIGNATURE_CONTRACT");
      console.log(JSON.stringify({ formula: formulaLabel, signedFields: names }));
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

console.error("No safe candidate passed write signature validation. No machine lane was changed.");
process.exit(4);
