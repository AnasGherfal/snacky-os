import { createHash } from "node:crypto";
import { detectHeaderRowIndex, normalizeHeader, type VmsSalesReportPeriod } from "./vms-parser.ts";
import { orderDetailsNumber } from "./vms-order-details.ts";

export const VMS_MONTHLY_TRANSACTION_DETAILS_REPORT_TYPE = "monthly_transaction_details" as const;

export function isTransactionDetailsReportType(reportType: string | null | undefined) {
  return reportType === "vms_order_details_weekly" || reportType === VMS_MONTHLY_TRANSACTION_DETAILS_REPORT_TYPE;
}

export const monthlyTransactionAliases = {
  businessDate: [
    "business_date",
    "sale_date",
    "sales_date",
    "report_date",
    "transaction_date",
    "settlement_date",
    "Date",
    "Sale date",
    "Sale Date",
    "Transaction Date",
  ],
  merchantId: ["merchant_id", "Merchant ID"],
  merchantName: ["merchant_name", "Merchant Name"],
  machineCode: ["machine_code", "Machine code", "Machine Code"],
  machineName: ["machine_name", "Machine name", "Machine Name"],
  serialNumber: ["serial_number", "Serial number", "Serial Number"],
  productNumber: ["product_number", "Product Number", "Product number"],
  productName: ["product_name", "product name", "Product name", "Product Name", "vms_product_name"],
  cargoLane: ["cargo_lane", "Cargo lane", "Cargo Lane", "cargo_lane_number", "Cargo Lane Number"],
  salesPrice: ["sales_price", "Sales price", "Sales Price", "selling_price", "Selling price", "Selling Price", "price", "Price", "unit_price", "Unit price", "Unit Price"],
  modeOfPayment: ["mode_of_payment", "Mode of payment", "Mode of Payment", "payment_method", "Payment method", "Payment Method", "payment_type", "Payment type", "tender", "Tender", "method", "Method"],
  paymentAmount: ["payment_amount", "Payment amount", "Payment Amount", "amount", "Amount", "paid_amount", "Paid amount", "Paid Amount"],
  refundAmount: ["refund_amount", "Refund amount", "Refund Amount"],
  discountPrice: ["discount_price", "Discount price", "Discount Price", "discounted_price", "Discounted price", "Discounted Price"],
  paymentTime: ["payment_time", "Payment time", "Payment Time", "time_of_payment", "Time of payment", "Time Of Payment", "paid_time", "Paid time", "Paid Time"],
  refundTime: ["refund_time", "Refund time", "Refund Time"],
  thirdPartyOrderNo: ["third_party_order_no", "Third Party Order No.", "Third Party Order No", "third_party_order_number"],
  thirdPartyTransaction: ["third_party_transaction", "Third Party Transaction", "Third Party Transaction No.", "Third Party Transaction No", "third_party_transaction_number"],
  logicCardNumber: ["logic_card_number", "Logic card number", "Logic Card Number", "card_number", "Card number", "Card Number"],
  quantity: ["quantity", "Quantity", "Qty", "qty", "Num", "num"],
  transactionStatus: ["transaction_status", "Transaction status", "Transaction Status", "status", "Status", "result", "Result", "payment_status", "Payment status", "Payment Status", "vend_status", "Vend status", "Vend Status", "order_status", "Order status", "Order Status"],
} as const;

export function monthlyTransactionValue(row: Record<string, string>, aliases: readonly string[]) {
  for (const alias of aliases) {
    const found = row[alias] ?? row[normalizeHeader(alias)] ?? row[alias.toLowerCase()];
    if (found !== undefined && String(found).trim() !== "") return String(found).trim();
  }
  return "";
}

export function monthlyTransactionNumber(input: string) {
  return orderDetailsNumber(input);
}

function stableText(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function compactText(value: unknown) {
  return stableText(value).replace(/[^a-z0-9]+/g, "");
}

function parseTripoliDateTime(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 25000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }

  if (/z$|[+-]\d{2}:?\d{2}$/i.test(raw)) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/);
  if (!match) {
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

  const utcHour = match[4] === undefined ? 0 : hour - 2;
  return new Date(Date.UTC(year, month - 1, day, utcHour, minute, second));
}

function dateOnlyInTimeZone(date: Date, timeZone = "Africa/Tripoli") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const lookup = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = lookup.get("year") ?? "";
  const month = lookup.get("month") ?? "";
  const day = lookup.get("day") ?? "";
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function localDateOnlyFromText(input: string) {
  const parsed = parseTripoliDateTime(input);
  if (parsed) return dateOnlyInTimeZone(parsed);

  const fallback = new Date(input);
  return Number.isNaN(fallback.getTime()) ? null : dateOnlyInTimeZone(fallback);
}

function monthStartFromDateOnly(value: string) {
  const [year, month] = value.split("-");
  return `${year}-${month}-01`;
}

function parseMonthlyTransactionReportPeriodFromText(text: string, sourceRowIndex = 0): VmsSalesReportPeriod | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const datePattern = String.raw`(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})`;
  const rangePattern = new RegExp(String.raw`${datePattern}\s*(?:/|~|\u2013|\u2014|-|\bto\b)\s*${datePattern}`, "i");
  const match = raw.match(rangePattern);
  if (!match) return null;

  const reportStartDate = `${String(Number(match[1])).padStart(4, "0")}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
  const reportEndDate = `${String(Number(match[4])).padStart(4, "0")}-${String(Number(match[5])).padStart(2, "0")}-${String(Number(match[6])).padStart(2, "0")}`;
  if (reportStartDate > reportEndDate) return null;

  return {
    reportStartDate,
    reportEndDate,
    salesMonth: monthStartFromDateOnly(reportStartDate),
    sourceTitle: raw,
    sourceRowIndex,
  };
}

export function findMonthlyTransactionReportPeriod(rows: unknown[][], headerRowIndex?: number): VmsSalesReportPeriod | null {
  const nonEmptyRows = rows
    .map((row) => row.map((cell) => String(cell ?? "").trim()))
    .filter((row) => row.some(Boolean));
  if (!nonEmptyRows.length) return null;

  const headerIndex = Math.max(0, Math.min(headerRowIndex ?? detectHeaderRowIndex(nonEmptyRows, "monthly_transaction_details"), nonEmptyRows.length - 1));
  const metadataRows = nonEmptyRows.slice(0, headerIndex);
  for (const [index, row] of metadataRows.entries()) {
    const period = parseMonthlyTransactionReportPeriodFromText(row.filter(Boolean).join(" "), index);
    if (period) return period;
  }

  return null;
}

export function monthlyTransactionDate(input: string) {
  return parseTripoliDateTime(input);
}

export function monthlyTransactionDateOnly(date: Date) {
  return dateOnlyInTimeZone(date);
}

function explicitPaymentAmount(row: Record<string, string>) {
  const paymentAmount = monthlyTransactionNumber(monthlyTransactionValue(row, monthlyTransactionAliases.paymentAmount));
  return paymentAmount === null ? null : paymentAmount;
}

export function monthlyTransactionPaymentAmount(row: Record<string, string>) {
  const paymentAmount = explicitPaymentAmount(row);
  if (paymentAmount !== null && paymentAmount > 0) return paymentAmount;

  const salesPrice = monthlyTransactionSalesPrice(row);
  if (salesPrice === null) return null;

  return Math.max(0, salesPrice) * Math.max(1, monthlyTransactionQuantity(row));
}

export function monthlyTransactionRefundAmount(row: Record<string, string>) {
  const refundAmount = monthlyTransactionNumber(monthlyTransactionValue(row, monthlyTransactionAliases.refundAmount));
  return refundAmount === null ? 0 : Math.max(0, refundAmount);
}

export function monthlyTransactionSalesPrice(row: Record<string, string>) {
  const salesPrice = monthlyTransactionNumber(monthlyTransactionValue(row, monthlyTransactionAliases.salesPrice));
  if (salesPrice !== null) return Math.max(0, salesPrice);

  const discountedPrice = monthlyTransactionNumber(monthlyTransactionValue(row, monthlyTransactionAliases.discountPrice));
  if (discountedPrice !== null) return Math.max(0, discountedPrice);

  const paymentAmount = explicitPaymentAmount(row);
  if (paymentAmount === null) return null;

  return Math.max(0, paymentAmount) / Math.max(1, monthlyTransactionQuantity(row));
}

export function monthlyTransactionQuantity(row: Record<string, string>) {
  const quantity = monthlyTransactionNumber(monthlyTransactionValue(row, monthlyTransactionAliases.quantity));
  return quantity === null || quantity <= 0 ? 1 : Math.floor(quantity);
}

export function monthlyTransactionPaymentMethod(row: Record<string, string>) {
  const raw = monthlyTransactionValue(row, monthlyTransactionAliases.modeOfPayment);
  const normalized = stableText(raw).replace(/\s+/g, " ");
  const compact = compactText(raw);
  if (!normalized) return "unknown";
  if (normalized.includes("cash") || compact.includes("cash") || compact.includes("banknote") || compact.includes("coin")) return "cash";
  if (
    normalized.includes("card")
    || normalized.includes("credit")
    || normalized.includes("debit")
    || normalized.includes("visa")
    || normalized.includes("master")
    || normalized.includes("wallet")
    || compact.includes("card")
    || compact.includes("credit")
    || compact.includes("debit")
  ) return "card";
  return "unknown";
}

function statusText(value: string) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function statusCompact(value: string) {
  return statusText(value).replace(/[^a-z0-9]+/g, "");
}

function statusHasSignal(value: string, needles: string[]) {
  const normalized = statusText(value);
  const compact = statusCompact(value);
  if (!normalized && !compact) return false;
  return needles.some((needle) => normalized.includes(needle) || compact.includes(needle.replace(/[^a-z0-9]+/g, "")));
}

function paymentFailureSignal(value: string) {
  return statusHasSignal(value, ["fail", "failed", "declined", "rejected", "cancel", "void", "error", "timeout", "unpaid", "payment failed"]);
}

function vendFailureSignal(value: string) {
  return statusHasSignal(value, ["vend fail", "vend failed", "failed vend", "not dispensed", "dispense fail", "delivery fail", "not delivered", "failed to vend", "machine error", "timeout", "cancel", "error"]);
}

function refundSignal(value: string) {
  return statusHasSignal(value, ["refund", "refunded", "refunding", "reversal", "chargeback"]);
}

export function monthlyTransactionBusinessDate(row: Record<string, string>) {
  const explicitBusinessDate = monthlyTransactionValue(row, monthlyTransactionAliases.businessDate);
  if (explicitBusinessDate) {
    const parsed = localDateOnlyFromText(explicitBusinessDate);
    if (parsed) return parsed;
  }

  const paymentTime = monthlyTransactionValue(row, monthlyTransactionAliases.paymentTime);
  const paymentDate = paymentTime ? localDateOnlyFromText(paymentTime) : null;
  if (paymentDate) return paymentDate;

  const refundTime = monthlyTransactionValue(row, monthlyTransactionAliases.refundTime);
  const refundDate = refundTime ? localDateOnlyFromText(refundTime) : null;
  if (refundDate) return refundDate;

  return null;
}

export function monthlyTransactionPaymentTime(row: Record<string, string>) {
  return monthlyTransactionDate(monthlyTransactionValue(row, monthlyTransactionAliases.paymentTime));
}

export function monthlyTransactionRefundTime(row: Record<string, string>) {
  return monthlyTransactionDate(monthlyTransactionValue(row, monthlyTransactionAliases.refundTime));
}

export function monthlyTransactionTransactionStatus(row: Record<string, string>) {
  const refundAmount = monthlyTransactionRefundAmount(row);
  const paymentAmount = monthlyTransactionPaymentAmount(row);
  const statusSource = [
    monthlyTransactionValue(row, monthlyTransactionAliases.transactionStatus),
    monthlyTransactionValue(row, monthlyTransactionAliases.paymentAmount),
    monthlyTransactionValue(row, monthlyTransactionAliases.modeOfPayment),
  ].filter(Boolean).join(" ");

  if (refundAmount > 0) return "refunded";
  if (paymentAmount !== null && paymentAmount > 0) {
    if (vendFailureSignal(statusSource)) return "failed_vend";
    return "successful_sale";
  }
  if (paymentFailureSignal(statusSource)) return "failed_payment";
  if (vendFailureSignal(statusSource)) return "failed_vend";
  if (refundSignal(statusSource)) return "refunded";
  return "needs_review";
}

function transactionDetailsLineIdentity(row: Record<string, string>) {
  return {
    business_date: stableText(monthlyTransactionBusinessDate(row)),
    cargo_lane: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.cargoLane)),
    logic_card_number: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.logicCardNumber)),
    machine_code: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.machineCode)),
    mode_of_payment: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.modeOfPayment)),
    payment_amount: String(monthlyTransactionPaymentAmount(row) ?? 0),
    payment_time: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.paymentTime)),
    product_name: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.productName)),
    product_number: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.productNumber)),
    refund_amount: String(monthlyTransactionRefundAmount(row)),
    refund_time: stableText(monthlyTransactionValue(row, monthlyTransactionAliases.refundTime)),
    quantity: String(monthlyTransactionQuantity(row)),
  };
}

export function createVmsMonthlyTransactionDuplicateHash(row: Record<string, string>) {
  const thirdPartyOrderNo = monthlyTransactionValue(row, monthlyTransactionAliases.thirdPartyOrderNo);
  const thirdPartyTransaction = monthlyTransactionValue(row, monthlyTransactionAliases.thirdPartyTransaction);
  const machineCode = monthlyTransactionValue(row, monthlyTransactionAliases.machineCode);
  const productNumber = monthlyTransactionValue(row, monthlyTransactionAliases.productNumber);
  const productName = monthlyTransactionValue(row, monthlyTransactionAliases.productName);
  const paymentTime = monthlyTransactionValue(row, monthlyTransactionAliases.paymentTime);
  const paymentAmount = monthlyTransactionPaymentAmount(row);
  const cargoLane = monthlyTransactionValue(row, monthlyTransactionAliases.cargoLane);

  if (thirdPartyOrderNo || thirdPartyTransaction) {
    return createHash("sha256").update(JSON.stringify({
      type: "vms_order_details",
      key: thirdPartyOrderNo ? "third_party_order_no_line" : "third_party_transaction_number_line",
      third_party_order_no: stableText(thirdPartyOrderNo),
      third_party_transaction_number: stableText(thirdPartyTransaction),
      ...transactionDetailsLineIdentity(row),
    })).digest("hex");
  }

  return createHash("sha256").update(JSON.stringify({
    type: "vms_order_details",
    key: "fallback",
    machine_code: stableText(machineCode),
    product_number: stableText(productNumber),
    product_name: stableText(productName),
    payment_time: stableText(paymentTime),
    payment_amount: String(paymentAmount ?? 0),
    cargo_lane: stableText(cargoLane),
    ...transactionDetailsLineIdentity(row),
  })).digest("hex");
}

export function detectMonthlyTransactionDateRange(rows: Record<string, string>[]) {
  const dates = rows
    .map(monthlyTransactionBusinessDate)
    .filter((date): date is string => Boolean(date))
    .sort((a, b) => a.localeCompare(b));
  if (!dates.length) return { start: "", end: "" };
  return {
    start: dates[0],
    end: dates[dates.length - 1],
  };
}
