import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = fs.readFileSync(path.join(root, "src/app/reports/route-performance/page.tsx"), "utf8");
const tabs = fs.readFileSync(path.join(root, "src/components/module-tabs-config.ts"), "utf8");

test("monthly route dashboard filters routes by selected month", () => {
  assert.match(page, /type="month"/);
  assert.match(page, /\.gte\("route_date", start\)/);
  assert.match(page, /\.lt\("route_date", next\)/);
});

test("dashboard counts completed machine stops and groups by machine and operator", () => {
  assert.match(page, /\["completed", "done"\]/);
  assert.match(page, /machineStats/);
  assert.match(page, /operatorStats/);
  assert.match(page, /Machine fill frequency/);
  assert.match(page, /Operator performance/);
  assert.match(page, /عدد مرات تعبئة كل جهاز/);
  assert.match(page, /أداء المشغلين/);
});

test("route performance is available in Reports navigation", () => {
  assert.match(tabs, /label: "Route Performance", href: "\/reports\/route-performance"/);
});
