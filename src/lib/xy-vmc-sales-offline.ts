/**
 * Offline-only parser for the Hunan Xingyuan XY VMC ↔ upper-computer protocol.
 * 
 * Research prototype: does NOT open a serial port, transmit a command, connect
 * to production, or write anything to Snacky OS. Frame shape is documented in
 * "VMC - Upper computer V3.0 0411"; actual hardware compatibility and byte
 * order / monetary units still require manufacturer or hardware verification.
 */

export type XyVmcFrame = {
  command: number;
  packetNumber: number | null;
  payload: Uint8Array;
  rawData: Uint8Array;
};

export type XyVmcUnsignedWord = {
  bytesHex: string;
  candidateBigEndian: number;
  candidateLittleEndian: number;
};

const FRAME_PREFIX = [0xfa, 0xfb] as const;

export const XY_VMC_SALES_QUERY = {
  DAILY: 0x43,
  MONTHLY: 0x44,
  YEARLY: 0x45,
  ENTIRE_MACHINE: 0x46,
  SELECTION: 0x47,
} as const;

const AGGREGATE_SALES_FIELDS = [
  "total_transaction_count", "total_transaction_amount",
  "cash_transaction_count", "cash_transaction_amount",
  "wechat_transaction_count", "wechat_transaction_amount",
  "alipay_transaction_count", "alipay_transaction_amount",
  "union_scan_count", "union_scan_amount",
  "token_code_count", "token_code_amount",
  "union_card_count", "union_card_amount",
  "ic_card_count", "ic_card_amount",
  "holding_credit_count", "holding_credit_amount",
] as const;

function bytesHex(data: Uint8Array) {
  return Array.from(data, (item) => item.toString(16).padStart(2, "0")).join("");
}

function decodeU32BothOrders(value: Uint8Array): XyVmcUnsignedWord {
  if (value.length !== 4) throw new Error("XY VMC word must be exactly 4 bytes.");
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return {
    bytesHex: bytesHex(value),
    candidateBigEndian: view.getUint32(0, false),
    candidateLittleEndian: view.getUint32(0, true),
  };
}

/**
 * Packet grammar: FA FB | command (1) | payload length (1) | payload | XOR (1).
 * This parser supports complete packets ONLY; streaming assembly is a separate
 * part of a future field pilot. It never sends ACK or a command to the VMC.
 */
export function parseXyVmcFrame(raw: Uint8Array): XyVmcFrame {
  if (raw.length < 5) throw new Error("Incomplete XY VMC frame.");
  if (raw[0] !== FRAME_PREFIX[0] || raw[1] !== FRAME_PREFIX[1]) {
    throw new Error("XY VMC frame has an incorrect start marker.");
  }
  const expected = 5 + raw[3];
  if (raw.length !== expected) throw new Error("XY VMC frame length mismatch.");
  let checksum = 0;
  for (let index = 0; index < raw.length - 1; index += 1) checksum ^= raw[index];
  if (checksum !== raw[raw.length - 1]) {
    throw new Error("XY VMC checksum mismatch.");
  }
  const payload = raw.slice(4, -1);
  return {
    command: raw[2],
    packetNumber: payload.length ? payload[0] : null,
    payload,
    rawData: raw.slice(),
  };
}

export type XyVmcSalesTelemetry = {
  category: "daily" | "monthly" | "yearly" | "entire_machine" | "selection";
  packetNumber: number;
  /** Raw, unscaled numbers; neither endianness nor minor-unit scale is validated. */
  fields: Record<string, XyVmcUnsignedWord>;
  interpretationVerified: false;
};

/**
 * Parses read-only VMC response 0x71 with nested query kind 0x43..0x47.
 * Never claims these are amounts in LYD or individual cloud transactions.
 * No query date is included in the reply: a field collector must capture
 * its original query date and the local VMC time to interpret daily totals.
 */
export function parseXyVmcSalesReply(frame: XyVmcFrame): XyVmcSalesTelemetry {
  if (frame.command !== 0x71 || frame.payload.length < 3) {
    throw new Error("Expected XY VMC configuration/sales response 0x71.");
  }
  const [packetNo, kind, operation] = frame.payload;
  if (!packetNo || operation !== 0x00) {
    throw new Error("XY VMC sales reply has an invalid packet number or operation.");
  }
  const categories = new Map<number, XyVmcSalesTelemetry["category"]>([
    [XY_VMC_SALES_QUERY.DAILY, "daily"],
    [XY_VMC_SALES_QUERY.MONTHLY, "monthly"],
    [XY_VMC_SALES_QUERY.YEARLY, "yearly"],
    [XY_VMC_SALES_QUERY.ENTIRE_MACHINE, "entire_machine"],
    [XY_VMC_SALES_QUERY.SELECTION, "selection"],
  ]);
  const category = categories.get(kind);
  if (!category) throw new Error("Not an XY VMC sales response.");
  const fieldNames = kind === XY_VMC_SALES_QUERY.SELECTION
    ? ["selection_transaction_count", "selection_transaction_amount"]
    : AGGREGATE_SALES_FIELDS;
  const data = frame.payload.slice(3);
  if (data.length !== fieldNames.length * 4) {
    throw new Error("XY VMC sales response has an unexpected field layout.");
  }

  const fields: Record<string, XyVmcUnsignedWord> = {};
  fieldNames.forEach((field, index) => {
    fields[field] = decodeU32BothOrders(data.slice(index * 4, index * 4 + 4));
  });
  return { category, packetNumber: packetNo, fields, interpretationVerified: false };
}
