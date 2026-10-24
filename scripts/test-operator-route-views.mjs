import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/app/operator/routes/page.tsx", "utf8");
const nav = readFileSync("src/lib/role-mobile-navigation.ts", "utf8");

test("operator route view selection is respected by the server page", () => {
  assert.match(page, /searchParams\?: Promise<\{ view\?: string \| string\[\] \}>/);
  assert.match(page, /const availableView = rawView === "available"/);
  assert.match(page, /!availableView \? <section className="space-y-4"/);
  assert.match(page, /\(availableView \|\| canManageAllRoutes\) \? <section className="space-y-4"/);
  assert.match(page, /href="\/operator\/routes\?view=available"/);
  assert.match(page, /aria-current=\{availableView \? "page" : undefined\}/);
});

test("assigned and available mobile shortcuts point to distinct real views", () => {
  assert.match(nav, /href: "\/operator\/routes", en: "My Routes"/);
  assert.match(nav, /href: "\/operator\/routes\?view=available", en: "Available"/);
  assert.match(page, /title=\{availableView \?/);
  assert.match(page, /Unassigned routes you can claim/);
});

test("completed operator history is collapsed; route execution remains unchanged", () => {
  assert.match(page, /<details className="rounded-xl border border-slate-200 bg-white p-4"/);
  assert.match(page, /<summary className="cursor-pointer text-base font-semibold text-slate-900"/);
  assert.match(page, /completedRoutes\.map\(\(route\) => \(/);
  assert.match(page, /href=\{\`\/operator\/routes\/\$\{route\.id\}\`\}/);
  assert.doesNotMatch(page, /\.update\(|\.insert\(|\.delete\(/);
});
