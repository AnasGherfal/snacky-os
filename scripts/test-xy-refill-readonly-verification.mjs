import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyMachineQuantityRowsAgainstXy } from "../src/lib/xy-quantity-verification.ts";

const lane = (slotCode, currentQty, vmsProductId = "cola") => ({
  slotCode, vmsProductId, productName: vmsProductId, priceLyd: 5,
  currentQty, capacity: 12,
});
const row = (slotCode, finalQty, productId = "cola") => ({
  slotCode, machineSlotId: slotCode, productId, productName: productId,
  previousQty: 0, addedQty: finalQty, finalQty,
});

test("same snack in two selections must match each selection independently", () => {
  const result = verifyMachineQuantityRowsAgainstXy(
    [row("001", 8), row("003", 8)],
    [lane("001", 8), lane("003", 0)],
    new Map([["cola", "cola"]]),
  );
  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatches.map((x) => x.slotCode), ["003"]);
  assert.equal(result.mismatches[0].actualQty, 0);
});

test("read-only check passes when both duplicate-product lanes are correctly filled", () => {
  const result = verifyMachineQuantityRowsAgainstXy(
    [row("001", 8), row("003", 8)],
    [lane("001", 8), lane("003", 8)],
    new Map([["cola", "cola"]]),
  );
  assert.equal(result.verified, true);
});

test("same physical lane listed twice cannot silently pass", () => {
  const result = verifyMachineQuantityRowsAgainstXy(
    [row("001", 5), row("001", 5)],
    [lane("001", 5)],
    new Map([["cola", "cola"]]),
  );
  assert.equal(result.verified, false);
  assert.equal(result.mismatches[0].reason, "duplicate_slot");
});

test("physical swap or wrong assigned product is flagged even if quantity matches", () => {
  const result = verifyMachineQuantityRowsAgainstXy(
    [row("021", 10, "water")],
    [lane("021", 10, "cola")],
    new Map([["cola", "cola"], ["water", "water"]]),
  );
  assert.equal(result.mismatches[0].reason, "product_mismatch");
});

test("XY unmapped product, nonexistent lane and unknown quantity fail closed", () => {
  assert.equal(verifyMachineQuantityRowsAgainstXy([row("001", 7)], [lane("001", 7)], new Map()).mismatches[0].reason, "unmapped_product");
  assert.equal(verifyMachineQuantityRowsAgainstXy([row("099", 7)], [lane("001", 7)]).mismatches[0].reason, "missing_slot");
  assert.equal(verifyMachineQuantityRowsAgainstXy([row("001", 7)], [lane("001", null)]).verified, false);
});

test("legacy unassigned lane and no actual restock are not verified", () => {
  assert.equal(verifyMachineQuantityRowsAgainstXy([row("VMS", 5)], []).mismatches[0].reason, "generic_slot");
  assert.equal(verifyMachineQuantityRowsAgainstXy([], [lane("001", 8)]).verified, false);
});

test("read-only route endpoint keeps XY write in a separate mode", () => {
  const endpoint = fs.readFileSync("src/app/api/operator/routes/[id]/stops/[stopId]/quantity-confirmation/route.ts", "utf8");
  assert.match(endpoint, /mode === "xy_readonly"/);
  assert.match(endpoint, /verifyMachineQuantityRowsAgainstXy\(rows, liveLayout, productByVmsId\)/);
  assert.match(endpoint, /\} else \{\s*const liveBySlot/);
  assert.match(endpoint, /mode === "xy_api" \|\| mode === "xy_readonly"/);
});

test("operator exposes read-only check and isolated test route", () => {
  const card = fs.readFileSync("src/components/operator/MachineQuantityConfirmationCard.tsx", "utf8");
  const stopPage = fs.readFileSync("src/app/operator/routes/[id]/stops/[stopId]/page.tsx", "utf8");
  const lab = fs.readFileSync("src/app/operator/verification-test/page.tsx", "utf8");
  assert.match(card, /saveMode\("xy_readonly"\)/);
  assert.match(card, /mismatchedSelections/);
  assert.match(stopPage, /<MachineQuantityConfirmationCard/);
  assert.match(lab, /Safe, in-browser test route/);
  assert.doesNotMatch(lab, /fetch\(|getSupabase|setXySlotProduct/);
});
