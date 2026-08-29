"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { DraftRestoreBanner, DraftSaveStatus, useDraftKey, useLocalDraft } from "@/components/LocalDraft";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { EmptyState, ErrorState, LoadingState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { useLanguage } from "@/components/I18nProvider";
import { applyPendingStopRecommendationRefresh, confirmPickList, previewPendingStopRecommendationRefresh, startRoute, type PendingStopRefreshComparison } from "@/lib/operator-actions";
import { comparePickupProductRows, groupRouteItemsForDisplay, pickupProductPriorityGroup, sortPickupProductRows } from "@/lib/route-pickup-checklist";
import { ROUTE_STOP_PENDING_STATUS } from "@/lib/route-workflow";
import { formatProductQuantity } from "@/lib/product-quantity";

const UNASSIGNED_EXTRA_TARGET = "__unassigned__";
const PICKUP_CHECKLIST_STORAGE_PREFIX = "snacky:route-pickup-checklist";

interface PickStopItem {
  routeStopItemId: string;
  routeStopId: string | null;
  machineId: string | null;
  productId: string;
  productName: string;
  productCategory: string | null;
  sku: string | null;
  caseQuantity: number;
  requestedQty: number;
  availableStorageQty: number;
  confirmedQty: number;
  reason: string;
  notes: string;
  source: string;
  isChecked: boolean;
  stopOrder: number;
  machineName: string;
  locationName: string;
}
interface PickStopGroup {
  routeStopId: string | null;
  machineId: string | null;
  machineName: string;
  machineCode: string;
  locationName: string;
  stopOrder: number;
  stopStatus: string | null;
  items: PickStopItem[];
}
interface ProductOption {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  imageUrl?: string | null;
  caseQuantity: number;
  availableStorageQty: number;
}
interface ExtraPickItem {
  id: string;
  targetStopId: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
}
interface RouteTotal {
  productId: string;
  productName: string;
  productCategory?: string | null;
  sku: string | null;
  caseQuantity: number;
  plannedQty: number;
  confirmedQty: number;
  availableStorageQty: number;
}
interface PreparedPickupSummaryRow {
  productId: string;
  productName: string | null;
  quantity: number;
}
interface PreparedPickupBatch {
  id: string;
  routeId: string;
  operatorId: string | null;
  status: string;
  selectedStopIds: string[];
  productSummary: PreparedPickupSummaryRow[];
  storageDeducted: boolean;
  preparedAt: string | null;
  preparedBy: string | null;
  confirmedAt: string | null;
  returnedToAssignedAt: string | null;
  returnedToAssignedReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
type PickListDraft = {
  selectedStopIds: string[];
  stopItems: { routeStopItemId: string; confirmedQty: number; reason: string; notes: string }[];
  extras: ExtraPickItem[];
};
type LocalPickupChecklistState = Record<string, boolean>;

type PickListApiStopItem = {
  route_stop_item_id?: unknown;
  route_stop_id?: unknown;
  machine_id?: unknown;
  product_id?: unknown;
  product_name?: unknown;
  category?: unknown;
  sku?: unknown;
  case_quantity?: unknown;
  planned_qty?: unknown;
  available_storage_qty?: unknown;
  picked_qty?: unknown;
  reason?: unknown;
  notes?: unknown;
  source?: unknown;
  is_checked?: unknown;
};

type PickListApiStopGroup = {
  route_stop_id?: unknown;
  machine_id?: unknown;
  machine_name?: unknown;
  machine_code?: unknown;
  location_name?: unknown;
  stop_order?: unknown;
  stop_status?: unknown;
  items?: unknown;
};

type PickListApiExtraItem = {
  routeStopId?: unknown;
  route_stop_id?: unknown;
  productId?: unknown;
  product_id?: unknown;
  quantity?: unknown;
  reason?: unknown;
  notes?: unknown;
};

type PickListApiProductOption = {
  id?: unknown;
  sku?: unknown;
  barcode?: unknown;
  name?: unknown;
  category?: unknown;
  brand?: unknown;
  imageUrl?: unknown;
  caseQuantity?: unknown;
  availableStorageQty?: unknown;
};
type PickListApiPreparedBatch = {
  id?: unknown;
  routeId?: unknown;
  operatorId?: unknown;
  status?: unknown;
  selectedStopIds?: unknown;
  productSummary?: unknown;
  storageDeducted?: unknown;
  preparedAt?: unknown;
  preparedBy?: unknown;
  confirmedAt?: unknown;
  returnedToAssignedAt?: unknown;
  returnedToAssignedReason?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

type RefreshPreviewState = {
  loading: boolean;
  applying: boolean;
  comparisons: PendingStopRefreshComparison[];
  message: string;
  error: string;
};

function safeRouteHref(routeId: string) {
  return routeId ? `/operator/routes/${routeId}` : "/operator";
}

function optionalText(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function textOrFallback(value: unknown, fallback: string) {
  const text = optionalText(value);
  return text && text.trim() ? text : fallback;
}

function newExtraRow(): ExtraPickItem {
  return { id: crypto.randomUUID(), targetStopId: "", productId: "", quantity: 0, reason: "Customer demand", notes: "" };
}

function groupStopsByLocation<T extends { locationName: string; stopOrder?: number; machineName?: string }>(groups: T[]) {
  const grouped = new Map<string, T[]>();
  groups.forEach((group) => {
    const key = group.locationName || "Unknown location";
    grouped.set(key, [...(grouped.get(key) ?? []), group]);
  });
  return Array.from(grouped.entries())
    .map(([locationName, locationGroups]) => ({
      locationName,
      groups: locationGroups.sort((a, b) => Number(a.stopOrder ?? 0) - Number(b.stopOrder ?? 0) || String(a.machineName ?? "").localeCompare(String(b.machineName ?? ""))),
    }))
    .sort((a, b) => a.locationName.localeCompare(b.locationName));
}

function progressPercent(completed: number, total: number) {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
}

function pickupPriorityBadge(productName: string) {
  const priorityGroup = pickupProductPriorityGroup(productName);
  if (priorityGroup === 1) return { label: "Mr Crunch first", className: "bg-rose-100 text-rose-800" };
  if (priorityGroup === 2) return { label: "Doritos second", className: "bg-amber-100 text-amber-900" };
  return null;
}

function comparablePickDraft(draft: PickListDraft) {
  return JSON.stringify({
    selectedStopIds: [...(draft.selectedStopIds ?? [])].sort(),
    stopItems: [...draft.stopItems].sort((a, b) => a.routeStopItemId.localeCompare(b.routeStopItemId)),
    extras: draft.extras
      .map((item) => ({
        targetStopId: item.targetStopId,
        productId: item.productId,
        quantity: item.quantity,
        reason: item.reason,
        notes: item.notes,
      }))
      .filter((item) => item.targetStopId || item.productId || item.quantity > 0 || item.notes.trim())
      .sort((a, b) => `${a.targetStopId}:${a.productId}:${a.reason}:${a.notes}`.localeCompare(`${b.targetStopId}:${b.productId}:${b.reason}:${b.notes}`)),
  });
}

function targetStopId(routeStopId: string | null | undefined) {
  return routeStopId ? routeStopId : UNASSIGNED_EXTRA_TARGET;
}

function submittedRouteStopId(target: string) {
  if (!target || target === UNASSIGNED_EXTRA_TARGET) return null;
  return target;
}

function pickupChecklistStorageKey(routeId: string) {
  return `${PICKUP_CHECKLIST_STORAGE_PREFIX}:${routeId}`;
}

function readLocalPickupChecklist(routeId: string): LocalPickupChecklistState {
  if (!routeId || typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(pickupChecklistStorageKey(routeId));
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function writeLocalPickupChecklist(routeId: string, state: LocalPickupChecklistState) {
  if (!routeId || typeof window === "undefined") return;

  try {
    window.localStorage.setItem(pickupChecklistStorageKey(routeId), JSON.stringify(state));
  } catch {
    // Local checklist is a UX helper. Storage quota or privacy-mode failures should not block pickup.
  }
}

export default function PickListPage() {
  const router = useRouter();
  const { t, locale } = useLanguage();
  const params = useParams<{ id?: string | string[] }>();
  const searchParams = useSearchParams();
  const rawRouteId = params?.id;
  const routeId = Array.isArray(rawRouteId) ? rawRouteId[0] ?? "" : rawRouteId ?? "";
  const routeHref = safeRouteHref(routeId);
  const pickupSubmissionIdRef = useRef(crypto.randomUUID());
  const shouldStartRoute = searchParams.get("start") === "1";
  const startAttempted = useRef(false);
  const [stopGroups, setStopGroups] = useState<PickStopGroup[]>([]);
  const [selectedStopIds, setSelectedStopIds] = useState<string[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [extras, setExtras] = useState<ExtraPickItem[]>([]);
  const [routeItemCount, setRouteItemCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [savingCheckedIds, setSavingCheckedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [checklistSyncError, setChecklistSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const [preparedBatch, setPreparedBatch] = useState<PreparedPickupBatch | null>(null);
  const [loadCheckedProductIds, setLoadCheckedProductIds] = useState<Set<string>>(new Set());
  const [vehicleClearChecked, setVehicleClearChecked] = useState(false);
  const [refreshPreview, setRefreshPreview] = useState<RefreshPreviewState>({ loading: false, applying: false, comparisons: [], message: "", error: "" });
  const [expandedChecklistFamilyKeys, setExpandedChecklistFamilyKeys] = useState<Record<string, boolean>>({});
  const errorRef = useRef<HTMLDivElement | null>(null);
  const initialPickDraftRef = useRef<string>("");
  const localChecklistRef = useRef<LocalPickupChecklistState>({});
  const draftKey = useDraftKey("route-pickup", [routeId || "missing-route"]);

  const selectedStopGroups = useMemo(
    () => stopGroups.filter((group) => group.routeStopId && selectedStopIds.includes(group.routeStopId)),
    [selectedStopIds, stopGroups],
  );
  const stopGroupsByLocation = useMemo(() => groupStopsByLocation(stopGroups), [stopGroups]);
  const selectedStopGroupsByLocation = useMemo(() => groupStopsByLocation(selectedStopGroups), [selectedStopGroups]);
  const allStopItems = useMemo(() => selectedStopGroups.flatMap((group) => group.items), [selectedStopGroups]);
  const productById = useMemo(() => new Map(productOptions.map((product) => [product.id, product])), [productOptions]);
  const stopById = useMemo(() => new Map(selectedStopGroups.filter((group) => group.routeStopId).map((group) => [group.routeStopId as string, group])), [selectedStopGroups]);
  const pickedByProduct = useMemo(() => {
    const totals = new Map<string, number>();
    allStopItems.forEach((item) => totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.confirmedQty));
    extras.forEach((item) => {
      if (item.productId && item.quantity > 0) totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.quantity);
    });
    return totals;
  }, [allStopItems, extras]);
  const routeTotals = useMemo<RouteTotal[]>(() => {
    const totals = new Map<string, RouteTotal>();
    allStopItems.forEach((item) => {
      const current = totals.get(item.productId) ?? {
        productId: item.productId,
        productName: item.productName,
        productCategory: item.productCategory,
        sku: item.sku,
        caseQuantity: item.caseQuantity,
        plannedQty: 0,
        confirmedQty: 0,
        availableStorageQty: productById.get(item.productId)?.availableStorageQty ?? item.availableStorageQty,
      };
      current.plannedQty += item.requestedQty;
      current.confirmedQty += item.confirmedQty;
      current.availableStorageQty = Math.max(current.availableStorageQty, productById.get(item.productId)?.availableStorageQty ?? item.availableStorageQty);
      totals.set(item.productId, current);
    });
    extras.forEach((item) => {
      if (!item.productId || item.quantity <= 0) return;
      const product = productById.get(item.productId);
      const current = totals.get(item.productId) ?? {
        productId: item.productId,
        productName: product?.name ?? "Unknown product",
        productCategory: product?.category ?? null,
        sku: product?.sku ?? null,
        caseQuantity: product?.caseQuantity ?? 1,
        plannedQty: 0,
        confirmedQty: 0,
        availableStorageQty: product?.availableStorageQty ?? 0,
      };
      current.confirmedQty += item.quantity;
      totals.set(item.productId, current);
    });
    return sortPickupProductRows(Array.from(totals.values()));
  }, [allStopItems, extras, productById]);
  const totalPickedUnits = routeTotals.reduce((sum, item) => sum + item.confirmedQty, 0);
  const checkedItemCount = allStopItems.filter((item) => item.isChecked).length;
  const remainingItemCount = Math.max(0, allStopItems.length - checkedItemCount);
  const checkedUnitCount = allStopItems.filter((item) => item.isChecked).reduce((sum, item) => sum + item.confirmedQty, 0);
  const remainingUnitCount = Math.max(0, totalPickedUnits - checkedUnitCount);
  const assignedExtraCount = extras.filter((item) => item.productId && item.quantity > 0 && submittedRouteStopId(item.targetStopId)).length;
  const unassignedExtraCount = extras.filter((item) => item.productId && item.quantity > 0 && item.targetStopId === UNASSIGNED_EXTRA_TARGET).length;
  const selectedLocationCount = selectedStopGroupsByLocation.length;
  const checklistProgress = progressPercent(checkedItemCount, allStopItems.length);
  const selectedStopProgress = progressPercent(selectedStopIds.length, stopGroups.length);
  const preparedSummaryMatchesRouteTotals = useMemo(() => {
    if (!preparedBatch?.productSummary?.length) return true;
    const expected = new Map(routeTotals.filter((item) => item.confirmedQty > 0).map((item) => [item.productId, item.confirmedQty]));
    const prepared = new Map(preparedBatch.productSummary.filter((item) => item.quantity > 0).map((item) => [item.productId, item.quantity]));
    if (expected.size !== prepared.size) return false;
    return Array.from(expected.entries()).every(([productId, quantity]) => prepared.get(productId) === quantity);
  }, [preparedBatch, routeTotals]);
  const activePreparedBatch = preparedBatch && !preparedBatch.confirmedAt && !preparedBatch.returnedToAssignedAt && preparedSummaryMatchesRouteTotals ? preparedBatch : null;
  const checklistFrozen = Boolean(activePreparedBatch);
  const preparedLoadRows = (activePreparedBatch?.productSummary?.length ? activePreparedBatch.productSummary : routeTotals.map((item) => ({
    productId: item.productId,
    productName: item.productName,
    quantity: item.confirmedQty,
  }))).filter((item) => item.quantity > 0);
  const allDetailedItemsChecked = allStopItems.length > 0 && allStopItems.every((item) => item.isChecked);
  const allLoadRowsChecked = preparedLoadRows.length > 0 && preparedLoadRows.every((item) => loadCheckedProductIds.has(item.productId));
  const acknowledgedPickupLineIds = useMemo(
    () => allStopItems.filter((item) => item.isChecked && item.routeStopItemId).map((item) => item.routeStopItemId as string),
    [allStopItems],
  );
  const canPreparePickup = !activePreparedBatch && allDetailedItemsChecked && selectedStopIds.length > 0 && !submitting;
  const canConfirmPickup = Boolean(activePreparedBatch) && allLoadRowsChecked && vehicleClearChecked && !submitting;

  const pickDraft = useMemo<PickListDraft>(() => ({
    selectedStopIds,
    stopItems: allStopItems.map((item) => ({
      routeStopItemId: item.routeStopItemId,
      confirmedQty: item.confirmedQty,
      reason: item.reason,
      notes: item.notes,
    })),
    extras,
  }), [allStopItems, extras, selectedStopIds]);
  const shouldSavePickDraft = useCallback((draft: PickListDraft) => {
    if (!routeId || locked || checklistFrozen || !initialPickDraftRef.current) return false;
    return comparablePickDraft(draft) !== initialPickDraftRef.current;
  }, [checklistFrozen, locked, routeId]);
  const localDraft = useLocalDraft<PickListDraft>({
    key: draftKey,
    value: pickDraft,
    shouldSave: shouldSavePickDraft,
    onRestore: (draft) => {
      if (checklistFrozen) return;
      const availableStopIds = new Set(stopGroups.map((group) => group.routeStopId).filter(Boolean) as string[]);
      setSelectedStopIds((draft.selectedStopIds ?? []).filter((stopId) => availableStopIds.has(stopId)));
      const draftByStopItem = new Map((draft.stopItems ?? []).map((item) => [item.routeStopItemId, item]));
      setStopGroups((current) => current.map((group) => ({
        ...group,
        items: group.items.map((item) => {
          const saved = draftByStopItem.get(item.routeStopItemId);
          return saved ? { ...item, confirmedQty: saved.confirmedQty, reason: saved.reason, notes: saved.notes } : item;
        }),
      })));
      setExtras((draft.extras ?? []).map((item) => ({ ...item, id: item.id || crypto.randomUUID(), targetStopId: item.targetStopId || "" })));
    },
  });

  const loadPickList = useCallback(async ({ keepSelection = false }: { keepSelection?: boolean } = {}) => {
    if (!routeId) {
      setError("Route id is missing. Go back to your operator routes and open the route again.");
      setLoading(false);
      return;
    }

    try {
      if (shouldStartRoute && !startAttempted.current) {
        startAttempted.current = true;
        await startRoute(routeId);
        setNotice("Route started.");
      }

      const response = await fetch(`/api/operator/routes/${routeId}/pick-list`);
      const data = await response.json();
      if (!response.ok) {
        const message = process.env.NODE_ENV === "development" && data.details ? `${data.error}: ${data.details}` : "Could not load pickup list. Please retry.";
        throw new Error(message || "Could not load pickup list. Please retry.");
      }

      setLocked(Boolean(data.locked));
      setRouteItemCount(Number(data.routeItemCount ?? 0));
      setError('');
      const responseStopGroups = Array.isArray(data.stopGroups) ? (data.stopGroups as PickListApiStopGroup[]) : [];
      const responseProductOptions = Array.isArray(data.productOptions) ? (data.productOptions as PickListApiProductOption[]) : [];
      const responseExtraItems = Array.isArray(data.extraItems) ? (data.extraItems as PickListApiExtraItem[]) : [];
      const localChecklist = readLocalPickupChecklist(routeId);
      localChecklistRef.current = localChecklist;
      const nextStopGroups = responseStopGroups.map((group) => ({
        routeStopId: group.route_stop_id ? String(group.route_stop_id) : null,
        machineId: group.machine_id ? String(group.machine_id) : null,
        machineName: textOrFallback(group.machine_name, "Unknown machine"),
        machineCode: textOrFallback(group.machine_code, "-"),
        locationName: textOrFallback(group.location_name, "Unknown location"),
        stopOrder: Number(group.stop_order ?? 0),
        stopStatus: optionalText(group.stop_status) ?? ROUTE_STOP_PENDING_STATUS,
        items: (Array.isArray(group.items) ? (group.items as PickListApiStopItem[]) : []).map((item) => {
        const routeStopItemId = String(item.route_stop_item_id ?? "");
        const requestedQty = Number(item.planned_qty ?? 0);
        const availableStorageQty = Number(item.available_storage_qty ?? 0);
        const hasSavedPickQty = item.picked_qty !== null && item.picked_qty !== undefined;
        return {
            routeStopItemId,
            routeStopId: item.route_stop_id ? String(item.route_stop_id) : group.route_stop_id ? String(group.route_stop_id) : null,
          machineId: item.machine_id ? String(item.machine_id) : group.machine_id ? String(group.machine_id) : null,
          productId: String(item.product_id ?? ""),
          productName: textOrFallback(item.product_name, "Unknown product"),
          productCategory: optionalText(item.category),
          sku: optionalText(item.sku),
          caseQuantity: Math.max(1, Number(item.case_quantity ?? 1)),
          requestedQty,
          availableStorageQty,
            confirmedQty: hasSavedPickQty ? Number(item.picked_qty ?? 0) : Math.min(requestedQty, availableStorageQty),
            reason: optionalText(item.reason) ?? "Product not available in storage",
            notes: optionalText(item.notes) ?? "",
            source: optionalText(item.source) ?? "refill_recommendation",
            isChecked: Object.prototype.hasOwnProperty.call(localChecklist, routeStopItemId) ? Boolean(localChecklist[routeStopItemId]) : Boolean(item.is_checked),
            stopOrder: Number(group.stop_order ?? 0),
            machineName: textOrFallback(group.machine_name, "Unknown machine"),
            locationName: textOrFallback(group.location_name, "Unknown location"),
          };
        }).filter((item: PickStopItem) => item.routeStopItemId && item.productId),
      })).filter((group: PickStopGroup) => group.items.length > 0);
      const nextStopIds = nextStopGroups.map((group: PickStopGroup) => group.routeStopId).filter((id: string | null): id is string => Boolean(id));
      const nextExtras = responseExtraItems.map((item) => ({
        id: crypto.randomUUID(),
        targetStopId: targetStopId(optionalText(item.routeStopId ?? item.route_stop_id)),
        productId: String(item.productId ?? item.product_id ?? ""),
        quantity: Number(item.quantity ?? 0),
        reason: optionalText(item.reason) ?? "Customer demand",
        notes: optionalText(item.notes) ?? "",
      })).filter((item: ExtraPickItem) => item.productId || item.quantity > 0);
      setStopGroups(nextStopGroups);
      setSelectedStopIds((current) => {
        if (!keepSelection) return nextStopIds;
        const nextAvailable = new Set(nextStopIds);
        const preserved = current.filter((stopId) => nextAvailable.has(stopId));
        return preserved.length ? preserved : nextStopIds;
      });
      setProductOptions(responseProductOptions.map((product) => ({
        id: String(product.id ?? ""),
        sku: optionalText(product.sku),
        barcode: optionalText(product.barcode),
        name: textOrFallback(product.name, "Unnamed product"),
        category: optionalText(product.category),
        brand: optionalText(product.brand),
        imageUrl: optionalText(product.imageUrl),
        caseQuantity: Math.max(1, Number(product.caseQuantity ?? 1)),
        availableStorageQty: Number(product.availableStorageQty ?? 0),
      })).filter((product: ProductOption) => product.id));
      setExtras(nextExtras);
      const responsePreparedBatch = data.preparedBatch as PickListApiPreparedBatch | undefined;
      const parsedPreparedBatch = responsePreparedBatch && responsePreparedBatch.id && Array.isArray(responsePreparedBatch.productSummary)
        ? {
            id: String(responsePreparedBatch.id ?? ""),
            routeId: String(responsePreparedBatch.routeId ?? routeId),
            operatorId: responsePreparedBatch.operatorId ? String(responsePreparedBatch.operatorId) : null,
            status: String(responsePreparedBatch.status ?? "draft"),
            selectedStopIds: Array.isArray(responsePreparedBatch.selectedStopIds) ? responsePreparedBatch.selectedStopIds.map((stopId) => String(stopId ?? "")).filter(Boolean) : [],
            productSummary: responsePreparedBatch.productSummary.map((row: any) => ({
              productId: String(row?.productId ?? row?.product_id ?? ""),
              productName: row?.productName ?? row?.product_name ?? null,
              quantity: Number(row?.quantity ?? 0),
            })).filter((row: PreparedPickupSummaryRow) => row.productId && row.quantity > 0),
            storageDeducted: Boolean(responsePreparedBatch.storageDeducted),
            preparedAt: responsePreparedBatch.preparedAt ? String(responsePreparedBatch.preparedAt) : null,
            preparedBy: responsePreparedBatch.preparedBy ? String(responsePreparedBatch.preparedBy) : null,
            confirmedAt: responsePreparedBatch.confirmedAt ? String(responsePreparedBatch.confirmedAt) : null,
            returnedToAssignedAt: responsePreparedBatch.returnedToAssignedAt ? String(responsePreparedBatch.returnedToAssignedAt) : null,
            returnedToAssignedReason: responsePreparedBatch.returnedToAssignedReason ? String(responsePreparedBatch.returnedToAssignedReason) : null,
            createdAt: responsePreparedBatch.createdAt ? String(responsePreparedBatch.createdAt) : null,
            updatedAt: responsePreparedBatch.updatedAt ? String(responsePreparedBatch.updatedAt) : null,
          }
        : null;
      setPreparedBatch(parsedPreparedBatch);
      setLoadCheckedProductIds(new Set());
      setVehicleClearChecked(false);
      if (parsedPreparedBatch?.id) {
        pickupSubmissionIdRef.current = parsedPreparedBatch.id;
      }
      initialPickDraftRef.current = comparablePickDraft({
        selectedStopIds: nextStopIds,
        stopItems: nextStopGroups.flatMap((group: PickStopGroup) => group.items.map((item) => ({
          routeStopItemId: item.routeStopItemId,
          confirmedQty: item.confirmedQty,
          reason: item.reason,
          notes: item.notes,
        }))),
        extras: nextExtras,
      });
    } catch (err) {
      setError(process.env.NODE_ENV === "development" && err instanceof Error && err.message.trim() ? err.message : "Could not load pickup list. Please retry.");
    } finally {
      setLoading(false);
    }
  }, [routeId, shouldStartRoute]);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      void loadPickList();
    }, 0);

    return () => window.clearTimeout(loadTimer);
  }, [loadPickList]);

  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);

  const maxForProduct = (productId: string, currentQty: number, fallbackAvailable: number) => {
    const available = productById.get(productId)?.availableStorageQty ?? fallbackAvailable;
    const used = pickedByProduct.get(productId) ?? 0;
    return Math.max(0, available - used + currentQty);
  };

  const updateStopItem = (routeStopItemId: string, patch: Partial<PickStopItem>) => {
    if (checklistFrozen) return;
    setStopGroups((prev) => prev.map((group) => ({
      ...group,
      items: group.items.map((item) => (item.routeStopItemId === routeStopItemId ? { ...item, ...patch } : item)),
    })));
  };

  const saveLocalPickupItem = (routeStopItemId: string, isChecked: boolean) => {
    if (!routeStopItemId) return;
    const next = { ...localChecklistRef.current, [routeStopItemId]: isChecked };
    localChecklistRef.current = next;
    writeLocalPickupChecklist(routeId, next);
  };

  const togglePickupItemChecked = async (item: PickStopItem) => {
    if (locked || submitting || checklistFrozen) return;

    const nextChecked = !item.isChecked;
    setChecklistSyncError("");
    updateStopItem(item.routeStopItemId, { isChecked: nextChecked });
    saveLocalPickupItem(item.routeStopItemId, nextChecked);
    setSavingCheckedIds((current) => new Set(current).add(item.routeStopItemId));

    try {
      const response = await fetch(`/api/operator/routes/${routeId}/pick-list`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeStopItemId: item.routeStopItemId,
          isChecked: nextChecked,
          pickedQty: item.confirmedQty,
          reason: item.reason,
          notes: item.notes,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const message = [data?.error, data?.details].filter(Boolean).join(" - ") || "Could not save checklist item. Local state was kept.";
        setChecklistSyncError(message);
        console.error("[operator:pick-list] Checklist backend sync failed; local state kept", {
          routeId,
          routeStopItemId: item.routeStopItemId,
          status: response.status,
          error: data?.error ?? null,
          details: data?.details ?? null,
          response_payload: data ?? null,
        });
      } else {
        const savedChecked = typeof data?.item?.isChecked === "boolean"
          ? data.item.isChecked
          : typeof data?.item?.is_checked === "boolean"
            ? data.item.is_checked
            : nextChecked;
        updateStopItem(item.routeStopItemId, { isChecked: savedChecked });
        setNotice(data?.localOnly ? "Saved locally. Server sync will catch up later." : "Saved.");
        console.info("[operator:pick-list] Checklist backend sync succeeded", {
          routeId,
          routeStopItemId: item.routeStopItemId,
          response_payload: data ?? null,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save checklist item. Local state was kept.";
      setChecklistSyncError(message);
      console.error("[operator:pick-list] Checklist backend sync unavailable; local state kept", {
        routeId,
        routeStopItemId: item.routeStopItemId,
        error: err,
      });
    } finally {
      setSavingCheckedIds((current) => {
        const next = new Set(current);
        next.delete(item.routeStopItemId);
        return next;
      });
    }
  };

  const addExtraProduct = () => {
    if (checklistFrozen) return;
    setExtras((prev) => [...prev, newExtraRow()]);
    setError("");
  };

  const toggleStopSelection = (stopId: string) => {
    if (checklistFrozen) return;
    setSelectedStopIds((current) => current.includes(stopId) ? current.filter((id) => id !== stopId) : [...current, stopId]);
  };

  const toggleLocationSelection = (stopIds: string[], shouldSelect: boolean) => {
    if (checklistFrozen) return;
    setSelectedStopIds((current) => {
      if (shouldSelect) {
        const next = new Set(current);
        stopIds.forEach((stopId) => next.add(stopId));
        return Array.from(next);
      }
      return current.filter((stopId) => !stopIds.includes(stopId));
    });
  };

  const toggleChecklistFamily = (familyKey: string, defaultExpanded = false) => {
    setExpandedChecklistFamilyKeys((current) => ({
      ...current,
      [familyKey]: !(current[familyKey] ?? defaultExpanded),
    }));
  };

  const handlePreviewRefresh = async () => {
    setRefreshPreview({ loading: true, applying: false, comparisons: [], message: "", error: "" });
    setError("");
    const result = await previewPendingStopRecommendationRefresh(routeId);
    if (!result.success) {
      setRefreshPreview({ loading: false, applying: false, comparisons: [], message: "", error: result.error || "Could not refresh pending recommendations." });
      return;
    }
    setRefreshPreview({
      loading: false,
      applying: false,
      comparisons: result.comparisons ?? [],
      message: result.hasChanges
        ? "Review recommendation changes before applying them to pending stops."
        : result.eligibleStopCount
          ? "Pending recommendations are already current."
          : "There are no pending stops to refresh.",
      error: "",
    });
  };

  const handleApplyRefresh = async () => {
    setRefreshPreview((current) => ({ ...current, applying: true, error: "" }));
    const result = await applyPendingStopRecommendationRefresh(routeId);
    if (!result.success) {
      setRefreshPreview((current) => ({ ...current, applying: false, error: result.error || "Could not apply pending updates." }));
      return;
    }
    setRefreshPreview({ loading: false, applying: false, comparisons: [], message: result.message || "Pending stop recommendations refreshed.", error: "" });
    setNotice(result.message || "Pending stop recommendations refreshed.");
    await loadPickList({ keepSelection: true });
  };

  const handlePreparePickup = async () => {
    if (locked) {
      router.push(routeHref);
      return;
    }

    if (!selectedStopIds.length) {
      setError("Choose at least one pending machine stop for this pickup batch.");
      return;
    }

    const invalidExtra = extras.find((item) => item.productId && item.quantity > 0 && !item.targetStopId);
    if (invalidExtra) {
      setError("Choose a machine/stop for the added product, or mark it as extra carried stock.");
      return;
    }

    if (!allDetailedItemsChecked) {
      setError("Check every required product line before pressing Items prepared.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const items = allStopItems.map((item) => ({
        routeStopItemId: item.routeStopItemId,
        routeStopId: item.routeStopId,
        machineId: item.machineId,
        productId: item.productId,
        quantity: item.confirmedQty,
        plannedQty: item.requestedQty,
        reason: item.reason,
        notes: item.notes,
        isChecked: item.isChecked,
      }));
      const result = await confirmPickList(
        routeId,
        items,
        extras
          .filter((item) => item.productId && item.quantity > 0)
          .map((item) => {
            const stop = submittedRouteStopId(item.targetStopId) ? stopById.get(submittedRouteStopId(item.targetStopId) as string) : null;
            return {
              routeStopId: submittedRouteStopId(item.targetStopId),
              machineId: stop?.machineId ?? null,
              productId: item.productId,
              quantity: item.quantity,
              reason: item.reason,
              notes: item.notes,
            };
          }),
        {
          stopIds: selectedStopIds,
          clientSubmissionId: pickupSubmissionIdRef.current,
          acknowledgedPickupLineIds,
          stage: "prepare",
        },
      );
      if (!result.success) {
        throw new Error(result.error || "Could not save the prepared pickup snapshot.");
      }

      const preparedSummary = Array.isArray(result.productSummary)
        ? result.productSummary.map((row: any) => ({
            productId: String(row?.productId ?? row?.product_id ?? ""),
            productName: row?.productName ?? row?.product_name ?? null,
            quantity: Number(row?.quantity ?? 0),
          })).filter((row: PreparedPickupSummaryRow) => row.productId && row.quantity > 0)
        : preparedLoadRows.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
          }));
      const nextPreparedBatch: PreparedPickupBatch = {
        id: String(result.pickupBatchId ?? pickupSubmissionIdRef.current),
        routeId,
        operatorId: null,
        status: "draft",
        selectedStopIds: [...selectedStopIds],
        productSummary: preparedSummary,
        storageDeducted: false,
        preparedAt: new Date().toISOString(),
        preparedBy: null,
        confirmedAt: null,
        returnedToAssignedAt: null,
        returnedToAssignedReason: null,
        createdAt: null,
        updatedAt: null,
      };
      setPreparedBatch(nextPreparedBatch);
      setLoadCheckedProductIds(new Set());
      setVehicleClearChecked(false);
      pickupSubmissionIdRef.current = nextPreparedBatch.id;
      setNotice("Items prepared. Load checklist is ready.");
      localDraft.clearDraft();
      await loadPickList({ keepSelection: true });
    } catch (err) {
      setError(err instanceof Error && err.message.trim() ? err.message : "Could not prepare this pickup. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmPick = async () => {
    if (locked) {
      router.push(routeHref);
      return;
    }

    if (!activePreparedBatch) {
      setError("Press Items prepared before confirming pickup.");
      return;
    }

    if (!allLoadRowsChecked || !vehicleClearChecked) {
      setError("Check every loaded product and the final storage confirmation before confirming pickup.");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const items = allStopItems.map((item) => ({
        routeStopItemId: item.routeStopItemId,
        routeStopId: item.routeStopId,
        machineId: item.machineId,
        productId: item.productId,
        quantity: item.confirmedQty,
        plannedQty: item.requestedQty,
        reason: item.reason,
        notes: item.notes,
        isChecked: item.isChecked,
      }));
      const result = await confirmPickList(
        routeId,
        items,
        extras
          .filter((item) => item.productId && item.quantity > 0)
          .map((item) => {
            const stop = submittedRouteStopId(item.targetStopId) ? stopById.get(submittedRouteStopId(item.targetStopId) as string) : null;
            return {
              routeStopId: submittedRouteStopId(item.targetStopId),
              machineId: stop?.machineId ?? null,
              productId: item.productId,
              quantity: item.quantity,
              reason: item.reason,
              notes: item.notes,
            };
          }),
        {
          stopIds: selectedStopIds,
          clientSubmissionId: pickupSubmissionIdRef.current,
          acknowledgedPickupLineIds,
          stage: "confirm",
          preparedBatchId: activePreparedBatch.id,
        },
      );
      if (result && "success" in result && result.success === false) {
        throw new Error(result.error || "Could not save added product");
      }
      localDraft.clearDraft();
      pickupSubmissionIdRef.current = crypto.randomUUID();
      setPreparedBatch(null);
      setLoadCheckedProductIds(new Set());
      setVehicleClearChecked(false);
      const successMessage = "Pickup confirmed.";
      console.info("[operator:route-nav] Redirecting after pickup confirmation", {
        action: "confirm_pick_list",
        routeId,
        redirectPath: `${routeHref}?success=${encodeURIComponent(successMessage)}`,
      });
      router.push(`${routeHref}?success=${encodeURIComponent(successMessage)}`);
    } catch (err) {
      setError(err instanceof Error && err.message.trim() ? err.message : "Could not confirm pickup. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <LoadingState variant="cards" cards={4} />;
  }

  if (!routeId) {
    return (
      <>
        <ErrorState
          title={t("Route id missing")}
          body={t("This pick-list page was opened without a valid route id.")}
          action={<SecondaryButton href="/operator">{t("Back to operator home")}</SecondaryButton>}
        />
      </>
    );
  }

  return (
    <>
      <div className="max-w-5xl space-y-6">
        <PageHeader title={t("Storage Pickup")} subtitle={t("Pack products by machine before leaving storage.")} action={<SecondaryButton href={routeHref}>{t("Cancel")}</SecondaryButton>} />

        {!checklistFrozen ? <DraftRestoreBanner pendingDraft={localDraft.pendingDraft} onRestore={localDraft.restoreDraft} onDiscard={localDraft.discardDraft} /> : null}
        {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}
        {notice ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800">{t(notice, notice)}</div> : null}
        {error ? <div ref={errorRef} className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{t(error, error)}</div> : null}

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">{t("Pending stop recommendations")}</h2>
              <p className="mt-1 text-sm text-slate-500">{t("Refresh pending machines before confirming this pickup batch.")}</p>
            </div>
            <button type="button" onClick={handlePreviewRefresh} className="btn-secondary w-full sm:w-auto" disabled={locked || refreshPreview.loading || refreshPreview.applying}>
              {refreshPreview.loading ? `${t("Checking")}...` : t("Refresh recommendations for pending stops")}
            </button>
          </div>
          {refreshPreview.error ? <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{t(refreshPreview.error, refreshPreview.error)}</div> : null}
          {refreshPreview.message ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{t(refreshPreview.message, refreshPreview.message)}</div> : null}
          {refreshPreview.comparisons.length ? (
            <div className="mt-4 space-y-3">
              {refreshPreview.comparisons.map((machine) => (
                <div key={machine.routeStopId} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="font-semibold text-slate-900">Machine {machine.stopOrder}: {machine.machineName}</div>
                  <div className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
                    {machine.changes.map((change) => (
                      <div key={change.productId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-sm">
                        <span className="min-w-0 break-words font-medium text-slate-900">{change.productName}</span>
                        <span className={change.difference > 0 ? "font-semibold text-emerald-700" : change.difference < 0 ? "font-semibold text-rose-700" : "font-semibold text-slate-700"}>
                          {change.oldQty} -&gt; {change.newQty} ({change.difference > 0 ? `+${change.difference}` : change.difference})
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex flex-col gap-2 sm:flex-row">
                <button type="button" onClick={handleApplyRefresh} className="btn-primary w-full sm:w-auto" disabled={refreshPreview.applying}>
                  {refreshPreview.applying ? `${t("Applying")}...` : t("Accept Updates")}
                </button>
                <button type="button" onClick={() => setRefreshPreview({ loading: false, applying: false, comparisons: [], message: "Current plan kept.", error: "" })} className="btn-secondary w-full sm:w-auto" disabled={refreshPreview.applying}>
                  {t("Keep Current Plan")}
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <div className="grid gap-3 sm:grid-cols-3">
          <SectionCard>
            <div className="p-4">
              <p className="mb-1 text-xs text-slate-500">{t("Checklist")}</p>
              <p className="text-2xl font-bold text-slate-900">{t("Picked")} {checkedItemCount} {t("of")} {allStopItems.length} {t("items")}</p>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${checklistProgress}%` }} />
              </div>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <p className="mb-1 text-xs text-slate-500">{t("Selected stops")}</p>
              <p className="text-2xl font-bold text-slate-900">{selectedStopIds.length} / {stopGroups.length}</p>
              <p className="mt-2 text-xs text-slate-500">{selectedLocationCount} {t("locations in this pickup batch")}</p>
            </div>
          </SectionCard>
          <SectionCard>
            <div className="p-4">
              <p className="mb-1 text-xs text-slate-500">{t("Units left")}</p>
              <p className="text-2xl font-bold text-slate-900">{remainingUnitCount}</p>
              <p className="mt-2 text-xs text-slate-500">{remainingItemCount} {t("checklist rows still to pick")}</p>
            </div>
          </SectionCard>
        </div>

        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <div className="font-semibold">{t("Pickup progress saves on this phone immediately")}</div>
          <div className="mt-1">{t("If the backend is slow or offline, your checklist stays locally saved and sync can catch up later.")}</div>
        </div>
        {activePreparedBatch ? (
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
            <div className="font-semibold">{t("Items prepared snapshot saved")}</div>
            <div className="mt-1">{t("The detailed checklist is frozen. Load the prepared products into the vehicle, then confirm the storage is clear before pickup confirmation.")}</div>
          </div>
        ) : null}

        {stopGroups.length ? (
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-semibold text-slate-900">{t("Select stops for this pickup batch")}</h2>
                <p className="text-sm text-slate-500">{t("Only selected machines are deducted from storage and added to your bag.")}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="btn-secondary text-xs" onClick={() => setSelectedStopIds(stopGroups.map((group) => group.routeStopId).filter((id): id is string => Boolean(id)))} disabled={checklistFrozen || locked}>{t("Select all")}</button>
                <button type="button" className="btn-secondary text-xs" onClick={() => setSelectedStopIds([])} disabled={checklistFrozen || locked}>{t("Clear")}</button>
              </div>
            </div>
            <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-200">
              <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${selectedStopProgress}%` }} />
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {stopGroupsByLocation.map((locationGroup) => {
                const locationStopIds = locationGroup.groups.map((group) => group.routeStopId).filter((stopId): stopId is string => Boolean(stopId));
                const selectedCount = locationStopIds.filter((stopId) => selectedStopIds.includes(stopId)).length;
                const selectionProgress = progressPercent(selectedCount, locationStopIds.length);
                const allSelected = locationStopIds.length > 0 && selectedCount === locationStopIds.length;
                return (
                <div key={locationGroup.locationName} className="space-y-2">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locationGroup.locationName}</div>
                        <div className="mt-1 text-sm font-medium text-slate-900">
                          {locale === "ar" ? `تم تحديد ${selectedCount} من ${locationStopIds.length} مواقع` : `${selectedCount} of ${locationStopIds.length} stops selected`}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => toggleLocationSelection(locationStopIds, true)} disabled={checklistFrozen || !locationStopIds.length || allSelected}>Select location</button>
                        <button type="button" className="btn-secondary px-3 py-2 text-xs" onClick={() => toggleLocationSelection(locationStopIds, false)} disabled={checklistFrozen || !selectedCount}>{t("Clear")}</button>
                      </div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                      <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${selectionProgress}%` }} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    {locationGroup.groups.map((group) => {
                      const stopId = group.routeStopId ?? "";
                      const checked = Boolean(stopId && selectedStopIds.includes(stopId));
                      const planned = group.items.reduce((sum, item) => sum + item.requestedQty, 0);
                      return (
                        <label key={stopId || group.machineId || group.machineName} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${checked ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
                          <input type="checkbox" checked={checked} onChange={() => stopId && toggleStopSelection(stopId)} disabled={checklistFrozen || locked} className="mt-1 h-6 w-6 rounded accent-emerald-600" />
                          <span className="min-w-0">
                            <span className="block font-semibold text-slate-900">{locale === "ar" ? `الموقع ${group.stopOrder || "-"} - ${group.machineName}` : `Stop ${group.stopOrder || "-"} - ${group.machineName}`}</span>
                            <span className="block break-words text-slate-500">
                              {group.machineCode && group.machineCode !== "-" && group.machineCode !== group.machineName ? `${group.machineCode} · ` : ""}
                              {locale === "ar" ? `${planned} وحدة مخططة` : `${planned} units planned`}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
          </section>
        ) : null}

        {stopGroups.length === 0 ? (
          routeItemCount === 0 ? (
            <EmptyState title={t("No pickup items found for this route")} body={t("No pickup items found for this route")} />
          ) : (
            <EmptyState title={t("No pending pickup items")} body={t("All machine stops are already picked, completed, or skipped. Continue active stops from the route page.")} />
          )
        ) : selectedStopGroups.length === 0 ? (
          <EmptyState title={t("No stops selected")} body={t("Choose at least one pending machine stop for this pickup batch.")} />
        ) : (
          <section className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-200 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 className="font-semibold text-slate-900">{t("Warehouse checklist")}</h2>
                  <p className="text-sm text-slate-500">{t("Tap a product row after you physically pick it from storage.")}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
                  {t("Picked")} {checkedItemCount} {t("of")} {allStopItems.length}
                </div>
              </div>
              {checklistSyncError ? <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{t("Pickup checklist save issue")}: {t(checklistSyncError, checklistSyncError)}</div> : null}
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${checklistProgress}%` }} />
              </div>
            </div>
            <div className="space-y-4 p-4">
              {selectedStopGroupsByLocation.map((locationGroup) => {
                const locationItems = locationGroup.groups.flatMap((group) => group.items);
                const locationCheckedCount = locationItems.filter((item) => item.isChecked).length;
                const locationProgress = progressPercent(locationCheckedCount, locationItems.length);
                return (
                  <section key={locationGroup.locationName} className="space-y-3">
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{locationGroup.locationName}</div>
                          <div className="mt-1 text-sm font-medium text-slate-900">{locationCheckedCount} of {locationItems.length} products picked</div>
                        </div>
                        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
                          {locationProgress}% complete
                        </div>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${locationProgress}%` }} />
                      </div>
                    </div>
                    {locationGroup.groups.map((group) => {
                      const groupedItems = groupRouteItemsForDisplay(group.items.map((item) => ({
                        ...item,
                        quantity: item.confirmedQty,
                        checked: item.isChecked,
                        sortKey: `${group.stopOrder ?? 0}|${item.productName}|${item.routeStopItemId}`,
                      })));
                      const groupCheckedCount = group.items.filter((item) => item.isChecked).length;
                      const groupProgress = progressPercent(groupCheckedCount, group.items.length);
                      const groupKey = group.routeStopId ?? group.machineId ?? `${group.machineName}-${group.stopOrder}`;
                      return (
                        <article key={groupKey} className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                          <div className="flex flex-col gap-2 border-b border-slate-200 bg-white p-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <h3 className="break-words text-base font-semibold text-slate-900">{group.machineName}</h3>
                              <p className="mt-1 break-words text-sm text-slate-500">
                                Stop {group.stopOrder || "-"}
                              </p>
                              <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-200">
                                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${groupProgress}%` }} />
                              </div>
                            </div>
                            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-900">
                              Picked {groupCheckedCount} of {group.items.length}
                            </div>
                          </div>
                          <div className="space-y-3 border-t border-slate-200 p-3">
                            {groupedItems.map((familyGroup) => {
                              const familyKey = `${groupKey}:${familyGroup.groupKey}`;
                              const familyExpanded = expandedChecklistFamilyKeys[familyKey] ?? familyGroup.defaultExpanded;
                              return (
                                <section key={familyKey} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                                  <button
                                    type="button"
                                    onClick={() => toggleChecklistFamily(familyKey, familyGroup.defaultExpanded)}
                                    className="flex w-full items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 text-left"
                                  >
                                    <div className="min-w-0">
                                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{familyGroup.groupLabel}</div>
                                      <div className="mt-1 text-sm font-semibold text-slate-900">
                                        {familyGroup.checkedCount}/{familyGroup.itemCount} checked · {familyGroup.totalQuantity} units
                                      </div>
                                    </div>
                                    <div className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                                      {familyExpanded ? "Hide" : "Show"}
                                    </div>
                                  </button>

                                  {familyExpanded ? (
                                    <div className="divide-y divide-slate-200">
                                      {familyGroup.items.map((item) => {
                                        const maxQty = maxForProduct(item.productId, item.confirmedQty, item.availableStorageQty);
                                        const saving = savingCheckedIds.has(item.routeStopItemId);
                                        const priorityBadge = pickupPriorityBadge(item.productName);
                                        return (
                                          <div
                                            key={item.routeStopItemId}
                                            role="button"
                                            tabIndex={locked || checklistFrozen ? -1 : 0}
                                            onClick={() => togglePickupItemChecked(item)}
                                            onKeyDown={(event) => {
                                              if (event.key === "Enter" || event.key === " ") {
                                                event.preventDefault();
                                                togglePickupItemChecked(item);
                                              }
                                            }}
                                            className={`cursor-pointer space-y-4 p-4 transition ${item.isChecked ? "bg-emerald-50" : "bg-white hover:bg-slate-50"} ${saving ? "opacity-70" : ""}`}
                                          >
                                            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_190px] md:items-start">
                                              <div className="flex min-w-0 gap-3">
                                                <input
                                                  type="checkbox"
                                                  checked={item.isChecked}
                                                  onChange={() => togglePickupItemChecked(item)}
                                                  onClick={(event) => event.stopPropagation()}
                                                  disabled={locked || submitting || checklistFrozen}
                                                  aria-label={`Mark ${item.productName} picked`}
                                                  className="mt-1 h-11 w-11 shrink-0 cursor-pointer rounded-lg border-2 border-slate-300 accent-emerald-600 disabled:cursor-not-allowed"
                                                />
                                                <div className="min-w-0">
                                                  <div className="flex flex-wrap items-center gap-2">
                                                    <p className={`break-words font-semibold ${item.isChecked ? "text-emerald-950" : "text-slate-900"}`}>{item.productName}</p>
                                                    {priorityBadge ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${priorityBadge.className}`}>{priorityBadge.label}</span> : null}
                                                    {saving ? <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">Saving</span> : null}
                                                  </div>
                                                  <p className="mt-1 break-words text-xs text-slate-500">
                                                    SKU: {item.sku ?? "No SKU"} - Recommended: {formatProductQuantity(item.requestedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })} - Route storage: {formatProductQuantity(item.availableStorageQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}
                                                  </p>
                                                  <p className="mt-1 text-xs text-slate-500">{item.source === "manual_admin_assignment" ? "Manual assignment" : "Refill recommendation"}</p>
                                                </div>
                                              </div>
                                              <label className="block" onClick={(event) => event.stopPropagation()}>
                                                <span className="mb-1 block text-sm font-medium text-slate-800">Pickup qty</span>
                                                <QuantityStepper
                                                  value={item.confirmedQty}
                                                  max={maxQty}
                                                  onChange={(quantity) => updateStopItem(item.routeStopItemId, { confirmedQty: quantity })}
                                                  disabled={locked || checklistFrozen}
                                                  inputLabel={`${item.machineName} ${item.productName} pickup quantity`}
                                                />
                                                <span className="mt-1 block text-xs text-slate-500">Available for this row: {formatProductQuantity(maxQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}</span>
                                              </label>
                                            </div>

                                            {item.confirmedQty !== item.requestedQty ? (
                                              <div className="grid gap-3 md:grid-cols-2" onClick={(event) => event.stopPropagation()}>
                                                <label className="block">
                                                  <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
                                                  <select value={item.reason} onChange={(event) => updateStopItem(item.routeStopItemId, { reason: event.target.value })} className="field-input" disabled={locked || checklistFrozen}>
                                                    <option>Product not available in storage</option>
                                                    <option>Product not in operator bag</option>
                                                    <option>Product expired/damaged</option>
                                                    <option>Customer demand</option>
                                                    <option>Other</option>
                                                  </select>
                                                </label>
                                                <label className="block">
                                                  <span className="mb-1 block text-sm font-medium text-slate-800">Notes</span>
                                                  <input value={item.notes} onChange={(event) => updateStopItem(item.routeStopItemId, { notes: event.target.value })} className="field-input" placeholder="Explain the pickup change" disabled={locked || checklistFrozen} />
                                                </label>
                                              </div>
                                            ) : null}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  ) : null}
                                </section>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          </section>
        )}

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">Added products before leaving storage</h2>
              <p className="text-sm text-slate-500">{assignedExtraCount} assigned to stops, {unassignedExtraCount} carried as spare stock</p>
            </div>
            <button type="button" className="btn-secondary w-full sm:w-auto" onClick={addExtraProduct} disabled={locked || checklistFrozen}>Add Product</button>
          </div>
          <div className="mt-4 space-y-3">
            {extras.map((item) => (
              <AdjustmentRow
                key={item.id}
                products={productOptions}
                stopGroups={selectedStopGroups}
                targetStopId={item.targetStopId}
                productId={item.productId}
                quantity={item.quantity}
                reason={item.reason}
                notes={item.notes}
                disabled={locked || checklistFrozen}
                maxQuantity={item.productId ? maxForProduct(item.productId, item.quantity, productById.get(item.productId)?.availableStorageQty ?? 0) : 0}
                onChange={(patch) => setExtras((prev) => prev.map((row) => row.id === item.id ? { ...row, ...patch } : row))}
                onRemove={() => setExtras((prev) => prev.filter((row) => row.id !== item.id))}
              />
            ))}
            {!extras.length ? <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No added products.</p> : null}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="font-semibold text-slate-900">Route total</h2>
          <div className="mt-3 divide-y divide-slate-200">
            {routeTotals.map((item) => (
              <div key={item.productId} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="break-words font-medium text-slate-900">{item.productName}</p>
                  <p className="text-xs text-slate-500">{item.sku ?? "No SKU"} - Storage {formatProductQuantity(item.availableStorageQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}</p>
                </div>
                <div className="text-right font-semibold text-slate-900">
                  {formatProductQuantity(item.confirmedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })} / {formatProductQuantity(item.plannedQty, { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory }, { compact: true })}
                </div>
              </div>
            ))}
            {!routeTotals.length ? <p className="py-3 text-sm text-slate-500">No route totals yet.</p> : null}
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">{t("Load into vehicle")}</h2>
              <p className="text-sm text-slate-500">
                {activePreparedBatch
                  ? t("Check each prepared product before confirming the route pickup.")
                  : t("Prepare the detailed checklist first to unlock this loading checklist.")}
              </p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-900">
              {activePreparedBatch ? `${preparedLoadRows.filter((item) => loadCheckedProductIds.has(item.productId)).length} / ${preparedLoadRows.length}` : t("Locked")}
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {activePreparedBatch ? (
              preparedLoadRows.map((item) => {
                const checked = loadCheckedProductIds.has(item.productId);
                return (
                  <label
                    key={item.productId}
                    className={`flex items-center gap-4 rounded-xl border p-4 ${checked ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setLoadCheckedProductIds((current) => {
                        const next = new Set(current);
                        if (next.has(item.productId)) next.delete(item.productId);
                        else next.add(item.productId);
                        return next;
                      })}
                      disabled={!activePreparedBatch || locked || submitting}
                      className="h-8 w-8 rounded border-2 border-slate-300 accent-emerald-600 disabled:cursor-not-allowed"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="break-words font-semibold text-slate-900">{item.productName ?? "Unknown product"}</div>
                      <div className="mt-1 text-sm text-slate-500">{formatProductQuantity(item.quantity, { caseQuantity: productById.get(item.productId)?.caseQuantity ?? 1, productName: item.productName ?? productById.get(item.productId)?.name, category: productById.get(item.productId)?.category }, { compact: true })}</div>
                    </div>
                  </label>
                );
              })
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500">
                {t("No loading checklist is available yet.")}
              </div>
            )}
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={vehicleClearChecked}
                onChange={() => setVehicleClearChecked((current) => !current)}
                disabled={!activePreparedBatch || locked || submitting}
                className="mt-1 h-6 w-6 rounded accent-emerald-600 disabled:cursor-not-allowed"
              />
              <span className="min-w-0">
                <span className="block font-semibold text-slate-900">{t("I checked the preparation area and no route products remain in storage.")}</span>
                <span className="mt-1 block text-xs text-slate-500">{t("This is the final confirmation before pickup is submitted.")}</span>
              </span>
            </label>
          </div>
        </section>

        <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-3 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 sm:flex-1">
            <div className="font-semibold text-slate-900">{checkedItemCount} of {allStopItems.length} items checked</div>
            <div className="mt-1 text-xs text-slate-500">
              {selectedStopIds.length} stops selected · {totalPickedUnits} total units in this pickup batch
              {activePreparedBatch ? ` · ${preparedLoadRows.filter((item) => loadCheckedProductIds.has(item.productId)).length} of ${preparedLoadRows.length} load items checked` : ""}
            </div>
          </div>
          {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 sm:hidden">{t(error, error)}</div> : null}
          <button
            type="button"
            onClick={activePreparedBatch ? handleConfirmPick : handlePreparePickup}
            disabled={submitting || (!locked ? (activePreparedBatch ? !canConfirmPickup : !canPreparePickup) : false)}
            className="btn-primary w-full flex-1 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {locked
              ? t("Back to Route")
              : submitting
                ? `${t("Saving")}...`
                : activePreparedBatch
              ? t("Confirm Pickup List")
                  : t("Items prepared")}
          </button>
          {activePreparedBatch && error ? (
            <button
              type="button"
              onClick={handleConfirmPick}
              disabled={submitting || !canConfirmPickup}
              className="btn-secondary w-full flex-1 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("Retry confirmation")}
            </button>
          ) : null}
          <SecondaryButton href={routeHref} type="button">{t("Cancel")}</SecondaryButton>
        </div>
      </div>
    </>
  );
}

function AdjustmentRow({
  products,
  stopGroups,
  targetStopId,
  productId,
  quantity,
  reason,
  notes,
  disabled = false,
  maxQuantity,
  onChange,
  onRemove,
}: {
  products: ProductOption[];
  stopGroups: PickStopGroup[];
  targetStopId: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
  disabled?: boolean;
  maxQuantity: number;
  onChange: (patch: Partial<ExtraPickItem>) => void;
  onRemove: () => void;
}) {
  const selectedProduct = products.find((product) => product.id === productId);
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_140px]">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Machine / stop</span>
          <select
            value={targetStopId}
            onChange={(event) => onChange({ targetStopId: event.target.value })}
            className="field-input"
            disabled={disabled}
          >
            <option value="">Select machine/stop</option>
            {stopGroups.map((group) => (
              <option key={group.routeStopId ?? group.machineId ?? group.machineName} value={group.routeStopId ?? ""}>
                Stop {group.stopOrder || "-"} - {group.machineName} / {group.locationName}
              </option>
            ))}
            <option value={UNASSIGNED_EXTRA_TARGET}>Extra carried products / not assigned</option>
          </select>
        </label>
        <ProductCombobox products={products} label="Product" productId={productId} disabled={disabled || !targetStopId} onChange={(nextProductId) => onChange({ productId: nextProductId, quantity: 0 })} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Qty</span>
          <QuantityStepper
            value={quantity}
            max={maxQuantity}
            onChange={(nextQuantity) => onChange({ quantity: nextQuantity })}
            disabled={disabled || !productId}
            inputLabel="Added product quantity"
          />
          {selectedProduct ? <span className="mt-1 block text-xs text-slate-500">{formatProductQuantity(quantity, { caseQuantity: selectedProduct.caseQuantity, productName: selectedProduct.name, category: selectedProduct.category }, { compact: true })}</span> : null}
        </label>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_2fr]">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
          <select value={reason} onChange={(event) => onChange({ reason: event.target.value })} className="field-input" disabled={disabled}>
            <option>Product not available in storage</option>
            <option>Product expired/damaged</option>
            <option>Customer demand</option>
            <option>Other</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Notes</span>
          <input value={notes} onChange={(event) => onChange({ notes: event.target.value })} className="field-input" placeholder="Notes" disabled={disabled} />
        </label>
      </div>
      <button type="button" onClick={onRemove} className="mt-2 text-sm font-medium text-rose-700" disabled={disabled}>Remove</button>
    </div>
  );
}

function ProductCombobox({
  products,
  label,
  productId,
  disabled = false,
  onChange,
}: {
  products: ProductOption[];
  label: string;
  productId: string;
  disabled?: boolean;
  onChange: (productId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.id === productId);
  const filtered = products
    .filter((product) => !query.trim() || [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => comparePickupProductRows(
      { productName: a.name, productCategory: a.category },
      { productName: b.name, productCategory: b.category },
    ) || a.name.localeCompare(b.name))
    .slice(0, 8);

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-h-12 w-full rounded-md border-0 px-2 py-2 text-base outline-none ring-0 disabled:bg-slate-50 md:text-sm"
          placeholder={selected ? `${selected.name} - ${selected.sku ?? "No SKU"}` : "Search name, SKU, barcode, category, brand"}
          disabled={disabled}
        />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {selected && !query.trim() ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              Selected: {selected.name} - Storage {formatProductQuantity(selected.availableStorageQty, { caseQuantity: selected.caseQuantity, productName: selected.name, category: selected.category }, { compact: true })}
            </div>
          ) : null}
          {filtered.map((product) => {
            const outOfStock = product.availableStorageQty <= 0 && product.id !== productId;
            return (
              <button
                key={product.id}
                type="button"
                onClick={() => {
                  if (outOfStock) return;
                  onChange(product.id);
                  setQuery("");
                }}
                disabled={disabled || outOfStock}
                className={`min-h-14 w-full rounded-md px-3 py-2 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60 ${product.id === productId ? "brand-selected" : "hover:bg-slate-100"}`}
              >
                <span className="flex items-center gap-3">
                  <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{product.name}</span>
                    <span className={`block truncate ${product.id === productId ? "text-white/80" : "text-slate-500"}`}>{product.sku ?? "No SKU"} - Storage {formatProductQuantity(product.availableStorageQty, { caseQuantity: product.caseQuantity, productName: product.name, category: product.category }, { compact: true })}{outOfStock ? " available" : ""}</span>
                  </span>
                </span>
              </button>
            );
          })}
          {!filtered.length ? <p className="px-3 py-2 text-sm text-slate-500">No products found.</p> : null}
        </div>
      </div>
    </div>
  );
}
