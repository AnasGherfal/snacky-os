import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRouteManualSale } from "../src/lib/manual-route-sales.ts";

const rawConfirmedSale = {
  id: "5372042c-8e54-46ff-903d-89584dba6da8",
  route_id: "d337985c-7350-4e43-96de-241df92575e7",
  route_stop_id: "9c49043e-9c31-4048-9db3-5b852a053956",
  machine_id: "11111111-1111-4111-8111-111111111111",
  location_id: "22222222-2222-4222-8222-222222222222",
  operator_id: "33333333-3333-4333-8333-333333333333",
  product_id: "6316ac3c-4fae-47fb-804f-207d917a7f4b",
  product_name: "Mr Power",
  quantity: 1,
  unit_sale_price_lyd: "5.00",
  total_amount_lyd: "5.00",
  payment_method: "cash",
  notes: null,
  sale_time: "2026-09-19T22:37:46.403165+00:00",
  status: "confirmed",
  client_submission_id: "manual-sale-regression",
  inventory_movement_id: null,
  cash_collection_id: null,
  cancellation_reason: null,
  cancelled_at: null,
  cancelled_by_user_id: null,
};

test("manual-sale normalization is idempotent for the operator save response", () => {
  const serverPayload = normalizeRouteManualSale(rawConfirmedSale);
  assert.equal(serverPayload.productName, "Mr Power");
  assert.equal(serverPayload.quantity, 1);
  assert.equal(serverPayload.unitSalePriceLyd, 5);
  assert.equal(serverPayload.totalAmountLyd, 5);

  const phonePayload = normalizeRouteManualSale(serverPayload);
  assert.deepEqual(phonePayload, serverPayload);
  assert.notEqual(phonePayload.productName, "Unknown product");
});

test("already-normalized cancelled sales keep their product, quantity and price", () => {
  const serverPayload = normalizeRouteManualSale({
    ...rawConfirmedSale,
    id: "47723bfd-8449-45ab-9fb6-374a8e1c1b47",
    product_id: "50294090-6a32-4b43-9d27-e5fecd68c6ad",
    product_name: "Water",
    quantity: 6,
    unit_sale_price_lyd: "1.00",
    total_amount_lyd: "6.00",
    status: "cancelled",
    cancellation_reason: "Cancelled from route stop",
    cancelled_at: "2026-09-19T22:40:00.000000+00:00",
  });

  const phonePayload = normalizeRouteManualSale(serverPayload);
  assert.equal(phonePayload.productName, "Water");
  assert.equal(phonePayload.quantity, 6);
  assert.equal(phonePayload.unitSalePriceLyd, 1);
  assert.equal(phonePayload.totalAmountLyd, 6);
  assert.equal(phonePayload.status, "cancelled");
  assert.equal(phonePayload.cancellationReason, "Cancelled from route stop");
});

test("raw sale rows still normalize exactly as before", () => {
  const sale = normalizeRouteManualSale({
    ...rawConfirmedSale,
    quantity: "6",
    unit_sale_price_lyd: "1.00",
    total_amount_lyd: "999.00",
    product_name: "Water",
  });

  assert.equal(sale.productName, "Water");
  assert.equal(sale.quantity, 6);
  assert.equal(sale.unitSalePriceLyd, 1);
  assert.equal(sale.totalAmountLyd, 6);
  assert.equal(sale.paymentMethod, "cash");
});
