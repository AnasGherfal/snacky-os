export type BusinessRecordKind = "exchange" | "issue";
export type BusinessRecordResult = { ok: true; id: string; href: string } | { ok: false; message: string; retrySameRequest: boolean };
export const commandIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const supportIssueTypes = ["payment_problem", "product_stuck", "machine_down", "product_quality", "other"] as const;
export const supportChannels = ["whatsapp", "phone", "facebook", "instagram", "in_person", "other"] as const;
export const supportPriorities = ["low", "normal", "high", "critical"] as const;

export function businessDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

export function validBusinessDate(value: string, today = businessDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && value > "2026-05-15" && value <= today;
}

export function recordMoney(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) return null;
  const result = Number(text);
  return Number.isFinite(result) && result > 0 && result < 10000000000 ? result : null;
}

export function validateBusinessRecord(kind: BusinessRecordKind, values: Record<string, string>): string | null {
  if (!commandIdPattern.test(values.client_submission_id ?? "")) return "Invalid saved request. Reload before trying again.";
  if (kind === "exchange") {
    if (!["snacky_lyd", "owner_lyd"].includes(values.source_account_id)) return "Select the LYD account used to buy the dollars.";
    if (!["snacky_usd", "owner_usd"].includes(values.destination_account_id)) return "Select the USD account that received the dollars.";
    const source = recordMoney(values.source_amount), destination = recordMoney(values.destination_amount);
    if (source === null || destination === null) return "Enter the actual LYD paid and USD received, each with at most two decimal places.";
    const rate = source / destination;
    if (rate < 0.000001 || rate >= 1000000) return "Check the two amounts; the implied exchange rate is outside the supported range.";
    if (!validBusinessDate(values.transaction_date ?? "")) return "Use the actual exchange date after 15 May 2026, not a future date. Earlier exchanges belong to the opening-balance review.";
    if ((values.note ?? "").length > 2000) return "Keep the note under 2,000 characters.";
  } else {
    if (values.machine_id && !commandIdPattern.test(values.machine_id)) return "Select a valid machine or leave it unknown.";
    if (!(supportIssueTypes as readonly string[]).includes(values.issue_type)) return "Select an issue type.";
    if (!(supportChannels as readonly string[]).includes(values.contact_channel)) return "Select a contact channel.";
    if (!(supportPriorities as readonly string[]).includes(values.priority)) return "Select a priority.";
    if (!(values.description ?? "").trim() || values.description.length > 5000) return "Describe the issue using 1–5,000 characters.";
    if ((values.customer_name ?? "").length > 150 || (values.customer_phone ?? "").length > 50) return "The customer name or phone number is too long.";
  }
  return null;
}

export function readSavedBusinessRecord(raw: string, kind: BusinessRecordKind): Record<string, string> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved request");
  const record = value as Record<string, unknown>;
  if (record.kind !== kind || !commandIdPattern.test(String(record.client_submission_id ?? "")) || Object.values(record).some((item) => typeof item !== "string")) throw new Error("Invalid saved request");
  const request = record as Record<string, string>;
  // A surviving UUID without its original fields may refer to a committed
  // operation. Never clear it merely because a truncated payload is invalid.
  if (validateBusinessRecord(kind, request)) throw new Error("Incomplete saved request; review history before creating another entry");
  return request;
}
