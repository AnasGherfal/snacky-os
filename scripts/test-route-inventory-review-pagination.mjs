import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/routes/inventory-review/page.tsx", "utf8");

test("route inventory review provides all pages, not a silent first-100 cap", () => {
  assert.ok(page.includes('page?: string'));
  assert.ok(page.includes('if (page > 1) params.set("page", String(page))'));
  assert.ok(page.includes('.range((page - 1) * perPage, page * perPage - 1)'));
  assert.ok(page.includes('const hasMore = verifiedTotal === null ? rows.length === perPage : page * perPage < verifiedTotal'));
  assert.ok(page.includes('reviewHref(view, routeFilter, page + 1)'));
  assert.ok(page.includes('reviewHref(view, routeFilter, page - 1)'));
  assert.ok(page.includes('redirect(reviewHref(view, routeFilter, lastPage))'));
  assert.doesNotMatch(page, /\.limit\(100\)/);
});

test("oldest unresolved route stock cases are reviewed before new discrepancies", () => {
  assert.ok(page.includes('ascending: view === "open"'));
  assert.ok(page.includes('.order("id", { ascending: true })'));
  assert.ok(page.includes('const returnTo = reviewHref(view, routeFilter, page)'));
  assert.ok(page.includes('verifiedTotal === null ? tr("Unverified total"'));
});

test("pagination preserves the route filter and historical view", () => {
  assert.ok(page.includes('if (view === "history") params.set("view", view)'));
  assert.ok(page.includes('if (routeId) params.set("route", routeId)'));
  assert.ok(page.includes('if (page > 1) params.set("page", String(page))'));
});
