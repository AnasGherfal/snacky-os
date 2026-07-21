import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const profileSource = readFileSync("src/app/team/[id]/page.tsx", "utf8");

test("operator profile reads complete manual sales and damaged history", () => {
  assert.match(profileSource, /getSupabaseAdminClient\(\) \?\? getSupabaseServerClient\(\)/);
  assert.match(profileSource, /route_manual_sales/);
  assert.match(profileSource, /inventory_adjustments/);
  assert.doesNotMatch(profileSource, /inventory_adjustments[\s\S]{0,300}\.neq\("status", "cancelled"\)/);
  assert.match(profileSource, /HIDDEN_HISTORY_STATUSES/);
  assert.match(profileSource, /salesResult\.data \?\? \[\]\)\.filter\(isVisibleHistoryRow\)/);
  assert.match(profileSource, /adjustmentsResult\.data \?\? \[\]\)\.filter\(isVisibleHistoryRow\)/);
  assert.match(profileSource, /Manual sales made on routes/);
  assert.match(profileSource, /Damaged, returned, and machine storage/);
  assert.match(profileSource, /historyStatus\(sale\.status\) \|\| "recorded"/);
});
