import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("pickup confirmation requires the operator's real checklist", () => {
  const page = read("src/app/operator/routes/[id]/pick-list/page.tsx");
  const action = read("src/lib/direct-pickup-actions.ts");

  assert.match(page, /allSelectedPickupItemsChecked/);
  assert.match(page, /disabled=\{submitting \|\| locked \|\| confirmed \|\| !selectedStopIds\.length \|\| !stopGroups\.length \|\| !allSelectedPickupItemsChecked\}/);
  assert.match(page, /acknowledgedPickupLineIds: selectedPickupItemIds\.filter/);
  assert.match(page, /setError\(copy\.checkAll\)/);
  assert.doesNotMatch(page, /Checks are only a progress aid and never block confirmation/);

  assert.match(action, /acknowledgedPickupLineIds\?: string\[\]/);
  assert.match(action, /missingPickupLineIds/);
  assert.match(action, /Check every pickup item before confirming pickup/);
  assert.doesNotMatch(action, /isChecked: true/);
});

test("Pick this stop opens a checklist scoped to that stop", () => {
  const routePage = read("src/app/operator/routes/[id]/page.tsx");
  const pickupPage = read("src/app/operator/routes/[id]/pick-list/page.tsx");

  assert.match(routePage, /pick-list\?stop=\$\{stop\.id\}/);
  assert.match(pickupPage, /const requestedStopId = searchParams\.get\("stop"\)/);
  assert.match(pickupPage, /setSelectedStopIds\(requestedGroup \? \[requestedGroup\.routeStopId\]/);
});

test("an earlier stop pickup never locks later pending stops", () => {
  const api = read("src/app/api/operator/routes/[id]/pick-list/route.ts");

  assert.match(api, /let hasAnyConfirmedPickup = false/);
  assert.match(api, /hasAnyConfirmedPickup = Boolean\(pickMovementsResult\.data\?\.length\)/);
  assert.match(api, /const confirmed = pendingStopCount === 0 && hasAnyConfirmedPickup/);
  assert.doesNotMatch(api, /confirmed = Boolean\(pickMovementsResult\.data\?\.length\)/);
});
