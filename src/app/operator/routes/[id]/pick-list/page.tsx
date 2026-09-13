"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { useLanguage } from "@/components/I18nProvider";
import { confirmPickupDirect } from "@/lib/direct-pickup-actions";
import { startRoute } from "@/lib/operator-actions";
import { formatProductQuantity } from "@/lib/product-quantity";

const LEGACY_PICKUP_CHECKLIST_STORAGE_PREFIX = "snacky:route-pickup-checklist";
const PICKUP_PROGRESS_STORAGE_PREFIX = "snacky:route-pick-progress";

type PickStopItem = {
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
};

type PickStopGroup = {
  routeStopId: string;
  machineId: string | null;
  machineName: string;
  machineCode: string;
  locationName: string;
  stopOrder: number;
  items: PickStopItem[];
};

type ProductOption = {
  id: string;
  sku: string | null;
  name: string;
  category: string | null;
  imageUrl: string | null;
  caseQuantity: number;
  availableStorageQty: number;
};

type ExtraPickItem = {
  id: string;
  targetStopId: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
};

type ApiRow = Record<string, unknown>;

function asRows(value: unknown): ApiRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is ApiRow => Boolean(row) && typeof row === "object" && !Array.isArray(row));
}

function optionalText(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (value === null || value === undefined) return null;
  const next = String(value).trim();
  return next || null;
}

function textOrFallback(value: unknown, fallback: string) {
  return optionalText(value) ?? fallback;
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function normalizedCaseQuantity(value: unknown) {
  const parsed = Number(value ?? 1);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.floor(parsed));
}

function formatQuantity(
  quantity: number,
  packaging: { caseQuantity: number; productName: string; category?: string | null },
) {
  return formatProductQuantity(
    quantity,
    {
      caseQuantity: packaging.caseQuantity,
      productName: packaging.productName,
      category: packaging.category ?? null,
    },
    { compact: true },
  );
}

export default function PickListPage() {
  const router = useRouter();
  const params = useParams<{ id?: string | string[] }>();
  const searchParams = useSearchParams();
  const { locale } = useLanguage();
  const isArabic = locale === "ar";
  const rawRouteId = params?.id;
  const routeId = Array.isArray(rawRouteId) ? rawRouteId[0] ?? "" : rawRouteId ?? "";
  const shouldStartRoute = searchParams.get("start") === "1";
  const startAttempted = useRef(false);
  const submissionIdRef = useRef(crypto.randomUUID());

  const [stopGroups, setStopGroups] = useState<PickStopGroup[]>([]);
  const [selectedStopIds, setSelectedStopIds] = useState<string[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [extras, setExtras] = useState<ExtraPickItem[]>([]);
  const [checkedPickupItemIds, setCheckedPickupItemIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [locked, setLocked] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const copy = useMemo(
    () =>
      isArabic
        ? {
            title: "استلام منتجات المسار",
            subtitle: "راجع الكميات، علّم ما تم أخذه، ثم أكّد الاستلام مرة واحدة.",
            back: "العودة للمسار",
            retry: "إعادة المحاولة",
            loading: "جارٍ تحميل قائمة الاستلام…",
            stops: "المحطات",
            selectAll: "تحديد الكل",
            clearAll: "إلغاء الكل",
            planned: "المطلوب",
            available: "المتوفر بالمخزن",
            pickup: "الاستلام",
            reason: "السبب",
            notes: "ملاحظات",
            extras: "منتجات إضافية",
            addExtra: "إضافة منتج",
            product: "المنتج",
            destination: "المحطة / الماكينة",
            chooseDestination: "اختر المحطة التي سيذهب إليها المنتج",
            quantity: "الكمية",
            remove: "حذف",
            summary: "ملخص الاستلام",
            units: "وحدة",
            confirm: "تأكيد الاستلام",
            confirming: "جارٍ التأكيد…",
            picked: "تم أخذه",
            progress: "تم أخذ",
            chooseStop: "اختر محطة واحدة على الأقل.",
            chooseProduct: "اختر منتجًا لكل سطر إضافي أو احذف السطر.",
            chooseExtraDestination: "كل منتج إضافي يجب ربطه بمحطة / ماكينة حتى يُضاف فعليًا للجولة.",
            locked: "هذا المسار مقفل ولا يمكن تعديل الاستلام.",
            alreadyConfirmed: "تم تأكيد استلام هذا المسار مسبقًا.",
            noItems: "لا توجد منتجات مطلوبة للاستلام.",
            stockWarning: "الكمية المختارة أعلى من المخزون الظاهر. سيقوم النظام بالتحقق من المخزون الفعلي مرة أخرى عند التأكيد.",
            directNote: "علامات الصح للتتبع فقط ولا تمنع التأكيد. المنتجات الإضافية تُحفظ فعليًا على المحطة وتظهر للإدارة في ملخص الجولة بعد التأكيد.",
            extraNote: "المنتج الإضافي ليس مجرد ملاحظة: عند التأكيد يُضاف للمحطة المختارة ويُخصم من المخزن ويظهر في ملخص الإدارة.",
            startFailed: "تعذر بدء المسار.",
          }
        : {
            title: "Route pickup",
            subtitle: "Review quantities, mark what you physically picked, then confirm once.",
            back: "Back to route",
            retry: "Retry",
            loading: "Loading pickup list…",
            stops: "Stops",
            selectAll: "Select all",
            clearAll: "Clear all",
            planned: "Planned",
            available: "Storage available",
            pickup: "Pickup",
            reason: "Reason",
            notes: "Notes",
            extras: "Extra products",
            addExtra: "Add product",
            product: "Product",
            destination: "Stop / machine",
            chooseDestination: "Choose the stop that will receive this product",
            quantity: "Quantity",
            remove: "Remove",
            summary: "Pickup summary",
            units: "units",
            confirm: "Confirm pickup",
            confirming: "Confirming…",
            picked: "Picked",
            progress: "Picked",
            chooseStop: "Select at least one stop.",
            chooseProduct: "Choose a product for every extra row or remove the empty row.",
            chooseExtraDestination: "Every extra product must be assigned to a stop / machine so it becomes part of the route.",
            locked: "This route is locked and pickup cannot be edited.",
            alreadyConfirmed: "Pickup for this route has already been confirmed.",
            noItems: "There are no products to pick up.",
            stockWarning: "Selected quantity is above visible stock. The system will validate physical stock again on confirmation.",
            directNote: "Checks are only a progress aid and never block confirmation. Extra products are saved to the selected stop and appear in the admin route summary after confirmation.",
            extraNote: "An extra product is a real route item: confirmation assigns it to the selected stop, deducts stock, and exposes it in the admin summary.",
            startFailed: "Could not start route.",
          },
    [isArabic],
  );

  const selectedStopSet = useMemo(() => new Set(selectedStopIds), [selectedStopIds]);
  const selectedGroups = useMemo(
    () => stopGroups.filter((group) => selectedStopSet.has(group.routeStopId)),
    [stopGroups, selectedStopSet],
  );
  const productById = useMemo(() => new Map(productOptions.map((product) => [product.id, product])), [productOptions]);
  const selectedPickupItemIds = useMemo(
    () => selectedGroups.flatMap((group) => group.items.map((item) => item.routeStopItemId)),
    [selectedGroups],
  );
  const pickedProgressCount = useMemo(
    () => selectedPickupItemIds.filter((id) => checkedPickupItemIds.includes(id)).length,
    [selectedPickupItemIds, checkedPickupItemIds],
  );
  const totalUnits = useMemo(
    () =>
      selectedGroups.flatMap((group) => group.items).reduce((sum, item) => sum + item.confirmedQty, 0) +
      extras.reduce((sum, item) => sum + (item.productId ? item.quantity : 0), 0),
    [selectedGroups, extras],
  );

  const loadPickList = useCallback(async () => {
    if (!routeId) {
      setError("Route id is missing.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");
    try {
      if (shouldStartRoute && !startAttempted.current) {
        startAttempted.current = true;
        const startResult = await startRoute(routeId);
        if (!startResult.success) throw new Error(copy.startFailed);
        setNotice(isArabic ? "تم بدء المسار." : "Route started.");
      }

      const response = await fetch(`/api/operator/routes/${routeId}/pick-list`, { cache: "no-store" });
      const data: unknown = await response.json();
      const payload = data && typeof data === "object" && !Array.isArray(data) ? (data as ApiRow) : {};
      if (!response.ok) throw new Error(textOrFallback(payload.error, "Could not load pickup list."));

      const groups: PickStopGroup[] = asRows(payload.stopGroups)
        .map((group): PickStopGroup | null => {
          const routeStopId = optionalText(group.route_stop_id);
          if (!routeStopId) return null;
          const machineId = optionalText(group.machine_id);
          const items = asRows(group.items)
            .map((item): PickStopItem | null => {
              const routeStopItemId = optionalText(item.route_stop_item_id);
              const productId = optionalText(item.product_id);
              if (!routeStopItemId || !productId) return null;
              const requestedQty = unitQuantity(item.planned_qty);
              const availableStorageQty = unitQuantity(item.available_storage_qty);
              const hasSavedPickQty = item.picked_qty !== null && item.picked_qty !== undefined;
              return {
                routeStopItemId,
                routeStopId: optionalText(item.route_stop_id) ?? routeStopId,
                machineId: optionalText(item.machine_id) ?? machineId,
                productId,
                productName: textOrFallback(item.product_name, isArabic ? "منتج غير معروف" : "Unknown product"),
                productCategory: optionalText(item.category),
                sku: optionalText(item.sku),
                caseQuantity: normalizedCaseQuantity(item.case_quantity),
                requestedQty,
                availableStorageQty,
                confirmedQty: hasSavedPickQty ? unitQuantity(item.picked_qty) : Math.min(requestedQty, availableStorageQty),
                reason: textOrFallback(item.reason, "Product not available in storage"),
                notes: optionalText(item.notes) ?? "",
              };
            })
            .filter((item): item is PickStopItem => Boolean(item));

          return {
            routeStopId,
            machineId,
            machineName: textOrFallback(group.machine_name, isArabic ? "ماكينة غير معروفة" : "Unknown machine"),
            machineCode: textOrFallback(group.machine_code, "-"),
            locationName: textOrFallback(group.location_name, isArabic ? "موقع غير معروف" : "Unknown location"),
            stopOrder: Number(group.stop_order ?? 0),
            items,
          };
        })
        .filter((group): group is PickStopGroup => group !== null && group.items.length > 0)
        .sort((a, b) => a.stopOrder - b.stopOrder);

      const products: ProductOption[] = asRows(payload.productOptions)
        .map((product) => ({
          id: optionalText(product.id) ?? "",
          sku: optionalText(product.sku),
          name: textOrFallback(product.name, isArabic ? "منتج غير معروف" : "Unknown product"),
          category: optionalText(product.category),
          imageUrl: optionalText(product.imageUrl ?? product.image_url),
          caseQuantity: normalizedCaseQuantity(product.caseQuantity ?? product.case_quantity),
          availableStorageQty: unitQuantity(product.availableStorageQty ?? product.available_storage_qty),
        }))
        .filter((product) => Boolean(product.id));

      const loadedExtras: ExtraPickItem[] = asRows(payload.extraItems)
        .map((item) => ({
          id: crypto.randomUUID(),
          targetStopId: optionalText(item.routeStopId ?? item.route_stop_id) ?? "",
          productId: optionalText(item.productId ?? item.product_id) ?? "",
          quantity: unitQuantity(item.quantity),
          reason: textOrFallback(item.reason, "Customer demand"),
          notes: optionalText(item.notes) ?? "",
        }))
        .filter((item) => Boolean(item.productId) || item.quantity > 0);

      setStopGroups(groups);
      setSelectedStopIds(groups.map((group) => group.routeStopId));
      setProductOptions(products);
      setExtras(loadedExtras);
      setLocked(Boolean(payload.locked));
      setConfirmed(Boolean(payload.confirmed));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load pickup list.");
    } finally {
      setLoading(false);
    }
  }, [copy.startFailed, isArabic, routeId, shouldStartRoute]);

  useEffect(() => {
    void loadPickList();
  }, [loadPickList]);

  useEffect(() => {
    if (!routeId || typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(`${LEGACY_PICKUP_CHECKLIST_STORAGE_PREFIX}:${routeId}`);
      const saved = window.localStorage.getItem(`${PICKUP_PROGRESS_STORAGE_PREFIX}:${routeId}`);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) setCheckedPickupItemIds(parsed.map((value) => String(value)).filter(Boolean));
    } catch {
      setCheckedPickupItemIds([]);
    }
  }, [routeId]);

  useEffect(() => {
    if (!routeId || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(`${PICKUP_PROGRESS_STORAGE_PREFIX}:${routeId}`, JSON.stringify(checkedPickupItemIds));
    } catch {
      // Visual pickup progress must never block the route workflow.
    }
  }, [checkedPickupItemIds, routeId]);

  function updateItem(routeStopItemId: string, patch: Partial<PickStopItem>) {
    setStopGroups((current) =>
      current.map((group) => ({
        ...group,
        items: group.items.map((item) => (item.routeStopItemId === routeStopItemId ? { ...item, ...patch } : item)),
      })),
    );
  }

  function updateExtra(id: string, patch: Partial<ExtraPickItem>) {
    setExtras((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  function toggleStop(stopId: string, checked: boolean) {
    setSelectedStopIds((current) =>
      checked ? Array.from(new Set([...current, stopId])) : current.filter((id) => id !== stopId),
    );
  }

  function togglePickedProgress(itemId: string) {
    setCheckedPickupItemIds((current) =>
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    );
  }

  function addExtraRow() {
    const defaultStopId = selectedStopIds[0] ?? stopGroups[0]?.routeStopId ?? "";
    setExtras((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        targetStopId: defaultStopId,
        productId: "",
        quantity: 1,
        reason: "Customer demand",
        notes: "Added by operator during route pickup",
      },
    ]);
  }

  async function handleConfirm() {
    setError("");
    setNotice("");
    if (locked || confirmed) return;
    if (!selectedStopIds.length) {
      setError(copy.chooseStop);
      return;
    }
    if (extras.some((item) => item.quantity > 0 && !item.productId)) {
      setError(copy.chooseProduct);
      return;
    }
    if (extras.some((item) => item.productId && item.quantity > 0 && !item.targetStopId)) {
      setError(copy.chooseExtraDestination);
      return;
    }

    const pickedItems = selectedGroups.flatMap((group) =>
      group.items.map((item) => ({
        routeStopItemId: item.routeStopItemId,
        routeStopId: item.routeStopId ?? group.routeStopId,
        machineId: item.machineId ?? group.machineId,
        productId: item.productId,
        quantity: item.confirmedQty,
        plannedQty: item.requestedQty,
        reason: item.confirmedQty !== item.requestedQty ? item.reason || "Other" : undefined,
        notes: item.notes || undefined,
      })),
    );

    const extraPayload = extras
      .filter((item) => item.productId && item.quantity > 0 && item.targetStopId)
      .map((item) => {
        const stop = stopGroups.find((group) => group.routeStopId === item.targetStopId);
        if (!stop?.machineId) throw new Error(copy.chooseExtraDestination);
        return {
          routeStopId: stop.routeStopId,
          machineId: stop.machineId,
          productId: item.productId,
          quantity: item.quantity,
          reason: item.reason || "Customer demand",
          notes: item.notes || "Added by operator during route pickup",
        };
      });

    setSubmitting(true);
    try {
      const result = await confirmPickupDirect(routeId, pickedItems, extraPayload, {
        stopIds: [...selectedStopIds],
        clientSubmissionId: submissionIdRef.current,
      });
      if (!result.success) throw new Error(result.error || "Could not confirm pickup.");

      submissionIdRef.current = crypto.randomUUID();
      if (typeof window !== "undefined") {
        try {
          window.localStorage.removeItem(`${PICKUP_PROGRESS_STORAGE_PREFIX}:${routeId}`);
        } catch {
          // Non-critical visual state.
        }
      }
      setCheckedPickupItemIds([]);
      router.push(`/operator/routes/${routeId}`);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not confirm pickup.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div className="mx-auto max-w-5xl p-5 text-sm text-slate-600">{copy.loading}</div>;
  }

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 pb-32 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-950">{copy.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">{copy.subtitle}</p>
        </div>
        <button
          type="button"
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
          onClick={() => router.push(`/operator/routes/${routeId}`)}
        >
          {copy.back}
        </button>
      </header>

      {notice ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-800">{notice}</div> : null}
      {error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-semibold">{error}</div>
          <button type="button" className="mt-2 underline" onClick={() => void loadPickList()}>{copy.retry}</button>
        </div>
      ) : null}
      {locked ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{copy.locked}</div> : null}
      {confirmed ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">{copy.alreadyConfirmed}</div> : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold text-slate-950">{copy.stops}</h2>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40" disabled={locked || confirmed} onClick={() => setSelectedStopIds(stopGroups.map((group) => group.routeStopId))}>{copy.selectAll}</button>
            <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40" disabled={locked || confirmed} onClick={() => setSelectedStopIds([])}>{copy.clearAll}</button>
          </div>
        </div>
        {stopGroups.length ? (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {stopGroups.map((group) => (
              <label key={group.routeStopId} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3">
                <input type="checkbox" className="mt-1 h-5 w-5" checked={selectedStopSet.has(group.routeStopId)} disabled={locked || confirmed} onChange={(event) => toggleStop(group.routeStopId, event.target.checked)} />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">{group.locationName}</span>
                  <span className="block text-sm text-slate-600">{`${group.machineName}${group.machineCode !== group.machineName && group.machineCode !== "-" ? ` · ${group.machineCode}` : ""}`}</span>
                </span>
              </label>
            ))}
          </div>
        ) : <p className="mt-3 text-sm text-slate-600">{copy.noItems}</p>}
      </section>

      {selectedGroups.map((group) => {
        const stopItemIds = group.items.map((item) => item.routeStopItemId);
        const stopPickedCount = stopItemIds.filter((id) => checkedPickupItemIds.includes(id)).length;
        return (
          <section key={group.routeStopId} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <h2 className="font-bold text-slate-950">{group.locationName}</h2>
                <p className="text-sm text-slate-600">{`${group.machineName}${group.machineCode !== group.machineName && group.machineCode !== "-" ? ` · ${group.machineCode}` : ""}`}</p>
              </div>
              <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm">{copy.progress} {stopPickedCount}/{group.items.length}</span>
            </div>
            <div className="divide-y divide-slate-100">
              {group.items.map((item) => {
                const product = productById.get(item.productId);
                const packaging = { caseQuantity: item.caseQuantity, productName: item.productName, category: item.productCategory };
                const adjusted = item.confirmedQty !== item.requestedQty;
                const stockWarning = item.confirmedQty > item.availableStorageQty;
                const isPicked = checkedPickupItemIds.includes(item.routeStopItemId);
                return (
                  <div key={item.routeStopItemId} className={`p-4 transition ${isPicked ? "bg-emerald-50/70" : ""}`}>
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        aria-pressed={isPicked}
                        onClick={() => togglePickedProgress(item.routeStopItemId)}
                        disabled={locked || confirmed || submitting}
                        className={`mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-lg font-black ${isPicked ? "border-emerald-600 bg-emerald-600 text-white" : "border-slate-300 bg-white text-transparent"}`}
                      >
                        ✓
                      </button>
                      <ProductThumbnail imageUrl={product?.imageUrl} name={item.productName} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="font-semibold text-slate-950">{item.productName}</div>
                          {isPicked ? <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">{copy.picked}</span> : null}
                        </div>
                        <div className="mt-1 space-y-1 text-xs text-slate-600">
                          <div>{copy.planned}: <b>{formatQuantity(item.requestedQty, packaging)}</b></div>
                          <div>{copy.available}: <b>{formatQuantity(item.availableStorageQty, packaging)}</b></div>
                          {item.sku ? <div>SKU: {item.sku}</div> : null}
                        </div>
                      </div>
                      <div className="w-40 max-w-[42%]">
                        <div className="mb-1 text-xs font-semibold text-slate-700">{copy.pickup}</div>
                        <QuantityStepper value={item.confirmedQty} min={0} disabled={locked || confirmed || submitting} onChange={(value) => updateItem(item.routeStopItemId, { confirmedQty: value })} inputLabel={item.productName} />
                        <div className="mt-1 text-[11px] leading-4 text-slate-500">{formatQuantity(item.confirmedQty, packaging)}</div>
                      </div>
                    </div>
                    {stockWarning ? <p className="mt-2 text-xs font-medium text-amber-700">{copy.stockWarning}</p> : null}
                    {adjusted ? (
                      <div className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 sm:grid-cols-2">
                        <label>
                          <span className="mb-1 block text-xs font-semibold text-slate-700">{copy.reason}</span>
                          <select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.reason} disabled={locked || confirmed || submitting} onChange={(event) => updateItem(item.routeStopItemId, { reason: event.target.value })}>
                            <option>Product not available in storage</option>
                            <option>Product not in operator bag</option>
                            <option>Product expired/damaged</option>
                            <option>Customer demand</option>
                            <option>Other</option>
                          </select>
                        </label>
                        <label>
                          <span className="mb-1 block text-xs font-semibold text-slate-700">{copy.notes}</span>
                          <input className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.notes} disabled={locked || confirmed || submitting} onChange={(event) => updateItem(item.routeStopItemId, { notes: event.target.value })} />
                        </label>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-950">{copy.extras}</h2>
            <p className="mt-1 text-xs text-slate-600">{copy.extraNote}</p>
          </div>
          <button type="button" className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-40" disabled={locked || confirmed || submitting || !stopGroups.length} onClick={addExtraRow}>+ {copy.addExtra}</button>
        </div>

        <div className="mt-3 space-y-3">
          {extras.map((item) => {
            const selected = productById.get(item.productId);
            return (
              <div key={item.id} className="rounded-xl border border-slate-200 bg-slate-50/50 p-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label>
                    <span className="mb-1 block text-xs font-semibold text-slate-700">{copy.product}</span>
                    <select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.productId} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { productId: event.target.value })}>
                      <option value="">—</option>
                      {productOptions.map((product) => <option key={product.id} value={product.id}>{product.name}{product.sku ? ` · ${product.sku}` : ""}</option>)}
                    </select>
                    {selected ? <span className="mt-1 block text-xs text-slate-500">{copy.available}: {formatQuantity(selected.availableStorageQty, { caseQuantity: selected.caseQuantity, productName: selected.name, category: selected.category })}</span> : null}
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-semibold text-slate-700">{copy.destination}</span>
                    <select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.targetStopId} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { targetStopId: event.target.value })}>
                      <option value="">{copy.chooseDestination}</option>
                      {selectedGroups.map((group) => <option key={group.routeStopId} value={group.routeStopId}>{group.locationName} · {group.machineName}</option>)}
                    </select>
                  </label>

                  <label>
                    <span className="mb-1 block text-xs font-semibold text-slate-700">{copy.quantity}</span>
                    <QuantityStepper value={item.quantity} min={0} disabled={locked || confirmed || submitting} onChange={(value) => updateExtra(item.id, { quantity: value })} inputLabel={copy.quantity} />
                    {selected ? <span className="mt-1 block text-xs text-slate-500">{formatQuantity(item.quantity, { caseQuantity: selected.caseQuantity, productName: selected.name, category: selected.category })}</span> : null}
                  </label>
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <label>
                    <span className="mb-1 block text-xs font-semibold text-slate-700">{copy.reason}</span>
                    <select className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.reason} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { reason: event.target.value })}>
                      <option>Customer demand</option>
                      <option>Product not available in storage</option>
                      <option>Product expired/damaged</option>
                      <option>Other</option>
                    </select>
                  </label>
                  <label>
                    <span className="mb-1 block text-xs font-semibold text-slate-700">{copy.notes}</span>
                    <input className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" value={item.notes} disabled={locked || confirmed || submitting} onChange={(event) => updateExtra(item.id, { notes: event.target.value })} />
                  </label>
                </div>

                <button type="button" className="mt-3 text-sm font-semibold text-red-700 disabled:opacity-40" disabled={locked || confirmed || submitting} onClick={() => setExtras((current) => current.filter((row) => row.id !== item.id))}>{copy.remove}</button>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl bg-slate-950 p-4 text-white shadow-sm">
        <h2 className="font-bold">{copy.summary}</h2>
        <p className="mt-1 text-sm text-slate-300">{selectedStopIds.length} {copy.stops} · {totalUnits} {copy.units}</p>
        <p className="mt-1 text-sm text-slate-300">{copy.progress} {pickedProgressCount}/{selectedPickupItemIds.length}</p>
        {extras.filter((item) => item.productId && item.quantity > 0).length ? (
          <div className="mt-3 rounded-xl bg-white/10 p-3">
            <div className="text-xs font-bold uppercase tracking-wide text-slate-300">{copy.extras}</div>
            <div className="mt-2 space-y-1 text-sm">
              {extras.filter((item) => item.productId && item.quantity > 0).map((item) => {
                const product = productById.get(item.productId);
                const stop = stopGroups.find((group) => group.routeStopId === item.targetStopId);
                return <div key={item.id}>+ {product?.name ?? item.productId} × {item.quantity} → {stop ? `${stop.locationName} · ${stop.machineName}` : copy.chooseDestination}</div>;
              })}
            </div>
          </div>
        ) : null}
        <p className="mt-2 text-xs text-slate-300">{copy.directNote}</p>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 p-3 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3">
          <div className="hidden min-w-0 flex-1 sm:block">
            <div className="text-sm font-semibold text-slate-900">{selectedStopIds.length} {copy.stops} · {totalUnits} {copy.units}</div>
            <div className="text-xs text-slate-500">{copy.progress} {pickedProgressCount}/{selectedPickupItemIds.length}</div>
          </div>
          <button type="button" className="min-h-12 w-full rounded-xl bg-emerald-600 px-6 py-3 text-base font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto" disabled={submitting || locked || confirmed || !selectedStopIds.length || !stopGroups.length} onClick={() => void handleConfirm()}>{submitting ? copy.confirming : copy.confirm}</button>
        </div>
      </div>
    </main>
  );
}
