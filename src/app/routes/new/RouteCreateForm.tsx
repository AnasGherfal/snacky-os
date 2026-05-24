"use client";

import { Fragment, FormEvent, KeyboardEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormField, FormSection, SecondaryButton } from "@/components/ui";

type Operator = {
  id: string;
  full_name: string;
  role?: string | null;
};

type Machine = {
  id: string;
  name: string;
  machine_code: string;
};

type Recommendation = {
  recommendation_key: string;
  machine_slot_id: string | null;
  machine_id: string;
  machine_name: string;
  machine_code: string;
  slot_code: string | null;
  product_id: string;
  product_name: string;
  current_qty: number;
  capacity: number | null;
  par_qty: number | null;
  suggested_qty: number | null;
  available_storage_qty: number;
  final_qty_to_take: number | null;
  priority?: string | null;
};

type ProductPickOption = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  brand: string | null;
  imageUrl?: string | null;
  storageQty: number;
  availableQty: number;
};

type PlannedStock = {
  productId: string;
  quantity: number;
  available: number;
  recommendationQty: number;
  manualQty: number;
};

type StockValidationIssue = {
  product_id: string;
  product_name: string;
  selected_qty: number;
  available_qty: number;
  shortage_qty: number;
};

type RecommendationGroup = {
  groupKey: string;
  machineId: string;
  machineName: string;
  machineCode: string;
  productId: string;
  productName: string;
  recommendationKeys: string[];
  rows: Recommendation[];
  slotsCount: number;
  currentTotal: number;
  targetTotal: number;
  takeTotal: number;
  storageAvailable: number;
  priority: string;
};

type ManualStopItem = {
  machineId: string;
  productId: string;
  quantity: number;
};

const RECOMMENDATION_PAGE_SIZE = 50;
const priorityOrder = ["critical", "high", "medium", "low"] as const;
const priorityRank = new Map(priorityOrder.map((priority, index) => [priority, priorityOrder.length - index]));

function priorityScore(priority: string | null | undefined) {
  return priorityRank.get(String(priority ?? "low").toLowerCase() as (typeof priorityOrder)[number]) ?? 0;
}

function highestPriority(current: string | null | undefined, next: string | null | undefined) {
  const normalizedCurrent = String(current ?? "low").toLowerCase();
  const normalizedNext = String(next ?? "low").toLowerCase();
  return priorityScore(normalizedNext) > priorityScore(normalizedCurrent) ? normalizedNext : normalizedCurrent;
}

function recommendationQuantity(row: Recommendation) {
  return unitQuantity(row.final_qty_to_take ?? row.suggested_qty);
}

function recommendationTarget(row: Recommendation) {
  return unitQuantity(row.capacity ?? row.par_qty);
}

function formatRecommendationQty(value: number | null | undefined) {
  return value === null || value === undefined ? "Capacity missing" : value;
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function stockErrorMessage(issues: StockValidationIssue[]) {
  return [
    "These products exceed available storage stock:",
    ...issues.map((issue) => `- ${issue.product_name}: selected ${issue.selected_qty}, available ${issue.available_qty}, shortage ${issue.shortage_qty}`),
  ].join("\n");
}

export function RouteCreateForm({
  operators,
  machines,
  recommendations,
  products,
  recentProductIds,
  allowAdminOverride,
  defaultRouteDate,
}: {
  operators: Operator[];
  machines: Machine[];
  recommendations: Recommendation[];
  storageInventory: { product_id: string; product_name: string; quantity_on_hand: number }[];
  products: ProductPickOption[];
  recentProductIds: string[];
  allowAdminOverride: boolean;
  defaultRouteDate: string;
}) {
  const router = useRouter();
  const saveErrorRef = useRef<HTMLDivElement | null>(null);
  const [routeDate, setRouteDate] = useState(defaultRouteDate);
  const [assignmentMode, setAssignmentMode] = useState<"unassigned" | "assigned">("unassigned");
  const [operatorId, setOperatorId] = useState("");
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const [recommendationKeys, setRecommendationKeys] = useState<string[]>([]);
  const [finalTakeByRecommendationGroup, setFinalTakeByRecommendationGroup] = useState<Record<string, number>>({});
  const [manualStopItems, setManualStopItems] = useState<ManualStopItem[]>([]);
  const [manualMachineId, setManualMachineId] = useState("");
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [recommendationMachineFilter, setRecommendationMachineFilter] = useState("");
  const [recommendationPriorityFilter, setRecommendationPriorityFilter] = useState("");
  const [recommendationSearch, setRecommendationSearch] = useState("");
  const [showNoRefillNeeded, setShowNoRefillNeeded] = useState(false);
  const [expandedRecommendationGroups, setExpandedRecommendationGroups] = useState<string[]>([]);
  const [recommendationPage, setRecommendationPage] = useState(1);
  const [adminOverride, setAdminOverride] = useState(false);
  const [notFoundQuery, setNotFoundQuery] = useState("");
  const [error, setError] = useState("");
  const [stockErrors, setStockErrors] = useState<StockValidationIssue[]>([]);
  const [scrollErrorIntoView, setScrollErrorIntoView] = useState(false);
  const [saving, setSaving] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const deferredRecommendationSearch = useDeferredValue(recommendationSearch);

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const recommendationGroups = useMemo(() => {
    const groups = new Map<string, RecommendationGroup>();

    recommendations.forEach((row) => {
      const groupKey = `${row.machine_id}:${row.product_id}`;
      const product = productsById.get(row.product_id);
      const current = groups.get(groupKey) ?? {
        groupKey,
        machineId: row.machine_id,
        machineName: row.machine_name,
        machineCode: row.machine_code,
        productId: row.product_id,
        productName: row.product_name,
        recommendationKeys: [],
        rows: [],
        slotsCount: 0,
        currentTotal: 0,
        targetTotal: 0,
        takeTotal: 0,
        storageAvailable: unitQuantity(product?.availableQty ?? row.available_storage_qty),
        priority: "low",
      };

      current.recommendationKeys.push(row.recommendation_key);
      current.rows.push(row);
      current.currentTotal += unitQuantity(row.current_qty);
      current.targetTotal += recommendationTarget(row);
      current.takeTotal += recommendationQuantity(row);
      current.storageAvailable = unitQuantity(product?.availableQty ?? Math.max(current.storageAvailable, unitQuantity(row.available_storage_qty)));
      current.priority = highestPriority(current.priority, row.priority);
      groups.set(groupKey, current);
    });

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        slotsCount: new Set(group.rows.map((row) => row.machine_slot_id ?? row.slot_code ?? row.recommendation_key)).size,
        rows: [...group.rows].sort((a, b) => String(a.slot_code ?? "").localeCompare(String(b.slot_code ?? ""))),
      }))
      .sort((a, b) => {
        const priorityDifference = priorityScore(b.priority) - priorityScore(a.priority);
        if (priorityDifference) return priorityDifference;
        const machineDifference = a.machineName.localeCompare(b.machineName);
        if (machineDifference) return machineDifference;
        return a.productName.localeCompare(b.productName);
      });
  }, [productsById, recommendations]);

  const machineFilterOptions = useMemo(() => {
    const seen = new Set<string>();
    return recommendationGroups
      .filter((group) => {
        if (seen.has(group.machineId)) return false;
        seen.add(group.machineId);
        return true;
      })
      .map((group) => ({ id: group.machineId, label: `${group.machineName} (${group.machineCode})` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [recommendationGroups]);

  const filteredRecommendationGroups = useMemo(() => {
    const productSearch = deferredRecommendationSearch.trim().toLowerCase();
    return recommendationGroups.filter((group) => {
      if (!showNoRefillNeeded && group.takeTotal <= 0) return false;
      if (recommendationMachineFilter && group.machineId !== recommendationMachineFilter) return false;
      if (recommendationPriorityFilter && group.priority !== recommendationPriorityFilter) return false;
      if (productSearch && ![group.productName, group.machineName, group.machineCode].some((value) => value.toLowerCase().includes(productSearch))) return false;
      return true;
    });
  }, [deferredRecommendationSearch, recommendationGroups, recommendationMachineFilter, recommendationPriorityFilter, showNoRefillNeeded]);

  const totalRecommendationPages = Math.max(1, Math.ceil(filteredRecommendationGroups.length / RECOMMENDATION_PAGE_SIZE));
  const visibleRecommendationPage = Math.min(recommendationPage, totalRecommendationPages);
  const pagedRecommendationGroups = filteredRecommendationGroups.slice((visibleRecommendationPage - 1) * RECOMMENDATION_PAGE_SIZE, visibleRecommendationPage * RECOMMENDATION_PAGE_SIZE);

  useEffect(() => {
    if (!error || !scrollErrorIntoView) return;
    const errorElement = saveErrorRef.current;
    if (!errorElement) return;
    const rect = errorElement.getBoundingClientRect();
    const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
    if (!isVisible) errorElement.scrollIntoView({ behavior: "smooth", block: "center" });
    setScrollErrorIntoView(false);
  }, [error, scrollErrorIntoView]);

  const clampRecommendationFinalTake = useCallback((group: RecommendationGroup, value: number) => {
    const safeValue = unitQuantity(value);
    return adminOverride ? safeValue : Math.min(safeValue, unitQuantity(group.storageAvailable));
  }, [adminOverride]);

  const finalTakeForGroup = useCallback(
    (group: RecommendationGroup) => clampRecommendationFinalTake(group, finalTakeByRecommendationGroup[group.groupKey] ?? group.takeTotal),
    [clampRecommendationFinalTake, finalTakeByRecommendationGroup],
  );

  const selectedRecommendationGroups = useMemo(
    () => recommendationGroups.filter((group) => group.recommendationKeys.every((key) => recommendationKeys.includes(key))),
    [recommendationGroups, recommendationKeys],
  );

  const recommendationQtyByProduct = useMemo(() => {
    const quantities = new Map<string, number>();
    selectedRecommendationGroups
      .forEach((group) => {
        const quantity = finalTakeForGroup(group);
        quantities.set(group.productId, (quantities.get(group.productId) ?? 0) + unitQuantity(quantity));
      });
    return quantities;
  }, [selectedRecommendationGroups, finalTakeForGroup]);

  const plannedRouteStock = useMemo(() => {
    const manualQtyByProduct = new Map<string, number>();
    manualStopItems.forEach((item) => {
      const quantity = unitQuantity(item.quantity);
      if (quantity > 0) manualQtyByProduct.set(item.productId, (manualQtyByProduct.get(item.productId) ?? 0) + quantity);
    });
    const productIds = new Set([...Array.from(recommendationQtyByProduct.keys()), ...Array.from(manualQtyByProduct.keys())]);
    return Array.from(productIds)
      .map((productId): PlannedStock => {
        const product = productsById.get(productId);
        const recommendationQty = unitQuantity(recommendationQtyByProduct.get(productId));
        const manualQty = unitQuantity(manualQtyByProduct.get(productId));
        return {
          productId,
          quantity: recommendationQty + manualQty,
          available: unitQuantity(product?.availableQty),
          recommendationQty,
          manualQty,
        };
      })
      .filter((item) => item.quantity > 0);
  }, [productsById, recommendationQtyByProduct, manualStopItems]);

  const selectedProducts = useMemo(
    () =>
      plannedRouteStock.map((item) => ({
        ...item,
        product: productsById.get(item.productId),
      })),
    [plannedRouteStock, productsById],
  );

  const stockErrorByProduct = useMemo(() => new Map(stockErrors.map((issue) => [issue.product_id, issue])), [stockErrors]);

  const selectedRecommendationSummary = useMemo(() => {
    return selectedRecommendationGroups.reduce(
      (summary, group) => {
        summary.selectedProductsCount += 1;
        summary.totalRecommendedQty += group.takeTotal;
        summary.totalFinalTakeQty += finalTakeForGroup(group);
        return summary;
      },
      { selectedProductsCount: 0, totalRecommendedQty: 0, totalFinalTakeQty: 0 },
    );
  }, [selectedRecommendationGroups, finalTakeForGroup]);

  const selectedStopCount = useMemo(() => {
    const recommendedMachines = selectedRecommendationGroups.map((group) => group.machineId);
    return new Set([...machineIds, ...recommendedMachines]).size;
  }, [machineIds, selectedRecommendationGroups]);

  const recentProducts = useMemo(() => {
    const recent = recentProductIds.map((id) => productsById.get(id)).filter(Boolean) as ProductPickOption[];
    return recent.length ? recent.slice(0, 8) : products.slice(0, 8);
  }, [products, productsById, recentProductIds]);

  const searchResults = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) return recentProducts;
    return products
      .filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(query)))
      .slice(0, 12);
  }, [products, recentProducts, deferredSearch]);

  const toggleValue = (values: string[], value: string) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  const isRecommendationGroupSelected = (group: RecommendationGroup) => group.recommendationKeys.every((key) => recommendationKeys.includes(key));
  const recommendationGroupSelectable = (group: RecommendationGroup) => group.takeTotal > 0;
  const setRecommendationFinalTake = (group: RecommendationGroup, value: number) => {
    setFinalTakeByRecommendationGroup((current) => ({
      ...current,
      [group.groupKey]: clampRecommendationFinalTake(group, value),
    }));
  };
  const toggleRecommendationGroup = (group: RecommendationGroup) => {
    if (!recommendationGroupSelectable(group)) return;
    const selected = isRecommendationGroupSelected(group);
    if (selected) {
      setFinalTakeByRecommendationGroup((current) => {
        const next = { ...current };
        delete next[group.groupKey];
        return next;
      });
      setRecommendationKeys((current) => current.filter((key) => !group.recommendationKeys.includes(key)));
    } else {
      setFinalTakeByRecommendationGroup((finalTake) => ({
        ...finalTake,
        [group.groupKey]: group.takeTotal,
      }));
      setRecommendationKeys((current) => Array.from(new Set([...current, ...group.recommendationKeys])));
    }
  };
  const selectRecommendationGroups = (groups: RecommendationGroup[]) => {
    const selectableGroups = groups.filter(recommendationGroupSelectable);
    const keys = selectableGroups.flatMap((group) => group.recommendationKeys);
    setFinalTakeByRecommendationGroup((current) => {
      const next = { ...current };
      selectableGroups.forEach((group) => {
        if (next[group.groupKey] === undefined) next[group.groupKey] = group.takeTotal;
      });
      return next;
    });
    setRecommendationKeys((current) => Array.from(new Set([...current, ...keys])));
  };
  const clearSelectedRecommendations = () => {
    setRecommendationKeys([]);
    setFinalTakeByRecommendationGroup({});
  };

  const selectedManualMachineId = manualMachineId || machineIds[0] || "";

  const setManualStopQty = (machineId: string, productId: string, quantity: number) => {
    if (!machineId) {
      setError("Choose a machine stop before adding manual refill items.");
      return;
    }

    setManualStopItems((current) => {
      const next = current.filter((item) => !(item.machineId === machineId && item.productId === productId));
      const safeQuantity = unitQuantity(quantity);
      if (safeQuantity > 0) next.push({ machineId, productId, quantity: safeQuantity });
      return next;
    });
  };

  const setDesiredManualQty = (machineId: string, productId: string, desiredManual: number) => {
    const product = productsById.get(productId);
    const maxTotal = adminOverride ? Number.MAX_SAFE_INTEGER : unitQuantity(product?.availableQty);
    const safeTotal = Math.min(unitQuantity(desiredManual), maxTotal);
    setManualStopQty(machineId, productId, safeTotal);
  };

  const addProductQty = (productId: string, delta: number) => {
    const machineId = selectedManualMachineId;
    if (!machineId) {
      setError("Choose at least one machine stop before adding manual products.");
      return;
    }
    const currentQty = manualStopItems.find((item) => item.machineId === machineId && item.productId === productId)?.quantity ?? 0;
    setDesiredManualQty(machineId, productId, currentQty + delta);
  };

  const handleBarcodeSelect = () => {
    const query = barcode.trim().toLowerCase();
    if (!query) return;

    const product = products.find((item) => String(item.barcode ?? "").toLowerCase() === query || String(item.sku ?? "").toLowerCase() === query);
    if (!product) {
      setNotFoundQuery(barcode.trim());
      return;
    }

    setNotFoundQuery("");
    addProductQty(product.id, 1);
    setBarcode("");
  };

  const handleBarcodeKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleBarcodeSelect();
    }
  };

  const validateStock = () => {
    if (adminOverride) return [];
    const issues: StockValidationIssue[] = [];

    plannedRouteStock.forEach((item) => {
      const product = productsById.get(item.productId);
      const selectedQty = unitQuantity(item.quantity);
      const availableQty = unitQuantity(item.available);
      const shortageQty = Math.max(0, selectedQty - availableQty);

      if (selectedQty <= 0) return;

      console.info("[routes:new] Stock validation", {
        product_id: item.productId,
        product_name: product?.name ?? item.productId,
        selected_qty: selectedQty,
        available_storage_stock: availableQty,
        calculated_shortage: shortageQty,
        unit: "units",
      });

      if (shortageQty > 0) {
        issues.push({
          product_id: item.productId,
          product_name: product?.name ?? item.productId,
          selected_qty: selectedQty,
          available_qty: availableQty,
          shortage_qty: shortageQty,
        });
      }
    });

    return issues;
  };

  const validate = () => {
    if (!routeDate) return "Route date is required.";
    if (assignmentMode === "assigned" && !operatorId) return "Choose a route performer or leave this route unassigned.";
    if (!plannedRouteStock.length) return "Choose products to take from storage for this route.";
    const stockIssues = validateStock();
    if (stockIssues.length) return stockErrorMessage(stockIssues);
    return "";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    setStockErrors([]);
    const validationError = validate();
    if (validationError) {
      const localStockIssues = validateStock();
      if (localStockIssues.length) {
        console.warn("[routes:new] Stock validation failed", localStockIssues);
        setStockErrors(localStockIssues);
      }
      setScrollErrorIntoView(true);
      setError(validationError);
      return;
    }

    setSaving(true);
    setError("");

    try {
      const recommendationFinalTakeQty = selectedRecommendationGroups.map((group) => ({
        machineId: group.machineId,
        productId: group.productId,
        finalTakeQty: finalTakeForGroup(group),
      }));
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeDate, assignmentMode, operatorId: assignmentMode === "assigned" ? operatorId : "", machineIds, recommendationKeys, recommendationFinalTakeQty, manualStopItems, adminOverride }),
      });
      const result = await response.json().catch(() => ({ error: "Could not read the route creation response." }));

      if (!response.ok || !result.routeId) {
        const serverStockIssues = Array.isArray(result.stockErrors) ? result.stockErrors as StockValidationIssue[] : [];
        if (serverStockIssues.length) {
          console.warn("[routes:new] Server stock validation failed", serverStockIssues);
          setStockErrors(serverStockIssues);
        }
        throw new Error(result.error || "Could not create the route.");
      }

      window.sessionStorage.setItem("snacky-route-created", "Route created successfully.");
      router.replace(`/routes/${result.routeId}`);
    } catch (err) {
      setScrollErrorIntoView(true);
      setError(err instanceof Error ? err.message : "Could not create the route.");
      setSaving(false);
    }
  };

  const showMissingProduct = Boolean(notFoundQuery) || (Boolean(search.trim()) && searchResults.length === 0);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium whitespace-pre-line text-rose-800" role="alert" aria-live="assertive">
          {error}
        </div>
      ) : null}
      {error ? (
        <div className="fixed inset-x-3 bottom-3 z-50 max-h-[60vh] overflow-y-auto rounded-xl border border-rose-200 bg-white p-4 text-sm shadow-2xl md:left-auto md:right-4 md:w-[440px]" role="alert" aria-live="assertive">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold text-rose-800">Save failed</div>
              <div className="mt-1 whitespace-pre-line text-rose-700">{error}</div>
            </div>
            <button type="button" className="link-secondary shrink-0" onClick={() => setError("")}>Dismiss</button>
          </div>
        </div>
      ) : null}

      <FormSection title="Route overview">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Route date" required>
            <input type="date" value={routeDate} onChange={(event) => setRouteDate(event.target.value)} className="field-input" required disabled={saving} />
          </FormField>
          <FormField label="Assignment">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className={`rounded-lg border p-3 text-sm ${assignmentMode === "unassigned" ? "border-[var(--snacky-primary)] bg-emerald-50 text-slate-950" : "border-slate-200 bg-white text-slate-700"}`}>
                <input
                  type="radio"
                  name="assignment_mode"
                  value="unassigned"
                  checked={assignmentMode === "unassigned"}
                  onChange={() => {
                    setAssignmentMode("unassigned");
                    setOperatorId("");
                  }}
                  className="mr-2"
                  disabled={saving}
                />
                Leave unassigned
              </label>
              <label className={`rounded-lg border p-3 text-sm ${assignmentMode === "assigned" ? "border-[var(--snacky-primary)] bg-emerald-50 text-slate-950" : "border-slate-200 bg-white text-slate-700"}`}>
                <input
                  type="radio"
                  name="assignment_mode"
                  value="assigned"
                  checked={assignmentMode === "assigned"}
                  onChange={() => setAssignmentMode("assigned")}
                  className="mr-2"
                  disabled={saving}
                />
                Assign now
              </label>
            </div>
          </FormField>
          {assignmentMode === "assigned" ? (
            <FormField label="Route performer" required>
              <select value={operatorId} onChange={(event) => setOperatorId(event.target.value)} className="field-input" required disabled={saving}>
                <option value="">Select performer</option>
                {operators.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.full_name}{operator.role ? ` (${operator.role})` : ""}
                  </option>
                ))}
              </select>
            </FormField>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 md:col-span-2">
              This route will be available for an owner, admin, supervisor, or operator to claim when they start it.
            </div>
          )}
        </div>
      </FormSection>

      <FormSection title="Manual machine refill items">
        <p className="text-sm text-slate-500">Manual products must be assigned to a machine stop. The route pick list is calculated from these stop plans plus selected recommendations.</p>

        {!products.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No products are available. Add active products before creating a route pick list.
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
              <FormField label="Machine stop for manual items" required>
                <select
                  value={selectedManualMachineId}
                  onChange={(event) => {
                    setManualMachineId(event.target.value);
                    setMachineIds((current) => current.includes(event.target.value) ? current : [...current, event.target.value]);
                  }}
                  className="field-input"
                  disabled={saving}
                >
                  <option value="">Choose machine</option>
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>{machine.name} ({machine.machine_code})</option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
              <FormField label="Search products">
                <input
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    setNotFoundQuery("");
                  }}
                  placeholder="Search name, SKU, barcode, category, or brand"
                  className="field-input"
                  disabled={saving}
                />
              </FormField>
              <FormField label="Barcode / SKU scan">
                <div className="flex gap-2">
                  <input value={barcode} onChange={(event) => setBarcode(event.target.value)} onKeyDown={handleBarcodeKey} placeholder="Scan or type barcode" className="field-input" disabled={saving} />
                  <button type="button" onClick={handleBarcodeSelect} className="btn-secondary" disabled={saving}>
                    Add
                  </button>
                </div>
              </FormField>
            </div>

            {showMissingProduct ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <div className="font-semibold">Product not found</div>
                <p className="mt-1">Check the barcode, SKU, or product name before adding it to master data.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link className="btn-secondary" href="/products/new">
                    Add product
                  </Link>
                  <Link className="btn-secondary" href={`/issues?missing_product=${encodeURIComponent(notFoundQuery || search.trim())}`}>
                    Report missing product
                  </Link>
                </div>
              </div>
            ) : null}

            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-slate-800">{search.trim() ? "Search results" : "Recent / frequently used products"}</div>
                <div className="text-xs text-slate-500">Enter adds scanned products instantly.</div>
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {searchResults.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => addProductQty(product.id, 1)}
                    className="rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={saving || (!adminOverride && product.availableQty <= 0)}
                  >
                    <div className="flex gap-3">
                      <ProductThumbnail imageUrl={product.imageUrl} name={product.name} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium text-slate-900">{product.name}</div>
                        <div className="text-xs text-slate-500">
                          {product.sku ?? "No SKU"} - {product.category ?? "Uncategorized"} {product.brand ? `- ${product.brand}` : ""}
                        </div>
                        <div className="mt-1 text-xs text-slate-600">
                          Storage {product.storageQty} / Available {product.availableQty}
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {allowAdminOverride ? (
              <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <input type="checkbox" checked={adminOverride} onChange={(event) => setAdminOverride(event.target.checked)} className="mt-1" disabled={saving} />
                <span>
                  <span className="block font-semibold">Admin override</span>
                  Allow quantities above available storage for a supervised count correction.
                </span>
              </label>
            ) : null}

            <div className="overflow-x-auto rounded-xl border bg-white">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Machine</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Available storage qty</th>
                    <th className="px-3 py-2">Manual planned qty</th>
                    <th className="px-3 py-2">Remove</th>
                  </tr>
                </thead>
                <tbody>
                  {!manualStopItems.length ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                        No manual machine refill items selected yet.
                      </td>
                    </tr>
                  ) : (
                    manualStopItems.map((item) => {
                      const product = productsById.get(item.productId);
                      const machine = machines.find((row) => row.id === item.machineId);
                      const stockIssue = stockErrorByProduct.get(item.productId);
                      const available = stockIssue?.available_qty ?? unitQuantity(product?.availableQty);
                      const exceeds = Boolean(stockIssue) || unitQuantity(item.quantity) > available;
                      return (
                        <tr key={`${item.machineId}-${item.productId}`} className={`border-t border-slate-200 ${stockIssue ? "bg-rose-50" : ""}`}>
                          <td className="px-3 py-2">{machine?.name ?? "Unknown machine"}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-3">
                              <ProductThumbnail imageUrl={product?.imageUrl} name={product?.name} size="md" />
                              <div>
                                <div className="font-medium text-slate-900">{product?.name ?? "Unknown product"}</div>
                                <div className="text-xs text-slate-500">{product?.sku ?? "No SKU"}</div>
                                {stockIssue ? <div className="mt-1 text-xs font-medium text-rose-700">Short {stockIssue.shortage_qty} units across selected route plan.</div> : null}
                              </div>
                            </div>
                          </td>
                          <td className={`px-3 py-2 ${exceeds && !adminOverride ? "font-semibold text-rose-700" : ""}`}>{available}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              {[-1, 1, 5, 10].map((delta) => (
                                <button key={delta} type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setDesiredManualQty(item.machineId, item.productId, item.quantity + delta)} disabled={saving}>
                                  {delta > 0 ? `+${delta}` : delta}
                                </button>
                              ))}
                              <input
                                type="number"
                                min={0}
                                max={adminOverride ? undefined : available}
                                step={1}
                                value={item.quantity}
                                onChange={(event) => setDesiredManualQty(item.machineId, item.productId, Number(event.target.value) || 0)}
                                className={`field-input w-24 ${exceeds && !adminOverride ? "border-rose-300 bg-rose-50" : ""}`}
                                disabled={saving}
                              />
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => setManualStopQty(item.machineId, item.productId, 0)} className="link-secondary" disabled={saving}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </FormSection>

      <FormSection title="Refill recommendation rows">
        <p className="text-sm text-slate-500">Grouped by machine and product from the latest mapped VMS machine goods stock. Expand a row only when you need to review the underlying slots.</p>
        {!recommendationGroups.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No active refill recommendations found. You can still build the route manually above.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_180px]">
              <FormField label="Search product">
                <input
                  value={recommendationSearch}
                  onChange={(event) => {
                    setRecommendationSearch(event.target.value);
                    setRecommendationPage(1);
                  }}
                  placeholder="Search product or machine"
                  className="field-input"
                  disabled={saving}
                />
              </FormField>
              <FormField label="Machine">
                <select
                  value={recommendationMachineFilter}
                  onChange={(event) => {
                    setRecommendationMachineFilter(event.target.value);
                    setRecommendationPage(1);
                  }}
                  className="field-input"
                  disabled={saving}
                >
                  <option value="">All machines</option>
                  {machineFilterOptions.map((machine) => (
                    <option key={machine.id} value={machine.id}>{machine.label}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Priority">
                <select
                  value={recommendationPriorityFilter}
                  onChange={(event) => {
                    setRecommendationPriorityFilter(event.target.value);
                    setRecommendationPage(1);
                  }}
                  className="field-input"
                  disabled={saving}
                >
                  <option value="">All priorities</option>
                  {priorityOrder.map((priority) => (
                    <option key={priority} value={priority}>{priority}</option>
                  ))}
                </select>
              </FormField>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-secondary text-xs" onClick={() => selectRecommendationGroups(recommendationGroups.filter((group) => group.priority === "critical"))} disabled={saving}>
                Select all critical
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={() => selectRecommendationGroups(recommendationGroups.filter((group) => group.priority === "critical" || group.priority === "high"))} disabled={saving}>
                Select all high + critical
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={() => selectRecommendationGroups(filteredRecommendationGroups)} disabled={saving}>
                Select all visible
              </button>
              <button type="button" className="btn-secondary text-xs" onClick={clearSelectedRecommendations} disabled={saving || !recommendationKeys.length}>
                Clear selected
              </button>
              <label className="ml-auto flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={showNoRefillNeeded}
                  onChange={(event) => {
                    setShowNoRefillNeeded(event.target.checked);
                    setRecommendationPage(1);
                  }}
                  disabled={saving}
                />
                <span>Show rows with no refill needed</span>
              </label>
            </div>

            <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 md:grid-cols-3">
              <div>Selected products: <span className="font-semibold text-slate-900">{selectedRecommendationSummary.selectedProductsCount}</span></div>
              <div>Total recommended: <span className="font-semibold text-slate-900">{selectedRecommendationSummary.totalRecommendedQty}</span></div>
              <div>Total final take: <span className="font-semibold text-slate-900">{selectedRecommendationSummary.totalFinalTakeQty}</span></div>
            </div>

            <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2" />
                    <th className="px-3 py-2">Machine</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">Slots count</th>
                    <th className="px-3 py-2">Current total</th>
                    <th className="px-3 py-2">Target total</th>
                    <th className="px-3 py-2">Recommended take</th>
                    <th className="px-3 py-2">Final Take</th>
                    <th className="px-3 py-2">Storage</th>
                    <th className="px-3 py-2">Priority</th>
                    <th className="px-3 py-2">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {!filteredRecommendationGroups.length ? (
                    <tr>
                      <td colSpan={11} className="px-3 py-8 text-center text-slate-500">
                        No grouped recommendation rows match the current filters.
                      </td>
                    </tr>
                  ) : (
                    pagedRecommendationGroups.map((group) => {
                      const selected = isRecommendationGroupSelected(group);
                      const expanded = expandedRecommendationGroups.includes(group.groupKey);
                      const selectable = recommendationGroupSelectable(group);
                      const finalTake = finalTakeForGroup(group);
                      const finalExceedsStorage = finalTake > group.storageAvailable;
                      const finalIsZero = selected && finalTake === 0;
                      const finalHigherThanRecommended = selected && finalTake > group.takeTotal;
                      const finalLowerThanRecommended = selected && finalTake > 0 && finalTake < group.takeTotal;
                      const stockIssue = selected ? stockErrorByProduct.get(group.productId) : undefined;
                      const storageAvailable = stockIssue?.available_qty ?? unitQuantity(group.storageAvailable);
                      const showStockIssue = Boolean(stockIssue);

                      return (
                        <Fragment key={group.groupKey}>
                          <tr className={`border-t border-slate-200 ${stockIssue ? "bg-rose-50" : ""}`}>
                            <td className="px-3 py-2">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => toggleRecommendationGroup(group)}
                                className="h-4 w-4"
                                disabled={saving || !selectable}
                                title={!selectable ? "No refill quantity is needed for this grouped recommendation." : undefined}
                              />
                            </td>
                            <td className="px-3 py-2 font-medium">
                              <div>{group.machineName}</div>
                              <div className="text-xs font-normal text-slate-500">{group.machineCode}</div>
                            </td>
                            <td className="px-3 py-2">{group.productName}</td>
                            <td className="px-3 py-2">{group.slotsCount}</td>
                            <td className="px-3 py-2">{group.currentTotal}</td>
                            <td className="px-3 py-2">{group.targetTotal}</td>
                            <td className="px-3 py-2 font-semibold text-slate-900">{group.takeTotal}</td>
                            <td className="min-w-[260px] px-3 py-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  type="number"
                                  min={0}
                                  max={adminOverride ? undefined : storageAvailable}
                                  step={1}
                                  value={finalTake}
                                  onChange={(event) => setRecommendationFinalTake(group, Number(event.target.value) || 0)}
                                  className={`field-input w-24 ${(finalExceedsStorage || showStockIssue) && !adminOverride ? "border-rose-300 bg-rose-50" : ""}`}
                                  disabled={saving || !selected}
                                  aria-label={`Final take for ${group.productName} at ${group.machineName}`}
                                />
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, group.takeTotal)} disabled={saving || !selected}>Use recommended</button>
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, Math.ceil(group.takeTotal / 2))} disabled={saving || !selected}>Take half</button>
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, storageAvailable)} disabled={saving || !selected}>Take max available</button>
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, 0)} disabled={saving || !selected}>Clear</button>
                              </div>
                              {finalIsZero ? <div className="mt-1 text-xs font-medium text-amber-700">Final take is 0.</div> : null}
                              {finalHigherThanRecommended ? <div className="mt-1 text-xs font-medium text-amber-700">Final take is higher than recommended.</div> : null}
                              {finalLowerThanRecommended ? <div className="mt-1 text-xs text-slate-500">Taking less than recommended.</div> : null}
                              {stockIssue ? <div className="mt-1 text-xs font-medium text-rose-700">Selected {stockIssue.selected_qty}, available {stockIssue.available_qty}, shortage {stockIssue.shortage_qty}.</div> : null}
                            </td>
                            <td className={`px-3 py-2 ${(finalExceedsStorage || showStockIssue) && !adminOverride ? "font-semibold text-rose-700" : ""}`}>{storageAvailable}</td>
                            <td className="px-3 py-2">{group.priority}</td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                className="link-secondary"
                                onClick={() => setExpandedRecommendationGroups((current) => toggleValue(current, group.groupKey))}
                              >
                                {expanded ? "Hide" : "Expand"}
                              </button>
                            </td>
                          </tr>
                          {expanded ? (
                            <tr className="border-t border-slate-200 bg-slate-50">
                              <td colSpan={11} className="px-3 py-3">
                                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                                  <table className="min-w-full text-left text-xs">
                                    <thead className="bg-slate-50 text-slate-500">
                                      <tr>
                                        <th className="px-3 py-2">Slot</th>
                                        <th className="px-3 py-2">Current</th>
                                        <th className="px-3 py-2">Target</th>
                                        <th className="px-3 py-2">Recommended take</th>
                                        <th className="px-3 py-2">Priority</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {group.rows.map((row) => (
                                        <tr key={row.recommendation_key} className="border-t border-slate-100">
                                          <td className="px-3 py-2">{row.slot_code || "VMS item"}</td>
                                          <td className="px-3 py-2">{row.current_qty}</td>
                                          <td className="px-3 py-2">{formatRecommendationQty(row.capacity ?? row.par_qty)}</td>
                                          <td className="px-3 py-2 font-semibold">{recommendationQuantity(row)}</td>
                                          <td className="px-3 py-2">{row.priority ?? "-"}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {filteredRecommendationGroups.length > RECOMMENDATION_PAGE_SIZE ? (
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
                <div>
                  Showing {(visibleRecommendationPage - 1) * RECOMMENDATION_PAGE_SIZE + 1}-{Math.min(visibleRecommendationPage * RECOMMENDATION_PAGE_SIZE, filteredRecommendationGroups.length)} of {filteredRecommendationGroups.length}
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary" onClick={() => setRecommendationPage((page) => Math.max(1, page - 1))} disabled={saving || visibleRecommendationPage <= 1}>
                    Previous
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => setRecommendationPage((page) => Math.min(totalRecommendationPages, page + 1))} disabled={saving || visibleRecommendationPage >= totalRecommendationPages}>
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </FormSection>

      <FormSection title="Add machine stops manually">
        <p className="text-sm text-slate-500">Choose machines that should be included in the route even if there is no recommendation row.</p>
        {!machines.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            No active machines found. Create a machine first.
          </div>
        ) : (
          <div className="grid gap-2">
            {machines.map((machine) => (
              <label key={machine.id} className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm hover:border-slate-400">
                <input
                  type="checkbox"
                  checked={machineIds.includes(machine.id)}
                  onChange={() => setMachineIds((current) => toggleValue(current, machine.id))}
                  className="h-4 w-4"
                  disabled={saving}
                />
                <span>
                  {machine.name} <span className="text-slate-500">({machine.machine_code})</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </FormSection>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        Selected stops: <span className="font-semibold text-slate-900">{selectedStopCount}</span>
        <span className="mx-2 text-slate-300">/</span>
        Route pick-list products: <span className="font-semibold text-slate-900">{selectedProducts.length}</span>
      </div>

      {error ? (
        <div ref={saveErrorRef} className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium whitespace-pre-line text-rose-800" role="alert" aria-live="assertive">
          {error}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row">
        <button type="submit" className="btn-primary disabled:cursor-not-allowed disabled:opacity-60" disabled={saving}>
          {saving ? "Creating route..." : "Create route"}
        </button>
        <SecondaryButton href="/routes">Cancel</SecondaryButton>
      </div>
    </form>
  );
}
