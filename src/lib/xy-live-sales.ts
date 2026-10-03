import {
  createVmsMonthlyTransactionDuplicateHash,
  monthlyTransactionBusinessDate,
  monthlyTransactionPaymentAmount,
  monthlyTransactionPaymentMethod,
  monthlyTransactionPaymentTime,
  monthlyTransactionQuantity,
  monthlyTransactionRefundAmount,
  monthlyTransactionRefundTime,
  monthlyTransactionSalesPrice,
} from "./vms-transaction-details.ts";

export type XyLiveSalesRawRow = Record<string, unknown>;

export type NormalizedXyLiveSale = {
  businessDate: string | null;
  machineCode: string;
  machineName: string;
  orderNumber: string;
  cargoLane: string;
  productNumber: string;
  productName: string;
  salesPrice: number | null;
  discountedPrice: number | null;
  paymentMethod: string;
  paymentAmount: number | null;
  paymentTime: Date | null;
  refundAmount: number;
  refundTime: Date | null;
  quantity: number;
  transactionStatus: "successful_sale" | "failed_vend" | "refunded" | "failed_payment" | "needs_review";
  thirdPartyOrderNo: string;
  thirdPartyTransactionNumber: string;
  duplicateHash: string;
  canonicalRow: Record<string, string>;
};

const aliases = {
  businessDate: ["business_date", "businessDate", "sale_date", "saleDate", "transaction_date", "date", "rq", "ywrq"],
  merchantId: ["merchant_id", "merchantId", "shbh"],
  merchantName: ["merchant_name", "merchantName", "shmc"],
  machineCode: ["machine_code", "machineCode", "machine_no", "machineNo", "machine_identifier", "jqbh", "vmCode"],
  machineName: ["machine_name", "machineName", "jqmc", "vmName"],
  orderNumber: ["order_number", "orderNumber", "order_no", "orderNo", "ddbh", "ddh"],
  cargoLane: ["cargo_lane", "cargoLane", "cargo_lane_number", "lane", "laneNo", "lane_no", "hdbh", "hdh"],
  productNumber: ["product_number", "productNumber", "product_id", "productId", "goods_id", "goodsId", "sku", "spbh", "dsfspbh"],
  productName: ["product_name", "productName", "goods_name", "goodsName", "name", "spmc"],
  salesPrice: ["sales_price", "salesPrice", "selling_price", "sellingPrice", "unit_price", "unitPrice", "price", "spjg", "spsj"],
  discountPrice: ["discount_price", "discountPrice", "discounted_price", "discountedPrice", "actual_price", "actualPrice", "sjje"],
  paymentMethod: ["mode_of_payment", "payment_method", "paymentMethod", "payment_type", "paymentType", "payType", "zffs"],
  paymentAmount: ["payment_amount", "paymentAmount", "paid_amount", "paidAmount", "amount", "payAmount", "zfje", "ssje"],
  paymentTime: ["payment_time", "paymentTime", "pay_time", "payTime", "paid_time", "paidTime", "zfsj", "ddsjt", "createTime", "createdAt"],
  refundAmount: ["refund_amount", "refundAmount", "tkje"],
  refundTime: ["refund_time", "refundTime", "tksj"],
  thirdPartyOrderNo: ["third_party_order_no", "thirdPartyOrderNo", "third_party_order_number", "dsfddh"],
  thirdPartyTransaction: ["third_party_transaction", "thirdPartyTransaction", "third_party_transaction_number", "thirdPartyTransactionNumber", "dsfjyh"],
  logicCardNumber: ["logic_card_number", "logicCardNumber", "card_number", "cardNumber", "ljkh"],
  quantity: ["quantity", "qty", "num", "count", "sl", "spsl"],
  status: ["transaction_status", "transactionStatus", "order_status", "orderStatus", "vend_status", "vendStatus", "shipping_status", "shippingStatus", "status", "result", "ddzt", "zt"],
  refundStatus: ["refund_status", "refundStatus", "tkzt"],
} as const;

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function flattened(row: XyLiveSalesRawRow) {
  const result = new Map<string, unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizeKey(key);
      if (normalized && !result.has(normalized)) result.set(normalized, child);
      if (child && typeof child === "object" && !Array.isArray(child)) visit(child, depth + 1);
    }
  };
  visit(row, 0);
  return result;
}

function first(row: XyLiveSalesRawRow, names: readonly string[]) {
  const map = flattened(row);
  for (const name of names) {
    const value = map.get(normalizeKey(name));
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function compact(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function hasAny(value: unknown, needles: string[]) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const compacted = compact(value);
  return needles.some((needle) => normalized.includes(needle) || compacted.includes(compact(needle)));
}

function transactionStatus(row: XyLiveSalesRawRow, canonical: Record<string, string>) {
  const rawStatus = [
    first(row, aliases.status),
    first(row, aliases.refundStatus),
  ].filter(Boolean).join(" ");
  const refundAmount = monthlyTransactionRefundAmount(canonical);
  const refundTime = monthlyTransactionRefundTime(canonical);
  const paymentAmount = monthlyTransactionPaymentAmount(canonical);

  if (refundAmount > 0 || refundTime || hasAny(rawStatus, ["refund", "refunded", "reversal", "chargeback", "退款"])) return "refunded" as const;
  if (hasAny(rawStatus, ["payment failed", "declined", "rejected", "unpaid", "支付失败", "付款失败"])) return "failed_payment" as const;
  if (hasAny(rawStatus, ["vend fail", "failed vend", "not dispensed", "delivery fail", "machine error", "出货失败", "掉货失败"])) return "failed_vend" as const;
  if (hasAny(rawStatus, ["success", "successful", "completed", "complete", "shipped", "delivered", "交易成功", "支付成功", "出货成功", "成功"])) return "successful_sale" as const;
  if (paymentAmount !== null && paymentAmount > 0) return "successful_sale" as const;
  if (hasAny(rawStatus, ["fail", "failed", "error", "cancel", "timeout", "失败", "取消", "超时"])) return "failed_vend" as const;
  return "needs_review" as const;
}

export function normalizeXyLiveSalesRow(row: XyLiveSalesRawRow): NormalizedXyLiveSale {
  const canonicalRow: Record<string, string> = {
    business_date: first(row, aliases.businessDate),
    merchant_id: first(row, aliases.merchantId),
    merchant_name: first(row, aliases.merchantName),
    machine_code: first(row, aliases.machineCode),
    machine_name: first(row, aliases.machineName),
    serial_number: first(row, aliases.orderNumber),
    product_number: first(row, aliases.productNumber),
    product_name: first(row, aliases.productName),
    cargo_lane: first(row, aliases.cargoLane),
    sales_price: first(row, aliases.salesPrice),
    mode_of_payment: first(row, aliases.paymentMethod),
    payment_amount: first(row, aliases.paymentAmount),
    refund_amount: first(row, aliases.refundAmount),
    discount_price: first(row, aliases.discountPrice),
    payment_time: first(row, aliases.paymentTime),
    refund_time: first(row, aliases.refundTime),
    third_party_order_no: first(row, aliases.thirdPartyOrderNo),
    third_party_transaction: first(row, aliases.thirdPartyTransaction),
    logic_card_number: first(row, aliases.logicCardNumber),
    quantity: first(row, aliases.quantity),
    transaction_status: first(row, aliases.status),
  };

  const orderNumber = first(row, aliases.orderNumber);
  const status = transactionStatus(row, canonicalRow);

  return {
    businessDate: monthlyTransactionBusinessDate(canonicalRow),
    machineCode: canonicalRow.machine_code,
    machineName: canonicalRow.machine_name,
    orderNumber,
    cargoLane: canonicalRow.cargo_lane,
    productNumber: canonicalRow.product_number,
    productName: canonicalRow.product_name,
    salesPrice: monthlyTransactionSalesPrice(canonicalRow),
    discountedPrice: canonicalRow.discount_price ? Number(canonicalRow.discount_price) || null : null,
    paymentMethod: monthlyTransactionPaymentMethod(canonicalRow),
    paymentAmount: monthlyTransactionPaymentAmount(canonicalRow),
    paymentTime: monthlyTransactionPaymentTime(canonicalRow),
    refundAmount: monthlyTransactionRefundAmount(canonicalRow),
    refundTime: monthlyTransactionRefundTime(canonicalRow),
    quantity: monthlyTransactionQuantity(canonicalRow),
    transactionStatus: status,
    thirdPartyOrderNo: canonicalRow.third_party_order_no,
    thirdPartyTransactionNumber: canonicalRow.third_party_transaction,
    duplicateHash: createVmsMonthlyTransactionDuplicateHash(canonicalRow),
    canonicalRow,
  };
}

export function extractXyLiveSalesRows(value: unknown, explicitPath?: string | null): XyLiveSalesRawRow[] {
  const visitPath = (root: unknown, path: string) => {
    let current = root;
    for (const part of path.split(".").map((item) => item.trim()).filter(Boolean)) {
      if (!current || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  };

  const explicit = explicitPath ? visitPath(value, explicitPath) : null;
  if (Array.isArray(explicit)) return explicit.filter((row): row is XyLiveSalesRawRow => Boolean(row && typeof row === "object" && !Array.isArray(row)));

  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      const rows = current.filter((row): row is XyLiveSalesRawRow => Boolean(row && typeof row === "object" && !Array.isArray(row)));
      if (rows.length) return rows;
      continue;
    }

    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      for (const key of ["records", "rows", "list", "items", "data", "result", "page", "content"]) {
        if (key in record) queue.push(record[key]);
      }
    }
  }

  return [];
}

export function renderXyLiveSalesRequestTemplate(template: string, values: Record<string, string | number>) {
  const replaced = template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
    return String(values[key] ?? "");
  });
  const parsed = JSON.parse(replaced);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("XY live sales request template must render to one JSON object.");
  }
  return parsed as Record<string, unknown>;
}
