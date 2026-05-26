import assert from "node:assert/strict";
import test from "node:test";
import { validateVmsRows } from "../src/lib/vms-import-validation.ts";

test("first import with empty mappings groups unknown products and machines without crashing", () => {
  const result = validateVmsRows({
    reportType: "stock",
    rows: [
      {
        machine_identifier: "Unknown Machine",
        product_identifier: "VMS-001",
        product_name: "New Chips",
        current_qty: "3",
      },
    ],
    originalRows: [{ Machine: "Unknown Machine", Product: "New Chips", Qty: "3" }],
    firstDataRowNumber: 2,
    machines: [],
    machineMappings: [],
    mappings: [],
    products: [],
    autoCreateMissingProducts: false,
  });

  assert.equal(result.totalRows, 1);
  assert.equal(result.unknownMachineRows, 1);
  assert.equal(result.reviewGroups.some((group) => group.type === "unknown_machine"), true);
});

test("Khalij aliases resolve to جامعة طرابلس الاهلية when that machine exists", () => {
  const result = validateVmsRows({
    reportType: "stock",
    rows: [
      {
        machine_identifier: "KhalijUniversity",
        product_identifier: "WATER-500",
        product_name: "Water 500ml",
        current_qty: "5",
      },
      {
        machine_identifier: "@الخليج",
        product_identifier: "WATER-500",
        product_name: "Water 500ml",
        current_qty: "5",
      },
    ],
    originalRows: [{}, {}],
    firstDataRowNumber: 2,
    machines: [{ id: "machine-1", name: "جامعة طرابلس الاهلية", machine_code: "TRIPOLI-AHLIYA", vms_machine_id: null }],
    machineMappings: [],
    mappings: [{ id: "mapping-1", vms_product_id: "WATER-500", vms_product_name: "Water 500ml", product_id: "product-1", match_status: "confirmed" }],
    products: [{ id: "product-1", sku: "WATER-500", barcode: null, name: "Water 500ml" }],
  });

  assert.equal(result.unknownMachineRows, 0);
  assert.equal(result.rows.every((row) => row.matchedMachineId === "machine-1"), true);
});

test("normalized product names can match products without saved mappings", () => {
  const result = validateVmsRows({
    reportType: "stock",
    rows: [
      {
        machine_identifier: "M-1",
        product_identifier: "",
        product_name: "Pepsi 330 ML",
        current_qty: "6",
      },
    ],
    originalRows: [{}],
    firstDataRowNumber: 2,
    machines: [{ id: "machine-1", name: "Machine One", machine_code: "M-1", vms_machine_id: null }],
    machineMappings: [],
    mappings: [],
    products: [{ id: "product-1", sku: "PEPSI-330", barcode: "123", name: "Pepsi 330ml" }],
  });

  assert.equal(result.importedRows, 1);
  assert.equal(result.rows[0].matchedProductId, "product-1");
});
