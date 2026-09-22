import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(
  path.join(repoRoot, "supabase/migrations/20260922131922_optimize_refill_machine_slot_lookup.sql"),
  "utf8",
);

test("refill machine slot lookup has a covering active machine/product index", () => {
  assert.match(source, /create index if not exists idx_machine_slots_active_machine_product/i);
  assert.match(source, /on public\.machine_slots \(machine_id, product_id\)/i);
  assert.match(source, /include \(slot_code, min_qty, par_qty, created_at\)/i);
  assert.match(source, /where active = true/i);
});
