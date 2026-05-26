import assert from "node:assert/strict";
import test from "node:test";
import {
  applyColumnMapping,
  detectColumnMapping,
  detectHeaderRowIndex,
  findSalesReportPeriod,
  requiredMissing,
  sheetRowsToRecords,
} from "../src/lib/vms-parser.ts";
import {
  createVmsSalesSourceRowKey,
  vmsHeaderSignature,
} from "../src/lib/vms-sales-import.ts";

const salesRows = [
  ["Statistical statement of commodity profit(2026-03-01/2026-03-31)"],
  [
    "Merchant ID",
    "Merchant Name",
    "Machine code",
    "Machine name",
    "Product Number",
    "product name",
    "Commodity price",
    "Number of transaction",
    "Transaction amount",
    "Refund count",
    "Refund amount",
  ],
  ["6591", "Snacky", "2510001719", "HT Mall", "P001", "Water 500ml", "2.50", "10", "25.00", "1", "2.50"],
];

test("VMS sales Excel title provides the March 2026 report period", () => {
  const headerRow = detectHeaderRowIndex(salesRows, "sales");
  assert.equal(headerRow, 1);

  const period = findSalesReportPeriod(salesRows, headerRow);
  assert.deepEqual(period && {
    reportStartDate: period.reportStartDate,
    reportEndDate: period.reportEndDate,
    salesMonth: period.salesMonth,
    sourceRowIndex: period.sourceRowIndex,
  }, {
    reportStartDate: "2026-03-01",
    reportEndDate: "2026-03-31",
    salesMonth: "2026-03-01",
    sourceRowIndex: 0,
  });
});

test("VMS sales header detection skips the title row and maps transaction columns", () => {
  const headerRow = detectHeaderRowIndex(salesRows, "sales");
  const sheet = sheetRowsToRecords(salesRows, { reportType: "sales", headerRowIndex: headerRow });
  const mapping = detectColumnMapping(sheet.headers, "sales", sheet.columnSamples);
  const mappedRows = applyColumnMapping(sheet.records, mapping);

  assert.equal(sheet.records.length, 1);
  assert.equal(sheet.headers[0], "Merchant ID");
  assert.equal(mapping.machine_identifier, "Machine code");
  assert.equal(mapping.product_identifier, "Product Number");
  assert.equal(mapping.sold_qty, "Number of transaction");
  assert.equal(mapping.total_sales_amount, "Transaction amount");
  assert.deepEqual(requiredMissing(mapping, "sales"), []);
  assert.equal(mappedRows[0].machine_identifier, "2510001719");
  assert.equal(mappedRows[0].product_identifier, "P001");
  assert.equal(mappedRows[0].sold_qty, "10");
  assert.equal(mappedRows[0].total_sales_amount, "25.00");
});

test("VMS sales source row key is stable for duplicate imports", () => {
  const first = createVmsSalesSourceRowKey({
    machineId: "machine-1",
    productId: "product-1",
    saleStartDate: "2026-03-01",
    saleEndDate: "2026-03-31",
    reportStartDate: "2026-03-01",
    reportEndDate: "2026-03-31",
    soldQty: 10,
    grossSalesAmount: 25,
    netSalesAmount: 22.5,
  });
  const second = createVmsSalesSourceRowKey({
    machineId: "machine-1",
    productId: "product-1",
    saleStartDate: "2026-03-01",
    saleEndDate: "2026-03-31",
    reportStartDate: "2026-03-01",
    reportEndDate: "2026-03-31",
    soldQty: 10,
    grossSalesAmount: 25.0,
    netSalesAmount: 22.5,
  });

  assert.equal(first, second);
});

test("VMS header signature identifies reusable report formats", () => {
  const signature = vmsHeaderSignature("sales", salesRows[1]);
  assert.equal(signature, "sales:merchant_id|merchant_name|machine_code|machine_name|product_number|product_name|commodity_price|number_of_transaction|transaction_amount|refund_count|refund_amount");
});
