import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  validateGalleryObservations,
  GALLERY_PHOTO_SCHEMA,
  GALLERY_PHOTO_MAX_BYTES,
} from "../src/lib/xy-photo-gallery-test.ts";

const catalog = new Map([["cola", "Coca-Cola"], ["water", "Water"], ["snack", "Snickers"]]);
const detected = (rowNumber, positionNumber, productId, confidence = "high") => ({
  rowNumber, positionNumber, productId, confidence, visualEvidence: "Visible label and front packaging",
});

test("library AI test keeps one snack in multiple separate positions", () => {
  const check = validateGalleryObservations([
    detected(1, 1, "cola"),
    detected(1, 2, "cola"),
    detected(2, 1, "snack"),
  ], catalog);
  assert.equal(check.rejected, 0);
  assert.equal(check.observations.length, 3);
  assert.deepEqual(check.observations.map((row) => [row.rowNumber, row.positionNumber]), [[1,1],[1,2],[2,1]]);
});

test("unrecognized products, duplicate positions, nonsense indices and blank evidence fail closed", () => {
  const check = validateGalleryObservations([
    detected(1, 1, "cola"), detected(1, 1, "snack"),
    detected(9, 1, "unknown"), detected(-1, 1, "water"),
    detected(2, 2, "water", "maybe"),
    { ...detected(3, 1, "cola"), visualEvidence: "" },
    { ...detected("3", 2, "snack") },
  ], catalog);
  assert.equal(check.observations.length, 1);
  assert.equal(check.rejected, 6);
});

test("gallery route is owner-only, in-memory, explicitly not a vending update", () => {
  const endpoint = fs.readFileSync("src/app/api/admin/xy-photo-gallery-test/route.ts", "utf8");
  assert.match(endpoint, /isOwnerAdminRole\(profile\)/);
  assert.match(endpoint, /getCurrentProfile/);
  assert.match(endpoint, /await request.formData\(\)/);
  assert.match(endpoint, /store: false/);
  assert.match(endpoint, /validateGalleryObservations/);
  assert.match(endpoint, /GALLERY_PHOTO_MAX_BYTES/);
  assert.match(endpoint, /no-store/);
  assert.doesNotMatch(endpoint, /\.insert\(|\.upsert\(|\.update\(|setXySlotProduct|inventory_movements|uploadRefillProofPhoto|readXyMachineLayout/);
  assert(GALLERY_PHOTO_MAX_BYTES < 4.5 * 1024 * 1024);
});

test("iPhone photo gallery selector has no forced camera capture and sends selected image to AI test only", () => {
  const panel = fs.readFileSync("src/components/operator/PhotoLibraryAiTest.tsx", "utf8");
  const route = fs.readFileSync("src/app/operator/verification-test/page.tsx", "utf8");
  assert.match(panel, /type="file" accept="image\/\*"/);
  assert.doesNotMatch(panel, /capture="environment"/);
  assert.match(panel, /galleryJpeg\(photo\)/);
  assert.match(panel, /\/api\/admin\/xy-photo-gallery-test/);
  assert.match(panel, /PhotoLibraryAiTest/);
  assert.match(panel, /if \(permission !== "owner"\) return null/);
  assert.match(route, /<PhotoLibraryAiTest \/>/);
  assert.doesNotMatch(panel, /xy-final-quantities|xy-slot-product|xy-stop-quantity-syncs/);
});

test("photo test does not invent real XY slot codes or quantities", () => {
  const endpoint = fs.readFileSync("src/app/api/admin/xy-photo-gallery-test/route.ts", "utf8");
  const keys = GALLERY_PHOTO_SCHEMA.properties.observations.items.required;
  assert(keys.includes("rowNumber"));
  assert(keys.includes("positionNumber"));
  assert(!keys.includes("stockQty"));
  assert.match(endpoint, /NOT real XY machine selection codes/);
});
