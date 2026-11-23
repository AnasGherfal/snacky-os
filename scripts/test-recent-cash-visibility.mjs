import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const finance = readFileSync("src/app/finance/transactions/page.tsx", "utf8");
const receive = readFileSync("src/app/cash-handling/receive/page.tsx", "utf8");
const client = readFileSync("src/components/cash/CashReceiveWorkspace.tsx", "utf8");

test("a cash count never disappears just because it was entered after the removal date", () => {
  assert.match(finance, /params\.sort === "transaction_date" \? "transaction_date" : "created_at"/);
  assert.match(finance, /name="sort"/);
  assert.match(finance, /Recently entered \(newest first\)/);
  assert.match(finance, /Transaction date \(newest first\)/);
  assert.match(finance, /\.order\("id", \{ ascending: false \}\)/);
  assert.match(finance, /linked_cash_collection_id/);
});

test("owner receives recent counted records separately from the still-open bag queue", () => {
  assert.match(receive, /data-testid="recent-physical-cash-counts"/);
  assert.match(receive, /\.not\("counted_at", "is", null\)/);
  assert.match(receive, /\.not\("actual_cash_collected", "is", null\)/);
  assert.match(receive, /\.is\("voided_at", null\)/);
  assert.match(receive, /\.order\("counted_at", \{ ascending: false \}\)/);
  assert.match(receive, /\.limit\(10\)/);
  assert.match(receive, /\/finance\/transactions\?kind=cash_collection&sort=entered/);
  assert.match(receive, /isOwnerAdminRole/);
});

test("count confirmation offers receipt, refreshes history and never creates another removal", () => {
  assert.match(client, /if\(wasCounted\) \{/);
  assert.match(client, /setRecentCountLink\(box.id\)/);
  assert.match(client, /router\.refresh\(\)/);
  assert.match(client, /href=\{\`\/cash-collections\/\$\{recentCountLink\}\`\}/);
  assert.doesNotMatch(client, /createCashRemoval/);
});
