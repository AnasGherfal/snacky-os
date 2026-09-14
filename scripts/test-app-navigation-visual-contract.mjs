import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { navigationBreadcrumbItems } from "../src/lib/navigation-breadcrumbs.ts";

test("query-specific route breadcrumbs match the active navigation tab", () => {
  const user = { id: "operator", role: "operator", activeStatus: "active" };
  const result = navigationBreadcrumbItems([{ label: "My Routes" }], user, "/operator/routes?view=available", "en");
  assert.equal(result.at(-1).label, "Available Routes");
});

test("the global anchor reset cannot make active navigation text dark on green", () => {
  const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\[data-navigation-tabs\] a\[aria-current="page"\]\s*\{\s*color:\s*#fff;\s*background:\s*var\(--snacky-accent\)/);
  assert.match(css, /\[data-navigation-tabs\] a\s*\{[^}]*transition:\s*none/s);
});
