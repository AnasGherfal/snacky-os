import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  "src/app/dashboard/page.tsx",
  "src/app/routes/new/RouteCreateForm.tsx",
  "src/app/routes/[id]/page.tsx",
  "src/app/inventory/page.tsx",
  "src/app/refills/page.tsx",
  "src/app/vms-import/page.tsx",
  "src/lib/vms-import-actions.ts",
  "src/lib/operator-actions.ts",
];

const count = (source, regex) => (source.match(regex) ?? []).length;

const metrics = targets.map((relativePath) => {
  const absolutePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(absolutePath, "utf8");
  const bytes = fs.statSync(absolutePath).size;
  const fromCalls = count(source, /\.from\(/g);
  const rpcCalls = count(source, /\.rpc\(/g);
  const awaitSites = count(source, /\bawait\b/g);
  const promiseAllSites = count(source, /Promise\.all/g);

  return {
    path: relativePath,
    bytes,
    lines: source.split("\n").length,
    fromCalls,
    rpcCalls,
    dataCallSites: fromCalls + rpcCalls,
    selectCalls: count(source, /\.select\(/g),
    awaitSites,
    promiseAllSites,
    clientComponent: /^["']use client["'];/m.test(source),
  };
});

const riskLabel = (row) => {
  const risks = [];
  if (row.bytes >= 100_000) risks.push("large");
  if (row.dataCallSites >= 20) risks.push("data-heavy");
  if (row.awaitSites >= 25) risks.push("async-heavy");
  if (row.clientComponent && row.bytes >= 100_000) risks.push("large-client");
  return risks.length ? risks.join(", ") : "normal";
};

if (process.argv.includes("--json")) {
  process.stdout.write(JSON.stringify(metrics.map((row) => ({ ...row, risk: riskLabel(row) })), null, 2) + "\n");
  process.exit(0);
}

const formatKb = (bytes) => (bytes / 1024).toFixed(1);
const header = [
  "Snacky OS structural performance baseline",
  "",
  "This is a static complexity baseline, not a runtime latency benchmark.",
  "Use it to identify likely hotspots before measuring real request/render time.",
  "",
  "| Target | KB | Lines | DB call sites | await sites | Promise.all | Client | Risk |",
  "| --- | ---: | ---: | ---: | ---: | ---: | :---: | --- |",
];

const rows = [...metrics]
  .sort((a, b) => (b.dataCallSites - a.dataCallSites) || (b.bytes - a.bytes))
  .map((row) => [
    "|",
    `\`${row.path}\``,
    "|",
    formatKb(row.bytes),
    "|",
    row.lines,
    "|",
    row.dataCallSites,
    "|",
    row.awaitSites,
    "|",
    row.promiseAllSites,
    "|",
    row.clientComponent ? "yes" : "no",
    "|",
    riskLabel(row),
    "|",
  ].join(" "));

const totals = metrics.reduce(
  (acc, row) => {
    acc.bytes += row.bytes;
    acc.dataCallSites += row.dataCallSites;
    acc.awaitSites += row.awaitSites;
    return acc;
  },
  { bytes: 0, dataCallSites: 0, awaitSites: 0 },
);

const footer = [
  "",
  `Tracked source: ${formatKb(totals.bytes)} KB across ${metrics.length} critical targets.`,
  `Static DB call sites: ${totals.dataCallSites}. Await sites: ${totals.awaitSites}.`,
  "",
  "Optimization rule: measure a target, make one narrow change, then rerun the existing regression/build gates before merge.",
];

process.stdout.write([...header, ...rows, ...footer].join("\n") + "\n");
