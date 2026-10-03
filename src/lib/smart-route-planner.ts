import "server-only";

import { ROUTE_RESERVATION_STATUSES } from "@/lib/route-workflow";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { ensureFreshXyRoutePlanningData } from "@/lib/xy-vms-sync";

type SupabaseAdmin = NonNullable<ReturnType<typeof getSupabaseAdminClient>>;

type SmartPlanInput = {
  machineIds: string[];
  routeDate: string;
  operatorId?: string | null;
  requestedBy?: string | null;
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
  neededQty: number;
  substituted: boolean;
};

export type SmartRoutePlanItem = {
  machineId: string;
  productId: string;
  quantity: number;
  machineSlotId: string | null;
  slotCode: string | null;
  source: "smart_ai_plan";
  notes: string | null;
};

export type SmartRoutePlanResult = {
  plannerMode: "ai" | "deterministic_fallback";
  model: string | null;
  summary: string;
  demandSource: "xy_stock_depletion";
  manualStopItems: SmartRoutePlanItem[];
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
  }>;
  warnings: string[];
  freshness: {
    xyOutcome: string;
    latestStockAt: string | null;
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

function candidateScore({
  original,
  historicallySeen,
  explicitAllowed,
  locationRule,
  machineDemand,
  typeDemand,
  networkDemand,
  recentFill,
  sameBrand,
}: {
  original: boolean;
  historicallySeen: boolean;
  explicitAllowed: boolean;
  locationRule: LocationRuleRow | null;
  machineDemand: number;
  typeDemand: number;
  networkDemand: number;
  recentFill: number;
  sameBrand: boolean;
}) {
  let score = original ? 70 : 0;
  if (historicallySeen) score += 24;
  if (explicitAllowed) score += 30;
  if (sameBrand) score += 8;
  if (locationRule?.rule === "preferred") score += 30;
  if (locationRule?.rule === "avoid") score -= 35;
  score += signed(locationRule?.score_adjustment);
  score += Math.log1p(machineDemand) * 18;
  score += Math.log1p(typeDemand) * 8;
  score += Math.log1p(networkDemand) * 3;
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
      original: candidate.original,
    })),
  }));

  const prompt = [
    "You are Snacky OS smart route planner.",
    "Choose exactly one candidate product for each refill task when at least one candidate is useful.",
    "Never invent a product ID and never exceed neededQty or candidate availableUnits.",
    "The candidate list is already filtered by storage, physical fit, and location hard rules.",
    "Prefer keeping the original product when it is sufficiently available and has reasonable local demand.",
    "If the original is unavailable and the lane is empty, choose the strongest compatible substitute using exact-machine demand first, then same location type, then network demand and route history.",
    "Respect preferred/avoid location signals. Avoid low-confidence novelty when a proven-fit seller exists.",
    "Give short operational reasons. Do not create routes or reserve stock; this is only a review draft.",
    JSON.stringify({ tasks: compactTasks }),
  ].join("\n");

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
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
  const original = task.candidates.find((candidate) => candidate.original && candidate.availableUnits > 0);
  const selected = original ?? task.candidates[0] ?? null;
  if (!selected) return null;
  return {
    taskId: task.taskId,
    selectedProductId: selected.productId,
    quantity: Math.min(task.neededQty, selected.availableUnits),
    reason: original
      ? "Kept the current product and limited the quantity to verified unreserved storage."
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

    if (!candidate) {
      if (proposedDecision) warnings.push(`Ignored invalid AI product choice for ${task.machineName} slot ${task.slotCode}.`);
      decision = fallbackDecision(task) ?? undefined;
      candidate = decision ? task.candidates.find((row) => row.productId === decision?.selectedProductId) ?? null : null;
    }
    if (!decision || !candidate) {
      warnings.push(`No compatible in-stock product is available for ${task.machineName} slot ${task.slotCode} (${task.currentProductName}).`);
      continue;
    }

    const available = Math.max(0, remaining.get(candidate.productId) ?? 0);
    const requested = units(decision.quantity);
    const quantity = Math.min(task.neededQty, requested || task.neededQty, available);
    if (quantity <= 0) {
      warnings.push(`${candidate.productName} became unavailable after allocating other stops; skipped ${task.machineName} slot ${task.slotCode}.`);
      continue;
    }
    if (quantity < requested) {
      warnings.push(`Clamped ${candidate.productName} at ${task.machineName} slot ${task.slotCode} from ${requested} to ${quantity} because only ${available} unreserved units remained.`);
    }

    const substituted = candidate.productId !== task.currentProductId;
    if (substituted && !task.allowSubstitution) {
      warnings.push(`Blocked substitution in non-empty ${task.machineName} slot ${task.slotCode}; kept the existing product unchanged.`);
      const original = task.candidates.find((row) => row.original);
      if (!original) continue;
      const originalAvailable = Math.max(0, remaining.get(original.productId) ?? 0);
      const originalQty = Math.min(task.neededQty, originalAvailable);
      if (originalQty <= 0) continue;
      remaining.set(original.productId, originalAvailable - originalQty);
      validated.push({
        ...decision,
        selectedProductId: original.productId,
        selectedProductName: original.productName,
        quantity: originalQty,
        machineId: task.machineId,
        machineSlotId: task.machineSlotId,
        slotCode: task.slotCode,
        currentProductId: task.currentProductId,
        currentProductName: task.currentProductName,
        neededQty: task.neededQty,
        substituted: false,
        reason: "Substitution blocked because the lane still contains the current product.",
      });
      continue;
    }

    remaining.set(candidate.productId, available - quantity);
    validated.push({
      ...decision,
      selectedProductId: candidate.productId,
      selectedProductName: candidate.productName,
      quantity,
      machineId: task.machineId,
      machineSlotId: task.machineSlotId,
      slotCode: task.slotCode,
      currentProductId: task.currentProductId,
      currentProductName: task.currentProductName,
      neededQty: task.neededQty,
      substituted,
    });
  }

  return validated;
}

function aggregateManualItems(decisions: ValidatedDecision[]): SmartRoutePlanItem[] {
  const grouped = new Map<string, {
    machineId: string;
    productId: string;
    quantity: number;
    machineSlotIds: Set<string>;
    slotCodes: Set<string>;
    notes: string[];
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
    };
    current.quantity += decision.quantity;
    if (decision.machineSlotId) current.machineSlotIds.add(decision.machineSlotId);
    if (decision.slotCode) current.slotCodes.add(decision.slotCode);
    if (decision.substituted) {
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
  }));
}

export async function generateSmartRoutePlan(input: SmartPlanInput): Promise<SmartRoutePlanResult> {
  const supabase = getSupabaseAdminClient();
  if (!supabase) throw new Error("Supabase is not configured.");

  const machineIds = Array.from(new Set(input.machineIds.map(String).filter(Boolean)));
  if (!machineIds.length) throw new Error("Choose at least one machine before generating a smart plan.");

  const xyRefresh = await ensureFreshXyRoutePlanningData();
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
    supabase.rpc("snacky_smart_route_slot_fit_history", { p_machine_ids: machineIds, p_days: 180 }),
    supabase.from("route_stop_fill_lines").select("machine_id, product_id, actual_qty, created_at").in("machine_id", machineIds).gte("created_at", recentFillSince),
  ]);

  const failures = [
    ["machines", machinesResult.error],
    ["XY stock", stockResult.error],
    ["machine slots", slotsResult.error],
    ["products", productsResult.error],
    ["storage", storageResult.error],
    ["reservations", reservationsResult.error],
    ["reserving route statuses", reservingRoutesResult.error],
    ["product profiles", profilesResult.error],
    ["machine context", machineContextResult.error],
    ["slot rules", slotRulesResult.error],
    ["location rules", locationRulesResult.error],
    ["demand signals", demandResult.error],
    ["fit history", fitHistoryResult.error],
  ].filter((entry) => entry[1]);

  if (failures.length) {
    throw new Error(`Smart planning data is incomplete: ${failures.map(([label, error]) => `${label}: ${(error as { message?: string })?.message ?? "unknown error"}`).join("; ")}`);
  }

  const warnings: string[] = [];
  if (refillHistoryResult.error) warnings.push("Past route-fill history could not be loaded; demand ranking used XY stock depletion only.");

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
  const recentFill = routeFillMap((refillHistoryResult.data ?? []) as Array<{ machine_id?: string | null; product_id?: string | null; actual_qty?: unknown }>);

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
    if (!routeId || !reservingRouteIds.has(routeId)) return;
    const productId = String(row.product_id ?? "");
    if (!productId) return;
    reservedByProduct.set(productId, (reservedByProduct.get(productId) ?? 0) + Math.max(0, units(row.planned_qty) - units(row.picked_qty)));
  });
  const availableByProduct = new Map<string, number>();
  products.forEach((product) => availableByProduct.set(product.id, Math.max(0, units(storageByProduct.get(product.id)) - units(reservedByProduct.get(product.id)))));

  const slotByKey = new Map(((slotsResult.data ?? []) as MachineSlotRow[]).map((slot) => [`${slot.machine_id}:${slot.slot_code}`, slot]));
  const tasks: PlanTask[] = [];
  let latestStockAt: string | null = null;

  for (const stock of (stockResult.data ?? []) as StockRow[]) {
    if (!stock.machine_id || !stock.slot_code || !stock.product_id) continue;
    const product = productById.get(stock.product_id);
    const machine = machineById.get(stock.machine_id);
    if (!product || !machine) continue;

    const currentQty = units(stock.current_qty);
    const capacity = units(stock.capacity) || units(slotByKey.get(`${stock.machine_id}:${stock.slot_code}`)?.capacity);
    const neededQty = Math.max(0, capacity - currentQty);
    if (neededQty <= 0 || capacity <= 0) continue;
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
    const allowSubstitution = currentQty === 0;

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
          if (!allowSubstitution) return null;
          if (currentGroup && candidateGroup !== currentGroup && !explicitAllowed) return null;
          if (!explicitAllowed && candidateFit !== currentFit) return null;
        }

        const rule = locationRuleFor(locationRules, machine.id, locationId, locationType, candidate.id);
        if (rule?.rule === "prohibited") return null;

        const machineDemand = demand.machine.get(`${machine.id}:${candidate.id}`) ?? 0;
        const typeDemand = locationType ? demand.locationType.get(`${locationType}:${candidate.id}`) ?? 0 : 0;
        const networkDemand = demand.network.get(candidate.id) ?? 0;
        const fills = recentFill.get(`${machine.id}:${candidate.id}`) ?? 0;
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
            historicallySeen,
            explicitAllowed,
            locationRule: rule,
            machineDemand,
            typeDemand,
            networkDemand,
            recentFill: fills,
            sameBrand,
          }),
          fitProfile: candidateFit,
          fitEvidence,
          locationRule: rule?.rule ?? null,
          machineDemandUnits: machineDemand,
          locationTypeDemandUnits: typeDemand,
          networkDemandUnits: networkDemand,
          recentRouteFillUnits: fills,
          original,
        };
      })
      .filter((row): row is Candidate => Boolean(row))
      .sort((a, b) => {
        if (a.original !== b.original && (availableByProduct.get(product.id) ?? 0) >= Math.min(neededQty, Math.ceil(capacity * 0.5))) {
          return a.original ? -1 : 1;
        }
        return b.score - a.score || b.availableUnits - a.availableUnits || a.productName.localeCompare(b.productName);
      })
      .slice(0, 10);

    if (!candidates.length) {
      warnings.push(`No verified in-stock compatible product is available for ${machine.name ?? machine.machine_code ?? machine.id} slot ${stock.slot_code} (${product.name}).`);
      continue;
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
      candidates,
    });
  }

  if (!tasks.length) {
    const generatedAt = new Date().toISOString();
    return {
      plannerMode: "deterministic_fallback",
      model: null,
      summary: "No refill lines could be generated from current verified XY stock and storage.",
      demandSource: "xy_stock_depletion",
      manualStopItems: [],
      substitutions: [],
      warnings,
      freshness: { xyOutcome: xyRefresh.outcome, latestStockAt, generatedAt },
    };
  }

  const ai = await callPlannerAI(tasks);
  if (ai.warning) warnings.push(ai.warning);
  const proposed = ai.ok ? ai.decisions : tasks.map(fallbackDecision).filter((row): row is AiDecision => Boolean(row));
  const decisions = validateDecisions(tasks, proposed, availableByProduct, warnings);
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
    }));

  const plannerMode = ai.ok ? "ai" as const : "deterministic_fallback" as const;
  const generatedAt = new Date().toISOString();
  const summary = ai.ok
    ? ai.summary || `Smart plan generated ${manualStopItems.length} machine-product lines.`
    : `Fallback smart plan generated ${manualStopItems.length} machine-product lines from verified XY, storage, fit, location, and demand rules.`;

  const auditPayload = {
    plannerMode,
    model: ai.model,
    summary,
    demandSource: "xy_stock_depletion",
    manualStopItems,
    substitutions,
  };
  const { error: auditError } = await supabase.from("smart_route_plan_audits").insert({
    requested_by: input.requestedBy ?? null,
    route_date: input.routeDate,
    operator_id: input.operatorId || null,
    machine_ids: machineIds,
    planner_mode: plannerMode,
    model: ai.model,
    demand_source: "xy_stock_depletion",
    data_freshness: { xy_outcome: xyRefresh.outcome, latest_stock_at: latestStockAt, generated_at: generatedAt },
    plan: auditPayload,
    warnings,
  });
  if (auditError) console.warn("[smart-route] Could not save plan audit", auditError);

  return {
    plannerMode,
    model: ai.model,
    summary,
    demandSource: "xy_stock_depletion",
    manualStopItems,
    substitutions,
    warnings: Array.from(new Set(warnings)),
    freshness: {
      xyOutcome: xyRefresh.outcome,
      latestStockAt,
      generatedAt,
    },
  };
}
