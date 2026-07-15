import assert from "node:assert/strict";
import test from "node:test";
import {
  applyColumnMapping,
  detectColumnMapping,
  detectHeaderRowIndex,
  detectVmsReportTypeFromRows,
  findSalesReportPeriod,
  resolveVmsReportType,
  requiredMissing,
  sheetRowsToRecords,
} from "../src/lib/vms-parser.ts";
import {
  createVmsOrderDetailsDuplicateHash,
  detectOrderDetailsDateRange,
  orderDetailsTransactionStatus,
} from "../src/lib/vms-order-details.ts";
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
    "Total Transaction",
    "Total Transaction amount",
    "Cost Price",
    "Cost Amount",
    "Profits",
  ],
  ["6591", "Snacky", "2510001719", "HT Mall", "P001", "Water 500ml", "2.50", "10", "25.00", "1", "2.50", "11", "27.50", "1.20", "12.00", "13.00"],
];

const monthlyProfitMergedTitleRows = [
  ["Statistical statement of commodity profit(2026-04-01/2026-04-30)"],
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
    "The refund count",
    "Refund amount",
    "Total Transaction Quantity",
    "Total Transaction Amount",
    "Cost Price",
    "Cost Amount",
    "Profits",
  ],
  ["6591", "Snacky", "2510001719", "HT Mall", "P001", "Water 500ml", "2.50", "10", "25.00", "1", "2.50", "11", "27.50", "1.20", "12.00", "13.00"],
];

const orderDetailsRows = [
  ["Order Details2026-05-27"],
  [
    "Merchant ID",
    "Merchant Name",
    "Machine code",
    "Machine name",
    "Order number",
    "Cargo Lane Number",
    "Product Number",
    "product name",
    "Commodity price",
    "Commodity price",
    "Discounted price",
    "Delivery time",
    "Shipping status",
    "Purchaser",
    "Refund time",
    "Remarks",
    "Refund status",
    "Third Party Transaction Number",
    "Third Party Order No.",
    "Payment amount",
    "Time of payment",
    "Num",
  ],
  ["6591", "Snacky", "2510001719", "HT Mall", "ORD-1", "A1", "P001", "Water 500ml", "2.50", "2.50", "2.50", "2026-05-27 09:04:00", "Goods Shipped", "", "", "", "", "TP-1", "", "2.50", "2026-05-27 09:03:00", "1"],
  ["6591", "Snacky", "2510001719", "HT Mall", "ORD-2", "A2", "P002", "Chips", "3.00", "3.00", "3.00", "2026-05-28 10:10:00", "Not shipped", "", "", "", "", "TP-2", "", "3.00", "2026-05-28 10:09:00", "1"],
];

const machineStockSnapshotRows = [
  ["Inventory of machine goods"],
  [
    "Machine code",
    "Machine name",
    "Point name",
    "Product Number",
    "product name",
    "Product Specification",
    "Product bar code",
    "Third party commodity number",
    "Product Unit",
    "Production date",
    "Warranty date",
    "Inventory quantity",
    "Out of stock quantity",
    "Inventory capacity",
  ],
  ["M-001", "Machine One", "Point A", "P-001", "Water 500ml", "500ml", "1234567890123", "TP-1", "pcs", "", "", "7", "3", "10"],
];

test("VMS sales Excel title provides the March 2026 report period", () => {
  assert.equal(detectVmsReportTypeFromRows(salesRows), "monthly_product_profit");

  const headerRow = detectHeaderRowIndex(salesRows, "monthly_product_profit");
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
  const headerRow = detectHeaderRowIndex(salesRows, "monthly_product_profit");
  const sheet = sheetRowsToRecords(salesRows, { reportType: "monthly_product_profit", headerRowIndex: headerRow });
  const mapping = detectColumnMapping(sheet.headers, "monthly_product_profit", sheet.columnSamples);
  const mappedRows = applyColumnMapping(sheet.records, mapping);

  assert.equal(sheet.records.length, 1);
  assert.equal(sheet.headers[0], "Merchant ID");
  assert.equal(mapping.machine_identifier, "Machine code");
  assert.equal(mapping.product_identifier, "Product Number");
  assert.equal(mapping.transaction_count, "Number of transaction");
  assert.equal(mapping.transaction_amount, "Transaction amount");
  assert.equal(mapping.cost_price, "Cost Price");
  assert.equal(mapping.cost_amount, "Cost Amount");
  assert.equal(mapping.profit_amount, "Profits");
  assert.deepEqual(requiredMissing(mapping, "monthly_product_profit"), []);
  assert.equal(mappedRows[0].machine_identifier, "2510001719");
  assert.equal(mappedRows[0].product_identifier, "P001");
  assert.equal(mappedRows[0].transaction_count, "10");
  assert.equal(mappedRows[0].transaction_amount, "25.00");
  assert.equal(mappedRows[0].cost_price, "1.20");
  assert.equal(mappedRows[0].cost_amount, "12.00");
  assert.equal(mappedRows[0].profit_amount, "13.00");
});

test("VMS monthly profit report with merged title row detects row 2 headers and new aliases", () => {
  assert.equal(detectVmsReportTypeFromRows(monthlyProfitMergedTitleRows), "monthly_product_profit");

  const headerRow = detectHeaderRowIndex(monthlyProfitMergedTitleRows, "monthly_product_profit");
  const sheet = sheetRowsToRecords(monthlyProfitMergedTitleRows, { reportType: "monthly_product_profit", headerRowIndex: headerRow });
  const mapping = detectColumnMapping(sheet.headers, "monthly_product_profit", sheet.columnSamples);
  const mappedRows = applyColumnMapping(sheet.records, mapping);

  assert.equal(headerRow, 1);
  assert.equal(sheet.headers.length, 16);
  assert.deepEqual(sheet.headers, [
    "Merchant ID",
    "Merchant Name",
    "Machine code",
    "Machine name",
    "Product Number",
    "product name",
    "Commodity price",
    "Number of transaction",
    "Transaction amount",
    "The refund count",
    "Refund amount",
    "Total Transaction Quantity",
    "Total Transaction Amount",
    "Cost Price",
    "Cost Amount",
    "Profits",
  ]);
  assert.equal(mapping.refund_count, "The refund count");
  assert.equal(mapping.total_transaction_count, "Total Transaction Quantity");
  assert.equal(mapping.total_transaction_amount, "Total Transaction Amount");
  assert.deepEqual(requiredMissing(mapping, "monthly_product_profit"), []);
  assert.equal(mappedRows.length, 1);
  assert.equal(mappedRows[0].merchant_id, "6591");
  assert.equal(mappedRows[0].refund_count, "1");
  assert.equal(mappedRows[0].total_transaction_count, "11");
  assert.equal(mappedRows[0].total_transaction_amount, "27.50");
});

test("VMS report type resolution treats custom as fallback only", () => {
  assert.equal(
    resolveVmsReportType({
      requestedReportType: "custom",
      previewReportType: "custom",
      detectedReportType: "monthly_product_profit",
    }),
    "monthly_product_profit",
  );
  assert.equal(
    resolveVmsReportType({
      requestedReportType: "monthly_transaction_details",
      previewReportType: "custom",
      detectedReportType: "monthly_product_profit",
    }),
    "monthly_transaction_details",
  );
  assert.equal(
    resolveVmsReportType({
      requestedReportType: "custom",
      previewReportType: "monthly_product_profit",
      detectedReportType: null,
    }),
    "monthly_product_profit",
  );
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
  assert.equal(signature, "sales:merchant_id|merchant_name|machine_code|machine_name|product_number|product_name|commodity_price|number_of_transaction|transaction_amount|refund_count|refund_amount|total_transaction|total_transaction_amount|cost_price|cost_amount|profits");
});

test("VMS order details auto-detects title row and duplicate commodity price headers", () => {
  assert.equal(detectVmsReportTypeFromRows(orderDetailsRows), "vms_order_details_weekly");

  const headerRow = detectHeaderRowIndex(orderDetailsRows, "vms_order_details_weekly");
  const sheet = sheetRowsToRecords(orderDetailsRows, { reportType: "vms_order_details_weekly", headerRowIndex: headerRow });
  const mapping = detectColumnMapping(sheet.headers, "vms_order_details_weekly", sheet.columnSamples);
  const mappedRows = applyColumnMapping(sheet.records, mapping);

  assert.equal(headerRow, 1);
  assert.equal(sheet.headers.includes("Commodity price (1)"), true);
  assert.equal(sheet.headers.includes("Commodity price (2)"), true);
  assert.equal(mapping.commodity_price_1, "Commodity price (1)");
  assert.equal(mapping.commodity_price_2, "Commodity price (2)");
  assert.deepEqual(requiredMissing(mapping, "vms_order_details_weekly"), []);
  assert.equal(mappedRows[0].machine_identifier, "2510001719");
  assert.equal(mappedRows[0].product_identifier, "P001");
  assert.equal(mappedRows[0].payment_amount, "2.50");
});

test("VMS machine goods inventory report detects as machine stock snapshot", () => {
  assert.equal(detectVmsReportTypeFromRows(machineStockSnapshotRows), "machine_stock_snapshot");

  const headerRow = detectHeaderRowIndex(machineStockSnapshotRows, "machine_stock_snapshot");
  const sheet = sheetRowsToRecords(machineStockSnapshotRows, { reportType: "machine_stock_snapshot", headerRowIndex: headerRow });
  const mapping = detectColumnMapping(sheet.headers, "machine_stock_snapshot", sheet.columnSamples);
  const mappedRows = applyColumnMapping(sheet.records, mapping);

  assert.equal(headerRow, 1);
  assert.equal(sheet.records.length, 1);
  assert.deepEqual(requiredMissing(mapping, "machine_stock_snapshot"), []);
  assert.equal(mapping.machine_identifier, "Machine code");
  assert.equal(mapping.product_identifier, "Product Number");
  assert.equal(mapping.current_qty, "Inventory quantity");
  assert.equal(mapping.out_of_stock_qty, "Out of stock quantity");
  assert.equal(mapping.capacity, "Inventory capacity");
  assert.equal(mappedRows[0].machine_identifier, "M-001");
  assert.equal(mappedRows[0].machine_name, "Machine One");
  assert.equal(mappedRows[0].point_name, "Point A");
  assert.equal(mappedRows[0].product_identifier, "P-001");
  assert.equal(mappedRows[0].product_name, "Water 500ml");
  assert.equal(mappedRows[0].current_qty, "7");
  assert.equal(mappedRows[0].out_of_stock_qty, "3");
  assert.equal(mappedRows[0].capacity, "10");
});

test("VMS order details derives date range, status, and duplicate hash", () => {
  const headerRow = detectHeaderRowIndex(orderDetailsRows, "vms_order_details_weekly");
  const sheet = sheetRowsToRecords(orderDetailsRows, { reportType: "vms_order_details_weekly", headerRowIndex: headerRow });
  const mapping = detectColumnMapping(sheet.headers, "vms_order_details_weekly", sheet.columnSamples);
  const mappedRows = applyColumnMapping(sheet.records, mapping);

  assert.deepEqual(detectOrderDetailsDateRange(mappedRows), { start: "2026-05-27", end: "2026-05-28" });
  assert.equal(orderDetailsTransactionStatus(mappedRows[0]), "successful_sale");
  assert.equal(orderDetailsTransactionStatus(mappedRows[1]), "failed_vend");
  assert.equal(createVmsOrderDetailsDuplicateHash(mappedRows[0]), createVmsOrderDetailsDuplicateHash({ ...mappedRows[0] }));
});

test("VMS order details duplicate hash keeps distinct line items from the same order", () => {
  const firstLine = {
    machine_identifier: "2510001719",
    order_number: "ORD-MULTI-1",
    cargo_lane_number: "A1",
    product_identifier: "P001",
    product_name: "Water 500ml",
    payment_amount: "2.50",
    payment_time: "2026-05-27 09:03:00",
    delivery_time: "2026-05-27 09:04:00",
    num: "1",
  };
  const secondLine = {
    ...firstLine,
    cargo_lane_number: "B4",
    product_identifier: "P009",
    product_name: "Chips",
  };
  const exactDuplicate = { ...firstLine };

  assert.notEqual(createVmsOrderDetailsDuplicateHash(firstLine), createVmsOrderDetailsDuplicateHash(secondLine));
  assert.equal(createVmsOrderDetailsDuplicateHash(firstLine), createVmsOrderDetailsDuplicateHash(exactDuplicate));
});
