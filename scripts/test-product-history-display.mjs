import assert from "node:assert/strict";
import test from "node:test";

import {
  formatHistoryEntityLabel,
  formatHistoryRelatedReferences,
  formatPurchaseReference,
  formatRouteReference,
  sanitizeHistoryNotes,
  shortId,
} from "../src/lib/product-history-display.ts";

const lookups = {
  routes: new Map([
    [
      "11111111-1111-1111-1111-111111111111",
      {
        id: "11111111-1111-1111-1111-111111111111",
        route_date: "2026-04-09",
        operator: { full_name: "Noury" },
      },
    ],
  ]),
  purchases: new Map([
    [
      "22222222-2222-2222-2222-222222222222",
      {
        id: "22222222-2222-2222-2222-222222222222",
        receipt_number: "INV-2048",
        order_date: "2026-04-11",
        supplier: { name: "Snacky Supplies" },
      },
    ],
  ]),
  machines: new Map([
    [
      "33333333-3333-3333-3333-333333333333",
      {
        id: "33333333-3333-3333-3333-333333333333",
        name: "Snacky 12",
        machine_code: "M-12",
        location: { id: "loc-1", name: "Depot A" },
      },
    ],
  ]),
  storages: new Map([
    [
      "44444444-4444-4444-4444-444444444444",
      {
        id: "44444444-4444-4444-4444-444444444444",
        name: "Main storage",
        location_type: "main_storage",
      },
    ],
    [
      "55555555-5555-5555-5555-555555555555",
      {
        id: "55555555-5555-5555-5555-555555555555",
        name: "North storage",
        location_type: "storage",
      },
    ],
    [
      "bag-storage-1",
      {
        id: "bag-storage-1",
        name: "Noury bag",
        location_type: "operator_bag",
        related_operator_id: "66666666-6666-6666-6666-666666666666",
      },
    ],
  ]),
  teamMembers: new Map([
    [
      "66666666-6666-6666-6666-666666666666",
      {
        id: "66666666-6666-6666-6666-666666666666",
        full_name: "Noury",
      },
    ],
  ]),
  batches: new Map([
    [
      "77777777-7777-7777-7777-777777777777",
      {
        id: "77777777-7777-7777-7777-777777777777",
        route_id: "11111111-1111-1111-1111-111111111111",
        route: {
          id: "11111111-1111-1111-1111-111111111111",
          route_date: "2026-04-09",
          operator: { full_name: "Noury" },
        },
      },
    ],
  ]),
  suppliers: new Map(),
};

test("product history helpers render readable labels", () => {
  assert.equal(formatHistoryEntityLabel("operator_bag", "66666666-6666-6666-6666-666666666666", lookups), "Noury's operator bag");
  assert.equal(formatHistoryEntityLabel("operator_bag", "bag-storage-1", lookups), "Noury's operator bag");

  const machineLabel = formatHistoryEntityLabel("machine", "33333333-3333-3333-3333-333333333333", lookups);
  assert.match(machineLabel, /M-12/);
  assert.match(machineLabel, /Depot A/);

  assert.equal(formatHistoryEntityLabel("storage", "44444444-4444-4444-4444-444444444444", lookups), "Main storage");
  assert.equal(formatHistoryEntityLabel("storage", "55555555-5555-5555-5555-555555555555", lookups), "North storage");

  const routeLabel = formatRouteReference(lookups.routes.get("11111111-1111-1111-1111-111111111111"), "11111111-1111-1111-1111-111111111111");
  assert.match(routeLabel, /2026-04-09/);
  assert.match(routeLabel, /Noury/);
  assert.equal(routeLabel.includes("Ã‚Â·"), false);
  assert.match(routeLabel, / · /);

  const purchaseLabel = formatPurchaseReference(lookups.purchases.get("22222222-2222-2222-2222-222222222222"), "22222222-2222-2222-2222-222222222222");
  assert.match(purchaseLabel, /INV-2048/);
  assert.match(purchaseLabel, /Snacky Supplies/);

  const related = formatHistoryRelatedReferences(
    {
      related_route_id: "11111111-1111-1111-1111-111111111111",
      related_purchase_id: "22222222-2222-2222-2222-222222222222",
      related_machine_id: "33333333-3333-3333-3333-333333333333",
      related_pickup_batch_id: "77777777-7777-7777-7777-777777777777",
    },
    lookups,
  );
  assert.equal(related.length, 4);
  assert.match(related[0].label, /2026-04-09/);
  assert.match(related[1].label, /INV-2048/);
  assert.match(related[2].label, /M-12/);
  assert.match(related[3].label, /Pickup batch for Route 2026-04-09/);

  const notes = sanitizeHistoryNotes(
    "Moved route 11111111-1111-1111-1111-111111111111 from machine 33333333-3333-3333-3333-333333333333 to storage 44444444-4444-4444-4444-444444444444 for operator bag 66666666-6666-6666-6666-666666666666 and batch 77777777-7777-7777-7777-777777777777; linked purchase 22222222-2222-2222-2222-222222222222.",
    lookups,
  );
  assert.match(notes, /Route 2026-04-09/);
  assert.match(notes, /M-12/);
  assert.match(notes, /Main storage/);
  assert.match(notes, /Noury's operator bag/);
  assert.match(notes, /Pickup batch for Route 2026-04-09/);
  assert.match(notes, /Purchase INV-2048/);
  assert.equal(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(notes), false);

  assert.equal(shortId("12345678-1234-1234-1234-123456789abc"), "12345678");
});
