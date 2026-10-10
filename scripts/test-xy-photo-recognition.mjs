import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { selectPhotoSuggestions, canApplyPhotoChange, PHOTO_ANALYSIS_SCHEMA } from "../src/lib/xy-photo-recognition.ts";

const slots = [
  { slotCode: "001", currentProductId: "cola", currentVmsProductId: "xy-cola", currentQty: 6, capacity: 10 },
  { slotCode: "003", currentProductId: "cola", currentVmsProductId: "xy-cola", currentQty: 0, capacity: 10 },
  { slotCode: "005", currentProductId: "water", currentVmsProductId: "xy-water", currentQty: 5, capacity: 12 },
];
const catalog = [
  { id: "cola", name: "Cola", vmsProductId: "xy-cola" },
  { id: "water", name: "Water", vmsProductId: "xy-water" },
  { id: "snickers", name: "Snickers", vmsProductId: "xy-snickers" },
];
const obs = (slotCode, productId, confidence = "high") => ({
  slotCode, productId, confidence, visualEvidence: "Visible package with recognizable branding",
});

test("recognition treats duplicated products as separate XY lanes", () => {
  const result = selectPhotoSuggestions([obs("001", "cola"), obs("003", "cola")], slots, catalog);
  assert.equal(result.suggestions.length, 2);
  assert.deepEqual(result.suggestions.map((item) => item.slotCode), ["001", "003"]);
  assert(result.suggestions.every((item) => !item.differentFromXy));
  assert.deepEqual(result.unreadableSlots, ["005"]);
});

test("photo detects a different front package even when old XY stock is zero", () => {
  const result = selectPhotoSuggestions([obs("003", "snickers")], slots, catalog);
  assert.equal(result.suggestions[0].differentFromXy, true);
  assert.equal(result.suggestions[0].currentQty, 0);
  assert.equal(result.suggestions[0].productId, "snickers");
});

test("image model cannot inject unknown products or physical XY lanes", () => {
  const result = selectPhotoSuggestions([
    obs("003", "unknown"),
    obs("999", "cola"),
    obs("001", "snickers"),
    obs("001", "water"),
    { slotCode: "005", productId: "water", confidence: "high", visualEvidence: "" },
  ], slots, catalog);
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].slotCode, "001");
  assert.equal(result.rejectedObservations, 4);
});

test("operator must approve the physical product, old-stock custody and exact counted units", () => {
  const suggestion = selectPhotoSuggestions([obs("003", "snickers")], slots, catalog).suggestions[0];
  assert.equal(canApplyPhotoChange({ suggestion, actualQty: 5, operatorReviewed: false, oldProductAccounted: true }), false);
  assert.equal(canApplyPhotoChange({ suggestion, actualQty: 5, operatorReviewed: true, oldProductAccounted: false }), false);
  assert.equal(canApplyPhotoChange({ suggestion, actualQty: null, operatorReviewed: true, oldProductAccounted: true }), false);
  assert.equal(canApplyPhotoChange({ suggestion, actualQty: 11, operatorReviewed: true, oldProductAccounted: true }), false);
  assert.equal(canApplyPhotoChange({ suggestion, actualQty: 5, operatorReviewed: true, oldProductAccounted: true }), true);
});

test("AI result cannot independently authorize real XY changes", () => {
  const endpoint = fs.readFileSync("src/app/api/operator/routes/[id]/stops/[stopId]/xy-photo-detect/route.ts", "utf8");
  const card = fs.readFileSync("src/components/operator/MachinePhotoRecognitionCard.tsx", "utf8");
  const stop = fs.readFileSync("src/app/operator/routes/[id]/stops/[stopId]/page.tsx", "utf8");
  assert.match(endpoint, /readXyMachineLayout/);
  assert.match(endpoint, /machine_refill_history/);
  assert.match(endpoint, /getAuthAccessToken/);
  assert.match(endpoint, /selectPhotoSuggestions/);
  assert.match(endpoint, /PHOTO_ANALYSIS_SCHEMA/);
  assert.match(endpoint, /store: false/);
  assert.doesNotMatch(endpoint, /setXySlotProduct|xy-stop-quantity-syncs|inventory_movements/);
  assert.match(card, /canApplyPhotoChange/);
  assert.match(card, /queueOnOffline: false/);
  assert.match(card, /physicalChangeConfirmed: true/);
  assert.match(card, /laneDisabledConfirmed: true/);
  assert.match(card, /result.verified !== true/);
  assert.match(stop, /<MachinePhotoRecognitionCard/);
});

test("schema requires conservative confidence and visual evidence", () => {
  assert(PHOTO_ANALYSIS_SCHEMA.properties.observations.items.required.includes("visualEvidence"));
  assert(PHOTO_ANALYSIS_SCHEMA.properties.observations.items.properties.confidence.enum.includes("low"));
});
