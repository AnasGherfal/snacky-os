"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { DraftRestoreBanner, DraftSaveStatus, useDraftKey, useLocalDraft } from "@/components/LocalDraft";
import { useLanguage } from "@/components/I18nProvider";
import { QuantityStepper } from "@/components/QuantityStepper";
import { ErrorState, LoadingState, PageHeader, SecondaryButton, SectionCard } from "@/components/ui";
import { finalizeRouteInventory } from "@/lib/operator-actions";

interface LeftoverItem {
  productId: string;
  productName: string;
  bagOwnerId: string | null;
  bagOwnerName?: string | null;
  signedQuantity: number;
  quantity: number;
}

type ReconciliationItem = {
  productId: string;
  productName: string;
  loadedQty: number;
  filledQty: number;
  returnedQty: number;
  damagedQty: number;
  soldQty: number;
  compensatedQty: number;
  machineStorageQty: number;
  machineReturnQty: number;
  adjustmentQty: number;
  remainingQty: number;
};

type ReturnStorageOption = {
  id: string;
  name: string;
  locationType: string;
};

type ProductOption = {
  id: string;
  name: string;
  sku: string | null;
};

type TerminalStopSummary = {
  id: string;
  machineId: string | null;
  machineName: string | null;
  machineCode: string | null;
  locationName: string | null;
  stopOrder: number;
  status: string;
};

type CompletionReadinessCode =
  | "ROUTE_TERMINAL"
  | "ROUTE_UNASSIGNED"
  | "ROUTE_NOT_ACTIVE"
  | "ROUTE_HAS_NO_STOPS"
  | "STOP_INVENTORY_COMMIT_PENDING"
  | "ROUTE_STOPS_UNFINISHED"
  | null;

type InventoryFinalizationBlockCode =
  | "SERVICES_UNAVAILABLE"
  | "UNASSIGNED_CUSTODY"
  | "MANAGER_RECONCILIATION_REQUIRED"
  | null;

type LeftoversDraft = {
  ledgerToken: string;
  countedQtys: Record<string, number>;
  cancellationReason: string;
  reconciliationReason: string;
  storageLocationId: string;
  unexpectedProductIds: string[];
  confirmedCountKeys: string[];
  emptyBagConfirmed: boolean;
};

function custodyKey(item: Pick<LeftoverItem, "bagOwnerId" | "productId">) {
  return `${item.bagOwnerId ?? "unassigned"}:${item.productId}`;
}

function suggestedPhysicalCounts(items: LeftoverItem[]) {
  return items.reduce<Record<string, number>>((totals, item) => {
    totals[custodyKey(item)] = Math.max(0, Number(item.signedQuantity ?? item.quantity ?? 0));
    return totals;
  }, {});
}

function mergeCustodyItems(...groups: LeftoverItem[][]) {
  const itemsByKey = new Map<string, LeftoverItem>();
  for (const group of groups) {
    for (const item of group) {
      const key = custodyKey(item);
      if (!itemsByKey.has(key)) itemsByKey.set(key, item);
    }
  }
  return Array.from(itemsByKey.values()).sort((left, right) => (
    left.productName.localeCompare(right.productName)
      || String(left.bagOwnerId ?? "").localeCompare(String(right.bagOwnerId ?? ""))
  ));
}

export default function LeftoversPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, locale } = useLanguage();
  const tr = useCallback((en: string, ar: string) => t(en, locale === "ar" ? ar : en), [locale, t]);
  const trRef = useRef(tr);
  useEffect(() => {
    trRef.current = tr;
  }, [tr]);
  const params = useParams<{ id?: string | string[] }>();
  const rawRouteId = params?.id;
  const routeId = Array.isArray(rawRouteId) ? rawRouteId[0] ?? "" : rawRouteId ?? "";
  const isCancelMode = searchParams.get("mode") === "cancel";
  const finalizationMode = isCancelMode ? "cancel" : "complete";
  const leftoversSubmissionRef = useRef({ mode: finalizationMode, id: crypto.randomUUID() });
  useEffect(() => {
    if (leftoversSubmissionRef.current.mode !== finalizationMode) {
      leftoversSubmissionRef.current = { mode: finalizationMode, id: crypto.randomUUID() };
    }
  }, [finalizationMode]);

  const [items, setItems] = useState<LeftoverItem[]>([]);
  const [bagHistoryItems, setBagHistoryItems] = useState<LeftoverItem[]>([]);
  const [activeProductOptions, setActiveProductOptions] = useState<ProductOption[]>([]);
  const [assignedBagOwnerId, setAssignedBagOwnerId] = useState<string | null>(null);
  const [assignedBagOwnerName, setAssignedBagOwnerName] = useState<string | null>(null);
  const [unexpectedProductIds, setUnexpectedProductIds] = useState<string[]>([]);
  const [reconciliation, setReconciliation] = useState<ReconciliationItem[]>([]);
  const [descriptiveReconciliationAvailable, setDescriptiveReconciliationAvailable] = useState(true);
  const [returnStorageOptions, setReturnStorageOptions] = useState<ReturnStorageOption[]>([]);
  const [ledgerToken, setLedgerToken] = useState("");
  const [inventoryFinalizationAvailable, setInventoryFinalizationAvailable] = useState(false);
  const [inventoryFinalizationBlockCode, setInventoryFinalizationBlockCode] = useState<InventoryFinalizationBlockCode>(null);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [routeStatus, setRouteStatus] = useState("");
  const [routeIsTerminal, setRouteIsTerminal] = useState(false);
  const [routeReadyForCompletion, setRouteReadyForCompletion] = useState(false);
  const [canCancel, setCanCancel] = useState(false);
  const [managerRouteAccess, setManagerRouteAccess] = useState(false);
  const [routeDate, setRouteDate] = useState<string | null>(null);
  const [routeReference, setRouteReference] = useState("");
  const [stopSummaries, setStopSummaries] = useState<TerminalStopSummary[]>([]);
  const [pendingStopId, setPendingStopId] = useState<string | null>(null);
  const [totalStopCount, setTotalStopCount] = useState(0);
  const [unfinishedStopCount, setUnfinishedStopCount] = useState(0);
  const [completionReadinessCode, setCompletionReadinessCode] = useState<CompletionReadinessCode>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [progressMessage, setProgressMessage] = useState("");
  const [error, setError] = useState("");
  const [countedQtys, setCountedQtys] = useState<Record<string, number>>({});
  const [cancellationReason, setCancellationReason] = useState("");
  const [reconciliationReason, setReconciliationReason] = useState("");
  const [storageLocationId, setStorageLocationId] = useState("");
  const [confirmedCountKeys, setConfirmedCountKeys] = useState<string[]>([]);
  const [emptyBagConfirmed, setEmptyBagConfirmed] = useState(false);
  const errorAlertRef = useRef<HTMLDivElement>(null);
  const initialLeftoversDraftRef = useRef("");
  const routeHref = routeId
    ? managerRouteAccess ? `/routes/${routeId}` : `/operator/routes/${routeId}`
    : "/operator";
  const draftKey = useDraftKey("route-end", [routeId || "missing-route", finalizationMode]);
  const leftoversDraft = useMemo<LeftoversDraft>(() => ({
    ledgerToken,
    countedQtys,
    cancellationReason,
    reconciliationReason,
    storageLocationId,
    unexpectedProductIds,
    confirmedCountKeys,
    emptyBagConfirmed,
  }), [cancellationReason, confirmedCountKeys, countedQtys, emptyBagConfirmed, ledgerToken, reconciliationReason, storageLocationId, unexpectedProductIds]);
  const shouldSaveLeftoversDraft = useCallback((draft: LeftoversDraft) => {
    if (!routeId || submitting || !initialLeftoversDraftRef.current) return false;
    return JSON.stringify({
      ledgerToken: draft.ledgerToken ?? "",
      countedQtys: draft.countedQtys ?? {},
      cancellationReason: draft.cancellationReason ?? "",
      reconciliationReason: draft.reconciliationReason ?? "",
      storageLocationId: draft.storageLocationId ?? "",
      unexpectedProductIds: draft.unexpectedProductIds ?? [],
      confirmedCountKeys: draft.confirmedCountKeys ?? [],
      emptyBagConfirmed: Boolean(draft.emptyBagConfirmed),
    }) !== initialLeftoversDraftRef.current;
  }, [routeId, submitting]);
  const localDraft = useLocalDraft<LeftoversDraft>({
    key: draftKey,
    value: leftoversDraft,
    shouldSave: shouldSaveLeftoversDraft,
    onRestore: (draft) => {
      if (!ledgerToken || draft.ledgerToken !== ledgerToken) {
        setConfirmedCountKeys([]);
        setEmptyBagConfirmed(false);
        setError(tr("Route stock changed since this draft was saved. The old counts were not restored; count the current bag again.", "تغيّر مخزون الجولة منذ حفظ هذه المسودة. لم تتم استعادة الأعداد القديمة؛ أعد عدّ الحقيبة الحالية."));
        return;
      }
      setCountedQtys(draft.countedQtys ?? {});
      setCancellationReason(draft.cancellationReason ?? "");
      setReconciliationReason(draft.reconciliationReason ?? "");
      setStorageLocationId(draft.storageLocationId ?? "");
      setUnexpectedProductIds(draft.unexpectedProductIds ?? []);
      setConfirmedCountKeys(draft.confirmedCountKeys ?? []);
      setEmptyBagConfirmed(Boolean(draft.emptyBagConfirmed));
    },
  });

  const loadRouteInventorySnapshot = useCallback(async ({ showLoading = false }: { showLoading?: boolean } = {}) => {
    if (!routeId) {
      const missingRouteError = trRef.current("Route id is missing. Go back to your operator routes and open the route again.", "معرّف الجولة مفقود. ارجع إلى جولات المشغل وافتح الجولة مرة أخرى.");
      setError(missingRouteError);
      setLoading(false);
      throw new Error(missingRouteError);
    }

    if (showLoading) setLoading(true);
    try {
      const abortController = new AbortController();
      const timeoutId = window.setTimeout(() => abortController.abort(), 15_000);
      let response: Response;
      let responseText: string;
      try {
        response = await fetch(`/api/operator/routes/${routeId}/picked-items`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: abortController.signal,
        });
        responseText = await response.text();
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === "AbortError") {
          throw new Error(trRef.current("Loading the latest route stock timed out. Check your connection and try again.", "انتهت مهلة تحميل أحدث مخزون للجولة. تحقق من اتصالك وحاول مرة أخرى."));
        }
        throw fetchError;
      } finally {
        window.clearTimeout(timeoutId);
      }

      let data: Record<string, unknown> = {};
      if (responseText) {
        try {
          const parsed: unknown = JSON.parse(responseText);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            data = parsed as Record<string, unknown>;
          }
        } catch {
          if (response.ok) {
            throw new Error(trRef.current("The route inventory service returned an invalid response. Try again.", "أعادت خدمة مخزون الجولة استجابة غير صالحة. حاول مرة أخرى."));
          }
        }
      }
      if (!response.ok) {
        const responseError = typeof data.error === "string" ? data.error : "";
        throw new Error(responseError || trRef.current("Failed to fetch picked items", "تعذر تحميل الأصناف المستلمة"));
      }
      const nextItems: LeftoverItem[] = Array.isArray(data.items) ? data.items : [];
      const nextBagHistoryItems: LeftoverItem[] = Array.isArray(data.bagHistoryItems) ? data.bagHistoryItems : [];
      const nextActiveProductOptions: ProductOption[] = Array.isArray(data.activeProductOptions) ? data.activeProductOptions : [];
      const nextAssignedBagOwnerId = data.assignedBagOwnerId ? String(data.assignedBagOwnerId) : null;
      const nextAssignedBagOwnerName = data.assignedBagOwnerName ? String(data.assignedBagOwnerName) : null;
      const nextReconciliation: ReconciliationItem[] = Array.isArray(data.reconciliation) ? data.reconciliation : [];
      const nextStorageOptions: ReturnStorageOption[] = Array.isArray(data.returnStorageOptions) ? data.returnStorageOptions : [];
      const nextLedgerToken = typeof data.ledgerToken === "string" ? data.ledgerToken : "";
      const nextFinalizationAvailable = data.inventoryFinalizationAvailable === true;
      setItems(nextItems);
      setBagHistoryItems(nextBagHistoryItems);
      setActiveProductOptions(nextActiveProductOptions);
      setAssignedBagOwnerId(nextAssignedBagOwnerId);
      setAssignedBagOwnerName(nextAssignedBagOwnerName);
      setUnexpectedProductIds([]);
      setCancellationReason("");
      setReconciliationReason("");
      setConfirmedCountKeys([]);
      setEmptyBagConfirmed(false);
      setLedgerToken(nextLedgerToken);
      setInventoryFinalizationAvailable(nextFinalizationAvailable);
      setInventoryFinalizationBlockCode((data.inventoryFinalizationBlockCode ?? null) as InventoryFinalizationBlockCode);
      setReconciliation(nextReconciliation);
      setDescriptiveReconciliationAvailable(data.descriptiveReconciliationAvailable !== false);
      setReturnStorageOptions(nextStorageOptions);
      setRouteStatus(String(data.routeStatus ?? ""));
      setRouteIsTerminal(data.routeIsTerminal === true);
      setRouteReadyForCompletion(data.routeReadyForCompletion === true);
      setCanCancel(data.canCancel === true);
      setManagerRouteAccess(data.managerRouteAccess === true);
      setRouteDate(data.routeDate ? String(data.routeDate) : null);
      setRouteReference(String(data.routeReference ?? ""));
      setStopSummaries(Array.isArray(data.stopSummaries) ? data.stopSummaries as TerminalStopSummary[] : []);
      setPendingStopId(data.pendingStopId ? String(data.pendingStopId) : null);
      setTotalStopCount(Math.max(0, Number(data.totalStopCount ?? 0)));
      setUnfinishedStopCount(Math.max(0, Number(data.unfinishedStopCount ?? 0)));
      setCompletionReadinessCode((data.completionReadinessCode ?? null) as CompletionReadinessCode);
      const initialCountItems = mergeCustodyItems(nextItems, nextBagHistoryItems);
      const initialQtys = suggestedPhysicalCounts(initialCountItems);
      const initialStorageId = String(data.suggestedStorageLocationId ?? "");
      setCountedQtys(initialQtys);
      setStorageLocationId(initialStorageId);
      initialLeftoversDraftRef.current = JSON.stringify({
        ledgerToken: nextLedgerToken,
        countedQtys: initialQtys,
        cancellationReason: "",
        reconciliationReason: "",
        storageLocationId: initialStorageId,
        unexpectedProductIds: [],
        confirmedCountKeys: [],
        emptyBagConfirmed: false,
      });
      setSnapshotLoaded(true);
      return data;
    } catch (snapshotError) {
      setSnapshotLoaded(false);
      setInventoryFinalizationAvailable(false);
      setInventoryFinalizationBlockCode("SERVICES_UNAVAILABLE");
      throw snapshotError;
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [routeId]);

  useEffect(() => {
    loadRouteInventorySnapshot({ showLoading: true }).catch((err) => {
      setError(err instanceof Error ? err.message : trRef.current("Failed to load picked items", "تعذر تحميل الأصناف المستلمة"));
      setLoading(false);
    });
  }, [finalizationMode, loadRouteInventorySnapshot]);

  useEffect(() => {
    if (!error) return;
    const timeoutId = window.setTimeout(() => {
      errorAlertRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      errorAlertRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [error]);

  const baseCountItems = useMemo(
    () => mergeCustodyItems(items, bagHistoryItems),
    [bagHistoryItems, items],
  );
  const selectedUnexpectedItems = useMemo(() => {
    if (!assignedBagOwnerId) return [];
    const selectedIds = new Set(unexpectedProductIds);
    return activeProductOptions
      .filter((product) => selectedIds.has(product.id))
      .map((product): LeftoverItem => ({
        productId: product.id,
        productName: product.name,
        bagOwnerId: assignedBagOwnerId,
        bagOwnerName: assignedBagOwnerName,
        signedQuantity: 0,
        quantity: 0,
      }));
  }, [activeProductOptions, assignedBagOwnerId, assignedBagOwnerName, unexpectedProductIds]);
  const displayItems = useMemo(
    () => mergeCustodyItems(baseCountItems, selectedUnexpectedItems),
    [baseCountItems, selectedUnexpectedItems],
  );
  const displayedCountKeys = useMemo(() => new Set(displayItems.map(custodyKey)), [displayItems]);
  const availableUnexpectedProducts = useMemo(() => activeProductOptions.filter((product) => (
    !assignedBagOwnerId || !displayedCountKeys.has(`${assignedBagOwnerId}:${product.id}`)
  )), [activeProductOptions, assignedBagOwnerId, displayedCountKeys]);
  const historyCountKeys = useMemo(() => new Set(bagHistoryItems.map(custodyKey)), [bagHistoryItems]);
  const unexpectedCountKeys = useMemo(() => new Set(selectedUnexpectedItems.map(custodyKey)), [selectedUnexpectedItems]);
  const countGroups = useMemo(() => {
    const grouped = new Map<string, { bagOwnerId: string | null; bagOwnerName: string | null; items: LeftoverItem[] }>();
    for (const item of displayItems) {
      const groupKey = item.bagOwnerId ?? "unassigned";
      const group = grouped.get(groupKey) ?? {
        bagOwnerId: item.bagOwnerId,
        bagOwnerName: item.bagOwnerName ?? null,
        items: [],
      };
      if (!group.bagOwnerName && item.bagOwnerName) group.bagOwnerName = item.bagOwnerName;
      group.items.push(item);
      grouped.set(groupKey, group);
    }
    return Array.from(grouped.values()).sort((left, right) => (
      String(left.bagOwnerName ?? left.bagOwnerId ?? "").localeCompare(String(right.bagOwnerName ?? right.bagOwnerId ?? ""))
    ));
  }, [displayItems]);

  const addUnexpectedProduct = (productId: string) => {
    if (!productId || !assignedBagOwnerId) return;
    setUnexpectedProductIds((current) => current.includes(productId) ? current : [...current, productId]);
    const key = `${assignedBagOwnerId}:${productId}`;
    setCountedQtys((current) => Object.prototype.hasOwnProperty.call(current, key)
      ? current
      : { ...current, [key]: 0 });
  };

  const removeUnexpectedProduct = (item: LeftoverItem) => {
    setUnexpectedProductIds((current) => current.filter((productId) => productId !== item.productId));
    setCountedQtys((current) => {
      const next = { ...current };
      delete next[custodyKey(item)];
      return next;
    });
    setConfirmedCountKeys((current) => current.filter((key) => key !== custodyKey(item)));
  };

  const setPhysicalCount = (item: LeftoverItem, quantity: number) => {
    const key = custodyKey(item);
    setCountedQtys((current) => ({ ...current, [key]: quantity }));
    setConfirmedCountKeys((current) => current.filter((confirmedKey) => confirmedKey !== key));
  };

  const setCountConfirmed = (item: LeftoverItem, confirmed: boolean) => {
    const key = custodyKey(item);
    setConfirmedCountKeys((current) => confirmed
      ? Array.from(new Set([...current, key]))
      : current.filter((confirmedKey) => confirmedKey !== key));
  };

  const handleCompleteRoute = async () => {
    if (localDraft.pendingDraft) {
      setError(tr("Restore or discard the saved draft before finalizing this route.", "استعد المسودة المحفوظة أو تجاهلها قبل إنهاء هذه الجولة."));
      return;
    }
    localDraft.saveNow();
    if (routeIsTerminal) {
      setError(tr("This route has already been completed or cancelled. Return to the route to see its final status.", "تم إكمال هذه الجولة أو إلغاؤها بالفعل. ارجع إلى الجولة لرؤية حالتها النهائية."));
      return;
    }
    if (isCancelMode && !canCancel) {
      setError(tr("Only an owner, admin, or supervisor can cancel this route.", "يمكن للمالك أو المسؤول أو المشرف فقط إلغاء هذه الجولة."));
      return;
    }
    if (!isCancelMode && !routeReadyForCompletion) {
      setError(tr("This route is not ready to complete. Finish or explicitly skip every machine stop first.", "هذه الجولة غير جاهزة للإكمال. أنهِ كل موقع جهاز أو تخطّه بشكل صريح أولاً."));
      return;
    }
    if (!inventoryFinalizationAvailable) {
      setError(tr("Verified route inventory services are not available yet. Ask an admin to apply the pending database migration, then reload this page.", "خدمات التحقق من مخزون الجولة غير متاحة بعد. اطلب من الإدارة تطبيق ترحيل قاعدة البيانات المعلّق ثم أعد تحميل الصفحة."));
      return;
    }
    if (isCancelMode && !window.confirm(tr(
      "Return the counted stock and permanently cancel this route? This cannot be undone from the operator screen.",
      "هل تريد إعادة المخزون المعدود وإلغاء هذه الجولة نهائياً؟ لا يمكن التراجع عن ذلك من شاشة المشغل.",
    ))) {
      return;
    }
    setSubmitting(true);
    setProgressMessage(isCancelMode
      ? tr("Checking stock before cancellation...", "جارٍ التحقق من المخزون قبل الإلغاء...")
      : tr("Checking returned stock...", "جارٍ التحقق من المخزون المعاد..."));
    setError("");
    try {
      if (!ledgerToken || !inventoryFinalizationAvailable) {
        throw new Error(tr("Atomic route inventory validation is not available yet. Ask an admin to install the pending database migration, then reload this page.", "التحقق الذري من مخزون الجولة غير متاح بعد. اطلب من الإدارة تثبيت ترحيل قاعدة البيانات المعلّق ثم أعد تحميل الصفحة."));
      }
      if (displayItems.length === 0 && !emptyBagConfirmed) {
        throw new Error(tr("Confirm that you physically checked the operator bag and found it empty.", "أكّد أنك فحصت حقيبة المشغل فعلياً ووجدتها فارغة."));
      }
      const unconfirmedRows = displayItems.filter((item) => !confirmedCountKeys.includes(custodyKey(item)));
      if (unconfirmedRows.length > 0) {
        throw new Error(tr("Confirm the physical count for every listed product, including products counted as zero.", "أكّد العد الفعلي لكل منتج مدرج، بما في ذلك المنتجات التي عُدّت صفراً."));
      }
      const countRows = displayItems.map((item) => ({
        bagOwnerId: item.bagOwnerId,
        productId: item.productId,
        countedQuantity: Math.max(0, Number(countedQtys[custodyKey(item)] ?? 0)),
        discrepancyReason: Math.max(0, Number(countedQtys[custodyKey(item)] ?? 0)) !== Number(item.signedQuantity ?? 0)
          ? reconciliationReason.trim() || null
          : null,
      }));
      const hasVariance = displayItems.some((item) => (
        Math.max(0, Number(countedQtys[custodyKey(item)] ?? 0)) !== Number(item.signedQuantity ?? 0)
      ));
      if (isCancelMode && !cancellationReason.trim()) {
        throw new Error(tr("Enter the reason for cancelling this route.", "أدخل سبب إلغاء هذه الجولة."));
      }
      if (hasVariance && !reconciliationReason.trim()) {
        throw new Error(tr("Enter a reason because the physical count differs from Snacky OS.", "أدخل سبباً لأن العد الفعلي يختلف عن رصيد Snacky OS."));
      }
      const physicalReturnTotal = countRows.reduce((total, row) => total + row.countedQuantity, 0);
      if (physicalReturnTotal > 0 && returnStorageOptions.length === 0) {
        throw new Error(tr("No active storage location can receive this physical return.", "لا يوجد موقع تخزين نشط يمكنه استلام هذا الإرجاع الفعلي."));
      }
      if (physicalReturnTotal > 0 && returnStorageOptions.length > 1 && !storageLocationId) {
        throw new Error(tr("Select the storage location receiving the physical return.", "اختر موقع التخزين الذي سيستلم الإرجاع الفعلي."));
      }

      console.info("[operator:route-leftovers] Prepared physical route-bag count", {
        action_step: "complete_route.prepare_physical_count",
        route_id: routeId,
        product_rows: countRows,
      });

      setProgressMessage(isCancelMode
        ? tr("Returning counted stock and cancelling route...", "جارٍ إعادة المخزون المعدود وإلغاء الجولة...")
        : tr("Returning counted stock and finalizing route...", "جارٍ إعادة المخزون المعدود وإنهاء الجولة..."));
      const completionResult = await finalizeRouteInventory({
        routeId,
        counts: countRows,
        action: isCancelMode ? "cancel" : "complete",
        reason: isCancelMode
          ? cancellationReason.trim()
          : reconciliationReason.trim() || null,
        storageLocationId: storageLocationId || null,
        expectedLedgerToken: ledgerToken,
        clientSubmissionId: leftoversSubmissionRef.current.id,
      });
      if (!completionResult.success) {
        const errorCode = String(completionResult.code ?? "");
        const errorText = String(completionResult.error ?? "");
        const staleSnapshotMessage = errorText.toLowerCase().includes("route bag stock changed")
          || errorText.toLowerCase().includes("ledger token")
          || errorText.includes("تغيّر مخزون");
        const staleSnapshot = errorCode === "40001" && staleSnapshotMessage;
        if (staleSnapshot) {
          setProgressMessage(tr("Route stock changed. Reloading the latest physical-count list...", "تغيّر مخزون الجولة. جارٍ إعادة تحميل أحدث قائمة للعد الفعلي..."));
          localDraft.clearDraft();
          leftoversSubmissionRef.current = { mode: finalizationMode, id: crypto.randomUUID() };
          try {
            await loadRouteInventorySnapshot();
            setError(tr("Route stock changed while you were counting. The latest list is loaded; count and confirm every product again.", "تغيّر مخزون الجولة أثناء العد. تم تحميل أحدث قائمة؛ أعد عدّ كل منتج وتأكيده."));
          } catch {
            setError(tr("Route stock changed, but the latest count list could not be reloaded. Return to the route and open this page again.", "تغيّر مخزون الجولة، لكن تعذر إعادة تحميل أحدث قائمة للعد. ارجع إلى الجولة وافتح هذه الصفحة مرة أخرى."));
          }
          setSubmitting(false);
          setProgressMessage("");
          return;
        }
        throw new Error(completionResult.error);
      }

      localDraft.clearDraft();
      leftoversSubmissionRef.current = { mode: finalizationMode, id: crypto.randomUUID() };
      const successMessage = isCancelMode
        ? completionResult.reconciliationStatus === "needs_review"
          ? tr("Route cancelled and its inventory difference was sent for admin review.", "أُلغيت الجولة وأُرسل فرق المخزون إلى مراجعة الإدارة.")
          : tr("Route cancelled and its physical inventory was reconciled.", "أُلغيت الجولة وتمت تسوية مخزونها الفعلي.")
        : completionResult.reconciliationStatus === "needs_review"
        ? tr("Route completed and an inventory difference was sent for admin review.", "اكتملت الجولة وأُرسل فرق المخزون إلى مراجعة الإدارة.")
        : tr("Route stock returned and route completed successfully.", "تمت إعادة مخزون الجولة وإكمال الجولة بنجاح.");
      console.info("[operator:route-nav] Redirecting after route completion", {
        action: isCancelMode ? "cancel_route" : "complete_route",
        routeId,
        redirectPath: `${routeHref}?success=${encodeURIComponent(successMessage)}`,
      });
      router.push(`${routeHref}?success=${encodeURIComponent(successMessage)}`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : isCancelMode
        ? tr("Failed to cancel route", "تعذر إلغاء الجولة")
        : tr("Failed to complete route", "تعذر إكمال الجولة");
      if (errorMessage.toLowerCase().includes("stock changed") || errorMessage.includes("تغيّر مخزون")) {
        setConfirmedCountKeys([]);
        setEmptyBagConfirmed(false);
      }
      setError(errorMessage);
      setSubmitting(false);
      setProgressMessage("");
      window.setTimeout(() => localDraft.saveNow(), 0);
    }
  };

  if (loading) {
    return <LoadingState variant="cards" cards={3} />;
  }

  if (!routeId) {
    return (
      <>
        <ErrorState
          title={tr("Route id missing", "معرّف الجولة مفقود")}
          body={tr("This leftovers page was opened without a valid route id.", "فُتحت صفحة المتبقي دون معرّف جولة صالح.")}
          action={<SecondaryButton href="/operator">{tr("Back to operator home", "العودة إلى صفحة المشغل")}</SecondaryButton>}
        />
      </>
    );
  }

  if (!snapshotLoaded) {
    return (
      <ErrorState
        title={tr("Could not load route inventory", "تعذر تحميل مخزون الجولة")}
        body={error || tr("The verified physical-count list is unavailable. Reload it before counting or finalizing this route.", "قائمة العد الفعلي المتحقق منها غير متاحة. أعد تحميلها قبل عدّ المخزون أو إنهاء الجولة.")}
        action={(
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              setError("");
              loadRouteInventorySnapshot({ showLoading: true }).catch((snapshotError) => {
                setError(snapshotError instanceof Error ? snapshotError.message : tr("Failed to load picked items", "تعذر تحميل الأصناف المستلمة"));
              });
            }}
          >
            {tr("Reload latest counts", "إعادة تحميل أحدث الأعداد")}
          </button>
        )}
      />
    );
  }

  if (routeIsTerminal) {
    return (
      <ErrorState
        title={tr("Route already finished", "الجولة منتهية بالفعل")}
        body={tr(`This route is ${routeStatus || "already terminal"}. Physical counts can no longer be changed from this screen.`, `حالة هذه الجولة هي ${routeStatus || "منتهية"}. لم يعد من الممكن تغيير العد الفعلي من هذه الشاشة.`)}
        action={<SecondaryButton href={routeHref}>{tr("View final route", "عرض الجولة النهائية")}</SecondaryButton>}
      />
    );
  }

  if (isCancelMode && !canCancel) {
    return (
      <ErrorState
        title={tr("Route cancellation is restricted", "إلغاء الجولة مقيّد")}
        body={tr("Only an owner, admin, or supervisor can count stock and cancel this route. Return to the route; your inventory was not changed.", "يمكن للمالك أو المسؤول أو المشرف فقط عدّ المخزون وإلغاء هذه الجولة. ارجع إلى الجولة؛ لم يتغير مخزونك.")}
        action={<SecondaryButton href={routeHref}>{tr("Back to route", "العودة إلى الجولة")}</SecondaryButton>}
      />
    );
  }

  if (pendingStopId) {
    const pendingStop = stopSummaries.find((stop) => stop.id === pendingStopId);
    const pendingMachine = pendingStop?.machineName
      || pendingStop?.machineCode
      || tr(`Stop ${pendingStop?.stopOrder || ""}`.trim(), `المحطة ${pendingStop?.stopOrder || ""}`.trim());
    return (
      <ErrorState
        title={tr("A machine stop still needs recovery", "لا تزال هناك محطة جهاز تحتاج إلى استعادة")}
        body={tr(`${pendingMachine}: its inventory was committed, but the rest of the stop workflow did not finish. Retry that exact stop before counting or finalizing route stock; your route count has not been changed.`, `${pendingMachine}: تم تسجيل مخزون هذه المحطة، لكن بقية خطوات إنهائها لم تكتمل. أعد محاولة هذه المحطة تحديداً قبل عدّ مخزون الجولة أو إنهائها؛ لم يتغير عدّ الجولة.`)}
        action={(
          <SecondaryButton href={`/operator/routes/${routeId}/stops/${pendingStopId}`}>
            {tr("Recover pending stop", "استعادة المحطة المعلقة")}
          </SecondaryButton>
        )}
      />
    );
  }

  if (!isCancelMode && !routeReadyForCompletion) {
    const readinessBody = completionReadinessCode === "ROUTE_UNASSIGNED"
      ? tr("Assign an operator and start the route before completing it.", "عيّن مشغلاً وابدأ الجولة قبل إكمالها.")
      : completionReadinessCode === "ROUTE_NOT_ACTIVE"
        ? tr(`This route is ${routeStatus || "not active"}. Start and execute it before opening the final physical count.`, `حالة هذه الجولة هي ${routeStatus || "غير نشطة"}. ابدأها ونفّذها قبل فتح العد الفعلي النهائي.`)
        : completionReadinessCode === "ROUTE_HAS_NO_STOPS"
          ? tr("This route has no machine stops and cannot be completed from the inventory count screen.", "لا تحتوي هذه الجولة على مواقع أجهزة ولا يمكن إكمالها من شاشة عدّ المخزون.")
          : tr(`${unfinishedStopCount} of ${totalStopCount} machine stops still need to be completed or explicitly skipped.`, `لا يزال ${unfinishedStopCount} من أصل ${totalStopCount} من مواقع الأجهزة بحاجة إلى الإكمال أو التخطي بشكل صريح.`);
    return (
      <ErrorState
        title={tr("Route is not ready to complete", "الجولة غير جاهزة للإكمال")}
        body={readinessBody}
        action={<SecondaryButton href={routeHref}>{tr("Return to route stops", "العودة إلى مواقع الجولة")}</SecondaryButton>}
      />
    );
  }

  if (inventoryFinalizationBlockCode === "UNASSIGNED_CUSTODY") {
    return (
      <ErrorState
        title={tr("Route inventory needs administrator repair", "مخزون الجولة يحتاج إلى إصلاح من المسؤول")}
        body={tr("Snacky OS found historical bag stock without a recorded owner. It will not guess who held that stock. Ask an administrator to repair the custody record before completing or cancelling this route.", "وجد Snacky OS مخزوناً تاريخياً في الحقيبة دون مالك مسجّل. لن يخمّن النظام من كان يحتفظ بهذا المخزون. اطلب من المسؤول إصلاح سجل العهدة قبل إكمال الجولة أو إلغائها.")}
        action={<SecondaryButton href={routeHref}>{tr("Back to route", "العودة إلى الجولة")}</SecondaryButton>}
      />
    );
  }

  if (inventoryFinalizationBlockCode === "MANAGER_RECONCILIATION_REQUIRED") {
    return (
      <ErrorState
        title={tr("Manager reconciliation required", "مطلوب تسوية من المدير")}
        body={tr("This route contains bag history for more than one operator. An owner, admin, or supervisor must perform the physical count so stock is not assigned to the wrong person.", "تحتوي هذه الجولة على سجل حقائب لأكثر من مشغل. يجب أن يجري المالك أو المسؤول أو المشرف العد الفعلي حتى لا يُنسب المخزون إلى الشخص الخطأ.")}
        action={<SecondaryButton href={routeHref}>{tr("Back to route", "العودة إلى الجولة")}</SecondaryButton>}
      />
    );
  }

  const totalPhysicalCount = displayItems.reduce((total, item) => (
    total + Math.max(0, Number(countedQtys[custodyKey(item)] ?? 0))
  ), 0);
  const hasPhysicalVariance = displayItems.some((item) => (
    Math.max(0, Number(countedQtys[custodyKey(item)] ?? 0)) !== Number(item.signedQuantity ?? 0)
  ));
  const useLedgerCounts = () => {
    setCountedQtys(suggestedPhysicalCounts(displayItems));
    setConfirmedCountKeys([]);
  };
  const visibleStopSummaries = stopSummaries.slice(0, 8);
  const hiddenStopCount = Math.max(0, stopSummaries.length - visibleStopSummaries.length);
  const stopStatusLabel = (status: string) => {
    if (status === "completed") return tr("Completed", "مكتملة");
    if (status === "skipped") return tr("Skipped", "تم تخطيها");
    if (status === "in_progress") return tr("In progress", "قيد التنفيذ");
    if (status === "picked") return tr("Picked", "تم الاستلام");
    return tr("Pending", "معلقة");
  };

  return (
    <>
      <div className="space-y-6 max-w-2xl">
        <PageHeader
          title={isCancelMode ? tr("Count & Cancel Route", "عدّ وإلغاء الجولة") : tr("Count & Return Route Stock", "عدّ وإعادة مخزون الجولة")}
          subtitle={isCancelMode
            ? tr("Count the physical operator bag before cancelling. Snacky OS will return the counted stock and cancel the route in one transaction.", "عدّ حقيبة المشغل فعلياً قبل الإلغاء. سيعيد Snacky OS المخزون المعدود ويلغي الجولة في عملية واحدة.")
            : tr("Count what is physically in the operator bag. Snacky OS will return that stock and reconcile the route in one transaction.", "عدّ الموجود فعلياً في حقيبة المشغل. سيعيد Snacky OS المخزون ويسوّي الجولة في عملية واحدة.")}
          action={submitting
            ? <span className="btn-secondary cursor-not-allowed opacity-50" aria-disabled="true">{tr("Back", "رجوع")}</span>
            : <SecondaryButton href={routeHref}>{tr("Back", "رجوع")}</SecondaryButton>}
        />

        <SectionCard>
          <div className="space-y-4 p-4">
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{tr("Route", "الجولة")}</dt>
                <dd className="mt-1 font-semibold text-slate-900">#{routeReference || routeId.slice(0, 8).toUpperCase()}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{tr("Date", "التاريخ")}</dt>
                <dd className="mt-1 font-semibold text-slate-900">{routeDate || tr("Not recorded", "غير مسجل")}</dd>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{tr("Assigned operator", "المشغل المعيّن")}</dt>
                <dd className="mt-1 font-semibold text-slate-900">{assignedBagOwnerName || tr("Name unavailable", "الاسم غير متاح")}</dd>
              </div>
            </dl>
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {tr(`${stopSummaries.length} machine stops in this route`, `${stopSummaries.length} محطة جهاز في هذه الجولة`)}
              </h2>
              {visibleStopSummaries.length ? (
                <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                  {visibleStopSummaries.map((stop, index) => (
                    <li key={stop.id || `${stop.machineId ?? "machine"}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-medium text-slate-900">
                          {stop.machineName || stop.machineCode || tr(`Machine ${index + 1}`, `الجهاز ${index + 1}`)}
                        </span>
                        <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-600">
                          {stopStatusLabel(stop.status)}
                        </span>
                      </div>
                      {(stop.machineCode && stop.machineName) || stop.locationName ? (
                        <p className="mt-1 text-xs text-slate-500">
                          {[stop.machineCode && stop.machineName ? stop.machineCode : null, stop.locationName].filter(Boolean).join(" · ")}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-slate-500">{tr("No machine context is available.", "لا تتوفر معلومات عن الأجهزة.")}</p>
              )}
              {hiddenStopCount > 0 ? (
                <p className="mt-2 text-xs text-slate-500">{tr(`+${hiddenStopCount} more stops`, `+${hiddenStopCount} محطات أخرى`)}</p>
              ) : null}
            </div>
          </div>
        </SectionCard>

        {error && (
          <div
            ref={errorAlertRef}
            role="alert"
            aria-live="assertive"
            tabIndex={-1}
            className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700 outline-none focus:ring-2 focus:ring-red-500"
          >
            {error}
          </div>
        )}
        {submitting && progressMessage ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-900" role="status">
            {progressMessage}
          </div>
        ) : null}
        <fieldset disabled={submitting} aria-busy={submitting} className="contents">
          <DraftRestoreBanner pendingDraft={localDraft.pendingDraft} onRestore={localDraft.restoreDraft} onDiscard={localDraft.discardDraft} />
          {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}
          {!inventoryFinalizationAvailable ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            {tr("Route completion is temporarily locked because the verified inventory count services are not fully installed. No unverified stock can be submitted.", "إنهاء الجولة مقفل مؤقتاً لأن خدمات عدّ المخزون المتحقق منه غير مثبتة بالكامل. لا يمكن إرسال مخزون غير متحقق منه.")}
          </div>
          ) : null}
          {!descriptiveReconciliationAvailable ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
              {tr("The detailed movement summary could not be loaded. The verified bag snapshot is still current, so you can continue the physical count safely.", "تعذر تحميل ملخص الحركات التفصيلي. لا تزال لقطة الحقيبة المتحقق منها محدثة، لذا يمكنك متابعة العد الفعلي بأمان.")}
            </div>
          ) : null}

        {isCancelMode ? (
          <label className="block rounded-lg border border-rose-200 bg-white p-4">
            <span className="mb-2 block text-sm font-semibold text-slate-900">{tr("Reason for cancelling the route", "سبب إلغاء الجولة")}</span>
            <textarea
              className="field-input min-h-24"
              value={cancellationReason}
              onChange={(event) => setCancellationReason(event.target.value)}
              placeholder={tr("Explain why this route is being cancelled", "اشرح سبب إلغاء هذه الجولة")}
              required
            />
          </label>
        ) : null}

        {totalPhysicalCount > 0 ? (
          returnStorageOptions.length ? (
            <label className="block rounded-lg border border-slate-200 bg-white p-4">
              <span className="mb-2 block text-sm font-semibold text-slate-900">{tr("Physical return destination", "وجهة الإرجاع الفعلي")}</span>
              <select
                className="field-input"
                value={storageLocationId}
                onChange={(event) => setStorageLocationId(event.target.value)}
                required={returnStorageOptions.length > 1}
              >
                <option value="">{tr("Select storage location", "اختر موقع التخزين")}</option>
                {returnStorageOptions.map((storage) => (
                  <option key={storage.id} value={storage.id}>{storage.name}</option>
                ))}
              </select>
              <p className="mt-2 text-xs text-slate-500">
                {tr("Choose where the operator physically hands over the counted stock.", "اختر المكان الذي سيسلّم فيه المشغل المخزون المعدود فعلياً.")}
              </p>
            </label>
          ) : (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
              {tr("No active storage location can receive this return. Ask an admin to activate one before finalizing the route.", "لا يوجد موقع تخزين نشط لاستلام هذا الإرجاع. اطلب من الإدارة تفعيل موقع قبل إنهاء الجولة.")}
            </div>
          )
        ) : null}

        {reconciliation.length ? (
          <SectionCard>
            <div className="space-y-3 p-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">{tr("Route Inventory Reconciliation", "تسوية مخزون الجولة")}</h2>
                <p className="mt-1 text-sm text-slate-500">{tr("Calculated from inventory movements for this route.", "محسوبة من حركات المخزون الخاصة بهذه الجولة.")}</p>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">{tr("Product", "المنتج")}</th>
                      <th className="px-3 py-2">{tr("Loaded", "المحمّل")}</th>
                      <th className="px-3 py-2">{tr("To machines", "إلى الأجهزة")}</th>
                      <th className="px-3 py-2">{tr("Sold / customer", "مباع / عميل")}</th>
                      <th className="px-3 py-2">{tr("Damaged", "تالف")}</th>
                      <th className="px-3 py-2">{tr("Held at machine", "متروك عند الجهاز")}</th>
                      <th className="px-3 py-2">{tr("From machines", "من الأجهزة")}</th>
                      <th className="px-3 py-2">{tr("Returned", "المعاد")}</th>
                      <th className="px-3 py-2">{tr("Adjustments", "التعديلات")}</th>
                      <th className="px-3 py-2">{tr("Remaining", "المتبقي")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reconciliation.map((row) => (
                      <tr key={row.productId}>
                        <td className="px-3 py-2 font-medium text-slate-900">{row.productName}</td>
                        <td className="px-3 py-2">{row.loadedQty}</td>
                        <td className="px-3 py-2">{row.filledQty}</td>
                        <td className="px-3 py-2">{row.soldQty + row.compensatedQty}</td>
                        <td className="px-3 py-2">{row.damagedQty}</td>
                        <td className="px-3 py-2">{row.machineStorageQty}</td>
                        <td className="px-3 py-2">{row.machineReturnQty}</td>
                        <td className="px-3 py-2">{row.returnedQty}</td>
                        <td className="px-3 py-2">{row.adjustmentQty}</td>
                        <td className="px-3 py-2 font-semibold">{row.remainingQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard>
          <div className="space-y-3 p-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">{tr("Found another product in the bag?", "هل وجدت منتجاً آخر في الحقيبة؟")}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {tr("Add any active product that is physically in the assigned operator bag, even when Snacky OS shows no route balance for it. It will be recorded as a visible inventory difference.", "أضف أي منتج نشط موجود فعلياً في حقيبة المشغل المعيّن حتى لو لم يُظهر Snacky OS رصيداً له في الجولة. سيُسجّل كفرق مخزون ظاهر.")}
              </p>
            </div>
            {assignedBagOwnerId ? (
              availableUnexpectedProducts.length ? (
                <select
                  className="field-input"
                  value=""
                  onChange={(event) => addUnexpectedProduct(event.target.value)}
                  aria-label={tr("Add unexpected product", "إضافة منتج غير متوقع")}
                >
                  <option value="">{tr("Select a product to count", "اختر منتجاً لعدّه")}</option>
                  {availableUnexpectedProducts.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}{product.sku ? ` · ${product.sku}` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="text-sm text-slate-500">{tr("Every active product is already included in the physical count.", "كل المنتجات النشطة مدرجة بالفعل في العد الفعلي.")}</p>
              )
            ) : (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                {tr("This route has no assigned operator, so an unexpected bag product cannot be recorded. Assign an operator before finalizing it.", "لا يوجد مشغل معيّن لهذه الجولة، لذلك لا يمكن تسجيل منتج غير متوقع في الحقيبة. عيّن مشغلاً قبل إنهائها.")}
              </div>
            )}
          </div>
        </SectionCard>

        {displayItems.length === 0 ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-6 text-center">
            <p className="font-medium text-emerald-800">{tr("No route bag products to count", "لا توجد منتجات في حقيبة الجولة لعدّها")}</p>
            <p className="mt-1 text-sm text-emerald-700">{tr("The route has no operator-bag history or balance. If you physically found a product, add it above before finalizing.", "لا تحتوي الجولة على سجل أو رصيد لحقيبة المشغل. إذا وجدت منتجاً فعلياً فأضفه أعلاه قبل إنهاء الجولة.")}</p>
            <label className="mx-auto mt-4 flex max-w-md cursor-pointer items-center justify-center gap-2 text-sm font-medium text-emerald-950">
              <input
                type="checkbox"
                checked={emptyBagConfirmed}
                onChange={(event) => setEmptyBagConfirmed(event.target.checked)}
                className="h-4 w-4 rounded border-emerald-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span>{tr("I physically checked the operator bag and it is empty", "فحصت حقيبة المشغل فعلياً وهي فارغة")}</span>
            </label>
            <button
              onClick={handleCompleteRoute}
              disabled={submitting || !inventoryFinalizationAvailable}
              className="mt-4 btn-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting
                ? progressMessage || tr("Saving...", "جارٍ الحفظ...")
                : isCancelMode ? tr("Cancel Route", "إلغاء الجولة") : tr("Complete Route", "إكمال الجولة")}
            </button>
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <strong>{tr("Instructions:", "التعليمات:")}</strong> {tr("Count each product before handing the bag stock back to storage. Do not enter zero unless there are physically zero units in the bag.", "عدّ كل منتج قبل تسليم مخزون الحقيبة إلى المخزن. لا تدخل صفراً إلا إذا لم توجد أي وحدة فعلياً في الحقيبة.")}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={useLedgerCounts} className="btn-secondary">
                  {tr("Use Snacky OS counts", "استخدام أرصدة Snacky OS")}
                </button>
              </div>
            </div>

            <div className="space-y-5">
              {countGroups.map((group) => {
                const ownerLabel = group.bagOwnerName
                  || (group.bagOwnerId
                    ? tr(`Bag owner ${group.bagOwnerId.slice(-8)}`, `مالك الحقيبة ${group.bagOwnerId.slice(-8)}`)
                    : tr("Unassigned bag", "حقيبة غير معيّنة"));
                const isAssignedOwner = Boolean(
                  assignedBagOwnerId
                  && group.bagOwnerId
                  && assignedBagOwnerId === group.bagOwnerId,
                );
                const ownerHeadingId = `route-bag-owner-${group.bagOwnerId ?? "unassigned"}`;

                return (
                  <section
                    key={group.bagOwnerId ?? "unassigned"}
                    aria-labelledby={ownerHeadingId}
                    className="overflow-hidden rounded-xl border border-slate-300 bg-slate-50"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-100 px-4 py-3">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          {tr("Operator bag", "حقيبة المشغل")}
                        </p>
                        <h3 id={ownerHeadingId} className="font-semibold text-slate-900">{ownerLabel}</h3>
                      </div>
                      {isAssignedOwner ? (
                        <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800">
                          {tr("Assigned route operator", "مشغل الجولة المعيّن")}
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">
                          {tr("Additional bag owner", "مالك حقيبة إضافي")}
                        </span>
                      )}
                    </div>
                    <div className="space-y-3 p-3">
                      {group.items.map((item) => (
                        <div key={custodyKey(item)} className="rounded-lg border border-slate-200 bg-white p-4">
                          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-slate-900">{item.productName}</p>
                              <p className="mt-1 text-xs text-slate-500">
                                {tr("Snacky OS bag balance", "رصيد الحقيبة في Snacky OS")}: {item.signedQuantity} {tr("units", "وحدة")}
                              </p>
                              {unexpectedCountKeys.has(custodyKey(item)) ? (
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                  <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
                                    {tr("Not in the route ledger", "غير موجود في سجل الجولة")}
                                  </span>
                                  <button
                                    type="button"
                                    className="text-xs font-medium text-rose-700 underline underline-offset-2"
                                    onClick={() => removeUnexpectedProduct(item)}
                                  >
                                    {tr("Remove", "إزالة")}
                                  </button>
                                </div>
                              ) : item.signedQuantity === 0 && historyCountKeys.has(custodyKey(item)) ? (
                                <span className="mt-2 inline-flex rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                                  {tr("Previously handled — confirm the physical count", "تم التعامل معه سابقاً — أكّد العد الفعلي")}
                                </span>
                              ) : null}
                            </div>
                            <div className="w-full sm:w-44">
                              <div className="mb-1 text-xs font-medium text-slate-500">{tr("Physical count", "العد الفعلي")}</div>
                              <QuantityStepper
                                value={countedQtys[custodyKey(item)] ?? 0}
                                onChange={(quantity) => setPhysicalCount(item, quantity)}
                                inputLabel={`${ownerLabel} · ${item.productName} · ${tr("physical count", "العد الفعلي")}`}
                              />
                              <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                                <input
                                  type="checkbox"
                                  checked={confirmedCountKeys.includes(custodyKey(item))}
                                  onChange={(event) => setCountConfirmed(item, event.target.checked)}
                                  aria-label={`${ownerLabel} · ${item.productName} · ${tr("confirm physical count", "تأكيد العد الفعلي")}`}
                                  className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                                />
                                <span>{tr("I physically counted this product", "قمت بعدّ هذا المنتج فعلياً")}</span>
                              </label>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>

            {hasPhysicalVariance ? (
              <label className="block rounded-lg border border-amber-200 bg-white p-4">
                <span className="mb-2 block text-sm font-semibold text-slate-900">{tr("Reason for inventory difference", "سبب فرق المخزون")}</span>
                <textarea
                  className="field-input min-h-24"
                  value={reconciliationReason}
                  onChange={(event) => setReconciliationReason(event.target.value)}
                  placeholder={tr("Explain the physical difference for admin review", "اشرح الفرق الفعلي لمراجعة الإدارة")}
                  required
                />
              </label>
            ) : null}

            <SectionCard>
              <div className="p-4">
                <div className="text-sm text-slate-500 mb-1">{tr("Total physical units to return", "إجمالي الوحدات الفعلية للإعادة")}</div>
                <div className="text-3xl font-bold text-slate-900">{totalPhysicalCount}</div>
                <p className="text-xs text-slate-600 mt-2">{tr("units", "وحدة")}</p>
              </div>
            </SectionCard>

            <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-2 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
              <button
                onClick={handleCompleteRoute}
                disabled={submitting || !inventoryFinalizationAvailable}
                className="flex-1 btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting
                  ? progressMessage || tr("Saving...", "جارٍ الحفظ...")
                  : isCancelMode ? tr("Return Stock & Cancel Route", "إعادة المخزون وإلغاء الجولة") : tr("Return Stock & Complete Route", "إعادة المخزون وإكمال الجولة")}
              </button>
              {submitting ? (
                <button type="button" disabled className="btn-secondary cursor-not-allowed opacity-50">
                  {tr("Cancel", "إلغاء")}
                </button>
              ) : (
                <SecondaryButton href={routeHref} type="button">
                  {tr("Cancel", "إلغاء")}
                </SecondaryButton>
              )}
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
              <strong>{tr("Important:", "مهم:")}</strong> {tr("Confirm only after the physical count is correct. Any difference from Snacky OS becomes a visible admin reconciliation case; it is never hidden.", "أكد فقط بعد التأكد من صحة العد الفعلي. أي فرق عن Snacky OS يتحول إلى حالة تسوية ظاهرة للإدارة ولا يتم إخفاؤه.")}
            </div>
          </>
        )}
        </fieldset>
      </div>
    </>
  );
}
