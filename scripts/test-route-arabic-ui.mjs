import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const quick = read("src/components/operator/RouteStopQuickActions.tsx");
const compressor = read("src/components/operator/CompressorSafetyProofCard.tsx");
const manual = read("src/components/operator/ManualRouteSalesSection.tsx");
const stop = read("src/app/operator/routes/[id]/stops/[stopId]/page.tsx");
const routeSources = { quick, compressor, manual, stop };

function hasPair(source, english) {
  const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(source, new RegExp(`tr\\(\\"${escaped}\\", \\"[^\\"]+\\"\\)`));
}

test("route localization source is valid UTF-8 without mojibake markers", () => {
  const suspiciousPatterns = ["Ãƒ", "Ã¢", "Ã‚", "â€", "Ø", "Ù", "Ùƒ", "Ø§", "�"];
  for (const [name, source] of Object.entries(routeSources)) {
    for (const marker of suspiciousPatterns) {
      assert.equal(source.includes(marker), false, `${name} contains mojibake marker ${marker}`);
    }
  }
});

test("quick route actions are explicit language pairs", () => {
  for (const label of ["Quick stop actions", "Manual sale", "Damaged", "Return"]) hasPair(quick, label);
});

test("manual sales use locale-aware labels and validation", () => {
  for (const label of ["Manual Route Sales", "Choose a product or enter the product name.", "Manual sale saved.", "Optional context for this sale"]) hasPair(manual, label);
  assert.doesNotMatch(manual, /setError\(\"[^\"]*[\u0600-\u06ff]/);
  assert.match(manual, /locale === \"ar\"/);
});

test("compressor proof localizes labels and errors", () => {
  for (const label of ["Compressor switched ON", "Save compressor proof", "Confirm that the compressor is switched on.", "The photo could not be uploaded. Try again before completing the stop."]) hasPair(compressor, label);
  assert.match(compressor, /toLocaleString\(locale === \"ar\" \? \"ar-LY\" : \"en-US\"\)/);
});

test("cleaning and final proof controls are paired", () => {
  for (const label of ["Refill proof", "Cleaning and final check", "I have completed all checks:", "Machine exterior is clean", "Machine is operating properly", "Cancel"]) hasPair(stop, label);
});

test("damaged and return forms localize reason display", () => {
  hasPair(stop, "Return from machine");
  assert.match(stop, /localizedAdjustmentReasonLabel\(reason, locale\)/);
  assert.match(stop, /adjustmentReasonArabicLabels/);
});

test("cash controls do not leave hardcoded English yes and no", () => {
  hasPair(stop, "Yes");
  hasPair(stop, "No");
  hasPair(stop, "Stop notes");
  assert.doesNotMatch(stop, />\s*Yes\s*</);
  assert.doesNotMatch(stop, />\s*No\s*</);
});
