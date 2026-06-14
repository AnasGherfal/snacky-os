import { createHash } from "node:crypto";
import { normalizeHeader } from "./vms-parser.ts";

export const VMS_ORDER_DETAILS_REPORT_TYPE = "vms_order_details_weekly" as const;

export type VmsOrderTransactionStatus =
  | "successful_sale"
  | "failed_vend"
  | "refunded"
  | "failed_payment"
  | "needs_review";

export const orderDetailsAliases = {
  merchantId: ["merchant_id", "Merchant ID"],
  merchantName: ["merchant_name", "Merchant Name"],
  machineCode: ["machine_identifier", "machine_code", "Machine code", "Machine Code"],
  machineName: ["machine_name", "Machine name", "Machine Name"],
  orderNumber: ["order_number", "Order number", "Order Number"],
  cargoLaneNumber: ["cargo_lane_number", "Cargo Lane Number"],
  productNumber: ["product_identifier", "product_number", "Product Number"],
  productName: ["product_name", "vms_product_name", "product name", "Product name", "Product Name"],
  commodityPrice1: ["commodity_price_1", "Commodity price (1)", "Commodity Price (1)"],
  commodityPrice2: ["commodity_price_2", "Commodity price (2)", "Commodity Price (2)"],
  discountedPrice: ["discounted_price", "Discounted price", "Discounted Price"],
  deliveryTime: ["delivery_time", "Delivery time", "Delivery Time"],
  shippingStatus: ["shipping_status", "Shipping status", "Shipping Status"],
  purchaser: ["purchaser", "Purchaser"],
  refundTime: ["refund_time", "Refund time", "Refund Time"],
  remarks: ["remarks", "Remarks"],
  refundStatus: ["refund_status", "Refund status", "Refund Status"],
  thirdPartyTransactionNumber: ["third_party_transaction_number", "Third Party Transaction Number"],
  thirdPartyOrderNo: ["third_party_order_no", "Third Party Order No.", "Third Party Order No"],
  paymentAmount: ["payment_amount", "Payment amount", "Payment Amount"],
  paymentTime: ["payment_time", "time_of_payment", "Time of payment", "Payment time", "Payment Time"],
  quantity: ["quantity", "num", "Num", "Qty"],
} as const;

export function orderDetailsValue(row: Record<string, string>, aliases: readonly string[]) {
  for (const alias of aliases) {
    const found = row[alias] ?? row[normalizeHeader(alias)] ?? row[alias.toLowerCase()];
    if (found !== undefined && String(found).trim() !== "") return String(found).trim();
  }
  return "";
}

export function orderDetailsNumber(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const negative = raw.includes("(") && raw.includes(")");
  let cleaned = raw.replace(/[^\d,.\-]/g, "");
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    cleaned = lastComma > lastDot ? cleaned.replace(/\./g, "").replace(",", ".") : cleaned.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = cleaned.length - lastComma - 1;
    cleaned = decimals > 0 && decimals <= 2 ? cleaned.replace(",", ".") : cleaned.replace(/,/g, "");
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? (negative ? -Math.abs(parsed) : parsed) : null;
}

export function orderDetailsDate(input: string) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  const serial = Number(raw);
  if (Number.isFinite(serial) && serial > 25000 && serial < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function orderDetailsDateOnly(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function orderDetailsPaymentAmount(row: Record<string, string>) {
  return orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.paymentAmount));
}

export function orderDetailsQuantity(row: Record<string, string>) {
  const quantity = orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.quantity));
  return quantity === null || quantity <= 0 ? 1 : Math.floor(quantity);
}

export function orderDetailsGrossSalesAmount(row: Record<string, string>) {
  const paymentAmount = orderDetailsPaymentAmount(row);
  if (paymentAmount !== null && paymentAmount > 0) return paymentAmount;

  const unitPrice = orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.discountedPrice))
    ?? orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.commodityPrice1))
    ?? orderDetailsNumber(orderDetailsValue(row, orderDetailsAliases.commodityPrice2));
  if (unitPrice === null) return null;

  return Math.max(0, unitPrice) * Math.max(1, orderDetailsQuantity(row));
}

export function orderDetailsTransactionDate(row: Record<string, string>) {
  return orderDetailsDate(orderDetailsValue(row, orderDetailsAliases.paymentTime))
    ?? orderDetailsDate(orderDetailsValue(row, orderDetailsAliases.deliveryTime));
}

export function detectOrderDetailsDateRange(rows: Record<string, string>[]) {
  const dates = rows
    .map(orderDetailsTransactionDate)
    .filter((date): date is Date => Boolean(date))
    .sort((a, b) => a.getTime() - b.getTime());
  if (!dates.length) return { start: "", end: "" };
  return {
    start: orderDetailsDateOnly(dates[0]),
    end: orderDetailsDateOnly(dates[dates.length - 1]),
  };
}

function statusText(value: string) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function compactStatus(value: string) {
  return statusText(value).replace(/[^a-z0-9]+/g, "");
}

function refundStatusHasSignal(refundStatus: string, refundTime: string) {
  if (orderDetailsDate(refundTime)) return true;
  const normalized = statusText(refundStatus);
  const compact = compactStatus(refundStatus);
  if (!normalized) return false;
  return !["-", "0", "false", "no", "none", "null", "n/a", "na", "no refund", "not refunded", "not refund"].includes(normalized)
    && !["no", "none", "null", "na", "norefund", "notrefunded", "notrefund"].includes(compact);
}

function shippingLooksSuccessful(shippingStatus: string) {
  const normalized = statusText(shippingStatus);
  const compact = compactStatus(shippingStatus);
  return normalized === "goods shipped"
    || normalized === "completed"
    || compact === "goodsshipped"
    || compact === "shipped"
    || compact === "delivered"
    || compact === "completed"
    || compact === "complete"
    || compact === "success"
    || compact === "successful";
}

function shippingLooksFailed(shippingStatus: string) {
  const normalized = statusText(shippingStatus);
  const compact = compactStatus(shippingStatus);
  return normalized.includes("failed")
    || normalized.includes("not shipped")
    || normalized.includes("not delivered")
    || compact.includes("failed")
    || compact.includes("notshipped")
    || compact.includes("notdelivered")
    || compact.includes("cancel")
    || compact.includes("error")
    || compact.includes("timeout");
}

export function orderDetailsTransactionStatus(row: Record<string, string>): VmsOrderTransactionStatus {
  const refundStatus = orderDetailsValue(row, orderDetailsAliases.refundStatus);
  const refundTime = orderDetailsValue(row, orderDetailsAliases.refundTime);
  if (refundStatusHasSignal(refundStatus, refundTime)) return "refunded";

  const paymentAmount = orderDetailsPaymentAmount(row);
  if (paymentAmount === null || paymentAmount <= 0) return "failed_payment";

  const shippingStatus = orderDetailsValue(row, orderDetailsAliases.shippingStatus);
  if (shippingLooksFailed(shippingStatus)) return "failed_vend";
  if (shippingLooksSuccessful(shippingStatus)) return "successful_sale";
  return "needs_review";
}

function stableText(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hashPayload(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createVmsOrderDetailsDuplicateHash(row: Record<string, string>) {
  const orderNumber = orderDetailsValue(row, orderDetailsAliases.orderNumber);
  if (orderNumber) return hashPayload({ type: "vms_order_details", key: "order_number", value: stableText(orderNumber) });

  const thirdPartyTransactionNumber = orderDetailsValue(row, orderDetailsAliases.thirdPartyTransactionNumber);
  if (thirdPartyTransactionNumber) {
    return hashPayload({ type: "vms_order_details", key: "third_party_transaction_number", value: stableText(thirdPartyTransactionNumber) });
  }

  const thirdPartyOrderNo = orderDetailsValue(row, orderDetailsAliases.thirdPartyOrderNo);
  if (thirdPartyOrderNo) return hashPayload({ type: "vms_order_details", key: "third_party_order_no", value: stableText(thirdPartyOrderNo) });

  return hashPayload({
    type: "vms_order_details",
    key: "fallback",
    machine_code: stableText(orderDetailsValue(row, orderDetailsAliases.machineCode)),
    product_number: stableText(orderDetailsValue(row, orderDetailsAliases.productNumber)),
    product_name: stableText(orderDetailsValue(row, orderDetailsAliases.productName)),
    payment_time: stableText(orderDetailsValue(row, orderDetailsAliases.paymentTime)),
    payment_amount: String(orderDetailsPaymentAmount(row) ?? 0),
    cargo_lane_number: stableText(orderDetailsValue(row, orderDetailsAliases.cargoLaneNumber)),
  });
}

export function orderDetailsSuccessfulSalesAmount(rows: Record<string, string>[]) {
  return rows.reduce((sum, row) => {
    if (orderDetailsTransactionStatus(row) !== "successful_sale") return sum;
    return sum + Math.max(0, orderDetailsGrossSalesAmount(row) ?? 0);
  }, 0);
}
