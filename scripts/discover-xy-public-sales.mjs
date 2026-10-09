import { discoverXyDashboardAssets } from "../src/lib/xy-public-asset-paths.ts";

const origin = "https://www.xynetweb.com/";
const MAX_ASSETS = 6;
const timeoutMs = 12000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function get(url) {
  const response = await fetch(url, {
    headers: { Accept: "text/html,application/javascript,*/*;q=0.5" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (body.length > 12 * 1024 * 1024) throw new Error("Too large");
  return { body, contentType };
}

function candidatePaths(source) {
  const found = new Set();
  const expr = /\/(?:service-(?:order|api)|sram)\/[A-Za-z0-9/_-]{5,150}/g;
  for (const match of source.matchAll(expr)) {
    const path = match[0];
    if (!/(order|trade|sale|login|auth|token|query|transaction|merchant|jymx)/i.test(path)) continue;
    if (path.includes("//")) continue;
    found.add(path);
  }
  return [...found].sort();
}

async function main() {
  const root = await get(origin);
  const assets = discoverXyDashboardAssets(root.body, origin);
  // app.js first, not the huge vendor dependencies.
  assets.sort((left, right) =>
    Number(!/\/app\.[\w-]+\.js/i.test(left)) - Number(!/\/app\.[\w-]+\.js/i.test(right)));
  console.log("Public XY dashboard JavaScript assets:", assets.length);
  if (!assets.length) throw new Error("XY dashboard bootstrap assets not found.");
  let results = 0;
  for (const asset of assets.slice(0, MAX_ASSETS)) {
    try {
      const page = await get(asset);
      const found = candidatePaths(page.body);
      console.log("Asset", new URL(asset).pathname, "bytes", page.body.length, "candidatePaths", found.length);
      for (const path of found.slice(0, 100)) {
        console.log("PUBLIC_PATH", path);
        results++;
      }
    } catch (error) {
      console.log("Asset skipped", new URL(asset).pathname, String(error?.message || error));
    }
    await sleep(100);
  }
  console.log("TOTAL_PUBLIC_PATHS", results);
}

main().catch((error) => {
  console.error("Public vendor discovery failed:", String(error?.message || error));
  process.exitCode = 1;
});
