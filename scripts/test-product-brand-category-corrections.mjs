import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const migration = fs.readFileSync(
  path.join(root, "supabase/migrations/202607291815_product_brand_category_corrections.sql"),
  "utf8",
);

test("known brands are assigned to the requested product categories", () => {
  assert.match(migration, /set category = 'Chocolates'[\s\S]*laviva[\s\S]*lupo/i);
  assert.match(migration, /set category = 'Chips'[\s\S]*spuds/i);
  assert.match(migration, /set category = 'Drinks'[\s\S]*sirma/i);
});

test("category correction covers both product names and brands", () => {
  for (const brand of ["laviva", "lupo", "spuds", "sirma"]) {
    const occurrences = migration.match(new RegExp(`coalesce\\((name|brand), ''\\)\\) like '%${brand}%'`, "gi")) ?? [];
    assert.equal(occurrences.length, 2, `${brand} should match both name and brand`);
  }
});
