import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REQUIRED_ROUTE_DATABASE_STATUSES,
  REQUIRED_ROUTE_STOP_DATABASE_STATUSES,
  missingRouteWorkflowStatuses,
} from "../src/lib/route-workflow.ts";

const target = process.argv.includes("--local") ? "--local" : "--linked";
const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";

const sql = `
select 'route_status' as enum_name, enumlabel
from pg_enum
where enumtypid = 'route_status'::regtype
union all
select 'route_stop_status' as enum_name, enumlabel
from pg_enum
where enumtypid = 'route_stop_status'::regtype
order by enum_name, enumlabel;
`;

function parseCliJson(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Supabase CLI did not return JSON:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

const tempDir = mkdtempSync(join(tmpdir(), "snacky-route-schema-"));
const sqlPath = join(tempDir, "enum-check.sql");
writeFileSync(sqlPath, sql);

let output = "";
try {
  output = execFileSync(npxBin, ["supabase", "db", "query", target, "--output", "json", "--file", sqlPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

const payload = parseCliJson(output);
const rows = payload.rows ?? [];
const routeStatuses = rows.filter((row) => row.enum_name === "route_status").map((row) => row.enumlabel);
const routeStopStatuses = rows.filter((row) => row.enum_name === "route_stop_status").map((row) => row.enumlabel);
const missing = missingRouteWorkflowStatuses({ routeStatuses, routeStopStatuses });

assert.deepEqual(missing.routeStatuses, [], `route_status missing: ${missing.routeStatuses.join(", ")}`);
assert.deepEqual(missing.routeStopStatuses, [], `route_stop_status missing: ${missing.routeStopStatuses.join(", ")}`);

console.log("Route workflow schema is valid.");
console.log(`route_status: ${REQUIRED_ROUTE_DATABASE_STATUSES.join(", ")}`);
console.log(`route_stop_status: ${REQUIRED_ROUTE_STOP_DATABASE_STATUSES.join(", ")}`);
