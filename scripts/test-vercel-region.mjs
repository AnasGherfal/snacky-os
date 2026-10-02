import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));

test("Vercel Functions run beside Supabase in eu-west-1", () => {
  assert.deepEqual(config.regions, ["dub1"]);
  assert.deepEqual(config.crons, [{ path: "/api/cron/xy-vms", schedule: "0 4 * * *" }]);
});
