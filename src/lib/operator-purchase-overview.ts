/** Read-only personal purchase reporting. Never use these totals to write stock. */
export type DataRow = Record<string, unknown>;
export type PurchaseTotals = {
  personId: string;
  name: string;
  active: boolean;
  records: number;
  units: number;
  charged: number;
  paid: number;
  outstanding: number;
  currentMonthOutstanding: number;
  earlierOutstanding: number;
  otherOutstanding: number;
};
export type StockProof = {
  status: "deducted" | "missing" | "mismatch" | "reversed" | "unavailable";
  movementId: string | null;
  quantity: number | null;
  recordedAt: string | null;
  storageName: string | null;
};
export type PurchaseHistoryRow = {
  id: string;
  product: string;
  quantity: number;
  purchasedAt: string;
  charged: number;
  paid: number;
  outstanding: number;
  proof: StockProof;
};
export type PurchaseOverview = {
  success: true;
  personId: string;
  manager: boolean;
  month: string;
  checkedAt: string;
  selected: PurchaseTotals;
  people: PurchaseTotals[];
  history: PurchaseHistoryRow[];
  page: number;
  pages: number;
  historyCount: number;
};

export function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nonnegative(value: unknown, field: string): number {
  if (value === null || value === undefined || value === "") {
    throw new Error(`Missing ${field}; totals cannot be verified.`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${field}; totals cannot be verified.`);
  }
  return number;
}

export function moneyValue(value: unknown): number {
  return Math.round(nonnegative(value, "purchase amount") * 100) / 100;
}

export function unitsValue(value: unknown): number {
  const number = nonnegative(value, "purchase quantity");
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid purchase quantity.");
  return number;
}

export function tripoliMonth(at: Date | string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid purchase date.");
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Tripoli", year: "numeric", month: "2-digit",
  }).formatToParts(date);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

/** Authorization is independent of the browser's self-service/manager display. */
export function resolvePurchasePerson(manager: boolean, ownId: string, requestedId: string): string {
  if (!manager && (!ownId || (requestedId && requestedId !== ownId))) {
    throw new Error("You can only view your own personal purchases.");
  }
  const id = requestedId || ownId;
  if (!id) throw new Error("A linked team member is required.");
  return id;
}

export function emptyTotals(personId: string, name = "", active = true): PurchaseTotals {
  return { personId, name, active, records: 0, units: 0, charged: 0, paid: 0,
    outstanding: 0, currentMonthOutstanding: 0, earlierOutstanding: 0, otherOutstanding: 0 };
}

export function summarizePurchases(purchases: DataRow[], team: DataRow[], month: string): PurchaseTotals[] {
  const groups = new Map<string, PurchaseTotals>();
  const members = new Map(team.map((row) => [text(row.id), row]));
  for (const member of team) {
    const roles = [member.role, ...(Array.isArray(member.roles) ? member.roles : [])];
    if (roles.includes("operator")) {
      groups.set(text(member.id), emptyTotals(text(member.id), text(member.full_name), member.active !== false));
    }
  }
  for (const purchase of purchases) {
    const id = text(purchase.person_id);
    if (!id) throw new Error("Purchase is missing its owner.");
    const member = members.get(id);
    const total = groups.get(id) || emptyTotals(id, text(member?.full_name), member?.active !== false);
    const charged = Math.round(moneyValue(purchase.total_lyd) * 100);
    const paid = Math.round(moneyValue(purchase.paid_amount_lyd) * 100);
    const outstanding = Math.round(moneyValue(purchase.remaining_amount_lyd) * 100);
    // Do not disguise a corrupt payment allocation as a healthy zero balance.
    if (paid > charged || charged - paid !== outstanding) {
      throw new Error("Purchase amounts do not reconcile; review is required.");
    }
    const add = (field: "charged" | "paid" | "outstanding" | "currentMonthOutstanding" | "earlierOutstanding" | "otherOutstanding", cents: number) => {
      total[field] = (Math.round(total[field] * 100) + cents) / 100;
    };
    total.records += 1;
    total.units += unitsValue(purchase.quantity);
    add("charged", charged);
    add("paid", paid);
    add("outstanding", outstanding);
    const takenMonth = tripoliMonth(text(purchase.purchased_at));
    add(takenMonth === month ? "currentMonthOutstanding" : takenMonth < month ? "earlierOutstanding" : "otherOutstanding", outstanding);
    groups.set(id, total);
  }
  return [...groups.values()].sort((a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name) || a.personId.localeCompare(b.personId));
}

/** A payment state, a movement ID alone, or a mismatching link is NOT proof. */
export function verifyPurchaseStock(
  purchase: DataRow,
  movement: DataRow | undefined,
  reversedIds: ReadonlySet<string>,
  storageName: string | null = null,
): StockProof {
  const id = text(purchase.inventory_movement_id) || null;
  const result: StockProof = { status: "missing", movementId: id, quantity: null, recordedAt: null, storageName: null };
  if (!id || !movement) return result;
  const matches = text(movement.id) === id &&
    text(movement.product_id) === text(purchase.product_id) &&
    Number(movement.quantity) === unitsValue(purchase.quantity) &&
    movement.from_entity_type === "storage" &&
    text(movement.from_entity_id) === text(purchase.storage_location_id) &&
    movement.to_entity_type === "operator_personal_purchase" &&
    text(movement.to_entity_id) === text(purchase.person_id) &&
    movement.reason === "operator_personal_purchase" &&
    (!movement.source_id || text(movement.source_id) === text(purchase.id)) &&
    (!movement.source_type || movement.source_type === "operator_personal_purchase");
  // Do not return details from a movement linked to somebody else's purchase.
  if (!matches) return { ...result, status: "mismatch" };
  if (movement.reversed_movement_id || reversedIds.has(id)) return { ...result, status: "reversed" };
  const recordedAt = text(movement.created_at);
  if (!Number.isFinite(new Date(recordedAt).getTime())) return { ...result, status: "mismatch" };
  return { status: "deducted", movementId: id, quantity: unitsValue(purchase.quantity), recordedAt, storageName };
}

export type PageResult<T> = { data: T[] | null; error: unknown; count: number | null };
/** Exact-count paging prevents the API row limit from silently understating debt. */
export async function readAllPurchaseRows<T>(
  load: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 500,
  maxRows = 100_000,
): Promise<T[]> {
  const rows: T[] = [];
  let expected: number | null = null;
  for (;;) {
    const page = await load(rows.length, rows.length + pageSize - 1);
    if (page.error) throw new Error("Purchase records could not be verified.");
    if (!Array.isArray(page.data) || page.count === null || !Number.isSafeInteger(page.count) || page.count < 0) {
      throw new Error("Purchase records returned an incomplete response.");
    }
    if (expected !== null && expected !== page.count) throw new Error("Records changed during loading. Refresh the overview.");
    expected = page.count;
    if (expected > maxRows) throw new Error("This overview needs a larger reporting query; no partial totals are shown.");
    rows.push(...page.data);
    if (rows.length === expected) return rows;
    if (!page.data.length || rows.length > expected) throw new Error("Purchase records were incomplete; no partial totals are shown.");
  }
}
