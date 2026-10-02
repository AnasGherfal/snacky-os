import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveSalesDashboardRange,
  resolveSalesDashboardSourceReportType,
  salesCoverageSummary,
} from "../src/lib/sales-dashboard.ts";
import {
  describeSalesCoverageState,
  describeSalesDashboardNoDataState,
  salesDashboardSourceLabel,
} from "../src/lib/sales-coverage.ts";
import {
  createVmsImportDuplicateContextMap,
  describeVmsImportBatchStatus,
  vmsImportReportTypeLabel,
} from "../src/lib/vms-import-status.ts";

function makeDashboardBatch(overrides = {}) {
  return {
    id: "batch-1",
    report_type: "vms_order_details_weekly",
    status: "imported",
    is_active: true,
    deleted_at: null,
    file_hash: "hash-1",
    file_name: "Detailed Order Details.xlsx",
    uploaded_at: "2026-06-30T10:00:00Z",
    imported_at: "2026-06-30T10:05:00Z",
    report_start_date: "2026-06-01",
    report_end_date: "2026-06-30",
    detected_min_datetime: "2026-06-01T10:00:00Z",
    detected_max_datetime: "2026-06-30T10:00:00Z",
    rows_found: 10,
    rows_imported: 10,
    rows_needing_review: 0,
    ...overrides,
  };
}

function makeContribution(overrides = {}) {
  return {
    batch: makeDashboardBatch(),
    actualCoverageEnd: "2026-06-30",
    actualCoverageLabel: "2026-06",
    actualCoverageStart: "2026-06-01",
    fileName: "Detailed Order Details.xlsx",
    importedRowsTotal: 10,
    included: false,
    isActive: true,
    latestTransactionAt: null,
    metadataCoverageLabel: "2026-06",
    reason: "fixture",
    rowsInRange: 10,
    salesAmountInRange: 100,
    status: "included",
    successfulRowsInRange: 10,
    timestampCoverageEnd: "2026-06-30",
    timestampCoverageStart: "2026-06-01",
    uploadedAt: null,
    ...overrides,
    batch: { ...makeDashboardBatch(), ...(overrides.batch ?? {}) },
  };
}

function makeCoverageRow(overrides = {}) {
  return {
    activeFinalizedBatchCount: 0,
    batchCount: 0,
    businessMonth: "2026-06-01",
    finalizedBatchCount: 0,
    finalizedRows: 0,
    finalizedSuccessfulSaleAmount: 0,
    finalizedSuccessfulSaleRows: 0,
    maxBusinessDate: "2026-06-30",
    minBusinessDate: "2026-06-01",
    nullBusinessDateRows: 0,
    successfulSaleAmount: 0,
    successfulSaleRows: 0,
    totalRows: 0,
    ...overrides,
  };
}

test("sales dashboard source labels and report labels use the new wording", () => {
  assert.equal(salesDashboardSourceLabel("monthly"), "Monthly Profit Report");
  assert.equal(salesDashboardSourceLabel("detailed"), "Detailed Order Details");
  assert.equal(vmsImportReportTypeLabel("monthly_product_profit"), "Monthly Profit Report");
});

test("sales dashboard defaults to monthly profit coverage when detailed files are unavailable", () => {
  const monthlyProfitBatch = makeDashboardBatch({
    id: "monthly-profit-1",
    report_type: "monthly_product_profit",
    report_start_date: "2026-02-01",
    report_end_date: "2026-02-28",
    detected_min_datetime: "2026-02-01T09:00:00Z",
    detected_max_datetime: "2026-02-28T09:00:00Z",
    imported_at: "2026-02-28T10:00:00Z",
    uploaded_at: "2026-02-28T09:30:00Z",
  });

  const defaultRange = resolveSalesDashboardRange({}, [monthlyProfitBatch], new Date("2026-07-15T12:00:00Z"));
  assert.equal(defaultRange.start, "2026-02-01");
  assert.equal(defaultRange.end, "2026-02-28");
  assert.equal(defaultRange.label, "Latest available monthly profit");

  const sourceReportType = resolveSalesDashboardSourceReportType([monthlyProfitBatch], defaultRange);
  assert.equal(sourceReportType, "monthly_product_profit");
});

test("sales dashboard default range still prefers detailed current-month coverage when available", () => {
  const detailedBatch = makeDashboardBatch({
    id: "detailed-1",
    report_type: "vms_order_details_weekly",
    report_start_date: "2026-07-01",
    report_end_date: "2026-07-31",
    detected_min_datetime: "2026-07-01T09:00:00Z",
    detected_max_datetime: "2026-07-31T09:00:00Z",
    imported_at: "2026-07-31T10:00:00Z",
    uploaded_at: "2026-07-31T09:30:00Z",
  });
  const monthlyProfitBatch = makeDashboardBatch({
    id: "monthly-profit-2",
    report_type: "monthly_product_profit",
    report_start_date: "2026-02-01",
    report_end_date: "2026-02-28",
    detected_min_datetime: "2026-02-01T09:00:00Z",
    detected_max_datetime: "2026-02-28T09:00:00Z",
    imported_at: "2026-02-28T10:00:00Z",
    uploaded_at: "2026-02-28T09:30:00Z",
  });

  const defaultRange = resolveSalesDashboardRange({}, [detailedBatch, monthlyProfitBatch], new Date("2026-07-15T12:00:00Z"));
  assert.equal(defaultRange.start, "2026-07-01");
  assert.equal(defaultRange.end, "2026-07-15");
  assert.equal(defaultRange.label, "Latest available detailed sales");
});

test("sales dashboard manual month filters stay unchanged", () => {
  const monthlyProfitBatch = makeDashboardBatch({
    id: "monthly-profit-3",
    report_type: "monthly_product_profit",
    report_start_date: "2026-02-01",
    report_end_date: "2026-02-28",
  });
  const range = resolveSalesDashboardRange({ range: "month", month: "2026-03" }, [monthlyProfitBatch], new Date("2026-07-15T12:00:00Z"));
  assert.equal(range.start, "2026-03-01");
  assert.equal(range.end, "2026-03-31");
  assert.equal(range.label, "March 2026");
});

test("sales dashboard all-time coverage spans active detailed and monthly sources", () => {
  const monthlyProfitBatch = makeDashboardBatch({
    id: "monthly-profit-4",
    report_type: "monthly_product_profit",
    report_start_date: "2026-02-01",
    report_end_date: "2026-02-28",
    detected_min_datetime: "2026-02-01T09:00:00Z",
    detected_max_datetime: "2026-02-28T09:00:00Z",
    imported_at: "2026-02-28T10:00:00Z",
    uploaded_at: "2026-02-28T09:30:00Z",
  });
  const detailedBatch = makeDashboardBatch({
    id: "detailed-2",
    report_type: "vms_order_details_weekly",
    report_start_date: "2026-03-01",
    report_end_date: "2026-03-31",
    detected_min_datetime: "2026-03-01T09:00:00Z",
    detected_max_datetime: "2026-03-31T09:00:00Z",
    imported_at: "2026-03-31T10:00:00Z",
    uploaded_at: "2026-03-31T09:30:00Z",
  });

  const coverage = salesCoverageSummary([monthlyProfitBatch, detailedBatch]);
  assert.equal(coverage.start, "2026-02-01");
  assert.equal(coverage.end, "2026-03-31");
  assert.equal(coverage.active.length, 2);
});

test("sales dashboard no-data states cover attention, deleted, failed, and inactive cases", () => {
  const summaryError = describeSalesDashboardNoDataState({
    canFinalizeInactiveFiles: false,
    contributingFiles: [makeContribution({ included: true })],
    coverageLabel: "2026-06-01 to 2026-06-30",
    fileContributions: [makeContribution({ included: true })],
    monthlyCoverageRows: [],
    sourceMode: "detailed",
    selectedRange: { start: "2026-06-01", end: "2026-06-30" },
  });
  assert.equal(summaryError.kind, "summary_error");
  assert.equal(summaryError.label, "Needs attention");

  const deleted = describeSalesDashboardNoDataState({
    canFinalizeInactiveFiles: false,
    contributingFiles: [],
    coverageLabel: "2026-06-01 to 2026-06-30",
    fileContributions: [makeContribution({ batch: makeDashboardBatch({ deleted_at: "2026-06-15", status: "deleted" }), rowsInRange: 10, successfulRowsInRange: 10, status: "deleted" })],
    monthlyCoverageRows: [],
    sourceMode: "detailed",
    selectedRange: { start: "2026-06-01", end: "2026-06-30" },
  });
  assert.equal(deleted.kind, "deleted_batch");
  assert.equal(deleted.label, "Deleted");

  const failed = describeSalesDashboardNoDataState({
    canFinalizeInactiveFiles: false,
    contributingFiles: [],
    coverageLabel: "2026-06-01 to 2026-06-30",
    fileContributions: [makeContribution({ batch: makeDashboardBatch({ status: "failed" }), rowsInRange: 10, successfulRowsInRange: 0, status: "failed_import" })],
    monthlyCoverageRows: [],
    sourceMode: "detailed",
    selectedRange: { start: "2026-06-01", end: "2026-06-30" },
  });
  assert.equal(failed.kind, "failed_import");
  assert.equal(failed.label, "Failed");

  const inactive = describeSalesDashboardNoDataState({
    canFinalizeInactiveFiles: true,
    contributingFiles: [],
    coverageLabel: "2026-06-01 to 2026-06-30",
    fileContributions: [makeContribution({ batch: makeDashboardBatch({ is_active: false, status: "previewed" }), rowsInRange: 10, successfulRowsInRange: 10, status: "inactive_batch", isActive: false })],
    monthlyCoverageRows: [],
    sourceMode: "detailed",
    selectedRange: { start: "2026-06-01", end: "2026-06-30" },
  });
  assert.equal(inactive.kind, "inactive_batch");
  assert.equal(inactive.label, "Inactive");
});

test("sales dashboard no-data states cover missing dates, partial, and ready rows", () => {
  const missingDates = describeSalesDashboardNoDataState({
    canFinalizeInactiveFiles: true,
    contributingFiles: [],
    coverageLabel: "2026-06-01 to 2026-06-30",
    fileContributions: [makeContribution({ batch: makeDashboardBatch({ status: "imported" }), rowsInRange: 10, successfulRowsInRange: 10, status: "missing_transaction_datetime" })],
    monthlyCoverageRows: [makeCoverageRow({ businessMonth: null, finalizedRows: 1, nullBusinessDateRows: 2 })],
    sourceMode: "monthly",
    selectedRange: { start: "2026-06-01", end: "2026-06-30" },
  });
  assert.equal(missingDates.kind, "missing_business_date");
  assert.equal(missingDates.label, "Missing dates");

  const partial = describeSalesDashboardNoDataState({
    canFinalizeInactiveFiles: true,
    contributingFiles: [],
    coverageLabel: "2026-06-01 to 2026-06-30",
    fileContributions: [makeContribution({ batch: makeDashboardBatch({ status: "imported" }), rowsInRange: 10, successfulRowsInRange: 0, status: "rows_excluded_by_status" })],
    monthlyCoverageRows: [],
    sourceMode: "detailed",
    selectedRange: { start: "2026-06-01", end: "2026-06-30" },
  });
  assert.equal(partial.kind, "status_filtered");
  assert.equal(partial.label, "Partial");

  const noRows = describeSalesDashboardNoDataState({
    canFinalizeInactiveFiles: true,
    contributingFiles: [],
    coverageLabel: "2026-06-01 to 2026-06-30",
    fileContributions: [makeContribution({ batch: makeDashboardBatch({ status: "imported" }), rowsInRange: 10, successfulRowsInRange: 10, status: "included" })],
    monthlyCoverageRows: [],
    sourceMode: "detailed",
    selectedRange: { start: "2026-06-01", end: "2026-06-30" },
  });
  assert.equal(noRows.kind, "no_rows");
  assert.equal(noRows.label, "Missing");
});

test("sales coverage states use the shared helper labels", () => {
  const noSource = describeSalesCoverageState({
    activeBatches: [],
    coverageError: null,
    coveredDays: new Set(),
    monthDays: ["2026-06-01", "2026-06-02"],
    monthLabel: "June 2026",
    sourceBatches: [],
    sourceLabel: "Detailed Order Details",
  });
  assert.equal(noSource.label, "No source");

  const deleted = describeSalesCoverageState({
    activeBatches: [],
    coverageError: null,
    coveredDays: new Set(),
    monthDays: ["2026-06-01", "2026-06-02"],
    monthLabel: "June 2026",
    sourceBatches: [makeDashboardBatch({ status: "deleted", deleted_at: "2026-06-01" })],
    sourceLabel: "Detailed Order Details",
  });
  assert.equal(deleted.label, "Deleted");

  const failed = describeSalesCoverageState({
    activeBatches: [],
    coverageError: null,
    coveredDays: new Set(),
    monthDays: ["2026-06-01", "2026-06-02"],
    monthLabel: "June 2026",
    sourceBatches: [makeDashboardBatch({ status: "failed", deleted_at: null })],
    sourceLabel: "Monthly Profit Report",
  });
  assert.equal(failed.label, "Failed");

  const inactive = describeSalesCoverageState({
    activeBatches: [],
    coverageError: null,
    coveredDays: new Set(),
    monthDays: ["2026-06-01", "2026-06-02"],
    monthLabel: "June 2026",
    sourceBatches: [makeDashboardBatch({ status: "imported", is_active: false })],
    sourceLabel: "Monthly Profit Report",
  });
  assert.equal(inactive.label, "Inactive");

  const partial = describeSalesCoverageState({
    activeBatches: [makeDashboardBatch({ status: "imported" })],
    coverageError: null,
    coveredDays: new Set(["2026-06-01"]),
    monthDays: ["2026-06-01", "2026-06-02"],
    monthLabel: "June 2026",
    sourceBatches: [makeDashboardBatch({ status: "imported" })],
    sourceLabel: "Detailed Order Details",
  });
  assert.equal(partial.label, "Partial");

  const ready = describeSalesCoverageState({
    activeBatches: [makeDashboardBatch({ status: "imported" })],
    coverageError: null,
    coveredDays: new Set(["2026-06-01", "2026-06-02"]),
    monthDays: ["2026-06-01", "2026-06-02"],
    monthLabel: "June 2026",
    sourceBatches: [makeDashboardBatch({ status: "imported" })],
    sourceLabel: "Detailed Order Details",
  });
  assert.equal(ready.label, "Ready");
  assert.match(ready.body, /active detailed order details rows/i);
});

test("vms import status labels and actions stay file-oriented", () => {
  const activeBatch = makeDashboardBatch({ id: "active-1", uploaded_at: "2026-06-30T10:00:00Z", imported_at: "2026-06-30T10:05:00Z" });
  const duplicateBatch = makeDashboardBatch({ id: "duplicate-1", uploaded_at: "2026-06-29T10:00:00Z", imported_at: "2026-06-29T10:05:00Z" });
  const duplicateContexts = createVmsImportDuplicateContextMap([activeBatch, duplicateBatch]);
  const duplicateStatus = describeVmsImportBatchStatus(duplicateBatch, duplicateContexts.get(duplicateBatch.id));

  assert.equal(describeVmsImportBatchStatus(activeBatch).label, "Active in dashboard");
  assert.equal(duplicateStatus.label, "Duplicate active file");
  assert.equal(duplicateStatus.action, "view_existing");
  assert.equal(duplicateStatus.secondaryAction, "import_as_new_active");
  assert.match(duplicateStatus.reason, /already feeding the dashboard/i);

  const deletedStatus = describeVmsImportBatchStatus(makeDashboardBatch({ id: "deleted-1", status: "deleted", deleted_at: "2026-06-15", rows_found: 10, rows_imported: 10 }));
  assert.equal(deletedStatus.label, "Deleted import file");
  assert.equal(deletedStatus.action, "restore");
  assert.equal(deletedStatus.actionLabel, "Restore deleted batch");

  const failedStatus = describeVmsImportBatchStatus(makeDashboardBatch({ id: "failed-1", status: "failed", rows_found: 0, rows_imported: 0 }));
  assert.equal(failedStatus.label, "Import failed");
  assert.equal(failedStatus.action, "reprocess");
  assert.equal(failedStatus.actionLabel, "Reprocess file");
});

test("sales dashboard source selection follows monthly and custom range priority", () => {
  const monthlyTransaction = makeDashboardBatch({
    id: "monthly-transaction-1",
    report_type: "monthly_transaction_details",
    report_start_date: "2026-05-01",
    report_end_date: "2026-05-31",
  });
  const detailed = makeDashboardBatch({
    id: "details-1",
    report_type: "vms_order_details_weekly",
    report_start_date: "2026-05-01",
    report_end_date: "2026-05-08",
  });
  const monthlyProfit = makeDashboardBatch({
    id: "profit-1",
    report_type: "monthly_product_profit",
    report_start_date: "2026-05-01",
    report_end_date: "2026-05-31",
  });

  assert.equal(resolveSalesDashboardSourceReportType([monthlyProfit, detailed, monthlyTransaction], {
    key: "month",
    label: "May 2026",
    helperText: "",
    start: "2026-05-01",
    end: "2026-05-31",
    monthValue: "2026-05",
    yearValue: "2026",
    dateValue: "2026-05-31",
    dateFromValue: "2026-05-01",
    dateToValue: "2026-05-31",
  }), "monthly_transaction_details");

  assert.equal(resolveSalesDashboardSourceReportType([monthlyProfit, detailed, monthlyTransaction], {
    key: "custom",
    label: "May 1-8",
    helperText: "",
    start: "2026-05-01",
    end: "2026-05-08",
    monthValue: "2026-05",
    yearValue: "2026",
    dateValue: "2026-05-08",
    dateFromValue: "2026-05-01",
    dateToValue: "2026-05-08",
  }), "vms_order_details_weekly");

  assert.equal(resolveSalesDashboardSourceReportType([monthlyProfit, detailed], {
    key: "month",
    label: "May 2026",
    helperText: "",
    start: "2026-05-01",
    end: "2026-05-31",
    monthValue: "2026-05",
    yearValue: "2026",
    dateValue: "2026-05-31",
    dateFromValue: "2026-05-01",
    dateToValue: "2026-05-31",
  }), "monthly_product_profit");
});

