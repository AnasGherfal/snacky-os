import assert from "node:assert/strict";
import test from "node:test";
import { groupRouteItemsForDisplay } from "../src/lib/route-pickup-checklist.ts";

test("route product grouping maps the expected snack families", () => {
  const grouped = groupRouteItemsForDisplay([
    { productName: "Luppo" },
    { productName: "Galaxy" },
    { productName: "Snickers" },
    { productName: "Twix" },
    { productName: "X!R / Exar" },
    { productName: "Almarai chocolate" },
    { productName: "Almarai strawberry" },
    { productName: "Bebeto" },
    { productName: "Mr Crunch" },
    { productName: "Doritos" },
    { productName: "water" },
  ]);

  const groupByProduct = new Map(
    grouped.flatMap((group) => group.items.map((item) => [item.productName.toLowerCase(), group.groupKey])),
  );

  assert.equal(groupByProduct.get("luppo"), "chocolates");
  assert.equal(groupByProduct.get("galaxy"), "chocolates");
  assert.equal(groupByProduct.get("snickers"), "chocolates");
  assert.equal(groupByProduct.get("twix"), "chocolates");
  assert.equal(groupByProduct.get("x!r / exar"), "drinks");
  assert.equal(groupByProduct.get("almarai chocolate"), "almarai_dairy");
  assert.equal(groupByProduct.get("almarai strawberry"), "almarai_dairy");
  assert.equal(groupByProduct.get("bebeto"), "candy");
  assert.equal(groupByProduct.get("mr crunch"), "chips");
  assert.equal(groupByProduct.get("doritos"), "chips");
  assert.equal(groupByProduct.get("water"), "water");
});
