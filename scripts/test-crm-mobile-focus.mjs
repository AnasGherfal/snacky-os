import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/components/CrmWorkspace.tsx", "utf8");
const routes = readFileSync("src/app/my-work/page.tsx", "utf8");
const config = readFileSync("src/components/module-tabs-config.ts", "utf8");

test("CRM My Work shows urgent KPIs before an optional secondary-metrics section", () => {
  assert.match(page, /workMetrics\.slice\(0,4\)\.map/);
  assert.match(page, /workMetrics\.slice\(4\)\.map/);
  assert.match(page, /<details className="rounded-xl border border-slate-200 bg-white p-3">/);
  assert.match(page, /More work metrics/);
  for (const key of ["issue_action", "issue_waiting", "leads_today", "leads_overdue"]) assert.ok(page.includes(key),key);
  assert.match(page, /href=\{\`\$\{href\}&scope=mine\`\}/);
});

test("CRM advanced filters are expandable on My Work and show active selections", () => {
  assert.match(page, /workExtraFiltersSelected=Boolean\(/);
  assert.match(page, /open=\{section!=='work'\|\|workExtraFiltersSelected\}/);
  assert.match(page, /More filters','فلاتر إضافية/);
  assert.match(page, /name="q" defaultValue=\{filters\.q\}/);
  assert.match(page, /name="scope" defaultValue=\{filters\.scope/);
  assert.match(page, /name="window" defaultValue=\{filters\.window/);
  assert.match(page, /name="assigned_to" defaultValue=\{filters\.assigned_to/);
  assert.match(page, /name="archived" value="true"/);
  assert.match(page, /name="practice" value="true"/);
});

test("CRM issue and operator dispatch behavior remains available", () => {
  assert.match(routes, /CrmQuickIssueAction/);
  assert.match(page, /CrmIssueFieldQueueForm/);
  assert.match(page, /CrmDispatchTaskPanel/);
  assert.match(page, /snacky_crm_workspace_v1/);
  assert.match(config, /href: "\/issues\/new"/);
  assert.match(config, /href: "\/my-work"/);
});
