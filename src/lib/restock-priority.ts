export type RestockPriorityLevel = "high" | "normal" | "low";
export type RestockStatus = "out" | "critical" | "low" | "ok";
export type RestockSection = "critical" | "important" | "normal";
export type RestockFilter =
  | "focus"
  | "critical"
  | "low"
  | "fast"
  | "routes"
  | "machines"
  | "drinks"
  | "snacks"
  | "all";

export type RestockProductInput = {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  name: string;
  category?: string | null;
  brand?: string | null;
  active?: boolean | null;
  image_url?: string | null;
  current_cost_price_lyd?: number | string | null;
  last_purchase_cost_lyd?: number | string | null;
  average_cost_lyd?: number | string | null;
  last_purchase_date?: string | null;
  restock_priority?: string | null;
  min_storage_qty?: number | string | null;
  target_storage_qty?: number | string | null;
  reorder_point?: number | string | null;
  reorder_qty?: number | string | null;
};

export type RestockStorageRow = {
  product_id: string | null;
  product_name?: string | null;
  quantity_on_hand?: number | string | null;
};

export type RestockRecommendationRow = {
  product_id: string | null;
  product_name?: string | null;
  machine_id?: string | null;
  machine_name?: string | null;
  current_qty?: number | string | null;
  suggested_qty?: number | string | null;
  final_qty_to_take?: number | string | null;
  priority?: string | null;
};

export type RestockRouteNeedRow = {
  product_id: string | null;
  planned_qty?: number | string | null;
  picked_qty?: number | string | null;
  route_status?: string | null;
  route_date?: string | null;
};

export type RestockMachineSlotRow = {
  product_id: string | null;
  machine_id?: string | null;
  machine_name?: string | null;
  machine_code?: string | null;
  active?: boolean | null;
};

export type RestockVmsStockRow = {
  product_id: string | null;
  machine_id?: string | null;
  machine_name?: string | null;
  current_qty?: number | string | null;
  capacity?: number | string | null;
};

export type RestockSalesRow = {
  product_id: string | null;
  product_name?: string | null;
  sales_month?: string | null;
  units_sold?: number | string | null;
  stock_velocity_units_per_day?: number | string | null;
};

export type RestockPriorityItem = {
  productId: string;
  sku: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  imageUrl: string | null;
  manualPriority: RestockPriorityLevel;
  status: RestockStatus;
  section: RestockSection;
  priorityScore: number;
  storageQty: number;
  minStorageQty: number;
  targetStorageQty: number;
  reorderPoint: number;
  reorderQty: number;
  suggestedBuyQty: number;
  salesVelocity: number;
  unitsSold: number;
  machinesUsingCount: number;
  machinesNeedingCount: number;
  recommendedRefillQty: number;
  activeRouteNeedQty: number;
  lastPurchaseCost: number | null;
  lastPurchasedDate: string | null;
  machineNames: string[];
  machinesNeedingNames: string[];
  reasons: string[];
  isFastSeller: boolean;
  isDrink: boolean;
  isSnack: boolean;
  namePriorityRank: number;
};

export type RestockPriorityInput = {
  products: RestockProductInput[];
  storageRows?: RestockStorageRow[];
  recommendations?: RestockRecommendationRow[];
  routeNeeds?: RestockRouteNeedRow[];
  machineSlots?: RestockMachineSlotRow[];
  vmsStockRows?: RestockVmsStockRow[];
  salesRows?: RestockSalesRow[];
};

const reservationStatuses = new Set(["draft", "assigned", "in_progress", "pickup_confirmed"]);

function numberValue(value: unknown, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function wholeNumber(value: unknown, fallback = 0) {
  return Math.max(0, Math.floor(numberValue(value, fallback)));
}

function normalizePriority(value: unknown): RestockPriorityLevel {
  return value === "high" || value === "low" ? value : "normal";
}

function productText(product: Pick<RestockProductInput, "name" | "category" | "brand">) {
  return `${product.name ?? ""} ${product.category ?? ""} ${product.brand ?? ""}`.toLowerCase();
}

function namePriority(product: Pick<RestockProductInput, "name" | "category" | "brand">) {
  const text = productText(product);
  if (text.includes("mr crunch") || product.name?.includes("طربوش")) return { score: 34, rank: 0, label: "Snacky priority product" };
  if (text.includes("doritos")) return { score: 30, rank: 1, label: "Snacky priority product" };
  if (text.includes("water") || text.includes("مياه") || text.includes("pepsi")) return { score: 20, rank: 2, label: "Core drink" };
  if (text.includes("galaxy") || text.includes("snickers") || text.includes("twix")) return { score: 18, rank: 3, label: "Core chocolate" };
  return { score: 0, rank: 99, label: "" };
}

function productIsDrink(product: Pick<RestockProductInput, "name" | "category" | "brand">) {
  const text = productText(product);
  return ["drink", "water", "pepsi", "cola", "juice", "beverage", "مياه"].some((word) => text.includes(word));
}

function productIsSnack(product: Pick<RestockProductInput, "name" | "category" | "brand">) {
  const text = productText(product);
  return ["snack", "chips", "doritos", "biscuit", "chocolate", "galaxy", "snickers", "twix", "mr crunch"].some((word) => text.includes(word));
}

function addName(map: Map<string, Set<string>>, productId: string, name: string | null | undefined) {
  const clean = String(name ?? "").trim();
  if (!clean) return;
  if (!map.has(productId)) map.set(productId, new Set());
  map.get(productId)!.add(clean);
}

function activeRouteNeedQty(row: RestockRouteNeedRow) {
  if (!reservationStatuses.has(String(row.route_status ?? ""))) return 0;
  return Math.max(0, wholeNumber(row.planned_qty) - wholeNumber(row.picked_qty));
}

export function computeRestockPriority(input: RestockPriorityInput): RestockPriorityItem[] {
  const storageByProduct = new Map<string, number>();
  (input.storageRows ?? []).forEach((row) => {
    if (!row.product_id) return;
    storageByProduct.set(row.product_id, (storageByProduct.get(row.product_id) ?? 0) + numberValue(row.quantity_on_hand));
  });

  const refillQtyByProduct = new Map<string, number>();
  const machinesNeedingNames = new Map<string, Set<string>>();
  (input.recommendations ?? []).forEach((row) => {
    if (!row.product_id) return;
    const qty = Math.max(wholeNumber(row.final_qty_to_take), wholeNumber(row.suggested_qty));
    if (qty <= 0) return;
    refillQtyByProduct.set(row.product_id, (refillQtyByProduct.get(row.product_id) ?? 0) + qty);
    addName(machinesNeedingNames, row.product_id, row.machine_name);
  });

  const routeNeedByProduct = new Map<string, number>();
  (input.routeNeeds ?? []).forEach((row) => {
    if (!row.product_id) return;
    const qty = activeRouteNeedQty(row);
    if (qty <= 0) return;
    routeNeedByProduct.set(row.product_id, (routeNeedByProduct.get(row.product_id) ?? 0) + qty);
  });

  const machinesUsingNames = new Map<string, Set<string>>();
  (input.machineSlots ?? []).forEach((row) => {
    if (!row.product_id || row.active === false) return;
    addName(machinesUsingNames, row.product_id, row.machine_name ?? row.machine_code ?? row.machine_id);
  });

  const vmsMissingByProduct = new Map<string, number>();
  const vmsLowByProduct = new Map<string, number>();
  (input.vmsStockRows ?? []).forEach((row) => {
    if (!row.product_id) return;
    const currentQty = numberValue(row.current_qty);
    const capacity = numberValue(row.capacity);
    if (currentQty <= 0) {
      vmsMissingByProduct.set(row.product_id, (vmsMissingByProduct.get(row.product_id) ?? 0) + 1);
      addName(machinesNeedingNames, row.product_id, row.machine_name ?? row.machine_id);
    } else if (capacity > 0 && currentQty <= capacity * 0.25) {
      vmsLowByProduct.set(row.product_id, (vmsLowByProduct.get(row.product_id) ?? 0) + 1);
      addName(machinesNeedingNames, row.product_id, row.machine_name ?? row.machine_id);
    }
  });

  const salesByProduct = new Map<string, { velocity: number; unitsSold: number; month: string }>();
  (input.salesRows ?? []).forEach((row) => {
    if (!row.product_id) return;
    const velocity = Math.max(numberValue(row.stock_velocity_units_per_day), numberValue(row.units_sold) / 30);
    const unitsSold = wholeNumber(row.units_sold);
    const month = String(row.sales_month ?? "");
    const current = salesByProduct.get(row.product_id);
    if (!current || month > current.month || velocity > current.velocity) {
      salesByProduct.set(row.product_id, { velocity, unitsSold, month });
    }
  });

  return input.products
    .filter((product) => product.active !== false)
    .map((product) => {
      const manualPriority = normalizePriority(product.restock_priority);
      const storageQty = numberValue(storageByProduct.get(product.id));
      const minStorageQty = wholeNumber(product.min_storage_qty);
      const targetStorageQty = wholeNumber(product.target_storage_qty);
      const reorderPoint = wholeNumber(product.reorder_point);
      const reorderQty = wholeNumber(product.reorder_qty);
      const recommendedRefillQty = wholeNumber(refillQtyByProduct.get(product.id));
      const activeRouteNeedQtyValue = wholeNumber(routeNeedByProduct.get(product.id));
      const machineMissingCount = wholeNumber(vmsMissingByProduct.get(product.id));
      const machineLowCount = wholeNumber(vmsLowByProduct.get(product.id));
      const machineNames = Array.from(machinesUsingNames.get(product.id) ?? []).sort((a, b) => a.localeCompare(b));
      const machineNeedNames = Array.from(machinesNeedingNames.get(product.id) ?? []).sort((a, b) => a.localeCompare(b));
      const sales = salesByProduct.get(product.id) ?? { velocity: 0, unitsSold: 0, month: "" };
      const nameBoost = namePriority(product);
      const hasStoragePlan = minStorageQty > 0 || targetStorageQty > 0 || reorderPoint > 0 || reorderQty > 0 || manualPriority === "high";
      const effectiveReorderPoint = reorderPoint || minStorageQty;
      const effectiveTarget = targetStorageQty || Math.max(minStorageQty * 2, effectiveReorderPoint * 2, storageQty + reorderQty);
      const demandQty = Math.max(recommendedRefillQty, activeRouteNeedQtyValue);
      const suggestedBuyQty = Math.max(
        reorderQty,
        effectiveTarget > 0 ? effectiveTarget - storageQty : 0,
        demandQty - storageQty,
        hasStoragePlan && storageQty <= 0 && minStorageQty > 0 ? minStorageQty : 0,
        0,
      );

      const reasons: string[] = [];
      let score = 0;

      if (manualPriority === "high") {
        score += 35;
        reasons.push("Manual priority high");
      } else if (manualPriority === "low") {
        score -= 15;
        reasons.push("Manual priority low");
      }

      if (nameBoost.score) {
        score += nameBoost.score;
        reasons.push(nameBoost.label);
      }

      if (hasStoragePlan && storageQty <= 0) {
        score += 60;
        reasons.push("Out in storage");
      }
      if (minStorageQty > 0 && storageQty <= minStorageQty) {
        score += 45;
        reasons.push(`Storage ${storageQty} <= minimum ${minStorageQty}`);
      }
      if (effectiveReorderPoint > 0 && storageQty <= effectiveReorderPoint) {
        score += 30;
        reasons.push(`Storage ${storageQty} <= reorder point ${effectiveReorderPoint}`);
      }
      if (effectiveTarget > 0 && storageQty < effectiveTarget) {
        score += 10;
        reasons.push(`Below target ${effectiveTarget}`);
      }
      if (recommendedRefillQty > 0) {
        score += Math.min(35, recommendedRefillQty * 2);
        reasons.push(`Needed in refill recommendations: ${recommendedRefillQty}`);
      }
      if (activeRouteNeedQtyValue > 0) {
        score += Math.min(30, activeRouteNeedQtyValue * 2);
        reasons.push(`Needed for active/soon routes: ${activeRouteNeedQtyValue}`);
      }
      if (machineMissingCount > 0) {
        score += Math.min(30, machineMissingCount * 8);
        reasons.push(`VMS shows ${machineMissingCount} empty machine slot(s)`);
      }
      if (machineLowCount > 0) {
        score += Math.min(18, machineLowCount * 4);
        reasons.push(`VMS shows ${machineLowCount} low machine slot(s)`);
      }
      if (sales.velocity > 0) {
        score += Math.min(30, sales.velocity * 5);
        reasons.push(`Sales velocity ${sales.velocity.toFixed(1)} units/day`);
      }
      if (machineNames.length > 0) {
        score += Math.min(15, machineNames.length * 3);
        reasons.push(`Used in ${machineNames.length} machine(s)`);
      }

      let status: RestockStatus = "ok";
      if (storageQty <= 0 && (hasStoragePlan || demandQty > 0 || machineMissingCount > 0)) status = "out";
      else if (
        (minStorageQty > 0 && storageQty <= minStorageQty) ||
        (effectiveReorderPoint > 0 && storageQty <= effectiveReorderPoint && manualPriority === "high") ||
        (demandQty > 0 && storageQty < demandQty) ||
        machineMissingCount >= 2 ||
        score >= 75
      ) status = "critical";
      else if ((effectiveReorderPoint > 0 && storageQty <= effectiveReorderPoint) || (effectiveTarget > 0 && storageQty < effectiveTarget) || score >= 35) status = "low";

      if (status === "out") score = Math.max(score, 95);
      if (status === "critical") score = Math.max(score, 75);
      if (status === "low") score = Math.max(score, 40);

      const section: RestockSection = status === "out" || status === "critical" ? "critical" : status === "low" || manualPriority === "high" || score >= 45 ? "important" : "normal";
      const lastPurchaseCost = numberValue(product.last_purchase_cost_lyd ?? product.average_cost_lyd ?? product.current_cost_price_lyd, NaN);

      return {
        productId: product.id,
        sku: product.sku ?? null,
        name: product.name,
        category: product.category ?? null,
        brand: product.brand ?? null,
        imageUrl: product.image_url ?? null,
        manualPriority,
        status,
        section,
        priorityScore: Math.round(score),
        storageQty,
        minStorageQty,
        targetStorageQty,
        reorderPoint,
        reorderQty,
        suggestedBuyQty: Math.max(0, Math.ceil(suggestedBuyQty)),
        salesVelocity: sales.velocity,
        unitsSold: sales.unitsSold,
        machinesUsingCount: machineNames.length,
        machinesNeedingCount: machineNeedNames.length,
        recommendedRefillQty,
        activeRouteNeedQty: activeRouteNeedQtyValue,
        lastPurchaseCost: Number.isFinite(lastPurchaseCost) ? lastPurchaseCost : null,
        lastPurchasedDate: product.last_purchase_date ?? null,
        machineNames,
        machinesNeedingNames: machineNeedNames,
        reasons: reasons.length ? reasons : ["No restock signal"],
        isFastSeller: sales.velocity >= 1 || sales.unitsSold >= 30,
        isDrink: productIsDrink(product),
        isSnack: productIsSnack(product),
        namePriorityRank: nameBoost.rank,
      };
    })
    .sort((a, b) => {
      const sectionRank: Record<RestockSection, number> = { critical: 0, important: 1, normal: 2 };
      const statusRank: Record<RestockStatus, number> = { out: 0, critical: 1, low: 2, ok: 3 };
      return (
        sectionRank[a.section] - sectionRank[b.section] ||
        statusRank[a.status] - statusRank[b.status] ||
        b.priorityScore - a.priorityScore ||
        a.namePriorityRank - b.namePriorityRank ||
        a.name.localeCompare(b.name)
      );
    });
}

export function filterRestockItems(items: RestockPriorityItem[], filter: RestockFilter = "focus", query = "") {
  const normalizedQuery = query.trim().toLowerCase();
  return items.filter((item) => {
    const matchesQuery =
      !normalizedQuery ||
      [item.name, item.sku, item.category, item.brand].some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
    if (!matchesQuery) return false;
    if (filter === "all") return true;
    if (filter === "critical") return item.section === "critical";
    if (filter === "low") return item.status === "low";
    if (filter === "fast") return item.isFastSeller;
    if (filter === "routes") return item.activeRouteNeedQty > 0 || item.recommendedRefillQty > 0;
    if (filter === "machines") return item.machinesNeedingCount > 0;
    if (filter === "drinks") return item.isDrink;
    if (filter === "snacks") return item.isSnack;
    return item.section !== "normal";
  });
}

export function restockCounts(items: RestockPriorityItem[]) {
  return {
    critical: items.filter((item) => item.section === "critical").length,
    low: items.filter((item) => item.status === "low").length,
    important: items.filter((item) => item.section === "important").length,
    normal: items.filter((item) => item.section === "normal").length,
  };
}
