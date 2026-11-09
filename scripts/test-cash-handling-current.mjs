import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const handling = readFileSync("src/components/CashHandlingWorkspace.tsx", "utf8");
const month = readFileSync("src/lib/cash-current-period.ts", "utf8");

test("Cash handling defaults to current Libya month, retains all historical records", () => {
  assert.match(handling, /currentLibyaCashMonth\(\)\.startTimestamp/);
  assert.match(handling, /status === 'all' \|\| Date\.parse\(r\.collected_at\) >= currentMonthStartMs/);
  assert.match(handling, /currentCashRows\.map\(row =>/);
  assert.match(handling, /Older records remain in History/);
  assert.match(handling, /\['open', 'Needs action'/);
  assert.match(handling, /\['all', 'History'/);
  assert.match(month, /Africa\/Tripoli/);
});

test("Owner has a direct one-time physical count route for existing removals", () => {
  assert.match(handling, /href="\/cash-collections\/count"/);
  assert.match(handling, /Count current cash/);
  assert.doesNotMatch(handling, /\.insert\(|\.update\(|\.delete\(/);
});
