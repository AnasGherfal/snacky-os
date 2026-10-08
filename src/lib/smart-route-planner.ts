import "server-only";

import { ROUTE_RESERVATION_STATUSES } from "@/lib/route-workflow";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { ensureFreshXyRoutePlanningData } from "@/lib/xy-vms-sync";
import { ensureFreshXyLiveSales } from "@/lib/xy-live-sales-sync";

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;

type SmartPlanInput = {
  machineIds: string[];
  routeDate: string;
  operatorId?: string | null;
  requestedBy?: string | null;
  excludeRouteId?: string | null;
};

type ProductRow = {
  id: string;
  name: string;
  category: string | null;
  brand: string | null;
  active: boolean;
};

type MachineRow = {
  id: string;
  name: string | null;
  machine_code: string | null;
  location_id: string | null;
  location?: {
    id?: string | null;
    name?: string | null;
    location_type?: string | null;
  } | Array<{
    id?: string | null;
    name?: string | null;
    location_type?: string | null;
  }> | null;
};

type StockRow = {
  machine_id: string;
  slot_code: string | null;
  product_id: string | null;
  current_qty: number | string | null;
  capacity: number | string | null;
  captured_at: string | null;
};

type MachineSlotRow = {
  id: string;
  machine_id: string;
  slot_code: string;
  product_id: string | null;
  capacity: number | string | null;
  par_qty: number | string | null;
  active: boolean | null;
};

type ProductProfileRow = {
  product_id: string;
  fit_profile: string | null;
  substitution_group: string | null;
};

type MachineContextRow = {
  machine_id: string;
  location_type: string | null;
  location_label: string | null;
};

type SlotRuleRow = {
  machine_slot_id: string;
  product_id: string;
  rule: "allowed" | "prohibited";
};

type LocationRuleRow = {
  machine_id: string | null;
  location_id: string | null;
  location_type: string | null;
  product_id: string;
  rule: "preferred" | "allowed" | "avoid" | "prohibited";
  score_adjustment: number | string | null;
};

type DemandRow = {
  machine_id: string;
  location_id: string | null;
  location_type: string | null;
  product_id: string;
  units_proxy: number | string;
  observation_count: number | string;
  latest_observed_at: string | null;
};

type SalesSignalRow = {
  machine_id: string;
  location_id: string | null;
  location_type: string | null;
  product_id: string;
  units_sold: number | string;
  transaction_count: number | string;
  revenue_amount: number | string;
  latest_sale_at: string | null;
};

type RouteFillHistoryRow = {
  machine_id?: string | null;
  product_id?: string | null;
  actual_qty?: unknown;
  created_at?: string | null;
};

type FitHistoryRow = {
  machine_id: string;
  slot_code: string;
  product_id: string;
  observations: number | string;
  last_seen_at: string | null;
};

type Candidate = {
  productId: string;
  productName: string;
  availableUnits: number;
  score: number;
  fitProfile: string;
  fitEvidence: string;
  locationRule: string | null;
  machineDemandUnits: number;
  locationTypeDemandUnits: number;
  networkDemandUnits: number;
  recentRouteFillUnits: number;
  machineSalesUnits: number;
  locationTypeSalesUnits: number;
  networkSalesUnits: number;
  salesTransactions: number;
  original: boolean;
};

type PlanTask = {
  taskId: string;
  machineId: string;
  machineName: string;
  locationName: string | null;
  locationType: string | null;
  machineSlotId: string | null;
  slotCode: string;
  currentProductId: string;
  currentProductName: string;
  currentQty: number;
  capacity: number;
  neededQty: number;
  allowSubstitution: boolean;
  transitionMode: "none" | "empty_lane" | "replace_now";
  returnCurrentQty: number;
  dailyVelocity: number;
  serviceIntervalDays: number;
  projectedQtyAtNextService: number;
  transitionFloorQty: number;
  candidates: Candidate[];
};

type AiDecision = {
  taskId: string;
  selectedProductId: string;
  quantity: number;
  reason: string;
  confidence: "high" | "medium" | "low";
};

type ValidatedDecision = AiDecision & {
  machineId: string;
  machineSlotId: string | null;
  slotCode: string;
  currentProductId: string;
  currentProductName: string;
  selectedProductName: string;
  currentQty: number;
  capacity: number;
  neededQty: number;
  substituted: boolean;
  transitionMode: "none" | "empty_lane" | "replace_now";
  returnCurrentQty: number;
  projectedQtyAtNextService: number;
  transitionFloorQty: number;
};

export type SmartRouteSlotAllocation = {
  machine_slot_id: string | null;
  slot_code: string | null;
  current_qty: number;
  observed_current_qty: number;
  target_qty: number;
  capacity: number;
  recommended_take_qty: number;
  final_take_qty: number;
  allocation_kind: "slot";
  transition_mode: "none" | "empty_lane" | "replace_now";
  substituted: boolean;
  from_product_id: string;
  from_product_name: string;
  return_current_qty: number;
};

export type SmartRoutePlanItem = {
  machineId: string;
  productId: string;
  quantity: number;
  machineSlotId: string | null;
  slotCode: string | null;
  source: "smart_ai_plan";
  notes: string | null;
  slotAllocations: SmartRouteSlotAllocation[];
};

export type SmartRoutePlanResult = {
  plannerMode: "ai" | "deterministic_fallback";
  model: string | null;
  summary: string;
  demandSource: "xy_live_sales" | "xy_live_sales_plus_stock_depletion" | "xy_stock_depletion";
  manualStopItems: SmartRoutePlanItem[];
  slotAssignments: SmartRoutePlanItem[];
  substitutions: Array<{
    machineId: string;
    slotCode: string;
    fromProductId: string;
    fromProductName: string;
    toProductId: string;
    toProductName: string;
    quantity: number;
    reason: string;
    confidence: "high" | "medium" | "low";
    transitionMode: "empty_lane" | "replace_now";
    returnCurrentQty: number;
    projectedQtyAtNextService: number;
    transitionFloorQty: number;
  }>;
  warnings: string[];
  freshness: {
    xyOutcome: string;
    latestStockAt: string | null;
    latestSalesAt: string | null;
    salesSyncOutcome: string;
    generatedAt: string;
  };
};

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions"],
  properties: {
    summary: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["taskId", "selectedProductId", "quantity", "reason", "confidence"],
        properties: {
          taskId: { type: "string" },
          selectedProductId: { type: "string" },
          quantity: { type: "integer", minimum: 1 },
          reason: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
} as const;

function compactPlanWarnings(allWarnings: string[]) {
  const unique = Array.from(new Set(allWarnings.filter(Boolean)));
  const unfillable = unique.filter((message) =>
    message.startsWith("UNFILLABLE:") || message.startsWith("HARD NO-EMPTY-LANE EXCEPTION"));
  const stale = unique.filter((message) => message.startsWith("Skipped stale XY lane"));
  const stock = unique.filter((message) =>
    message.startsWith("Clamped ") || message.includes("exhausted by higher-priority"));
  const swap = unique.filter((message) => message.startsWith("Blocked substitution"));
  const handled = new Set([...unfillable, ...stale, ...stock, ...swap]);
  const notes = unique.filter((message) => !handled.has(message));
  const brief: string[] = [];
  if (unfillable.length) {
    brief.push(`${unfillable.length} usable lanes have no compatible in-stock replacement. Review before dispatch.`);
    brief.push(...unfillable.slice(0, 3));
  }
  if (stale.length) brief.push(`${stale.length} lanes were excluded because their XY data was stale.`);
  if (stock.length) brief.push(`${stock.length} stock allocations were automatically adjusted to available storage.`);
  if (swap.length) brief.push(`${swap.length} unsafe product substitutions were prevented.`);
  brief.push(...notes.slice(0, 5));
  if (notes.length > 5) brief.push(`${notes.length - 5} additional technical notices recorded in the Smart Route audit.`);
  return brief;
}

function units(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function signed(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function normalize(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function fitProfileFromName(product: ProductRow, override?: string | null) {
  const explicit = String(override ?? "").trim();
  if (explicit) return explicit;

  const value = normalize(`${product.name} ${product.category ?? ""} ${product.brand ?? ""}`);

  if (/\bwater\b|ivs[ae]r/.test(value)) return "water_bottle";
  if (/almarai|pepsi|7up|mirinda|schweppes|barbican|freez|kinza|juice|drink|suntop|rani|shani|caesar|caser|rauch|cola|energy|x!r|xr |prime\b|fruity|bottle|can\b/.test(value)) {
    return "drink_bottle_can";
  }
  if (/doritos|spuds|tiger|mr\.?\s*crunch|chips|takis|pring|chillax|shocks|activ|daddy/.test(value)) return "chips_bag";
  if (/bebeto|gummy|haribo|sweeto|yupi|skittles|jelly|marshm/.test(value)) return "candy_bag";
  if (/brioche|croissant|corissant|cake|cookie|biscuit|digestive|lovita|mulino|brownie/.test(value)) return "pastry_biscuit";
  if (/peanut|nuts|almond|smsm|sesame/.test(value)) return "nuts_bag";
  if (/chocolate|kinder|milka|galaxy|snickers|twix|gardena|bounty|maestro|maltesers|laviva|luppo|kitkat|mars|toblerone|wafer/.test(value)) {
    return "chocolate_bar";
  }
  return "standard_snack";
}

function locationRuleFor(
  rules: LocationRuleRow[],
  machineId: string,
  locationId: string | null,
  locationType: string | null,
  productId: string,
) {
  return rules.find((row) => row.product_id === productId && row.machine_id === machineId)
    ?? rules.find((row) => row.product_id === productId && !row.machine_id && row.location_id === locationId)
    ?? rules.find((row) => row.product_id === productId && !row.machine_id && !row.location_id && row.location_type === locationType)
    ?? null;
}

function collectOpenAIText(payload: unknown) {
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  if (typeof response.output_text === "string") return response.output_text;
  const chunks: string[] = [];
  for (const item of response.output ?? []) {
    for (const block of item.content ?? []) {
      if (typeof block.text === "string") chunks.push(block.text);
    }
  }
  return chunks.join("\n").trim();
}

function routeFillMap(rows: Array<{ machine_id?: string | null; product_id?: string | null; actual_qty?: unknown }>) {
  const result = new Map<string, number>();
  rows.forEach((row) => {
    const machineId = String(row.machine_id ?? "");
    const productId = String(row.product_id ?? "");
    if (!machineId || !productId) return;
    const key = `${machineId}:${productId}`;
    result.set(key, (result.get(key) ?? 0) + units(row.actual_qty));
  });
  return result;
}

function tripoliServiceDate(value: string | null | undefined) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Tripoli",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const map = new Map(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const year = map.get("year");
  const month = map.get("month");
  const day = map.get("day");
  return year && month && day ? `${year}-${month}-${day}` : null;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function serviceIntervalDaysMap(rows: RouteFillHistoryRow[]) {
  const datesByMachine = new Map<string, Set<string>>();
  rows.forEach((row) => {
    const machineId = String(row.machine_id ?? "");
    const date = tripoliServiceDate(row.created_at);
    if (!machineId || !date) return;
    const dates = datesByMachine.get(machineId) ?? new Set<string>();
    dates.add(date);
    datesByMachine.set(machineId, dates);
  });

  const result = new Map<string, number>();
  datesByMachine.forEach((dateSet, machineId) => {
    const dates = Array.from(dateSet).sort();
    const gaps: number[] = [];
    for (let index = 1; index < dates.length; index += 1) {
      const previous = Date.parse(`${dates[index - 1]}T00:00:00Z`);
      const current = Date.parse(`${dates[index]}T00:00:00Z`);
      const gap = (current - previous) / (24 * 60 * 60 * 1000);
      if (Number.isFinite(gap) && gap > 0 && gap <= 21) gaps.push(gap);
    }
    const typical = median(gaps);
    if (typical !== null) result.set(machineId, Math.max(1, Math.min(14, Math.round(typical))));
  });

  return result;
}

function demandMaps(rows: DemandRow[]) {
  const machine = new Map<string, number>();
  const locationType = new Map<string, number>();
  const network = new Map<string, number>();

  rows.forEach((row) => {
    const productId = String(row.product_id ?? "");
    const machineId = String(row.machine_id ?? "");
    const type = String(row.location_type ?? "");
    const quantity = units(row.units_proxy);
    if (!productId) return;
    if (machineId) machine.set(`${machineId}:${productId}`, (machine.get(`${machineId}:${productId}`) ?? 0) + quantity);
    if (type) locationType.set(`${type}:${productId}`, (locationType.get(`${type}:${productId}`) ?? 0) + quantity);
    network.set(productId, (network.get(productId) ?? 0) + quantity);
  });

  return { machine, locationType, network };
}

function salesMaps(rows: SalesSignalRow[]) {
  const machine = new Map<string, number>();
  const locationType = new Map<string, number>();
  const network = new Map<string, number>();
  const transactions = new Map<string, number>();

  rows.forEach((row) => {
    const productId = String(row.product_id ?? "");
    const machineId = String(row.machine_id ?? "");
    const type = String(row.location_type ?? "");
    const sold = units(row.units_sold);
    const count = units(row.transaction_count);
    if (!productId) return;
    if (machineId) {
      machine.set(`${machineId}:${productId}`, (machine.get(`${machineId}:${productId}`) ?? 0) + sold);
      transactions.set(`${machineId}:${productId}`, (transactions.get(`${machineId}:${productId}`) ?? 0) + count);
    }
    if (type) locationType.set(`${type}:${productId}`, (locationType.get(`${type}:${productId}`) ?? 0) + sold);
    network.set(productId, (network.get(productId) ?? 0) + sold);
  });

  return { machine, locationType, network, transactions };
}

function candidateScore({
  original,
  emptyLane,
  historicallySeen,
  explicitAllowed,
  locationRule,
  machineDemand,
  typeDemand,
  networkDemand,
  recentFill,
  machineSales,
  typeSales,
  networkSales,
  salesTransactions,
  sameBrand,
}: {
  original: boolean;
  emptyLane: boolean;
  historicallySeen: boolean;
  explicitAllowed: boolean;
  locationRule: LocationRuleRow | null;
  machineDemand: number;
  typeDemand: number;
  networkDemand: number;
  recentFill: number;
  machineSales: number;
  typeSales: number;
  networkSales: number;
  salesTransactions: number;
  sameBrand: boolean;
}) {
  // Continuity matters for a partially stocked lane, but an EMPTY lane is merchandising
  // space that should go to the strongest proven seller rather than blindly restoring
  // the previous SKU.
  let score = original ? (emptyLane ? 12 : 55) : 0;
  if (historicallySeen) score += 24;
  if (explicitAllowed) score += 30;
  if (sameBrand) score += 8;
  if (locationRule?.rule === "preferred") score += 30;
  if (locationRule?.rule === "avoid") score -= 35;
  score += signed(locationRule?.score_adjustment);
  score += Math.log1p(machineSales) * 30;
  score += Math.log1p(typeSales) * 13;
  score += Math.log1p(networkSales) * 5;
  score += Math.log1p(salesTransactions) * 3;
  score += Math.log1p(machineDemand) * 12;
  score += Math.log1p(typeDemand) * 6;
  score += Math.log1p(networkDemand) * 2;
  score += Math.log1p(recentFill) * 4;
  return Math.round(score * 100) / 100;
}

async function callPlannerAI(tasks: PlanTask[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.SMART_ROUTE_MODEL || process.env.RECEIPT_SCAN_MODEL || "gpt-4.1-mini";
  if (!apiKey) return { ok: false as const, model: null, summary: "", decisions: [] as AiDecision[], warning: "OPENAI_API_KEY is not configured; used deterministic smart planning." };

  const compactTasks = tasks.map((task) => ({
    taskId: task.taskId,
    machine: task.machineName,
    location: task.locationName,
    locationType: task.locationType,
    slotCode: task.slotCode,
    currentProduct: { id: task.currentProductId, name: task.currentProductName, currentQty: task.currentQty },
    capacity: task.capacity,
    neededQty: task.neededQty,
    allowSubstitution: task.allowSubstitution,
    transitionMode: task.transitionMode,
    returnCurrentQty: task.returnCurrentQty,
    dailyVelocity: Math.round(task.dailyVelocity * 100) / 100,
    serviceIntervalDays: task.serviceIntervalDays,
    projectedQtyAtNextService: task.projectedQtyAtNextService,
    transitionFloorQty: task.transitionFloorQty,
    candidates: task.candidates.map((candidate) => ({
      id: candidate.productId,
      name: candidate.productName,
      availableUnits: candidate.availableUnits,
      score: candidate.score,
      fitEvidence: candidate.fitEvidence,
      locationRule: candidate.locationRule,
      machineDemandUnits: candidate.machineDemandUnits,
      locationTypeDemandUnits: candidate.locationTypeDemandUnits,
      networkDemandUnits: candidate.networkDemandUnits,
      recentRouteFillUnits: candidate.recentRouteFillUnits,
      machineSalesUnits: candidate.machineSalesUnits,
      locationTypeSalesUnits: candidate.locationTypeSalesUnits,
      networkSalesUnits: candidate.networkSalesUnits,
      salesTransactions: candidate.salesTransactions,
      original: candidate.original,
    })),
  }));

  const prompt = [
    "You are Snacky OS smart route planner.",
    "Choose exactly one candidate product for each refill task when at least one candidate is useful.",
    "Never invent a product ID and never exceed neededQty or candidate availableUnits.",
    "The candidate list is already filtered by storage, physical fit, and location hard rules.",
    "For an empty lane, do not default to the old SKU just for continuity. Treat the lane as merchandising space and choose the candidate most likely to sell before the next service.",
    "Every empty lane must receive a compatible in-stock candidate when one exists. Repeating the same strong product across multiple lanes is explicitly allowed and is better than preserving weak variety.",
    "When transitionMode is replace_now, Snacky has already determined that the lane should change now because the current SKU cannot be replenished or a compatible SKU has materially stronger verified local sales. Choose the strongest compatible substitute; the operator will remove the remaining old units and return them to storage before changing the XY slot. Never mix old and new products in one lane.",
    "When transitionMode is empty_lane, choose the strongest compatible product using verified transaction sales first: exact-machine sales, then same venue-type sales, then network sales. Use stock-depletion demand, storage coverage and route history as secondary evidence. The previous SKU receives only a small continuity preference.",
    "Respect preferred/avoid location signals. Avoid low-confidence novelty when a proven-fit seller exists.",
    "Give short operational reasons. Do not create routes or reserve stock; this is only a review draft.",
    JSON.stringify({ tasks: compactTasks }),
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      signal: AbortSignal.timeout(9_000),
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        max_output_tokens: 5000,
        text: {
          format: {
            type: "json_schema",
            name: "smart_route_plan",
            schema: decisionSchema,
            strict: true,
          },
        },
      }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = (payload as { error?: { message?: string } } | null)?.error?.message ?? `OpenAI returned ${response.status}.`;
      return { ok: false as const, model, summary: "", decisions: [] as AiDecision[], warning: `AI planner unavailable: ${message}` };
    }

    const text = collectOpenAIText(payload);
    const parsed = JSON.parse(text) as { summary?: unknown; decisions?: unknown };
    const decisions = Array.isArray(parsed.decisions) ? parsed.decisions as AiDecision[] : [];
    return {
      ok: true as const,
      model,
      summary: String(parsed.summary ?? "Smart plan generated."),
      decisions,
      warning: null,
    };
  } catch (error) {
    return {
      ok: false as const,
      model,
      summary: "",
      decisions: [] as AiDecision[],
      warning: `AI planner unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function fallbackDecision(task: PlanTask): AiDecision | null {
  const selected = task.candidates[0] ?? null;
  if (!selected) return null;
  return {
    taskId: task.taskId,
    selectedProductId: selected.productId,
    quantity: Math.min(task.neededQty, selected.availableUnits),
    reason: selected.original
      ? "Kept the current product and limited the quantity to verified unreserved storage."
      : task.transitionMode === "replace_now"
        ? "Smart Route marked this lane for a product change because stock availability or verified local sales favor a stronger compatible SKU; use the highest-ranked substitute and do not mix products."
        : "Used the highest-ranked compatible in-stock substitute for the empty lane.",
    confidence: selected.fitEvidence === "explicit_slot_rule" || selected.fitEvidence === "historically_seen_exact_slot" ? "high" : "medium",
  };
}

function validateDecisions(tasks: PlanTask[], proposed: AiDecision[], startingAvailable: Map<string, number>, warnings: string[]) {
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));
  const proposalByTask = new Map<string, AiDecision>();
  proposed.forEach((decision) => {
    const taskId = String(decision?.taskId ?? "");
    if (taskById.has(taskId) && !proposalByTask.has(taskId)) proposalByTask.set(taskId, decision);
  });

  const remaining = new Map(startingAvailable);
  const validated: ValidatedDecision[] = [];

  for (const task of tasks) {
    const proposedDecision = proposalByTask.get(task.taskId);
    let decision = proposedDecision;
    let candidate = decision
      ? task.candidates.find((row) => row.productId === String(decision?.selectedProductId ?? ""))
      : null;

    if (proposedDecision && !candidate) {
      warnings.push(`Ignored invalid AI product choice for ${task.machineName} slot ${task.slotCode}.`);
    }

    if (candidate && (remaining.get(candidate.productId) ?? 0) <= 0) {
      warnings.push(
        `${candidate.productName} was exhausted by higher-priority route allocations before ${task.machineName} slot ${task.slotCode}; Smart Route tried the next-best compatible product instead.`,
      );
      candidate = null;
      decision = undefined;
    }

    if (!candidate) {
      candidate = task.candidates.find((row) => {
        if (!row.original && !task.allowSubstitution) return false;
        return Math.max(0, remaining.get(row.productId) ?? 0) > 0;
      }) ?? null;

      if (candidate) {
        const deterministic = fallbackDecision({
          ...task,
          candidates: [candidate, ...task.candidates.filter((row) => row.productId !== candidate?.productId)],
        });
        decision = deterministic
          ? {
              ...deterministic,
              selectedProductId: candidate.productId,
              reason: proposedDecision
                ? "The AI-selected SKU was unavailable after route-wide allocation, so Snacky used the next highest-ranked compatible in-stock product to keep the lane covered."
                : deterministic.reason,
            }
          : undefined;
      }
    }

    if (!decision || !candidate) {
      const policy = task.transitionMode === "empty_lane"
        ? "HARD NO-EMPTY-LANE EXCEPTION"
        : "Coverage exception";
      warnings.push(
        `${policy}: no compatible in-stock product is available for ${task.machineName} slot ${task.slotCode} (${task.currentProductName}).`,
      );
      continue;
    }

    const available = Math.max(0, remaining.get(candidate.productId) ?? 0);
    const requested = units(decision.quantity);
    const quantity = Math.min(task.neededQty, requested || task.neededQty, available);
    if (quantity <= 0) {
      warnings.push(
        `HARD NO-EMPTY-LANE EXCEPTION: all compatible candidates were exhausted before ${task.machineName} slot ${task.slotCode} could be covered.`,
      );
      continue;
    }
    if (quantity < requested) {
      warnings.push(`Clamped ${candidate.productName} at ${task.machineName} slot ${task.slotCode} from ${requested} to ${quantity} because only ${available} unreserved units remained.`);
    }

    const substituted = candidate.productId !== task.currentProductId;
    if (substituted && !task.allowSubstitution) {
      warnings.push(`Blocked substitution in non-empty ${task.machineName} slot ${task.slotCode}; kept the existing product unchanged.`);
      const original = task.candidates.find((row) => row.original && Math.max(0, remaining.get(row.productId) ?? 0) > 0);
      if (!original) continue;
      const originalAvailable = Math.max(0, remaining.get(original.productId) ?? 0);
      const originalQty = Math.min(task.neededQty, originalAvailable);
      if (originalQty <= 0) continue;
      remaining.set(original.productId, originalAvailable - originalQty);
      validated.push({
        ...decision,
        selectedProductId: original.productId,
        selectedProductName: original.productName,
        currentQty: task.currentQty,
        capacity: task.capacity,
        quantity: originalQty,
        machineId: task.machineId,
        machineSlotId: task.machineSlotId,
        slotCode: task.slotCode,
        currentProductId: task.currentProductId,
        currentProductName: task.currentProductName,
        neededQty: task.neededQty,
        substituted: false,
        transitionMode: task.transitionMode,
        returnCurrentQty: task.returnCurrentQty,
        projectedQtyAtNextService: task.projectedQtyAtNextService,
        transitionFloorQty: task.transitionFloorQty,
        reason: "Substitution blocked because the lane still contains the current product.",
      });
      continue;
    }

    remaining.set(candidate.productId, available - quantity);
    validated.push({
      ...decision,
      selectedProductId: candidate.productId,
      selectedProductName: candidate.productName,
      currentQty: task.currentQty,
      capacity: task.capacity,
      quantity,
      machineId: task.machineId,
      machineSlotId: task.machineSlotId,
      slotCode: task.slotCode,
      currentProductId: task.currentProductId,
      currentProductName: task.currentProductName,
      neededQty: task.neededQty,
      substituted,
      transitionMode: task.transitionMode,
      returnCurrentQty: task.returnCurrentQty,
      projectedQtyAtNextService: task.projectedQtyAtNextService,
      transitionFloorQty: task.transitionFloorQty,
    });
  }

  return validated;
}

function slotAssignmentItems(decisions: ValidatedDecision[]): SmartRoutePlanItem[] {
  return decisions.map((decision) => {
    let notes = `Slot ${decision.slotCode}: ${decision.reason}`;
    if (decision.substituted && decision.transitionMode === "replace_now") {
      notes = `PLANNED PRODUCT CHANGE — Slot ${decision.slotCode}: remove the remaining ${decision.returnCurrentQty} × ${decision.currentProductName} from the machine and record “Returned from machine → Product replaced”. Then change and verify the XY slot as ${decision.selectedProductName}, and fill ${decision.quantity} units. Do not mix the two products in one lane. ${decision.reason}`;
    } else if (decision.substituted) {
      notes = `Slot ${decision.slotCode}: replace ${decision.currentProductName} with ${decision.selectedProductName}. ${decision.reason}`;
    }

    const startingQtyForSelectedProduct = decision.substituted ? 0 : decision.currentQty;
    const targetQty = Math.min(decision.capacity, startingQtyForSelectedProduct + decision.quantity);
    return {
      machineId: decision.machineId,
      productId: decision.selectedProductId,
      quantity: decision.quantity,
      machineSlotId: decision.machineSlotId,
      slotCode: decision.slotCode,
      source: "smart_ai_plan" as const,
      notes,
      slotAllocations: [{
        machine_slot_id: decision.machineSlotId,
        slot_code: decision.slotCode,
        current_qty: startingQtyForSelectedProduct,
        observed_current_qty: decision.currentQty,
        target_qty: targetQty,
        capacity: decision.capacity,
        recommended_take_qty: decision.quantity,
        final_take_qty: decision.quantity,
        allocation_kind: "slot" as const,
        transition_mode: decision.transitionMode,
        substituted: decision.substituted,
        from_product_id: decision.currentProductId,
        from_product_name: decision.currentProductName,
        return_current_qty: decision.returnCurrentQty,
      }],
    };
  });
}

function aggregateManualItems(decisions: ValidatedDecision[]): SmartRoutePlanItem[] {
  const grouped = new Map<string, {
    machineId: string;
    productId: string;
    quantity: number;
    machineSlotIds: Set<string>;
    slotCodes: Set<string>;
    notes: string[];
    slotAllocations: SmartRouteSlotAllocation[];
  }>();

  decisions.forEach((decision) => {
    const key = `${decision.machineId}:${decision.selectedProductId}`;
    const current = grouped.get(key) ?? {
      machineId: decision.machineId,
      productId: decision.selectedProductId,
      quantity: 0,
      machineSlotIds: new Set<string>(),
      slotCodes: new Set<string>(),
      notes: [],
      slotAllocations: [],
    };
    current.quantity += decision.quantity;
    if (decision.machineSlotId) current.machineSlotIds.add(decision.machineSlotId);
    if (decision.slotCode) current.slotCodes.add(decision.slotCode);
    const startingQtyForSelectedProduct = decision.substituted ? 0 : decision.currentQty;
    current.slotAllocations.push({
      machine_slot_id: decision.machineSlotId,
      slot_code: decision.slotCode,
      current_qty: startingQtyForSelectedProduct,
      observed_current_qty: decision.currentQty,
      target_qty: Math.min(decision.capacity, startingQtyForSelectedProduct + decision.quantity),
      capacity: decision.capacity,
      recommended_take_qty: decision.quantity,
      final_take_qty: decision.quantity,
      allocation_kind: "slot",
      transition_mode: decision.transitionMode,
      substituted: decision.substituted,
      from_product_id: decision.currentProductId,
      from_product_name: decision.currentProductName,
      return_current_qty: decision.returnCurrentQty,
    });
    if (decision.substituted && decision.transitionMode === "replace_now") {
      current.notes.push(
        `PLANNED PRODUCT CHANGE — Slot ${decision.slotCode}: remove the remaining ${decision.returnCurrentQty} × ${decision.currentProductName} from the machine and record “Returned from machine → Product replaced”. Then change and verify the XY slot as ${decision.selectedProductName}, and fill ${decision.quantity} units. Do not mix the two products in one lane. ${decision.reason}`,
      );
    } else if (decision.substituted) {
      current.notes.push(`Slot ${decision.slotCode}: replace ${decision.currentProductName} with ${decision.selectedProductName}. ${decision.reason}`);
    } else {
      current.notes.push(`Slot ${decision.slotCode}: ${decision.reason}`);
    }
    grouped.set(key, current);
  });

  return Array.from(grouped.values()).map((row) => ({
    machineId: row.machineId,
    productId: row.productId,
    quantity: row.quantity,
    machineSlotId: row.machineSlotIds.size === 1 ? Array.from(row.machineSlotIds)[0] : null,
    slotCode: row.slotCodes.size ? Array.from(row.slotCodes).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(", ") : null,
    source: "smart_ai_plan" as const,
    notes: row.notes.join(" "),
    slotAllocations: row.slotAllocations.sort((a, b) => String(a.slot_code ?? "").localeCompare(String(b.slot_code ?? ""), undefined, { numeric: true })),
  }));
}

export async function generateSmartRoutePlan(input: SmartPlanInput): Promise<SmartRoutePlanResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const machineIds = Array.from(new Set(input.machineIds.map(String).filter(Boolean)));
  if (!machineIds.length) throw new Error("Choose at least one machine before generating a smart plan.");

  // Sync services improve the forecast but MUST NOT block an inventory-safe
  // plan when a single XY endpoint times out. Keep the last verified snapshot.
  const [xyRefresh, salesRefresh] = await Promise.all([
    ensureFreshXyRoutePlanningData().catch((error) => {
      console.warn("[smart-route] XY freshness refresh unavailable; using verified snapshot", error);
      return { outcome: "failed" as const, reason: "XY refresh unavailable" };
    }),
    ensureFreshXyLiveSales({ maxAgeMs: 90 * 60 * 1000 }).catch((error) => {
      console.warn("[smart-route] Live sales unavailable; using stock depletion", error);
      return { outcome: "failed" as const, reason: "Live sales unavailable" };
    }),
  ]);
  const now = new Date();
  const recentFillSince = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const [
    machinesResult,
    stockResult,
    slotsResult,
    productsResult,
    storageResult,
    reservationsResult,
    reservingRoutesResult,
    profilesResult,
    machineContextResult,
    slotRulesResult,
    locationRulesResult,
    demandResult,
    salesSignalResult,
    fitHistoryResult,
    refillHistoryResult,
  ] = await Promise.all([
    supabase.from("machines").select("id, name, machine_code, location_id, location:locations(id, name, location_type)").in("id", machineIds),
    supabase.from("latest_vms_stock_by_slot").select("machine_id, slot_code, product_id, current_qty, capacity, captured_at").in("machine_id", machineIds),
    supabase.from("machine_slots").select("id, machine_id, slot_code, product_id, capacity, par_qty, active").in("machine_id", machineIds).eq("active", true),
    supabase.from("products").select("id, name, category, brand, active").eq("active", true),
    supabase.from("route_storage_stock_by_product").select("product_id, quantity_on_hand"),
    supabase.from("route_stock_lines").select("route_id, product_id, planned_qty, picked_qty"),
    supabase.from("routes").select("id, status").in("status", [...ROUTE_RESERVATION_STATUSES]),
    supabase.from("smart_route_product_profiles").select("product_id, fit_profile, substitution_group"),
    supabase.from("smart_route_machine_context").select("machine_id, location_type, location_label").in("machine_id", machineIds),
    supabase.from("smart_route_slot_product_rules").select("machine_slot_id, product_id, rule"),
    supabase.from("smart_route_location_product_rules").select("machine_id, location_id, location_type, product_id, rule, score_adjustment"),
    supabase.rpc("snacky_smart_route_demand_signals", { p_days: 21 }),
    supabase.rpc("snacky_smart_route_sales_signals", { p_days: 21 }),
    supabase.rpc("snacky_smart_route_slot_fit_history", { p_machine_ids: machineIds, p_days: 180 }),
    supabase.from("route_stop_fill_lines").select("machine_id, product_id, actual_qty, created_at").in("machine_id", machineIds).gte("created_at", recentFillSince),
  ]);

  // Inventory, route reservations and XY machine identities are essential;
  // demand, AI fit evidence and optional history are improvements, not blockers.
  const essentialFailures = [
    ["machines", machinesResult.error],
    ["XY stock", stockResult.error],
    ["machine slots", slotsResult.error],
    ["products", productsResult.error],
    ["storage", storageResult.error],
    ["reservations", reservationsResult.error],
    ["reserving route statuses", reservingRoutesResult.error],
    ["physical-fit profiles", profilesResult.error],
    ["slot safety rules", slotRulesResult.error],
    ["location restrictions", locationRulesResult.error],
  ].filter(([, error]) => error);
  if (essentialFailures.length) {
    console.error("[smart-route] Essential planning reads failed", essentialFailures);
    throw new Error("Smart Route could not verify machine stock or available storage. Retry after the stock data has refreshed; no route or stock was changed.");
  }

  const warnings: string[] = [];
  const optionalFailures = [
    ["machine context", machineContextResult.error],
    ["demand signals", demandResult.error],
    ["sales signals", salesSignalResult.error],
    ["fit history", fitHistoryResult.error],
    ["past route fills", refillHistoryResult.error],
  ].filter(([, error]) => error);
  if (optionalFailures.length) {
    console.warn("[smart-route] Optional scoring inputs degraded", optionalFailures);
    warnings.push("Some optional demand/fit signals were unavailable; used verified XY stock and storage for a conservative plan.");
  }
  if (xyRefresh.outcome === "failed" || xyRefresh.outcome === "unavailable") {
    warnings.push("XY live refresh was unavailable; the plan uses the latest saved XY snapshot. Review data freshness before visiting machines.");
  }
  if (salesRefresh.outcome === "failed" || salesRefresh.outcome === "unavailable") {
    warnings.push("Recent live sales were unavailable; product ranking uses historic demand and stock depletion.");
  }

  const machines = (machinesResult.data ?? []) as MachineRow[];
  const machineById = new Map(machines.map((machine) => [machine.id, machine]));
  const products = (productsResult.data ?? []) as ProductRow[];
  const productById = new Map(products.map((product) => [product.id, product]));
  const profiles = (profilesResult.data ?? []) as ProductProfileRow[];
  const profileByProduct = new Map(profiles.map((row) => [row.product_id, row]));
  const machineContexts = (machineContextResult.data ?? []) as MachineContextRow[];
  const contextByMachine = new Map(machineContexts.map((row) => [row.machine_id, row]));
  const slotRules = (slotRulesResult.data ?? []) as SlotRuleRow[];
  const locationRules = (locationRulesResult.data ?? []) as LocationRuleRow[];
  const fitHistory = (fitHistoryResult.data ?? []) as FitHistoryRow[];
  const fitSeen = new Set(fitHistory.map((row) => `${row.machine_id}:${row.slot_code}:${row.product_id}`));
  const demand = demandMaps((demandResult.data ?? []) as DemandRow[]);
  const rawSalesSignals = salesSignalResult.error ? [] : (salesSignalResult.data ?? []) as SalesSignalRow[];
  const latestSalesAt = rawSalesSignals
    .map((row) => row.latest_sale_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const latestSalesMs = Date.parse(String(latestSalesAt ?? ""));
  const recentTransactionSales = Number.isFinite(latestSalesMs) && now.getTime() - latestSalesMs <= 48 * 60 * 60 * 1000;
  // A successful API sync proves the connector ran; it does not make old transactions fresh.
  // Only recent successful-sale timestamps are allowed to influence smart-route ranking.
  const useTransactionSales = rawSalesSignals.length > 0 && recentTransactionSales;
  if (rawSalesSignals.length && !useTransactionSales) {
    warnings.push("Transaction sales exist but are stale; smart ranking ignored them and used current XY stock depletion.");
  }
  const sales = salesMaps(useTransactionSales ? rawSalesSignals : []);
  const demandSource: SmartRoutePlanResult["demandSource"] = useTransactionSales
    ? "xy_live_sales_plus_stock_depletion"
    : "xy_stock_depletion";
  const routeFillHistoryRows = (refillHistoryResult.data ?? []) as RouteFillHistoryRow[];
  const recentFill = routeFillMap(routeFillHistoryRows);
  const serviceIntervals = serviceIntervalDaysMap(routeFillHistoryRows);

  const storageByProduct = new Map<string, number>();
  (storageResult.data ?? []).forEach((row: any) => {
    const productId = String(row.product_id ?? "");
    if (productId) storageByProduct.set(productId, (storageByProduct.get(productId) ?? 0) + signed(row.quantity_on_hand));
  });
  const reservingRouteIds = new Set(
    (reservingRoutesResult.data ?? []).map((row: any) => String(row.id ?? "")).filter(Boolean),
  );
  const reservedByProduct = new Map<string, number>();
  (reservationsResult.data ?? []).forEach((row: any) => {
    const routeId = String(row.route_id ?? "");
    if (!routeId || routeId === String(input.excludeRouteId ?? "") || !reservingRouteIds.has(routeId)) return;
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    reservedByProduct.set(productId, (reservedByProduct.get(productId) ?? 0) + Math.max(0, units(row.planned_qty) - units(row.picked_qty)));
  });
  const availableByProduct = new Map<string, number>();
  products.forEach((product) => availableByProduct.set(product.id, Math.max(0, units(storageByProduct.get(product.id)) - units(reservedByProduct.get(product.id)))));

  const { data: physicallyHidden, error: hiddenError } = await supabase.from("xy_hidden_machine_selections")
    .select("machine_id,slot_code").in("machine_id",machineIds);
  if (hiddenError) {
    console.error("[smart-route] Physical lane visibility unavailable", hiddenError);
    throw new Error("Smart Route could not verify which machine lanes physically exist. Retry when the machine layout service is available; no stock was changed.");
  }
  const hiddenLaneKeys = new Set((physicallyHidden ?? []).map((slot: any) => `${slot.machine_id}:${slot.slot_code}`));
  const stockRows = ((stockResult.data ?? []) as StockRow[])
    .filter((slot) => !hiddenLaneKeys.has(`${slot.machine_id}:${slot.slot_code}`));
  const latestCaptureByMachine = new Map<string, number>();
  stockRows.forEach((stock) => {
    const capturedAt = stock.captured_at ? Date.parse(stock.captured_at) : Number.NaN;
    if (!stock.machine_id || !Number.isFinite(capturedAt)) return;
    latestCaptureByMachine.set(stock.machine_id, Math.max(latestCaptureByMachine.get(stock.machine_id) ?? 0, capturedAt));
  });

  const slotByKey = new Map(((slotsResult.data ?? []) as MachineSlotRow[]).map((slot) => [`${slot.machine_id}:${slot.slot_code}`, slot]));
  const tasks: PlanTask[] = [];
  let latestStockAt: string | null = null;
  const SLOT_STALE_LAG_MS = 30 * 60 * 1000;

  for (const stock of stockRows) {
    if (!stock.machine_id || !stock.slot_code || !stock.product_id) continue;
    const product = productById.get(stock.product_id);
    const machine = machineById.get(stock.machine_id);
    if (!product || !machine) continue;

    const machineLatestAt = latestCaptureByMachine.get(stock.machine_id) ?? 0;
    const rowCapturedAt = stock.captured_at ? Date.parse(stock.captured_at) : Number.NaN;
    if (!Number.isFinite(rowCapturedAt) || (machineLatestAt > 0 && machineLatestAt - rowCapturedAt > SLOT_STALE_LAG_MS)) {
      warnings.push(`Skipped stale XY lane ${stock.slot_code} on ${machine.name ?? machine.machine_code ?? machine.id}; verify that lane manually before refilling it.`);
      continue;
    }

    const currentQty = units(stock.current_qty);
    const capacity = units(stock.capacity) || units(slotByKey.get(`${stock.machine_id}:${stock.slot_code}`)?.capacity);
    const refillNeededQty = Math.max(0, capacity - currentQty);
    if (capacity <= 0) continue;
    if (stock.captured_at && (!latestStockAt || Date.parse(stock.captured_at) > Date.parse(latestStockAt))) latestStockAt = stock.captured_at;

    const slot = slotByKey.get(`${stock.machine_id}:${stock.slot_code}`) ?? null;
    const relation = firstRelation(machine.location);
    const machineContext = contextByMachine.get(machine.id);
    const locationId = String(relation?.id ?? machine.location_id ?? "") || null;
    const locationType = String(machineContext?.location_type ?? relation?.location_type ?? "") || null;
    const locationName = String(machineContext?.location_label ?? relation?.name ?? "") || null;
    const currentProfile = profileByProduct.get(product.id);
    const currentFit = fitProfileFromName(product, currentProfile?.fit_profile);
    const currentGroup = String(currentProfile?.substitution_group ?? "").trim();
    const originalAvailableUnits = availableByProduct.get(product.id) ?? 0;
    const serviceIntervalDays = serviceIntervals.get(machine.id) ?? 3;
    const exactMachineSales = sales.machine.get(`${machine.id}:${product.id}`) ?? 0;
    const exactMachineDemand = demand.machine.get(`${machine.id}:${product.id}`) ?? 0;
    const velocityUnits21d = useTransactionSales && exactMachineSales > 0 ? exactMachineSales : exactMachineDemand;
    const dailyVelocity = velocityUnits21d / 21;
    const expectedDepletionBeforeNextService = Math.max(0, Math.ceil(dailyVelocity * serviceIntervalDays));
    const transitionFloorQty = Math.max(2, Math.ceil(capacity * 0.5));
    const projectedQtyAtNextService = Math.max(0, currentQty - expectedDepletionBeforeNextService);
    const stockoutReplaceNow = originalAvailableUnits <= 0
      && currentQty > 0
      && (currentQty <= transitionFloorQty || projectedQtyAtNextService <= transitionFloorQty);

    // To make this a merchandising AI rather than a refill calculator, fresh transaction
    // data may open compatible alternatives for evaluation even when the old SKU exists.
    // We only ACT on that comparison later when the sales advantage is large enough.
    const preliminaryAllowSubstitution = currentQty === 0
      || stockoutReplaceNow
      || (useTransactionSales && currentQty > 0);
    const candidateCoverageTarget = stockoutReplaceNow || (useTransactionSales && currentQty > 0)
      ? capacity
      : Math.max(1, refillNeededQty);

    if (originalAvailableUnits <= 0 && currentQty > 0 && !stockoutReplaceNow) {
      // Still stocked in the machine: no pickup and no operator action today.
      // This is not an error and should not flood the Smart Route screen.
      continue;
    }

    const explicitRulesForSlot = slot
      ? slotRules.filter((row) => row.machine_slot_id === slot.id)
      : [];
    const prohibitedIds = new Set(explicitRulesForSlot.filter((row) => row.rule === "prohibited").map((row) => row.product_id));
    const explicitlyAllowedIds = new Set(explicitRulesForSlot.filter((row) => row.rule === "allowed").map((row) => row.product_id));

    const candidates = products
      .map((candidate): Candidate | null => {
        const available = availableByProduct.get(candidate.id) ?? 0;
        if (available <= 0 || prohibitedIds.has(candidate.id)) return null;

        const candidateProfile = profileByProduct.get(candidate.id);
        const candidateFit = fitProfileFromName(candidate, candidateProfile?.fit_profile);
        const candidateGroup = String(candidateProfile?.substitution_group ?? "").trim();
        const original = candidate.id === product.id;
        const explicitAllowed = explicitlyAllowedIds.has(candidate.id);
        const historicallySeen = fitSeen.has(`${machine.id}:${stock.slot_code}:${candidate.id}`);

        if (!original) {
          if (!preliminaryAllowSubstitution) return null;
          if (currentGroup && candidateGroup !== currentGroup && !explicitAllowed && !historicallySeen) return null;
          if (!explicitAllowed && !historicallySeen && candidateFit !== currentFit) return null;
        }

        const rule = locationRuleFor(locationRules, machine.id, locationId, locationType, candidate.id);
        if (rule?.rule === "prohibited") return null;

        const machineDemand = demand.machine.get(`${machine.id}:${candidate.id}`) ?? 0;
        const typeDemand = locationType ? demand.locationType.get(`${locationType}:${candidate.id}`) ?? 0 : 0;
        const networkDemand = demand.network.get(candidate.id) ?? 0;
        const fills = recentFill.get(`${machine.id}:${candidate.id}`) ?? 0;
        const machineSales = sales.machine.get(`${machine.id}:${candidate.id}`) ?? 0;
        const typeSales = locationType ? sales.locationType.get(`${locationType}:${candidate.id}`) ?? 0 : 0;
        const networkSales = sales.network.get(candidate.id) ?? 0;
        const salesTransactions = sales.transactions.get(`${machine.id}:${candidate.id}`) ?? 0;
        const sameBrand = Boolean(normalize(product.brand) && normalize(product.brand) === normalize(candidate.brand));
        const fitEvidence = original
          ? "current_product"
          : explicitAllowed
            ? "explicit_slot_rule"
            : historicallySeen
              ? "historically_seen_exact_slot"
              : `same_fit_profile:${currentFit}`;

        return {
          productId: candidate.id,
          productName: candidate.name,
          availableUnits: available,
          score: candidateScore({
            original,
            emptyLane: currentQty === 0,
            historicallySeen,
            explicitAllowed,
            locationRule: rule,
            machineDemand,
            typeDemand,
            networkDemand,
            recentFill: fills,
            machineSales,
            typeSales,
            networkSales,
            salesTransactions,
            sameBrand,
          }),
          fitProfile: candidateFit,
          fitEvidence,
          locationRule: rule?.rule ?? null,
          machineDemandUnits: machineDemand,
          locationTypeDemandUnits: typeDemand,
          networkDemandUnits: networkDemand,
          recentRouteFillUnits: fills,
          machineSalesUnits: machineSales,
          locationTypeSalesUnits: typeSales,
          networkSalesUnits: networkSales,
          salesTransactions,
          original,
        };
      })
      .filter((row): row is Candidate => Boolean(row))
      .sort((a, b) => {
        const aCoverage = Math.min(1, a.availableUnits / Math.max(1, candidateCoverageTarget));
        const bCoverage = Math.min(1, b.availableUnits / Math.max(1, candidateCoverageTarget));
        const aEffectiveScore = a.score + aCoverage * 20;
        const bEffectiveScore = b.score + bCoverage * 20;
        return bEffectiveScore - aEffectiveScore
          || b.score - a.score
          || b.availableUnits - a.availableUnits
          || a.productName.localeCompare(b.productName);
      })
      .slice(0, 10);

    if (!candidates.length) {
      if (currentQty === 0) warnings.push(`UNFILLABLE: ${machine.name ?? machine.machine_code ?? machine.id}, lane ${stock.slot_code} has no compatible available product in storage.`);
      continue;
    }

    const originalCandidate = candidates.find((candidate) => candidate.original) ?? null;
    const strongestAlternative = candidates.find((candidate) => !candidate.original) ?? null;

    // Data-backed assortment optimization:
    // - only use fresh real transaction sales
    // - only re-merchandise a lane that is already at/below the transition floor
    // - require meaningful exact-machine evidence and a large advantage over the old SKU
    // - require the candidate score to beat the old SKU despite its continuity bonus
    const strongerLocalSeller = Boolean(
      useTransactionSales
      && currentQty > 0
      && currentQty <= transitionFloorQty
      && originalAvailableUnits > 0
      && originalCandidate
      && strongestAlternative
      && strongestAlternative.machineSalesUnits >= 6
      && (
        exactMachineSales === 0
          ? strongestAlternative.machineSalesUnits >= 8
          : strongestAlternative.machineSalesUnits >= exactMachineSales * 2.5
      )
      && strongestAlternative.score >= originalCandidate.score + 10
    );

    const mixReplaceNow = !stockoutReplaceNow && strongerLocalSeller;
    const transitionMode: PlanTask["transitionMode"] = currentQty === 0
      ? "empty_lane"
      : stockoutReplaceNow || mixReplaceNow
        ? "replace_now"
        : "none";
    const allowSubstitution = transitionMode !== "none";
    const neededQty = transitionMode === "replace_now" ? capacity : refillNeededQty;

    // A completely full lane only becomes a task when it has a valid replace-now reason.
    if (neededQty <= 0) continue;

    const taskCandidates = mixReplaceNow
      ? candidates.filter((candidate) => !candidate.original)
      : allowSubstitution
        ? candidates
        : candidates.filter((candidate) => candidate.original);

    if (!taskCandidates.length) {
      if (currentQty === 0) warnings.push(`UNFILLABLE: ${machine.name ?? machine.machine_code ?? machine.id}, lane ${stock.slot_code}: no compatible substitute in storage.`);
      continue;
    }

    if (mixReplaceNow && strongestAlternative) {
      // Approved merchandising changes appear in substitutions, not warnings.
    }

    tasks.push({
      taskId: `${machine.id}:${stock.slot_code}`,
      machineId: machine.id,
      machineName: machine.name ?? machine.machine_code ?? machine.id,
      locationName,
      locationType,
      machineSlotId: slot?.id ?? null,
      slotCode: stock.slot_code,
      currentProductId: product.id,
      currentProductName: product.name,
      currentQty,
      capacity,
      neededQty,
      allowSubstitution,
      transitionMode,
      returnCurrentQty: transitionMode === "replace_now" ? currentQty : 0,
      dailyVelocity,
      serviceIntervalDays,
      projectedQtyAtNextService,
      transitionFloorQty,
      candidates: taskCandidates,
    });
  }

  // Route-wide scarce-stock allocation is deterministic after AI reasoning. Put truly empty
  // lanes first so available substitutes cover sellable space before topping up lanes that
  // already contain product. Within the same urgency class, prioritize stronger local demand.
  tasks.sort((a, b) => {
    const priority = { empty_lane: 3, replace_now: 2, none: 1 } as const;
    const urgency = priority[b.transitionMode] - priority[a.transitionMode];
    if (urgency !== 0) return urgency;
    const aBest = a.candidates[0];
    const bBest = b.candidates[0];
    return (bBest?.machineSalesUnits ?? 0) - (aBest?.machineSalesUnits ?? 0)
      || (bBest?.machineDemandUnits ?? 0) - (aBest?.machineDemandUnits ?? 0)
      || b.dailyVelocity - a.dailyVelocity
      || a.machineName.localeCompare(b.machineName)
      || a.slotCode.localeCompare(b.slotCode, undefined, { numeric: true });
  });

  if (!tasks.length) {
    const generatedAt = new Date().toISOString();
    return {
      plannerMode: "deterministic_fallback",
      model: null,
      summary: "No refill lines could be generated from current verified XY stock and storage.",
      demandSource,
      manualStopItems: [],
      slotAssignments: [],
      substitutions: [],
      warnings: compactPlanWarnings(warnings),
      freshness: {
        xyOutcome: xyRefresh.outcome,
        latestStockAt,
        latestSalesAt,
        salesSyncOutcome: salesRefresh.outcome,
        generatedAt,
      },
    };
  }

  const aiResults: Array<Awaited<ReturnType<typeof callPlannerAI>>> = [];
  const proposed: AiDecision[] = [];
  const AI_TASK_BATCH_SIZE = 40;
  const MAX_AI_BATCHES = 2;
  const aiBatches: PlanTask[][] = [];
  for (let offset = 0; offset < tasks.length && aiBatches.length < MAX_AI_BATCHES; offset += AI_TASK_BATCH_SIZE) {
    aiBatches.push(tasks.slice(offset, offset + AI_TASK_BATCH_SIZE));
  }
  // AI may explain up to 80 top-priority lanes in parallel; all other lanes
  // still use the deterministic commercial optimizer. Never block the whole
  // route on a slow or unavailable language-model request.
  const batchResults = await Promise.all(aiBatches.map((batch) => callPlannerAI(batch)));
  batchResults.forEach((result, index) => {
    const batch = aiBatches[index];
    aiResults.push(result);
    if (result.warning) warnings.push("AI explanations were temporarily unavailable; the safe Smart Route optimizer completed the plan.");
    if (result.ok) {
      proposed.push(...result.decisions);
    } else {
      proposed.push(...batch.map(fallbackDecision).filter((row): row is AiDecision => Boolean(row)));
    }
  });
  const coveredByAI = aiBatches.length * AI_TASK_BATCH_SIZE;
  if (tasks.length > coveredByAI) {
    proposed.push(...tasks.slice(coveredByAI).map(fallbackDecision).filter((row): row is AiDecision => Boolean(row)));
  }

  const decisions = validateDecisions(tasks, proposed, availableByProduct, warnings);
  const slotAssignments = slotAssignmentItems(decisions);
  const manualStopItems = aggregateManualItems(decisions);
  const substitutions = decisions
    .filter((decision) => decision.substituted)
    .map((decision) => ({
      machineId: decision.machineId,
      slotCode: decision.slotCode,
      fromProductId: decision.currentProductId,
      fromProductName: decision.currentProductName,
      toProductId: decision.selectedProductId,
      toProductName: decision.selectedProductName,
      quantity: decision.quantity,
      reason: decision.reason,
      confidence: decision.confidence,
      transitionMode: decision.transitionMode === "replace_now" ? "replace_now" as const : "empty_lane" as const,
      returnCurrentQty: decision.returnCurrentQty,
      projectedQtyAtNextService: decision.projectedQtyAtNextService,
      transitionFloorQty: decision.transitionFloorQty,
    }));

  const successfulAiResults = aiResults.filter((result) => result.ok);
  const plannerMode = successfulAiResults.length ? "ai" as const : "deterministic_fallback" as const;
  const model = aiResults.find((result) => result.model)?.model ?? null;
  const generatedAt = new Date().toISOString();
  const aiSummaries = successfulAiResults
    .map((result) => result.summary.trim())
    .filter(Boolean)
    .slice(0, 3);
  const summary = plannerMode === "ai"
    ? (aiSummaries.join(" ") || `Smart plan generated ${manualStopItems.length} machine-product lines.`)
    : `Fallback smart plan generated ${manualStopItems.length} machine-product lines from verified XY, storage, fit, location, and demand rules.`;

  const auditPayload = {
    plannerMode,
    model,
    summary,
    demandSource,
    manualStopItems,
    slotAssignments,
    substitutions,
  };
  const { error: auditError } = await supabase.from("smart_route_plan_audits").insert({
    requested_by: input.requestedBy ?? null,
    route_date: input.routeDate,
    operator_id: input.operatorId || null,
    machine_ids: machineIds,
    planner_mode: plannerMode,
    model,
    demand_source: demandSource,
    data_freshness: {
      xy_outcome: xyRefresh.outcome,
      latest_stock_at: latestStockAt,
      latest_sales_at: latestSalesAt,
      sales_sync_outcome: salesRefresh.outcome,
      generated_at: generatedAt,
    },
    plan: auditPayload,
    warnings,
  });
  if (auditError) console.warn("[smart-route] Could not save plan audit", auditError);

  return {
    plannerMode,
    model,
    summary,
    demandSource,
    manualStopItems,
    slotAssignments,
    substitutions,
    warnings: compactPlanWarnings(warnings),
    freshness: {
      xyOutcome: xyRefresh.outcome,
      latestStockAt,
      latestSalesAt,
      salesSyncOutcome: salesRefresh.outcome,
      generatedAt,
    },
  };
}
