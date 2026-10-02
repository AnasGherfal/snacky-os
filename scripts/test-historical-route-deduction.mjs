import assert from "node:assert/strict";
import test from "node:test";
import {
  KHALIJ_UNIVERSITY_MACHINE_NAME,
  normalizeHistoricalDigits,
  parseHistoricalRouteDeductionText,
} from "../src/lib/historical-route-deduction.ts";

const products = [
  { id: "p-doritos", name: "Doritos", sku: "0001" },
  { id: "p-hot", name: "Doritos Green Hot", sku: "0002" },
  { id: "p-water-pack", name: "Water pack 12 bottles", sku: "WATER-12" },
  { id: "p-pepsi", name: "Pepsi", sku: "0029" },
  { id: "p-tarboouch", name: "Mr Crunch Tarboouch", sku: "TARB" },
  { id: "p-xr", name: "X!R", sku: "0011" },
];

const machines = [
  { id: "m-khalij", name: KHALIJ_UNIVERSITY_MACHINE_NAME, machine_code: "2510001719" },
  { id: "m-tahadi", name: "جامعة التحدي", machine_code: "2509000370" },
  { id: "m-ht", name: "اتش تي مول", machine_code: "2509000371" },
];

test("normalizes Arabic and Persian digits to English digits", () => {
  assert.equal(normalizeHistoricalDigits("١٢٣ ۴۵۶"), "123 456");
});

test("parses old route text into a clean machine-grouped preview", () => {
  const parsed = parseHistoricalRouteDeductionText({
    text: [
      "@الخليج",
      "دوريتوس ز ٥",
      "1 ميه",
      "@التحدي",
      "دورتوس خ 3",
      "بيبسي 2",
      "اتش مول",
      "٢ طربوش",
    ].join("\n"),
    products,
    machines,
    storageBalances: [
      { product_id: "p-doritos", quantity_on_hand: 20 },
      { product_id: "p-hot", quantity_on_hand: 5 },
      { product_id: "p-water-pack", quantity_on_hand: 10 },
      { product_id: "p-pepsi", quantity_on_hand: 4 },
      { product_id: "p-tarboouch", quantity_on_hand: 8 },
    ],
  });

  assert.equal(parsed.readyLines.length, 5);
  assert.equal(parsed.needsReviewLines.length, 0);
  assert.equal(parsed.machineGroups.length, 3);
  assert.equal(parsed.machineGroups.find((group) => group.machineId === "m-khalij").totalQuantity, 6);
  assert.equal(parsed.readyLines.find((line) => line.productId === "p-water-pack").quantity, 1);
  assert.equal(parsed.readyLines.find((line) => line.productId === "p-water-pack").productName, "Water pack 12 bottles");
});

test("maps KhalijUniversity aliases to the Khalij university machine", () => {
  const parsed = parseHistoricalRouteDeductionText({
    text: "KhalijUniversity\nبيبسي 1",
    products,
    machines,
    storageBalances: [{ product_id: "p-pepsi", quantity_on_hand: 1 }],
  });

  assert.equal(parsed.readyLines[0].machineId, "m-khalij");
  assert.equal(parsed.readyLines[0].machineName, KHALIJ_UNIVERSITY_MACHINE_NAME);
});

test("keeps unclear rows in grouped needs review", () => {
  const parsed = parseHistoricalRouteDeductionText({
    text: ["@الخليج", "بيبسي", "منتج مجهول 2", "@غير معروف", "بيبسي 1"].join("\n"),
    products,
    machines,
    storageBalances: [{ product_id: "p-pepsi", quantity_on_hand: 5 }],
  });

  assert.equal(parsed.readyLines.length, 0);
  assert.equal(parsed.needsReviewLines.length, 3);
  assert.ok(parsed.reviewGroups.some((group) => group.key.startsWith("quantity:") && group.count === 1));
  assert.ok(parsed.reviewGroups.some((group) => group.key.startsWith("product:") && group.count === 1));
  assert.ok(parsed.reviewGroups.some((group) => group.key.startsWith("machine:") && group.count === 1));
});

test("allows negative storage with a warning instead of blocking the ready row", () => {
  const parsed = parseHistoricalRouteDeductionText({
    text: "@التحدي\nدورتوس خ 3",
    products,
    machines,
    storageBalances: [{ product_id: "p-hot", quantity_on_hand: 2 }],
  });

  assert.equal(parsed.readyLines.length, 1);
  assert.equal(parsed.readyLines[0].storageNegativeWarning, true);
  assert.equal(parsed.readyLines[0].storageQtyAfter, -1);
});
