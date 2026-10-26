import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/routes/inventory-review/page.tsx", "utf8");

test("route inventory review provides all pages, not a silent first-100 cap", () => {
  assert.ok(page.includes('page?: string'));
  assert.ok(page.includes('if (page > 1) params.set("page", String(page))'));
  assert.ok(page.includes('.range((page - 1) * perPage, page * perPage - 1)'));
  assert.ok(page.includes('const hasMore = verifiedTotal === null ? rows.length === perPage : page * perPage < verifiedTotal'));
  assert.ok(page.includes('reviewHref(view, routeFilter, page + 1, ageFilter)'));
  assert.ok(page.includes('reviewHref(view, routeFilter, page - 1, ageFilter)'));
  assert.ok(page.includes('redirect(reviewHref(view, routeFilter, lastPage, ageFilter))'));
  assert.doesNotMatch(page, /\.limit\(100\)/);
});

test("oldest unresolved route stock cases are reviewed before new discrepancies", () => {
  assert.ok(page.includes('ascending: view === "open"'));
  assert.ok(page.includes('.order("id", { ascending: true })'));
  assert.ok(page.includes('const returnTo = reviewHref(view, routeFilter, page, ageFilter)'));
  assert.ok(page.includes('verifiedTotal === null ? tr("Unverified total"'));
});

test("pagination preserves the route filter and historical view", () => {
  assert.ok(page.includes('if (view === "history") params.set("view", view)'));
  assert.ok(page.includes('if (routeId) params.set("route", routeId)'));
  assert.ok(page.includes('if (page > 1) params.set("page", String(page))'));
});

test("age filters are server-side, preserve routes and pagination, and are bilingual", () => {
  assert.ok(page.includes("age?: string"));
  assert.ok(page.includes('rawAge === "7d" || rawAge === "30d"'));
  assert.ok(page.includes('const ageCutoff = ageFilter === "all" ? null'));
  assert.ok(page.includes('discrepancyQuery.lte("detected_at", ageCutoff)'));
  assert.ok(page.includes('if (age !== "all") params.set("age", age)'));
  assert.ok(page.includes('Older than 7 days'));
  assert.ok(page.includes('أقدم من 30 يوماً'));
  assert.ok(page.includes('reviewHref(view, routeFilter, 1, item.key)'));
  assert.ok(page.includes('reviewHref("open", routeFilter, 1, ageFilter)'));
  assert.ok(page.includes('reviewHref(view, routeFilter, page + 1, ageFilter)'));
  assert.ok(page.includes('const returnTo = reviewHref(view, routeFilter, page, ageFilter)'));
  assert.doesNotMatch(page, /\.update\(\{status: "aged"/);
});
