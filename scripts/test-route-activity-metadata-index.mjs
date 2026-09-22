import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationSource = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260922082606_optimize_route_activity_metadata_lookup.sql"),
  "utf8",
);
const routePageSource = fs.readFileSync(
  path.join(repoRoot, "src/app/routes/[id]/page.tsx"),
  "utf8",
);

test("route activity metadata lookup has a matching GIN index migration", () => {
  assert.match(
    migrationSource,
    /create index if not exists idx_system_activity_logs_metadata_gin/i,
  );
  assert.match(
    migrationSource,
    /using gin\s*\(metadata jsonb_path_ops\)/i,
  );
  assert.match(
    routePageSource,
    /\.contains\("metadata", \{ route_id: id \}\)/,
  );
});
