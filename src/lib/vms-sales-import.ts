import { createHash } from "node:crypto";
import { normalizeHeader, vmsExpectedFields, type VmsReportType, type VmsSalesReportPeriod } from "./vms-parser.ts";

export const VMS_IMPORT_MODES = {
  APPEND_NEW: "append_new",
  REPLACE_RANGE: "replace_range",
  PREVIEW_ONLY: "preview_only",
} as const;

export type VmsImportMode = (typeof VMS_IMPORT_MODES)[keyof typeof VMS_IMPORT_MODES];

export const vmsImportModeLabels: Record<VmsImportMode, string> = {
  append_new: "Append new records",
  replace_range: "Replace selected date range",
  preview_only: "Preview only",
};

export const salesRowDateAliases = [
  "sale_date",
  "period_end",
  "date",
  "sales_date",
  "business_date",
  "stat_date",
  "day",
  "datetime",
  "timestamp",
  "settlement_date",
  "end_date",
  "report_date",
];

export function parseVmsImportMode(value: unknown): VmsImportMode {
  const normalized = String(value ?? "").trim();
  return normalized === VMS_IMPORT_MODES.REPLACE_RANGE || normalized === VMS_IMPORT_MODES.PREVIEW_ONLY
    ? normalized
    : VMS_IMPORT_MODES.APPEND_NEW;
}

export function vmsHeaderSignature(reportType: VmsReportType, headers: string[]) {
  return `${reportType}:${headers.map((header) => normalizeHeader(header)).join("|")}`;
}

export function splitColumnMappingByRequirement(reportType: VmsReportType, mapping: Record<string, string>) {
  const required: Record<string, string> = {};
  const optional: Record<string, string> = {};
  for (const field of vmsExpectedFields[reportType]) {
    const value = mapping[field.field] ?? "";
    if (field.required || field.requiredGroup) required[field.field] = value;
    else optional[field.field] = value;
  }
  return { required, optional };
}

function stableText(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function stableNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(4) : "0.0000";
}

function stableDate(value: unknown) {
  return String(value ?? "").trim().slice(0, 10);
}

export function createVmsSalesSourceRowKey({
  vmsTransactionId,
  machineId,
  machineCode,
  machineName,
  productId,
  productCode,
  productName,
  saleStartDate,
  saleEndDate,
  reportStartDate,
  reportEndDate,
  soldQty,
  grossSalesAmount,
  netSalesAmount,
}: {
  vmsTransactionId?: string | null;
  machineId?: string | null;
  machineCode?: string | null;
  machineName?: string | null;
  productId?: string | null;
  productCode?: string | null;
  productName?: string | null;
  saleStartDate?: string | null;
  saleEndDate?: string | null;
  reportStartDate?: string | null;
  reportEndDate?: string | null;
  soldQty?: number | null;
  grossSalesAmount?: number | null;
  netSalesAmount?: number | null;
}) {
  const payload = {
    transaction: stableText(vmsTransactionId),
    machine: stableText(machineId || machineCode || machineName),
    product: stableText(productId || productCode || productName),
    sale_start: stableDate(saleStartDate),
    sale_end: stableDate(saleEndDate),
    report_start: stableDate(reportStartDate || saleStartDate),
    report_end: stableDate(reportEndDate || saleEndDate),
    quantity: stableNumber(soldQty),
    gross_sales: stableNumber(grossSalesAmount),
    net_sales: stableNumber(netSalesAmount ?? grossSalesAmount),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function readMappedValue(row: Record<string, string>, aliases: string[]) {
  for (const alias of aliases) {
    const found = row[alias] ?? row[normalizeHeader(alias)] ?? row[alias.toLowerCase()];
    if (found !== undefined && String(found).trim() !== "") return String(found).trim();
  }
  return "";
}

export function parseMappedDate(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 25000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateOnlyFromDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function monthStartFromDateOnly(dateOnly: string) {
  const [year, month] = dateOnly.split("-");
  return `${year}-${month}-01`;
}

export function salesPeriodFromMappedRow(row: Record<string, string>): VmsSalesReportPeriod | null {
  const periodDate = parseMappedDate(readMappedValue(row, salesRowDateAliases));
  if (!periodDate) return null;
  const reportStartDate = dateOnlyFromDate(periodDate);
  return {
    reportStartDate,
    reportEndDate: reportStartDate,
    salesMonth: monthStartFromDateOnly(reportStartDate),
    sourceTitle: "",
    sourceRowIndex: -1,
  };
}
