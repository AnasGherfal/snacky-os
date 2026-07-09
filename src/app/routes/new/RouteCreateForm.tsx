"use client";

import { Fragment, FormEvent, KeyboardEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { DraftRestoreBanner, DraftSaveStatus, useDraftKey, useLocalDraft } from "@/components/LocalDraft";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RouteRecommendationDiagnostics } from "@/app/routes/new/types";
import { FormField, FormSection, SecondaryButton } from "@/components/ui";
import { useLanguage } from "@/components/I18nProvider";
import { formatMachineDisplayName } from "@/lib/machine-site-display";
import { comparePickupProductRows, groupRouteItemsForDisplay } from "@/lib/route-pickup-checklist";

type Operator = {
  id: string;
  full_name: string;
  role?: string | null;
};

type Machine = {
  id: string;
  name: string;
  machine_display_name?: string | null;
  machine_code: string;
  location_name?: string | null;
};

type MachinePlanogramRow = {
  id: string;
  machine_id: string;
  slot_code: string | null;
  product_id: string | null;
  par_qty: number | null;
  min_qty: number | null;
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
  source_file_name?: string | null;
  source_uploaded_at?: string | null;
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
  locationName: string | null;
  productId: string;
  productName: string;
  productCategory: string | null;
  recommendationKeys: string[];
  rows: Recommendation[];
  slotsCount: number;
  currentTotal: number;
  targetTotal: number;
  recommendedTotal: number;
  defaultFinalTakeTotal: number;
  storageAvailable: number;
  storageKnown: boolean;
  priority: string;
};

type ManualStopItem = {
  machineId: string;
  productId: string;
  quantity: number;
};

type RouteCreateDraft = {
  routeDate: string;
  assignmentMode: "unassigned" | "assigned";
  operatorId: string;
  machineIds: string[];
  recommendationKeys: string[];
  finalTakeByRecommendationGroup: Record<string, number>;
  manualStopItems: ManualStopItem[];
  manualMachineId: string;
  search: string;
  barcode: string;
  recommendationMachineFilter: string;
  recommendationPriorityFilter: string;
  recommendationSearch: string;
  showNoRefillNeeded: boolean;
  expandedRecommendationGroups: string[];
  recommendationPage: number;
  adminOverride: boolean;
  notFoundQuery: string;
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
  return unitQuantity(row.suggested_qty);
}

function recommendationTarget(row: Recommendation) {
  return unitQuantity(row.capacity ?? row.par_qty);
}

function formatRecommendationQty(value: number | null | undefined) {
  return value === null || value === undefined ? "Capacity missing" : value;
}

function locationLabel(value: string | null | undefined) {
  return String(value ?? "").trim() || "No location";
}

function machineLabel(machine: Machine | null | undefined) {
  if (!machine) return "Unknown machine";
  return formatMachineDisplayName(machine, { includeArea: true });
}

function recommendationReasonSummary(group: RecommendationGroup) {
  const reasons: string[] = [];
  if (group.currentTotal <= 0) reasons.push("Machine is empty");
  if (group.currentTotal > 0 && group.currentTotal < group.targetTotal) reasons.push(`Current ${group.currentTotal} is below target ${group.targetTotal}`);
  if (group.rows.some((row) => String(row.priority ?? "").toLowerCase() === "critical")) reasons.push("At least one slot is critical");
  if (group.rows.some((row) => String(row.priority ?? "").toLowerCase() === "high")) reasons.push("At least one slot is below minimum");
  if (group.slotsCount > 1) reasons.push(`Spread across ${group.slotsCount} slots`);
  return reasons.length ? reasons.slice(0, 2).join(" - ") : `Refill up to ${group.targetTotal} units`;
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

function productMatchesSearch(product: ProductPickOption, query: string) {
  return [product.name, product.sku, product.barcode, product.category, product.brand]
    .some((value) => String(value ?? "").toLowerCase().includes(query));
}

function hasKnownStorage(value: unknown) {
  return value !== null && value !== undefined && Number.isFinite(Number(value));
}

function defaultRecommendationFinalTake(recommendedTotal: number, storageAvailable: number, storageKnown: boolean) {
  if (!storageKnown) return recommendedTotal;
  if (storageAvailable <= 0) return recommendedTotal;
  return Math.min(recommendedTotal, storageAvailable);
}

function tr(locale: "ar" | "en", en: string, ar: string) {
  return locale === "ar" ? ar : en;
}

export function RouteCreateForm({
  operators,
  machines,
  recommendations,
  diagnostics,
  machinePlanogramRows,
  products,
  recentProductIds,
  allowAdminOverride,
  defaultRouteDate,
}: {
  operators: Operator[];
  machines: Machine[];
  recommendations: Recommendation[];
  diagnostics: RouteRecommendationDiagnostics;
  machinePlanogramRows: MachinePlanogramRow[];
  storageInventory: { product_id: string; product_name: string; quantity_on_hand: number }[];
  products: ProductPickOption[];
  recentProductIds: string[];
  allowAdminOverride: boolean;
  defaultRouteDate: string;
  }) {
  const router = useRouter();
  const { locale } = useLanguage();
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
  const [expandedRecommendationFamilyKeys, setExpandedRecommendationFamilyKeys] = useState<Record<string, boolean>>({});
  const [recommendationPage, setRecommendationPage] = useState(1);
  const [adminOverride, setAdminOverride] = useState(false);
  const [notFoundQuery, setNotFoundQuery] = useState("");
  const [error, setError] = useState("");
  const [stockErrors, setStockErrors] = useState<StockValidationIssue[]>([]);
  const [scrollErrorIntoView, setScrollErrorIntoView] = useState(false);
  const [saving, setSaving] = useState(false);
  const deferredSearch = useDeferredValue(search);
  const deferredRecommendationSearch = useDeferredValue(recommendationSearch);
  const draftKey = useDraftKey("route", ["new"]);

  const routeDraft = useMemo<RouteCreateDraft>(() => ({
    routeDate,
    assignmentMode,
    operatorId,
    machineIds,
    recommendationKeys,
    finalTakeByRecommendationGroup,
    manualStopItems,
    manualMachineId,
    search,
    barcode,
    recommendationMachineFilter,
    recommendationPriorityFilter,
    recommendationSearch,
    showNoRefillNeeded,
    expandedRecommendationGroups,
    recommendationPage,
    adminOverride,
    notFoundQuery,
  }), [
    adminOverride,
    assignmentMode,
    barcode,
    expandedRecommendationGroups,
    finalTakeByRecommendationGroup,
    machineIds,
    manualMachineId,
    manualStopItems,
    notFoundQuery,
    operatorId,
    recommendationKeys,
    recommendationMachineFilter,
    recommendationPage,
    recommendationPriorityFilter,
    recommendationSearch,
    routeDate,
    search,
    showNoRefillNeeded,
  ]);

  const shouldSaveRouteDraft = useCallback((draft: RouteCreateDraft) => {
    return Boolean(
      draft.routeDate !== defaultRouteDate ||
        draft.assignmentMode !== "unassigned" ||
        draft.operatorId ||
        draft.machineIds.length ||
        draft.recommendationKeys.length ||
        Object.keys(draft.finalTakeByRecommendationGroup).length ||
        draft.manualStopItems.length ||
        draft.manualMachineId ||
        draft.search ||
        draft.barcode ||
        draft.recommendationMachineFilter ||
        draft.recommendationPriorityFilter ||
        draft.recommendationSearch ||
        draft.showNoRefillNeeded ||
        draft.expandedRecommendationGroups.length ||
        draft.recommendationPage !== 1 ||
        draft.adminOverride ||
        draft.notFoundQuery
    );
  }, [defaultRouteDate]);

  const localDraft = useLocalDraft<RouteCreateDraft>({
    key: draftKey,
    value: routeDraft,
    shouldSave: shouldSaveRouteDraft,
    onRestore: (draft) => {
      setRouteDate(draft.routeDate || defaultRouteDate);
      setAssignmentMode(draft.assignmentMode === "assigned" ? "assigned" : "unassigned");
      setOperatorId(draft.operatorId ?? "");
      setMachineIds(Array.isArray(draft.machineIds) ? draft.machineIds : []);
      setRecommendationKeys(Array.isArray(draft.recommendationKeys) ? draft.recommendationKeys : []);
      setFinalTakeByRecommendationGroup(draft.finalTakeByRecommendationGroup ?? {});
      setManualStopItems(Array.isArray(draft.manualStopItems) ? draft.manualStopItems : []);
      setManualMachineId(draft.manualMachineId ?? "");
      setSearch(draft.search ?? "");
      setBarcode(draft.barcode ?? "");
      setRecommendationMachineFilter(draft.recommendationMachineFilter ?? "");
      setRecommendationPriorityFilter(draft.recommendationPriorityFilter ?? "");
      setRecommendationSearch(draft.recommendationSearch ?? "");
      setShowNoRefillNeeded(Boolean(draft.showNoRefillNeeded));
      setExpandedRecommendationGroups(Array.isArray(draft.expandedRecommendationGroups) ? draft.expandedRecommendationGroups : []);
      setRecommendationPage(Math.max(1, Number(draft.recommendationPage ?? 1)));
      setAdminOverride(Boolean(draft.adminOverride));
      setNotFoundQuery(draft.notFoundQuery ?? "");
    },
  });

  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const machinesById = useMemo(() => new Map(machines.map((machine) => [machine.id, machine])), [machines]);

  const recommendationGroups = useMemo(() => {
    const groups = new Map<string, RecommendationGroup>();

    recommendations.forEach((row) => {
      const groupKey = `${row.machine_id}:${row.product_id}`;
      const product = productsById.get(row.product_id);
      const machine = machinesById.get(row.machine_id);
      const current = groups.get(groupKey) ?? {
        groupKey,
        machineId: row.machine_id,
        machineName: row.machine_name,
        machineCode: row.machine_code,
        locationName: machine?.location_name ?? null,
        productId: row.product_id,
        productName: row.product_name,
        productCategory: product?.category ?? null,
        recommendationKeys: [],
        rows: [],
        slotsCount: 0,
        currentTotal: 0,
        targetTotal: 0,
        recommendedTotal: 0,
        defaultFinalTakeTotal: 0,
        storageAvailable: unitQuantity(product?.availableQty ?? row.available_storage_qty),
        storageKnown: typeof product?.availableQty === "number" || hasKnownStorage(row.available_storage_qty),
        priority: "low",
      };

      current.recommendationKeys.push(row.recommendation_key);
      current.rows.push(row);
      current.currentTotal += unitQuantity(row.current_qty);
      current.targetTotal += recommendationTarget(row);
      current.recommendedTotal += recommendationQuantity(row);
      current.storageAvailable = unitQuantity(product?.availableQty ?? Math.max(current.storageAvailable, unitQuantity(row.available_storage_qty)));
      current.storageKnown = current.storageKnown || typeof product?.availableQty === "number" || hasKnownStorage(row.available_storage_qty);
      current.priority = highestPriority(current.priority, row.priority);
      groups.set(groupKey, current);
    });

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        defaultFinalTakeTotal: defaultRecommendationFinalTake(group.recommendedTotal, unitQuantity(group.storageAvailable), group.storageKnown),
        slotsCount: new Set(group.rows.map((row) => row.machine_slot_id ?? row.slot_code ?? row.recommendation_key)).size,
        rows: [...group.rows].sort((a, b) => String(a.slot_code ?? "").localeCompare(String(b.slot_code ?? ""))),
      }))
      .sort((a, b) => {
        const locationDifference = locationLabel(a.locationName).localeCompare(locationLabel(b.locationName));
        if (locationDifference) return locationDifference;
        const machineDifference = a.machineName.localeCompare(b.machineName);
        if (machineDifference) return machineDifference;
        const productDifference = comparePickupProductRows(
          { productName: a.productName, productCategory: a.productCategory, productBrand: productsById.get(a.productId)?.brand ?? null },
          { productName: b.productName, productCategory: b.productCategory, productBrand: productsById.get(b.productId)?.brand ?? null },
        );
        if (productDifference) return productDifference;
        return priorityScore(b.priority) - priorityScore(a.priority);
      });
  }, [machinesById, productsById, recommendations]);

  const machineFilterOptions = useMemo(() => {
    const seen = new Set<string>();
    return recommendationGroups
      .filter((group) => {
        if (seen.has(group.machineId)) return false;
        seen.add(group.machineId);
        return true;
      })
      .map((group) => ({ id: group.machineId, label: `${group.machineName} - ${locationLabel(group.locationName)}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [recommendationGroups]);
  const machineDiagnosticsById = useMemo(
    () => new Map(diagnostics.machineDiagnostics.map((machine) => [machine.machineId, machine])),
    [diagnostics.machineDiagnostics],
  );

  const filteredRecommendationGroups = useMemo(() => {
    const productSearch = deferredRecommendationSearch.trim().toLowerCase();
    return recommendationGroups.filter((group) => {
      if (!showNoRefillNeeded && group.recommendedTotal <= 0) return false;
      if (recommendationMachineFilter && group.machineId !== recommendationMachineFilter) return false;
      if (recommendationPriorityFilter && group.priority !== recommendationPriorityFilter) return false;
      if (productSearch && ![group.productName, group.machineName, group.machineCode].some((value) => value.toLowerCase().includes(productSearch))) return false;
      return true;
    });
  }, [deferredRecommendationSearch, recommendationGroups, recommendationMachineFilter, recommendationPriorityFilter, showNoRefillNeeded]);
  const recommendationEmptyMessage = useMemo(() => {
    if (!recommendationGroups.length) return diagnostics.summaryMessage;
    if (filteredRecommendationGroups.length) return "";
    if (recommendationMachineFilter) {
      const machineDiagnostic = machineDiagnosticsById.get(recommendationMachineFilter);
      if (machineDiagnostic) return machineDiagnostic.reasonMessage;
    }
    if (!showNoRefillNeeded && recommendationGroups.every((group) => group.recommendedTotal <= 0)) {
      return "No recommendations because current stock is already full. Turn on \"Show rows with no refill needed\" to inspect the latest snapshot rows.";
    }
    return "No grouped recommendation rows match the current filters.";
  }, [diagnostics.summaryMessage, filteredRecommendationGroups.length, machineDiagnosticsById, recommendationGroups, recommendationMachineFilter, showNoRefillNeeded]);

  const totalRecommendationPages = Math.max(1, Math.ceil(filteredRecommendationGroups.length / RECOMMENDATION_PAGE_SIZE));
  const visibleRecommendationPage = Math.min(recommendationPage, totalRecommendationPages);
  const pagedRecommendationGroups = filteredRecommendationGroups.slice((visibleRecommendationPage - 1) * RECOMMENDATION_PAGE_SIZE, visibleRecommendationPage * RECOMMENDATION_PAGE_SIZE);
  const mobileRecommendationGroups = useMemo(
    () =>
      groupRouteItemsForDisplay(
        pagedRecommendationGroups.map((group) => ({
          ...group,
          productBrand: productsById.get(group.productId)?.brand ?? null,
          quantity: group.recommendedTotal,
          checked: group.recommendationKeys.every((key) => recommendationKeys.includes(key)),
          sortKey: `${locationLabel(group.locationName)}|${group.machineName}|${group.machineCode}|${group.productName}|${group.groupKey}`,
        })),
      ),
    [pagedRecommendationGroups, productsById, recommendationKeys],
  );

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
    if (adminOverride) return safeValue;
    if (!group.storageKnown || unitQuantity(group.storageAvailable) <= 0) return safeValue;
    return Math.min(safeValue, unitQuantity(group.storageAvailable));
  }, [adminOverride]);

  const finalTakeForGroup = useCallback(
    (group: RecommendationGroup) => clampRecommendationFinalTake(group, finalTakeByRecommendationGroup[group.groupKey] ?? group.defaultFinalTakeTotal),
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
        summary.totalRecommendedQty += group.recommendedTotal;
        summary.totalFinalTakeQty += finalTakeForGroup(group);
        return summary;
      },
      { selectedProductsCount: 0, totalRecommendedQty: 0, totalFinalTakeQty: 0 },
    );
  }, [selectedRecommendationGroups, finalTakeForGroup]);

  const filteredRecommendationSummary = useMemo(() => {
    const summary = filteredRecommendationGroups.reduce(
      (current, group) => {
        current.locationNames.add(locationLabel(group.locationName));
        current.machineIds.add(group.machineId);
        if (group.recommendedTotal > 0) current.refillGroups += 1;
        const shortage = Math.max(0, group.recommendedTotal - unitQuantity(group.storageAvailable));
        if (shortage > 0) {
          current.shortageGroups += 1;
          current.shortageUnits += shortage;
        }
        return current;
      },
      {
        locationNames: new Set<string>(),
        machineIds: new Set<string>(),
        refillGroups: 0,
        shortageGroups: 0,
        shortageUnits: 0,
      },
    );

    return {
      locationCount: summary.locationNames.size,
      machineCount: summary.machineIds.size,
      refillGroups: summary.refillGroups,
      shortageGroups: summary.shortageGroups,
      shortageUnits: summary.shortageUnits,
    };
  }, [filteredRecommendationGroups]);

  const selectedStopCount = useMemo(() => {
    const recommendedMachines = selectedRecommendationGroups.map((group) => group.machineId);
    return new Set([...machineIds, ...recommendedMachines]).size;
  }, [machineIds, selectedRecommendationGroups]);

  const machinePlanogramRowsByMachine = useMemo(() => {
    const rowsByMachine = new Map<string, MachinePlanogramRow[]>();
    machinePlanogramRows.forEach((row) => {
      const machineId = String(row.machine_id ?? "").trim();
      if (!machineId) return;
      rowsByMachine.set(machineId, [...(rowsByMachine.get(machineId) ?? []), row]);
    });
    return rowsByMachine;
  }, [machinePlanogramRows]);

  const recommendationGroupsByMachine = useMemo(() => {
    const groupsByMachine = new Map<string, RecommendationGroup[]>();
    recommendationGroups.forEach((group) => {
      groupsByMachine.set(group.machineId, [...(groupsByMachine.get(group.machineId) ?? []), group]);
    });
    return groupsByMachine;
  }, [recommendationGroups]);

  const manualItemsByMachine = useMemo(() => {
    const itemsByMachine = new Map<string, ManualStopItem[]>();
    manualStopItems.forEach((item) => {
      itemsByMachine.set(item.machineId, [...(itemsByMachine.get(item.machineId) ?? []), item]);
    });
    return itemsByMachine;
  }, [manualStopItems]);

  const manualSectionMachineIds = useMemo(() => {
    const visibleMachineIds = new Set<string>();
    machineIds.forEach((machineId) => {
      if (machineId) visibleMachineIds.add(machineId);
    });
    selectedRecommendationGroups.forEach((group) => {
      if (group.machineId) visibleMachineIds.add(group.machineId);
    });
    manualStopItems.forEach((item) => {
      if (item.machineId) visibleMachineIds.add(item.machineId);
    });
    if (manualMachineId) visibleMachineIds.add(manualMachineId);

    return machines
      .map((machine) => machine.id)
      .filter((machineId) => visibleMachineIds.has(machineId));
  }, [machineIds, machines, manualMachineId, manualStopItems, selectedRecommendationGroups]);

  const selectedManualMachineId = manualMachineId || manualSectionMachineIds[0] || machineIds[0] || "";
  const selectedManualMachine = selectedManualMachineId ? machinesById.get(selectedManualMachineId) ?? null : null;
  const selectedManualPlanogramRows = useMemo(
    () => (selectedManualMachineId ? (machinePlanogramRowsByMachine.get(selectedManualMachineId) ?? []) : []),
    [machinePlanogramRowsByMachine, selectedManualMachineId],
  );
  const selectedManualRecommendationGroups = useMemo(
    () => (selectedManualMachineId ? (recommendationGroupsByMachine.get(selectedManualMachineId) ?? []) : []),
    [recommendationGroupsByMachine, selectedManualMachineId],
  );
  const selectedManualItems = useMemo(
    () => (selectedManualMachineId ? (manualItemsByMachine.get(selectedManualMachineId) ?? []) : []),
    [manualItemsByMachine, selectedManualMachineId],
  );
  const manualSearchQuery = deferredSearch.trim().toLowerCase();

  const machineScopedProductCandidates = useMemo(() => {
    const candidates = new Map<string, {
      product: ProductPickOption;
      selectedQty: number;
      recommendedQty: number;
      sourceKinds: Set<string>;
      slotCodes: Set<string>;
    }>();
    const ensureCandidate = (productId: string) => {
      const product = productsById.get(productId);
      if (!product) return null;
      const existing = candidates.get(productId);
      if (existing) return existing;
      const next = {
        product,
        selectedQty: 0,
        recommendedQty: 0,
        sourceKinds: new Set<string>(),
        slotCodes: new Set<string>(),
      };
      candidates.set(productId, next);
      return next;
    };

    selectedManualPlanogramRows.forEach((row) => {
      const productId = String(row.product_id ?? "").trim();
      if (!productId) return;
      const candidate = ensureCandidate(productId);
      if (!candidate) return;
      candidate.sourceKinds.add("planogram");
      const slotCode = String(row.slot_code ?? "").trim();
      if (slotCode) candidate.slotCodes.add(slotCode);
    });

    selectedManualRecommendationGroups.forEach((group) => {
      const candidate = ensureCandidate(group.productId);
      if (!candidate) return;
      candidate.sourceKinds.add("recommendation");
      candidate.recommendedQty += group.recommendedTotal;
      group.rows.forEach((row) => {
        const slotCode = String(row.slot_code ?? "").trim();
        if (slotCode) candidate.slotCodes.add(slotCode);
      });
    });

    selectedManualItems.forEach((item) => {
      const candidate = ensureCandidate(item.productId);
      if (!candidate) return;
      candidate.sourceKinds.add("selected");
      candidate.selectedQty = item.quantity;
    });

    return Array.from(candidates.values())
      .sort((a, b) => {
        const selectedDifference = b.selectedQty - a.selectedQty;
        if (selectedDifference) return selectedDifference;
        const recommendationDifference = b.recommendedQty - a.recommendedQty;
        if (recommendationDifference) return recommendationDifference;
        const planogramDifference = Number(b.sourceKinds.has("planogram")) - Number(a.sourceKinds.has("planogram"));
        if (planogramDifference) return planogramDifference;
        return comparePickupProductRows(
          { productName: a.product.name, productCategory: a.product.category, productBrand: a.product.brand },
          { productName: b.product.name, productCategory: b.product.category, productBrand: b.product.brand },
        );
      });
  }, [productsById, selectedManualItems, selectedManualPlanogramRows, selectedManualRecommendationGroups]);

  const machineScopedProductIds = useMemo(
    () => new Set(machineScopedProductCandidates.map((candidate) => candidate.product.id)),
    [machineScopedProductCandidates],
  );

  const recentFallbackProducts = useMemo(
    () => recentProductIds.map((id) => productsById.get(id)).filter(Boolean) as ProductPickOption[],
    [productsById, recentProductIds],
  );

  const machineScopedSearchResults = useMemo(() => {
    const filtered = manualSearchQuery
      ? machineScopedProductCandidates.filter((candidate) => productMatchesSearch(candidate.product, manualSearchQuery))
      : machineScopedProductCandidates;
    return [...filtered].slice(0, manualSearchQuery ? 18 : 12);
  }, [machineScopedProductCandidates, manualSearchQuery]);

  const machineFallbackProducts = useMemo(() => {
    const fallbackSource = products.filter((product) => {
      if (machineScopedProductIds.has(product.id)) return false;
      if (!adminOverride && product.availableQty <= 0 && product.storageQty <= 0) return false;
      return true;
    });
    if (manualSearchQuery) {
      return fallbackSource
        .filter((product) => productMatchesSearch(product, manualSearchQuery))
        .sort((a, b) => comparePickupProductRows(
          { productName: a.name, productCategory: a.category, productBrand: a.brand },
          { productName: b.name, productCategory: b.category, productBrand: b.brand },
        ) || b.availableQty - a.availableQty || a.name.localeCompare(b.name))
        .slice(0, 18);
    }

    const recent = recentFallbackProducts.filter((product) => !machineScopedProductIds.has(product.id));
    const recentIds = new Set(recent.map((product) => product.id));
    const remaining = fallbackSource
      .filter((product) => !recentIds.has(product.id))
      .sort((a, b) => comparePickupProductRows(
        { productName: a.name, productCategory: a.category, productBrand: a.brand },
        { productName: b.name, productCategory: b.category, productBrand: b.brand },
      ) || b.availableQty - a.availableQty || a.name.localeCompare(b.name));
    return [...recent, ...remaining].slice(0, 12);
  }, [adminOverride, machineScopedProductIds, manualSearchQuery, products, recentFallbackProducts]);

  const toggleValue = (values: string[], value: string) => (values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  const toggleRecommendationFamily = (groupKey: string, defaultExpanded = false) => {
    setExpandedRecommendationFamilyKeys((current) => ({
      ...current,
      [groupKey]: !(current[groupKey] ?? defaultExpanded),
    }));
  };
  const isRecommendationGroupSelected = (group: RecommendationGroup) => group.recommendationKeys.every((key) => recommendationKeys.includes(key));
  const recommendationGroupSelectable = (group: RecommendationGroup) => group.recommendedTotal > 0;
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
        [group.groupKey]: group.defaultFinalTakeTotal,
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
        if (next[group.groupKey] === undefined) next[group.groupKey] = group.defaultFinalTakeTotal;
      });
      return next;
    });
    setRecommendationKeys((current) => Array.from(new Set([...current, ...keys])));
  };
  const clearSelectedRecommendations = () => {
    setRecommendationKeys([]);
    setFinalTakeByRecommendationGroup({});
  };

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

    const product = products.find((item) => (
      String(item.barcode ?? "").toLowerCase() === query
      || String(item.sku ?? "").toLowerCase() === query
    ));
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

  const showMissingProduct = Boolean(notFoundQuery)
    || (Boolean(search.trim()) && selectedManualMachineId !== "" && machineScopedSearchResults.length === 0 && machineFallbackProducts.length === 0);

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
    if (!plannedRouteStock.length) {
      if (selectedRecommendationGroups.some((group) => group.recommendedTotal > 0)) {
        return "Selected recommendations still need stock, but the current final take is 0. Replenish storage, adjust final take, or use admin override.";
      }
      return "Choose products to take from storage for this route.";
    }
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
      localDraft.clearDraft();
      router.replace(`/routes/${result.routeId}`);
    } catch (err) {
      setScrollErrorIntoView(true);
      setError(err instanceof Error ? err.message : "Could not create the route.");
      setSaving(false);
    }
  };

  const sortedManualStopItems = useMemo(
    () => [...manualStopItems].sort((a, b) => {
        const machineDifference = machineLabel(machinesById.get(a.machineId)).localeCompare(machineLabel(machinesById.get(b.machineId)));
      if (machineDifference) return machineDifference;
      return comparePickupProductRows(
        {
          productName: String(productsById.get(a.productId)?.name ?? ""),
          productCategory: productsById.get(a.productId)?.category ?? null,
          productBrand: productsById.get(a.productId)?.brand ?? null,
        },
        {
          productName: String(productsById.get(b.productId)?.name ?? ""),
          productCategory: productsById.get(b.productId)?.category ?? null,
          productBrand: productsById.get(b.productId)?.brand ?? null,
        },
      );
    }),
    [machinesById, manualStopItems, productsById],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <DraftRestoreBanner pendingDraft={localDraft.pendingDraft} onRestore={localDraft.restoreDraft} onDiscard={localDraft.discardDraft} />
      {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}
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
                <option value="">{tr(locale, "Select performer", "اختر المنفذ")}</option>
                {operators.map((operator) => (
                  <option key={operator.id} value={operator.id}>
                    {operator.full_name}{operator.role ? ` (${operator.role})` : ""}
                  </option>
                ))}
              </select>
            </FormField>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 md:col-span-2">
              {tr(locale, "This route will be available for an owner, admin, supervisor, or operator to claim when they start it.", "ستكون هذه الجولة متاحة للمالك أو المدير أو المشرف أو المشغل ليستلمها عند البدء.")}
            </div>
          )}
        </div>
      </FormSection>

      <FormSection title="Manual machine refill items">
        <p className="text-sm text-slate-500">{tr(locale, "Manual products must be assigned to a machine stop. The route pick list is calculated from these stop plans plus selected recommendations.", "يجب ربط المنتجات اليدوية بموقع جهاز. تُحسب قائمة التحميل من خطط المواقع هذه بالإضافة إلى التوصيات المختارة.")}</p>

        {!products.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            {tr(locale, "No products are available. Add active products before creating a route pick list.", "لا توجد منتجات متاحة. أضف منتجات نشطة قبل إنشاء قائمة تحميل للجولة.")}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
              <FormField label="Add or focus a machine stop" required>
                <select
                  value={selectedManualMachineId}
                  onChange={(event) => {
                    setManualMachineId(event.target.value);
                    setMachineIds((current) => current.includes(event.target.value) ? current : [...current, event.target.value]);
                  }}
                  className="field-input"
                  disabled={saving}
                >
                  <option value="">{tr(locale, "Choose machine", "اختر الجهاز")}</option>
                  {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>{machineLabel(machine)} - {locationLabel(machine.location_name)}</option>
                  ))}
                </select>
              </FormField>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                {tr(locale, "Manual stop sections:", "أقسام المواقع اليدوية:")} <span className="font-semibold text-slate-900">{manualSectionMachineIds.length}</span>
                <div className="mt-1 text-xs text-slate-500">
                  {tr(locale, "Each machine stop keeps its own product picker so Snacky OS does not mix products across machines.", "كل موقع جهاز يحتفظ بقائمة منتجاته الخاصة حتى لا يخلط Snacky OS المنتجات بين الأجهزة.")}
                </div>
              </div>
            </div>

            {manualSectionMachineIds.length ? (
              <div className="flex flex-wrap gap-2">
                {manualSectionMachineIds.map((machineId) => {
                  const machine = machinesById.get(machineId);
                  if (!machine) return null;
                  const selected = machineId === selectedManualMachineId;
                  const machineManualCount = manualItemsByMachine.get(machineId)?.length ?? 0;
                  const machineRecommendedCount = recommendationGroupsByMachine.get(machineId)?.length ?? 0;
                  return (
                    <button
                      key={machineId}
                      type="button"
                      onClick={() => setManualMachineId(machineId)}
                      className={`rounded-full border px-3 py-2 text-left text-sm transition ${selected ? "border-[var(--snacky-primary)] bg-emerald-50 text-slate-950" : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"}`}
                    >
                      <div className="font-medium">{machineLabel(machine)}</div>
                      <div className="text-xs text-slate-500">{machine.machine_code} - Manual {machineManualCount} - Recommended {machineRecommendedCount}</div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                Choose a machine stop to load its manual picker. The product list will stay scoped to that machine only.
              </div>
            )}

            {selectedManualMachine ? (
              <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr(locale, "Machine stop", "موقع الجهاز")}</div>
                    <div className="mt-1 text-lg font-semibold text-slate-900">{machineLabel(selectedManualMachine)}</div>
                    <div className="text-sm text-slate-500">{selectedManualMachine.machine_code} - {locationLabel(selectedManualMachine.location_name)}</div>
                  </div>
                  <div className="grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-slate-500">{tr(locale, "Planogram products", "منتجات المخطط")}</div>
                      <div className="font-semibold text-slate-900">{selectedManualPlanogramRows.filter((row) => row.product_id).length}</div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-slate-500">{tr(locale, "Recommended products", "المنتجات الموصى بها")}</div>
                      <div className="font-semibold text-slate-900">{selectedManualRecommendationGroups.length}</div>
                    </div>
                    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <div className="text-xs uppercase tracking-wide text-slate-500">{tr(locale, "Manual products", "المنتجات اليدوية")}</div>
                      <div className="font-semibold text-slate-900">{selectedManualItems.length}</div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
                  <FormField label={`Search ${machineLabel(selectedManualMachine)} products`}>
                    <input
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setNotFoundQuery("");
                      }}
                      placeholder={tr(locale, "Search name, SKU, barcode, category, or brand", "ابحث بالاسم أو SKU أو الباركود أو الفئة أو العلامة")}
                      className="field-input"
                      disabled={saving}
                    />
                  </FormField>
                  <FormField label={`${tr(locale, "Barcode / SKU scan for", "مسح الباركود / SKU لـ")} ${machineLabel(selectedManualMachine)}`}>
                    <div className="flex gap-2">
                      <input value={barcode} onChange={(event) => setBarcode(event.target.value)} onKeyDown={handleBarcodeKey} placeholder={tr(locale, "Scan or type barcode", "امسح أو اكتب الباركود")} className="field-input" disabled={saving} />
                      <button type="button" onClick={handleBarcodeSelect} className="btn-secondary" disabled={saving}>
                        Add
                      </button>
                    </div>
                  </FormField>
                </div>

                {showMissingProduct ? (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    <div className="font-semibold">{tr(locale, "Product not found for this machine picker", "لم يتم العثور على المنتج لهذا المحدد")}</div>
                    <p className="mt-1">{tr(locale, "Check the barcode, SKU, or product name before adding it to master data.", "تحقق من الباركود أو SKU أو اسم المنتج قبل إضافته إلى البيانات الأساسية.")}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link className="btn-secondary" href="/products/new">
                        {tr(locale, "Add product", "إضافة منتج")}
                      </Link>
                      <Link className="btn-secondary" href={`/issues?missing_product=${encodeURIComponent(notFoundQuery || search.trim())}`}>
                        {tr(locale, "Report missing product", "الإبلاغ عن منتج مفقود")}
                      </Link>
                    </div>
                  </div>
                ) : null}

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-800">{tr(locale, "Planogram and recommended products for this machine", "منتجات المخطط والمنتجات الموصى بها لهذا الجهاز")}</div>
                      <div className="text-xs text-slate-500">{tr(locale, "Snacky OS keeps this list scoped to", "يحصر Snacky OS هذه القائمة على")} {machineLabel(selectedManualMachine)} {tr(locale, "only.", "فقط.")}</div>
                    </div>
                    <div className="text-xs text-slate-500">{tr(locale, "Enter adds scanned products instantly.", "زر Enter يضيف المنتجات الممسوحة فورًا.")}</div>
                  </div>
                  {!machineScopedSearchResults.length ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                      {manualSearchQuery
                        ? tr(locale, "No planogram or recommended products matched the current search for this machine.", "لم تطابق أي منتجات من المخطط أو التوصيات البحث الحالي لهذا الجهاز.")
                        : tr(locale, "This machine does not currently have planogram or recommended products. Use the fallback storage list below if needed.", "لا يملك هذا الجهاز حاليًا منتجات مخطط أو توصيات. استخدم قائمة المخزون البديلة أدناه إذا لزم الأمر.")}
                    </div>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {machineScopedSearchResults.map((candidate) => (
                        <button
                          key={candidate.product.id}
                          type="button"
                          onClick={() => addProductQty(candidate.product.id, 1)}
                          className="rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={saving || (!adminOverride && candidate.product.availableQty <= 0)}
                        >
                          <div className="flex gap-3">
                            <ProductThumbnail imageUrl={candidate.product.imageUrl} name={candidate.product.name} size="md" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium text-slate-900">{candidate.product.name}</div>
                              <div className="text-xs text-slate-500">
                                {candidate.product.sku ?? tr(locale, "No SKU", "لا يوجد SKU")} - {candidate.product.category ?? tr(locale, "Uncategorized", "غير مصنف")} {candidate.product.brand ? `- ${candidate.product.brand}` : ""}
                              </div>
                              <div className="mt-1 text-xs text-slate-600">
                                Storage {candidate.product.storageQty} / Available {candidate.product.availableQty}
                              </div>
                              <div className="mt-2 flex flex-wrap gap-2 text-xs">
                                {candidate.sourceKinds.has("planogram") ? <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">Planogram</span> : null}
                                {candidate.recommendedQty > 0 ? <span className="rounded-full bg-emerald-100 px-2 py-1 text-emerald-800">Recommended {candidate.recommendedQty}</span> : null}
                                {candidate.selectedQty > 0 ? <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900">Selected {candidate.selectedQty}</span> : null}
                                {candidate.slotCodes.size ? (
                                  <span className="rounded-full bg-sky-100 px-2 py-1 text-sky-800">
                                    {tr(locale, "Slots", "الفتحات")} {Array.from(candidate.slotCodes).slice(0, 3).join(", ")}{candidate.slotCodes.size > 3 ? ` +${candidate.slotCodes.size - 3}` : ""}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{tr(locale, "Other storage products", "منتجات تخزين أخرى")}</div>
                    <div className="text-xs text-slate-500">{tr(locale, "Fallback catalog items not currently in this machine’s planogram or recommendation set.", "عناصر بديلة من الكتالوج غير موجودة حاليًا في مخطط هذا الجهاز أو مجموعة توصياته.")}</div>
                  </div>
                  {!machineFallbackProducts.length ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                      {manualSearchQuery ? tr(locale, "No fallback storage products matched the current search.", "لا توجد منتجات تخزين بديلة تطابق البحث الحالي.") : tr(locale, "No additional storage products are available right now.", "لا توجد منتجات تخزين إضافية متاحة الآن.")}
                    </div>
                  ) : (
                    <div className="grid gap-2 md:grid-cols-2">
                      {machineFallbackProducts.map((product) => (
                        <button
                          key={product.id}
                          type="button"
                          onClick={() => addProductQty(product.id, 1)}
                          className="rounded-lg border border-dashed border-slate-200 bg-white p-3 text-left transition hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={saving || (!adminOverride && product.availableQty <= 0)}
                        >
                          <div className="flex gap-3">
                            <ProductThumbnail imageUrl={product.imageUrl} name={product.name} size="md" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium text-slate-900">{product.name}</div>
                              <div className="text-xs text-slate-500">
                                {product.sku ?? tr(locale, "No SKU", "لا يوجد SKU")} - {product.category ?? tr(locale, "Uncategorized", "غير مصنف")} {product.brand ? `- ${product.brand}` : ""}
                              </div>
                              <div className="mt-1 text-xs text-slate-600">
                                Storage {product.storageQty} / Available {product.availableQty}
                              </div>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {allowAdminOverride ? (
              <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                <input type="checkbox" checked={adminOverride} onChange={(event) => setAdminOverride(event.target.checked)} className="mt-1" disabled={saving} />
                <span>
                  <span className="block font-semibold">{tr(locale, "Admin override", "تجاوز إداري")}</span>
                  {tr(locale, "Allow quantities above available storage for a supervised count correction.", "السماح بكميات أعلى من المخزون المتاح لتصحيح عدٍّ تحت الإشراف.")}
                </span>
              </label>
            ) : null}

            <div className="overflow-x-auto rounded-xl border bg-white">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Machine</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">{tr(locale, "Available storage qty", "كمية المخزون المتاحة")}</th>
                    <th className="px-3 py-2">Manual planned qty</th>
                    <th className="px-3 py-2">{tr(locale, "Remove", "إزالة")}</th>
                  </tr>
                </thead>
                <tbody>
                  {!sortedManualStopItems.length ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-slate-500">
                        {tr(locale, "No manual machine refill items selected yet.", "لم يتم تحديد أي عناصر تعبئة يدوية للجهاز بعد.")}
                      </td>
                    </tr>
                  ) : (
                    sortedManualStopItems.map((item) => {
                      const product = productsById.get(item.productId);
                      const machine = machinesById.get(item.machineId);
                      const stockIssue = stockErrorByProduct.get(item.productId);
                      const available = stockIssue?.available_qty ?? unitQuantity(product?.availableQty);
                      const exceeds = Boolean(stockIssue) || unitQuantity(item.quantity) > available;
                      return (
                        <tr key={`${item.machineId}-${item.productId}`} className={`border-t border-slate-200 ${stockIssue ? "bg-rose-50" : ""}`}>
                          <td className="px-3 py-2">{machineLabel(machine)}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-3">
                              <ProductThumbnail imageUrl={product?.imageUrl} name={product?.name} size="md" />
                              <div>
                                <div className="font-medium text-slate-900">{product?.name ?? tr(locale, "Unknown product", "منتج غير معروف")}</div>
                                <div className="text-xs text-slate-500">{product?.sku ?? tr(locale, "No SKU", "لا يوجد SKU")}</div>
                                {stockIssue ? <div className="mt-1 text-xs font-medium text-rose-700">{tr(locale, "Short", "النقص")} {stockIssue.shortage_qty} {tr(locale, "units across selected route plan.", "وحدة عبر خطة الجولة المحددة.")}</div> : null}
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
                              {tr(locale, "Remove", "إزالة")}
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
        <p className="text-sm text-slate-500">Grouped by machine and product so you can review what each stop needs and adjust the final take when storage is short.</p>
        {!recommendationGroups.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            <div>{recommendationEmptyMessage}</div>
            <div className="mt-2">You can still build the route manually above.</div>
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
              <button type="button" className="btn-secondary text-xs" onClick={() => selectRecommendationGroups(filteredRecommendationGroups)} disabled={saving}>
                Add all recommended
              </button>
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
                {tr(locale, "Clear selected", "مسح المحدد")}
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

            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Locations in view</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredRecommendationSummary.locationCount}</div>
                <div className="mt-1 text-sm text-slate-500">{filteredRecommendationSummary.machineCount} machines match these filters</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Refill groups</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredRecommendationSummary.refillGroups}</div>
                <div className="mt-1 text-sm text-slate-500">Grouped by machine and location</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Storage short</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{filteredRecommendationSummary.shortageUnits}</div>
                <div className="mt-1 text-sm text-slate-500">{filteredRecommendationSummary.shortageGroups} product groups need extra storage stock</div>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Selected final take</div>
                <div className="mt-2 text-2xl font-semibold text-slate-900">{selectedRecommendationSummary.totalFinalTakeQty}</div>
                <div className="mt-1 text-sm text-slate-500">{selectedRecommendationSummary.selectedProductsCount} products currently selected</div>
              </div>
            </div>

            <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700 md:grid-cols-3">
              <div>Selected products: <span className="font-semibold text-slate-900">{selectedRecommendationSummary.selectedProductsCount}</span></div>
              <div>Total recommended: <span className="font-semibold text-slate-900">{selectedRecommendationSummary.totalRecommendedQty}</span></div>
              <div>Total final take: <span className="font-semibold text-slate-900">{selectedRecommendationSummary.totalFinalTakeQty}</span></div>
            </div>

            <div className="space-y-3 md:hidden">
              {!mobileRecommendationGroups.length ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
                  {recommendationEmptyMessage}
                </div>
              ) : (
                mobileRecommendationGroups.map((familyGroup) => {
                  const familyExpanded = expandedRecommendationFamilyKeys[familyGroup.groupKey] ?? familyGroup.defaultExpanded;
                  return (
                    <section key={familyGroup.groupKey} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                      <button
                        type="button"
                        onClick={() => toggleRecommendationFamily(familyGroup.groupKey, familyGroup.defaultExpanded)}
                        className="flex w-full items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 text-left"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Product group</div>
                          <div className="mt-1 text-base font-semibold text-slate-900">{familyGroup.groupLabel}</div>
                          <div className="mt-1 text-xs text-slate-500">
                            {familyGroup.itemCount} items · {familyGroup.totalQuantity} units recommended
                          </div>
                        </div>
                        <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                          {familyExpanded ? "Hide" : "Show"}
                        </div>
                      </button>

                      {familyExpanded ? (
                        <div className="space-y-3 p-3">
                          {familyGroup.items.map((group) => {
                            const selected = Boolean(group.checked);
                            const expanded = expandedRecommendationGroups.includes(group.groupKey);
                            const selectable = recommendationGroupSelectable(group as RecommendationGroup);
                            const finalTake = finalTakeForGroup(group as RecommendationGroup);
                            const stockIssue = selected ? stockErrorByProduct.get(group.productId) : undefined;
                            const storageKnown = Boolean(stockIssue) || (group as RecommendationGroup).storageKnown;
                            const storageAvailable = stockIssue?.available_qty ?? unitQuantity((group as RecommendationGroup).storageAvailable);
                            const finalExceedsStorage = storageKnown && storageAvailable > 0 && finalTake > storageAvailable;
                            const finalIsZero = selected && finalTake === 0;
                            const finalHigherThanRecommended = selected && finalTake > (group as RecommendationGroup).recommendedTotal;
                            const finalLowerThanRecommended = selected && finalTake > 0 && finalTake < (group as RecommendationGroup).recommendedTotal;
                            const recommendationShortage = storageKnown ? Math.max(0, (group as RecommendationGroup).recommendedTotal - storageAvailable) : 0;
                            const noStorageAvailable = storageKnown && (group as RecommendationGroup).recommendedTotal > 0 && storageAvailable <= 0;
                            const storageUnknown = !storageKnown;
                            const recommendationGroup = group as RecommendationGroup;

                            return (
                              <article key={recommendationGroup.groupKey} className={`rounded-2xl border p-4 shadow-sm ${stockIssue ? "border-rose-200 bg-rose-50/70" : selected ? "border-emerald-300 bg-emerald-50/60" : "border-slate-200 bg-white"}`}>
                                <div className="flex items-start gap-3">
                                  <input
                                    type="checkbox"
                                    checked={selected}
                                    onChange={() => toggleRecommendationGroup(recommendationGroup)}
                                    className="mt-1 h-5 w-5 shrink-0"
                                    disabled={saving || !selectable}
                                    title={!selectable ? "No refill quantity is needed for this grouped recommendation." : undefined}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <h3 className="break-words text-base font-semibold text-slate-900">{recommendationGroup.productName}</h3>
                                      <span className={`rounded-full px-2 py-1 text-xs font-semibold ${recommendationGroup.priority === "critical" ? "bg-rose-100 text-rose-800" : recommendationGroup.priority === "high" ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700"}`}>
                                        {recommendationGroup.priority}
                                      </span>
                                    </div>
                                    <p className="mt-1 text-sm font-medium text-slate-700">{recommendationGroup.machineName}</p>
                                    <p className="mt-1 text-xs text-slate-500">{recommendationGroup.machineCode} - {locationLabel(recommendationGroup.locationName)}</p>
                                    <p className="mt-2 text-sm text-slate-600">{recommendationReasonSummary(recommendationGroup)}</p>
                                  </div>
                                </div>

                                <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Current</div>
                                    <div className="mt-1 text-lg font-semibold text-slate-900">{recommendationGroup.currentTotal}</div>
                                  </div>
                                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Capacity</div>
                                    <div className="mt-1 text-lg font-semibold text-slate-900">{recommendationGroup.targetTotal}</div>
                                  </div>
                                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Suggested</div>
                                    <div className="mt-1 text-lg font-semibold text-slate-900">{recommendationGroup.recommendedTotal}</div>
                                  </div>
                                  <div className={`rounded-xl border p-3 ${storageKnown && storageAvailable <= 0 ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Storage</div>
                                    <div className="mt-1 text-lg font-semibold text-slate-900">{storageUnknown ? "Unknown" : storageAvailable}</div>
                                  </div>
                                </div>

                                <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3">
                                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Slots</div>
                                  <div className="mt-1 text-sm text-slate-700">{recommendationGroup.slotsCount} slot{recommendationGroup.slotsCount === 1 ? "" : "s"} in this machine/location group</div>
                                  <div className="mt-1 text-sm text-slate-700">
                                    {storageUnknown ? tr(locale, `Storage is unknown. Needed quantity stays at ${recommendationGroup.recommendedTotal} until stock is confirmed.`, `المخزون غير معروف. ستبقى الكمية المطلوبة ${recommendationGroup.recommendedTotal} حتى يتم تأكيد المخزون.`) : tr(locale, `Storage available ${storageAvailable} vs recommended ${recommendationGroup.recommendedTotal}`, `المخزون المتاح ${storageAvailable} مقابل التوصية ${recommendationGroup.recommendedTotal}`)}
                                  </div>
                                </div>

                                <div className="mt-4 space-y-3">
                                  <label className="block">
                                    <span className="mb-1 block text-sm font-medium text-slate-800">Final take</span>
                                    <input
                                      type="number"
                                      min={0}
                                      max={adminOverride || !storageKnown || storageAvailable <= 0 ? undefined : storageAvailable}
                                      step={1}
                                      value={finalTake}
                                      onChange={(event) => setRecommendationFinalTake(recommendationGroup, Number(event.target.value) || 0)}
                                      className={`field-input w-full ${(finalExceedsStorage || stockIssue) && !adminOverride ? "border-rose-300 bg-rose-50" : ""}`}
                                      disabled={saving || !selected}
                                      aria-label={`Final take for ${recommendationGroup.productName} at ${recommendationGroup.machineName}`}
                                    />
                                  </label>
                                  <div className="flex flex-wrap gap-2">
                                <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setRecommendationFinalTake(recommendationGroup, recommendationGroup.recommendedTotal)} disabled={saving || !selected}>{tr(locale, "Use recommended", "استخدم التوصية")}</button>
                                <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setRecommendationFinalTake(recommendationGroup, Math.ceil(recommendationGroup.recommendedTotal / 2))} disabled={saving || !selected}>{tr(locale, "Take half", "خذ النصف")}</button>
                                <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setRecommendationFinalTake(recommendationGroup, storageAvailable)} disabled={saving || !selected || !storageKnown}>{tr(locale, "Take max available", "خذ الحد الأقصى المتاح")}</button>
                                <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => setRecommendationFinalTake(recommendationGroup, 0)} disabled={saving || !selected}>{tr(locale, "Clear", "مسح")}</button>
                                  </div>
                              {finalIsZero ? <div className="text-xs font-medium text-amber-700">{tr(locale, "Final take is 0.", "الكمية النهائية تساوي 0.")}</div> : null}
                              {finalHigherThanRecommended ? <div className="text-xs font-medium text-amber-700">{tr(locale, "Final take is higher than recommended.", "الكمية النهائية أعلى من التوصية.")}</div> : null}
                              {finalLowerThanRecommended ? <div className="text-xs text-slate-500">{tr(locale, "Taking less than recommended.", "يتم أخذ أقل من التوصية.")}</div> : null}
                              {storageUnknown ? <div className="text-xs font-medium text-amber-700">{tr(locale, "Storage is unknown, so Snacky OS is keeping the full needed quantity visible.", "المخزون غير معروف، لذا يعرض Snacky OS كامل الكمية المطلوبة.")}</div> : null}
                              {noStorageAvailable ? <div className="text-xs font-medium text-amber-700">{tr(locale, `Storage is currently 0, but this machine still needs ${recommendationGroup.recommendedTotal}. Replenish storage or override it after verifying stock.`, `المخزون حاليًا 0، لكن هذا الجهاز ما زال يحتاج ${recommendationGroup.recommendedTotal}. عبئ المخزن أو تجاوز ذلك بعد التحقق من المخزون.`)}</div> : null}
                              {!noStorageAvailable && recommendationShortage > 0 ? <div className="text-xs text-amber-700">{tr(locale, `Storage has ${storageAvailable}; recommendation needs ${recommendationGroup.recommendedTotal}. Short by ${recommendationShortage}.`, `المخزون المتاح ${storageAvailable}؛ والتوصية تحتاج ${recommendationGroup.recommendedTotal}. النقص ${recommendationShortage}.`)}</div> : null}
                                  {stockIssue ? <div className="text-xs font-medium text-rose-700">Selected {stockIssue.selected_qty}, available {stockIssue.available_qty}, shortage {stockIssue.shortage_qty}.</div> : null}
                                </div>

                                <div className="mt-4 flex items-center justify-between gap-3">
                                  <button
                                    type="button"
                                    className="link-secondary"
                                    onClick={() => setExpandedRecommendationGroups((current) => toggleValue(current, recommendationGroup.groupKey))}
                                  >
                                {expanded ? tr(locale, "Hide slot details", "إخفاء تفاصيل الفتحة") : tr(locale, "Show slot details", "عرض تفاصيل الفتحة")}
                                  </button>
                                </div>

                                {expanded ? (
                                  <div className="mt-4 space-y-2">
                                    {recommendationGroup.rows.map((row) => (
                                      <div key={row.recommendation_key} className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                                        <div className="flex items-start justify-between gap-3">
                                          <div>
                                            <div className="font-medium text-slate-900">{row.slot_code || tr(locale, "VMS item", "عنصر VMS")}</div>
                                            <div className="mt-1 text-xs text-slate-500">{tr(locale, "Current", "الحالي")} {row.current_qty} / {tr(locale, "Target", "الهدف")} {formatRecommendationQty(row.capacity ?? row.par_qty)} / {tr(locale, "Suggested", "المقترح")} {recommendationQuantity(row)}</div>
                                          </div>
                                          <div className="text-xs font-medium text-slate-600">{row.priority ?? "-"}</div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : null}
                              </article>
                            );
                          })}
                        </div>
                      ) : null}
                    </section>
                  );
                })
              )}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border bg-white shadow-sm md:block">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="px-3 py-2" />
                    <th className="px-3 py-2">Machine</th>
                    <th className="px-3 py-2">Product</th>
                    <th className="px-3 py-2">{tr(locale, "Slots count", "عدد الفتحات")}</th>
                    <th className="px-3 py-2">{tr(locale, "Current total", "الإجمالي الحالي")}</th>
                    <th className="px-3 py-2">{tr(locale, "Target total", "الإجمالي المستهدف")}</th>
                    <th className="px-3 py-2">{tr(locale, "Recommended take", "الكمية الموصى بها")}</th>
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
                        {recommendationEmptyMessage}
                      </td>
                    </tr>
                  ) : (
                    pagedRecommendationGroups.map((group, index) => {
                      const previousGroup = index > 0 ? pagedRecommendationGroups[index - 1] : null;
                      const showLocationHeader = !previousGroup || locationLabel(previousGroup.locationName) !== locationLabel(group.locationName);
                      const selected = isRecommendationGroupSelected(group);
                      const expanded = expandedRecommendationGroups.includes(group.groupKey);
                      const selectable = recommendationGroupSelectable(group);
                      const finalTake = finalTakeForGroup(group);
                      const stockIssue = selected ? stockErrorByProduct.get(group.productId) : undefined;
                      const storageKnown = Boolean(stockIssue) || group.storageKnown;
                      const storageAvailable = stockIssue?.available_qty ?? unitQuantity(group.storageAvailable);
                      const finalExceedsStorage = storageKnown && storageAvailable > 0 && finalTake > storageAvailable;
                      const finalIsZero = selected && finalTake === 0;
                      const finalHigherThanRecommended = selected && finalTake > group.recommendedTotal;
                      const finalLowerThanRecommended = selected && finalTake > 0 && finalTake < group.recommendedTotal;
                      const recommendationShortage = storageKnown ? Math.max(0, group.recommendedTotal - storageAvailable) : 0;
                      const noStorageAvailable = storageKnown && group.recommendedTotal > 0 && storageAvailable <= 0;
                      const storageUnknown = !storageKnown;
                      const showStockIssue = Boolean(stockIssue);

                      return (
                        <Fragment key={group.groupKey}>
                          {showLocationHeader ? (
                            <tr className="border-t border-slate-200 bg-slate-100/80">
                              <td colSpan={11} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600">
                                {locationLabel(group.locationName)}
                              </td>
                            </tr>
                          ) : null}
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
                              <div className="text-xs font-normal text-slate-500">{locationLabel(group.locationName)}</div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-medium text-slate-900">{group.productName}</div>
                              <div className="mt-1 text-xs text-slate-500">{recommendationReasonSummary(group)}</div>
                              <div className="mt-1 text-xs text-slate-600">{storageUnknown ? `Storage unknown / Needed ${group.recommendedTotal}` : `Storage ${storageAvailable} / Recommended ${group.recommendedTotal}`}</div>
                            </td>
                            <td className="px-3 py-2">{group.slotsCount}</td>
                            <td className="px-3 py-2">{group.currentTotal}</td>
                            <td className="px-3 py-2">{group.targetTotal}</td>
                            <td className="px-3 py-2 font-semibold text-slate-900">{group.recommendedTotal}</td>
                            <td className="min-w-[260px] px-3 py-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <input
                                  type="number"
                                  min={0}
                                  max={adminOverride || !storageKnown || storageAvailable <= 0 ? undefined : storageAvailable}
                                  step={1}
                                  value={finalTake}
                                  onChange={(event) => setRecommendationFinalTake(group, Number(event.target.value) || 0)}
                                  className={`field-input w-24 ${(finalExceedsStorage || showStockIssue) && !adminOverride ? "border-rose-300 bg-rose-50" : ""}`}
                                  disabled={saving || !selected}
                                  aria-label={`Final take for ${group.productName} at ${group.machineName}`}
                                />
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, group.recommendedTotal)} disabled={saving || !selected}>{tr(locale, "Use recommended", "استخدم التوصية")}</button>
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, Math.ceil(group.recommendedTotal / 2))} disabled={saving || !selected}>{tr(locale, "Take half", "خذ النصف")}</button>
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, storageAvailable)} disabled={saving || !selected || !storageKnown}>{tr(locale, "Take max available", "خذ الحد الأقصى المتاح")}</button>
                                <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setRecommendationFinalTake(group, 0)} disabled={saving || !selected}>{tr(locale, "Clear", "مسح")}</button>
                              </div>
                              {finalIsZero ? <div className="mt-1 text-xs font-medium text-amber-700">{tr(locale, "Final take is 0.", "الكمية النهائية تساوي 0.")}</div> : null}
                              {finalHigherThanRecommended ? <div className="mt-1 text-xs font-medium text-amber-700">{tr(locale, "Final take is higher than recommended.", "الكمية النهائية أعلى من التوصية.")}</div> : null}
                              {finalLowerThanRecommended ? <div className="mt-1 text-xs text-slate-500">{tr(locale, "Taking less than recommended.", "يتم أخذ أقل من التوصية.")}</div> : null}
                              {storageUnknown ? <div className="mt-1 text-xs font-medium text-amber-700">{tr(locale, "Storage is unknown, so Snacky OS is keeping the full needed quantity visible.", "المخزون غير معروف، لذا يعرض Snacky OS كامل الكمية المطلوبة.")}</div> : null}
                              {noStorageAvailable ? <div className="mt-1 text-xs font-medium text-amber-700">{tr(locale, `Storage is currently 0, but this machine still needs ${group.recommendedTotal}. Replenish storage or override it after verifying stock.`, `المخزون حاليًا 0، لكن هذا الجهاز ما زال يحتاج ${group.recommendedTotal}. عبئ المخزن أو تجاوز ذلك بعد التحقق من المخزون.`)}</div> : null}
                              {!noStorageAvailable && recommendationShortage > 0 ? <div className="mt-1 text-xs text-amber-700">{tr(locale, `Storage has ${storageAvailable}; recommendation needs ${group.recommendedTotal}. Short by ${recommendationShortage}.`, `المخزون المتاح ${storageAvailable}؛ والتوصية تحتاج ${group.recommendedTotal}. النقص ${recommendationShortage}.`)}</div> : null}
                              {stockIssue ? <div className="mt-1 text-xs font-medium text-rose-700">Selected {stockIssue.selected_qty}, available {stockIssue.available_qty}, shortage {stockIssue.shortage_qty}.</div> : null}
                            </td>
                            <td className={`px-3 py-2 ${(finalExceedsStorage || showStockIssue) && !adminOverride ? "font-semibold text-rose-700" : ""}`}>{storageUnknown ? "Unknown" : storageAvailable}</td>
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
                                        <th className="px-3 py-2">{tr(locale, "Recommended take", "الكمية الموصى بها")}</th>
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
        <p className="text-sm text-slate-500">{tr(locale, "Choose machines that should be included in the route even if there is no recommendation row.", "اختر الأجهزة التي يجب تضمينها في الجولة حتى لو لم توجد لها توصية.")}</p>
        {!machines.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
            {tr(locale, "No active machines found. Create a machine first.", "لم يتم العثور على أجهزة نشطة. أنشئ جهازًا أولًا.")}
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
                  {machineLabel(machine)}
                  <span className="block text-xs text-slate-500">{locationLabel(machine.location_name)}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </FormSection>

      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">
        {tr(locale, "Selected stops:", "المواقع المحددة:")} <span className="font-semibold text-slate-900">{selectedStopCount}</span>
        <span className="mx-2 text-slate-300">/</span>
        {tr(locale, "Route pick-list products:", "منتجات قائمة التحميل:")} <span className="font-semibold text-slate-900">{selectedProducts.length}</span>
      </div>

      {error ? (
        <div ref={saveErrorRef} className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-medium whitespace-pre-line text-rose-800" role="alert" aria-live="assertive">
          {error}
        </div>
      ) : null}

      <div className="sticky bottom-3 z-20 -mx-3 flex flex-col gap-3 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 sm:flex-1">
          <div className="font-semibold text-slate-900">
            {selectedProducts.length} items selected · {plannedRouteStock.reduce((sum, item) => sum + unitQuantity(item.quantity), 0)} total units
          </div>
          <div className="mt-1 text-xs text-slate-500">{tr(locale, "The create button stays visible on phones while you review the route.", "يبقى زر الإنشاء ظاهرًا على الهواتف أثناء مراجعة الجولة.")}</div>
        </div>
        <button type="submit" className="btn-primary disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto" disabled={saving}>
          {saving ? tr(locale, "Creating route...", "جارٍ إنشاء الجولة...") : tr(locale, "Create route", "إنشاء جولة")}
        </button>
        <SecondaryButton href="/routes">{tr(locale, "Cancel", "إلغاء")}</SecondaryButton>
      </div>
    </form>
  );
}
