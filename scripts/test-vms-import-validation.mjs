import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeVmsImportBatchPayload } from "../src/lib/vms-import-batch-payload.ts";
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

test("sanitizeVmsImportBatchPayload rejects invalid batch payload fields", () => {
  assert.throws(
    () => sanitizeVmsImportBatchPayload({ file_name: "test.csv", of: "bad" }, { queryName: "test", currentStep: "preview", selectedImportBatchId: null }),
    /invalid field `of`/,
  );
});

test("sanitizeVmsImportBatchPayload returns a plain payload for Supabase", () => {
  const payload = sanitizeVmsImportBatchPayload(
    { file_name: "Order Details.xls", rows_found: 22, status: "previewed" },
    { queryName: "test", currentStep: "preview", selectedImportBatchId: null },
  );

  assert.equal(payload instanceof Promise, false);
  assert.deepEqual(payload, { file_name: "Order Details.xls", rows_found: 22, status: "previewed" });
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

test("order details validation accepts mapped transaction rows and flags unknown mappings", () => {
  const result = validateVmsRows({
    reportType: "vms_order_details_weekly",
    rows: [
      {
        machine_identifier: "M-1",
        machine_name: "Machine One",
        product_identifier: "P-1",
        product_name: "Water 500ml",
        shipping_status: "Goods Shipped",
        payment_amount: "2.50",
        payment_time: "2026-05-27 09:03:00",
        quantity: "1",
      },
      {
        machine_identifier: "M-2",
        product_identifier: "P-2",
        product_name: "Unknown Chips",
        shipping_status: "Goods Shipped",
        payment_amount: "3.00",
        payment_time: "2026-05-27 09:05:00",
      },
    ],
    originalRows: [{}, {}],
    firstDataRowNumber: 2,
    machines: [{ id: "machine-1", name: "Machine One", machine_code: "M-1", vms_machine_id: null }],
    machineMappings: [],
    mappings: [{ id: "mapping-1", vms_product_id: "P-1", vms_product_name: "Water 500ml", product_id: "product-1", match_status: "confirmed" }],
    products: [{ id: "product-1", sku: "P-1", barcode: null, name: "Water 500ml" }],
  });

  assert.equal(result.importedRows, 1);
  assert.equal(result.unknownMachineRows, 1);
  assert.equal(result.missingProductMappingCount, 1);
  assert.equal(result.rows[0].matchedMachineId, "machine-1");
  assert.equal(result.rows[0].matchedProductId, "product-1");
});
