import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const dashboard=readFileSync("src/app/dashboard/page.tsx","utf8");
const tabs=readFileSync("src/components/module-tabs-config.ts","utf8");

test("dashboard directs owner to one actionable buying list rather than a redundant restock dashboard",()=>{
  assert.match(dashboard,/<SecondaryButton href="\/restock-priority\/purchase-list">/);
  assert.match(dashboard,/href: "\/restock-priority\/purchase-list"/);
  assert.doesNotMatch(dashboard,/href="\/restock-priority"/);
  assert.doesNotMatch(dashboard,/href: "\/restock-priority\?filter=critical"/);
  assert.match(tabs,/label: "What to Buy", href: "\/restock-priority\/purchase-list"/);
});

test("live XY trouble opens actual XY control page, not historical upload metadata",()=>{
  assert.match(dashboard,/href="\/admin\/vms-api".*Check current XY data/);
  assert.match(tabs,/label: "XY VMS API", href: "\/admin\/vms-api"/);
  assert.match(dashboard,/href="\/vms-import\/sources"/,
    "Historical import detail remains available in the correct import section");
});

test("route and cash critical actions remain prominent on home",()=>{
  assert.match(dashboard,/<PrimaryButton href="\/routes\/new">/);
  assert.match(dashboard,/key: "cash-waiting"/);
  assert.match(dashboard,/href: "\/cash-collections\?status=collected_pending_count"/);
  assert.match(dashboard,/href: "\/routes\/inventory-review"/);
});
