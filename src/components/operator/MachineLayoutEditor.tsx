"use client";

import { useMemo, useState } from "react";
import { ProductThumbnail } from "@/components/ProductThumbnail";

export type MachineLayoutSlot = {
  slotCode: string;
  productId: string | null;
  vmsProductId: string | null;
  productName: string;
  vmsProductName?: string | null;
  imageUrl?: string | null;
  currentQty: number;
  capacity: number;
  salePriceLyd: number | null;
  aisleStatus?: string | null;
  xyMapped?: boolean;
};

export type MachineLayoutProduct = {
  id: string;
  name: string;
  imageUrl?: string | null;
  availableQty?: number;
  vmsSellingPriceLyd?: number | null;
  vmsProductId?: string | null;
  vmsProductName?: string | null;
  xyEligible?: boolean;
};

type ReviewChange =
  | {
      kind: "replace";
      slot: MachineLayoutSlot;
      product: MachineLayoutProduct;
      priceLyd: number;
      removedQty: number;
      plannedFillQty: number;
    }
  | {
      kind: "swap";
      slot: MachineLayoutSlot;
      target: MachineLayoutSlot;
    };

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function qtyTone(current: number, capacity: number) {
  if (capacity <= 0) return "bg-slate-100 text-slate-600";
  const ratio = current / capacity;
  if (ratio <= 0.2) return "bg-rose-50 text-rose-700";
  if (ratio <= 0.45) return "bg-amber-50 text-amber-700";
  return "bg-emerald-50 text-emerald-700";
}

export function MachineLayoutEditor({
  routeId,
  stopId,
  machineId,
  slots,
  initialProducts,
  onApplied,
  tr,
}: {
  routeId: string;
  stopId: string;
  machineId: string;
  slots: MachineLayoutSlot[];
  initialProducts: MachineLayoutProduct[];
  onApplied: () => void;
  tr: (english: string, arabic: string) => string;
}) {
  const [selectedSlotCode, setSelectedSlotCode] = useState<string | null>(null);
  const [mode, setMode] = useState<"replace" | "swap">("replace");
  const [catalog, setCatalog] = useState<MachineLayoutProduct[]>(initialProducts);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [swapSlotCode, setSwapSlotCode] = useState("");
  const [removedQty, setRemovedQty] = useState(0);
  const [plannedFillQty, setPlannedFillQty] = useState(0);
  const [review, setReview] = useState<ReviewChange | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedSlot = slots.find((slot) => slot.slotCode === selectedSlotCode) ?? null;
  const selectedProduct = catalog.find((product) => product.id === selectedProductId) ?? null;
  const swapSlot = slots.find((slot) => slot.slotCode === swapSlotCode) ?? null;

  const eligibleCatalog = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalog
      .filter((product) => product.xyEligible && product.vmsProductId)
      .filter((product) => !query || product.name.toLowerCase().includes(query) || String(product.vmsProductName ?? "").toLowerCase().includes(query))
      .sort((left, right) => {
        const leftBag = numberValue(left.availableQty);
        const rightBag = numberValue(right.availableQty);
        if ((leftBag > 0) !== (rightBag > 0)) return leftBag > 0 ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
  }, [catalog, search]);

  const replacementPrice = useMemo(() => {
    if (!selectedProduct) return null;
    const machineSpecific = slots.find((slot) => slot.productId === selectedProduct.id && numberValue(slot.salePriceLyd) > 0)?.salePriceLyd;
    if (numberValue(machineSpecific) > 0) return Number(machineSpecific);
    if (numberValue(selectedProduct.vmsSellingPriceLyd) > 0) return Number(selectedProduct.vmsSellingPriceLyd);
    return null;
  }, [selectedProduct, slots]);

  async function ensureCatalog() {
    if (catalogLoaded || catalogLoading) return;
    setCatalogLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}?catalog=all`, { cache: "no-store" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload?.error ?? "Could not load product catalog."));
      const rows = Array.isArray(payload?.productOptions) ? payload.productOptions as MachineLayoutProduct[] : [];
      setCatalog(rows);
      setCatalogLoaded(true);
    } catch (catalogError) {
      setError(catalogError instanceof Error ? catalogError.message : String(catalogError));
    } finally {
      setCatalogLoading(false);
    }
  }

  function openSlot(slot: MachineLayoutSlot) {
    setSelectedSlotCode(slot.slotCode);
    setMode("replace");
    setSelectedProductId("");
    setSwapSlotCode("");
    setSearch("");
    setRemovedQty(Math.max(0, slot.currentQty));
    setPlannedFillQty(0);
    setReview(null);
    setError(null);
    void ensureCatalog();
  }

  function closeEditor() {
    setSelectedSlotCode(null);
    setReview(null);
    setError(null);
  }

  function prepareReview() {
    if (!selectedSlot) return;
    setError(null);
    if (mode === "replace") {
      if (!selectedProduct || !selectedProduct.vmsProductId) {
        setError(tr("Choose a product that is mapped to XY.", "اختر منتجاً مربوطاً بـ XY."));
        return;
      }
      if (!replacementPrice || replacementPrice <= 0) {
        setError(tr("This product has no confirmed XY sale price. Set its price before using it in a slot.", "هذا المنتج لا يملك سعر بيع مؤكد في XY. حدّد سعره قبل وضعه في الخانة."));
        return;
      }
      const available = Math.max(0, numberValue(selectedProduct.availableQty));
      if (plannedFillQty > available) {
        setError(tr(`Only ${available} units are available in the route bag.`, `المتاح في حقيبة المسار فقط ${available} وحدة.`));
        return;
      }
      if (selectedSlot.capacity > 0 && plannedFillQty > selectedSlot.capacity) {
        setError(tr(`This slot capacity is ${selectedSlot.capacity}.`, `سعة هذه الخانة ${selectedSlot.capacity}.`));
        return;
      }
      if (removedQty > selectedSlot.currentQty) {
        setError(tr("Removed quantity cannot exceed the current XY stock.", "كمية الإرجاع لا يمكن أن تتجاوز مخزون XY الحالي."));
        return;
      }
      setReview({
        kind: "replace",
        slot: selectedSlot,
        product: selectedProduct,
        priceLyd: replacementPrice,
        removedQty: Math.max(0, Math.floor(removedQty)),
        plannedFillQty: Math.max(0, Math.floor(plannedFillQty)),
      });
      return;
    }

    if (!swapSlot || swapSlot.slotCode === selectedSlot.slotCode) {
      setError(tr("Choose another slot to swap with.", "اختر خانة أخرى للتبديل."));
      return;
    }
    if (!selectedSlot.vmsProductId || !swapSlot.vmsProductId) {
      setError(tr("Both slots need valid XY products before they can be swapped.", "يجب أن تحتوي الخانتان على منتجات XY صالحة قبل التبديل."));
      return;
    }
    if (!selectedSlot.salePriceLyd || !swapSlot.salePriceLyd) {
      setError(tr("Both products need XY prices before they can be swapped.", "يجب أن يكون للمنتجين سعر في XY قبل التبديل."));
      return;
    }
    setReview({ kind: "swap", slot: selectedSlot, target: swapSlot });
  }

  async function applyReview() {
    if (!review) return;
    setSaving(true);
    setError(null);
    try {
      const body = review.kind === "replace"
        ? {
            action: "replace",
            machineId,
            slotCode: review.slot.slotCode,
            newProductId: review.product.id,
            removedQty: review.removedQty,
            plannedFillQty: review.plannedFillQty,
            clientSubmissionId: crypto.randomUUID(),
          }
        : {
            action: "swap",
            machineId,
            slotCode: review.slot.slotCode,
            targetSlotCode: review.target.slotCode,
            clientSubmissionId: crypto.randomUUID(),
          };
      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/layout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.success !== true) {
        throw new Error(String(payload?.error ?? "Could not update XY machine layout."));
      }
      closeEditor();
      onApplied();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-50 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{tr("Machine layout", "خريطة الماكينة")}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {tr("Live from XY. Tap a slot to replace or move a product without opening XY.", "مباشرة من XY. اضغط على أي خانة لتغيير أو نقل المنتج بدون فتح XY.")}
            </p>
          </div>
          <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
            {tr("Live XY", "XY مباشر")}
          </span>
        </div>
      </div>

      {slots.length === 0 ? (
        <div className="p-5 text-sm text-slate-600">{tr("No XY slot layout is available for this machine yet.", "لا توجد خريطة خانات من XY لهذه الماكينة حتى الآن.")}</div>
      ) : (
        <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {slots.map((slot) => {
            const low = slot.capacity > 0 && slot.currentQty / slot.capacity <= 0.25;
            return (
              <button
                key={slot.slotCode}
                type="button"
                onClick={() => openSlot(slot)}
                className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 text-start shadow-sm transition hover:border-emerald-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-400"
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="rounded-md bg-slate-900 px-2 py-1 text-xs font-black text-white">{slot.slotCode}</span>
                  {!slot.xyMapped ? <span className="text-[10px] font-semibold text-amber-700">{tr("Unmapped", "غير مربوط")}</span> : null}
                </div>
                <div className="flex items-center gap-2">
                  <ProductThumbnail imageUrl={slot.imageUrl} name={slot.productName} size="md" />
                  <div className="min-w-0">
                    <div className="line-clamp-2 text-sm font-semibold leading-5 text-slate-900">{slot.productName}</div>
                    <div className="mt-1 text-sm font-black text-emerald-800">
                      {slot.salePriceLyd ? `${Number(slot.salePriceLyd).toFixed(2)} ${tr("LYD", "د.ل")}` : tr("No price", "بدون سعر")}
                    </div>
                  </div>
                </div>
                <div className={`mt-3 rounded-lg px-2.5 py-2 text-xs font-semibold ${qtyTone(slot.currentQty, slot.capacity)}`}>
                  {tr("Stock", "المخزون")} {slot.currentQty}{slot.capacity > 0 ? ` / ${slot.capacity}` : ""}
                  {low ? <span className="ms-1">• {tr("Low", "منخفض")}</span> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {selectedSlot ? (
        <div className="border-t border-slate-200 bg-slate-50 p-4 md:p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{tr("Edit slot", "تعديل الخانة")} {selectedSlot.slotCode}</div>
              <div className="mt-1 flex items-center gap-3">
                <ProductThumbnail imageUrl={selectedSlot.imageUrl} name={selectedSlot.productName} size="md" />
                <div>
                  <div className="font-semibold text-slate-900">{selectedSlot.productName}</div>
                  <div className="text-sm text-slate-600">
                    {selectedSlot.currentQty}/{selectedSlot.capacity || "—"} · {selectedSlot.salePriceLyd ? `${selectedSlot.salePriceLyd.toFixed(2)} ${tr("LYD", "د.ل")}` : tr("No XY price", "لا يوجد سعر XY")}
                  </div>
                </div>
              </div>
            </div>
            <button type="button" onClick={closeEditor} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700">
              {tr("Close", "إغلاق")}
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => { setMode("replace"); setReview(null); setError(null); }} className={mode === "replace" ? "btn-primary" : "btn-secondary"}>
              {tr("Replace product", "تغيير المنتج")}
            </button>
            <button type="button" onClick={() => { setMode("swap"); setReview(null); setError(null); }} className={mode === "swap" ? "btn-primary" : "btn-secondary"}>
              {tr("Move / swap", "نقل / تبديل")}
            </button>
          </div>

          {mode === "replace" ? (
            <div className="mt-4 space-y-3">
              <input value={search} onChange={(event) => setSearch(event.target.value)} className="field-input" placeholder={tr("Search product by name", "ابحث عن المنتج بالاسم")} />
              {catalogLoading ? <div className="text-sm text-slate-500">{tr("Loading catalog…", "جاري تحميل المنتجات…")}</div> : null}
              <div className="max-h-72 space-y-2 overflow-y-auto">
                {eligibleCatalog.slice(0, 80).map((product) => {
                  const selected = product.id === selectedProductId;
                  const machinePrice = slots.find((slot) => slot.productId === product.id && numberValue(slot.salePriceLyd) > 0)?.salePriceLyd;
                  const price = numberValue(machinePrice) > 0 ? Number(machinePrice) : numberValue(product.vmsSellingPriceLyd) > 0 ? Number(product.vmsSellingPriceLyd) : null;
                  return (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => {
                        setSelectedProductId(product.id);
                        setPlannedFillQty(Math.min(Math.max(0, numberValue(product.availableQty)), selectedSlot.capacity || Number.MAX_SAFE_INTEGER));
                        setReview(null);
                      }}
                      className={`flex w-full items-center gap-3 rounded-xl border p-3 text-start ${selected ? "border-emerald-500 bg-emerald-50" : "border-slate-200 bg-white"}`}
                    >
                      <ProductThumbnail imageUrl={product.imageUrl} name={product.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-900">{product.name}</div>
                        <div className="text-xs text-slate-500">{tr("Bag", "الحقيبة")}: {numberValue(product.availableQty)}</div>
                      </div>
                      <div className="text-sm font-black text-emerald-800">{price ? `${price.toFixed(2)} ${tr("LYD", "د.ل")}` : "—"}</div>
                    </button>
                  );
                })}
              </div>

              {selectedProduct ? (
                <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2">
                  <label>
                    <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Old units removed", "الكمية القديمة التي أخرجتها")}</span>
                    <input type="number" min={0} max={selectedSlot.currentQty} value={removedQty} onChange={(event) => setRemovedQty(Math.max(0, Math.floor(Number(event.target.value) || 0)))} className="field-input" />
                    <span className="mt-1 block text-xs text-slate-500">{tr("These units will be recorded as returned from the machine.", "سيتم تسجيل هذه الوحدات كمرتجعات من الماكينة.")}</span>
                  </label>
                  <label>
                    <span className="mb-1 block text-sm font-medium text-slate-800">{tr("New units to load", "كمية المنتج الجديد")}</span>
                    <input type="number" min={0} max={Math.min(numberValue(selectedProduct.availableQty), selectedSlot.capacity || Number.MAX_SAFE_INTEGER)} value={plannedFillQty} onChange={(event) => setPlannedFillQty(Math.max(0, Math.floor(Number(event.target.value) || 0)))} className="field-input" />
                    <span className="mt-1 block text-xs text-slate-500">{tr("Snacky will add this product to the stop plan.", "سناكي سيضيف هذا المنتج لخطة التعبئة.")}</span>
                  </label>
                  <div className="sm:col-span-2 rounded-lg bg-emerald-50 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{tr("Automatic XY price", "سعر XY التلقائي")}</div>
                    <div className="mt-1 text-xl font-black text-emerald-950">{replacementPrice ? `${replacementPrice.toFixed(2)} ${tr("LYD", "د.ل")}` : tr("Unavailable", "غير متوفر")}</div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              <p className="text-sm text-slate-600">{tr("Choose the slot that should exchange places with this product.", "اختر الخانة التي تريد تبديل مكان منتجها مع هذه الخانة.")}</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {slots.filter((slot) => slot.slotCode !== selectedSlot.slotCode).map((slot) => (
                  <button
                    key={slot.slotCode}
                    type="button"
                    onClick={() => { setSwapSlotCode(slot.slotCode); setReview(null); }}
                    className={`rounded-xl border p-3 text-start ${swapSlotCode === slot.slotCode ? "border-emerald-500 bg-emerald-50" : "border-slate-200 bg-white"}`}
                  >
                    <div className="text-xs font-black text-slate-500">{slot.slotCode}</div>
                    <div className="mt-1 line-clamp-2 text-sm font-semibold text-slate-900">{slot.productName}</div>
                    <div className="mt-1 text-xs text-emerald-800">{slot.salePriceLyd ? `${slot.salePriceLyd.toFixed(2)} ${tr("LYD", "د.ل")}` : "—"}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {error ? <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}

          {!review ? (
            <button type="button" onClick={prepareReview} className="btn-primary mt-4 w-full sm:w-auto">
              {tr("Review change", "راجع التغيير")}
            </button>
          ) : (
            <div className="mt-4 rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
              <div className="font-bold text-amber-950">{tr("Confirm live XY change", "تأكيد التغيير المباشر في XY")}</div>
              {review.kind === "replace" ? (
                <div className="mt-2 text-sm leading-6 text-amber-950">
                  <strong>{review.slot.slotCode}</strong>: {review.slot.productName} → <strong>{review.product.name}</strong><br />
                  {tr("Price", "السعر")}: <strong>{review.priceLyd.toFixed(2)} {tr("LYD", "د.ل")}</strong> · {tr("New fill", "التعبئة الجديدة")}: <strong>{review.plannedFillQty}</strong> · {tr("Returned old units", "المرتجع القديم")}: <strong>{review.removedQty}</strong>
                </div>
              ) : (
                <div className="mt-2 text-sm leading-6 text-amber-950">
                  <strong>{review.slot.slotCode}</strong> {review.slot.productName} ⇄ <strong>{review.target.slotCode}</strong> {review.target.productName}
                </div>
              )}
              <p className="mt-2 text-xs text-amber-800">{tr("Snacky will send this to XY, update the stop plan, and verify the new layout.", "سناكي سيرسل التغيير إلى XY ويحدّث خطة المحطة ثم يتحقق من الخريطة الجديدة.")}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <button type="button" disabled={saving} onClick={() => void applyReview()} className="btn-primary">
                  {saving ? tr("Applying…", "جاري التطبيق…") : tr("Confirm & sync XY", "تأكيد ومزامنة XY")}
                </button>
                <button type="button" disabled={saving} onClick={() => setReview(null)} className="btn-secondary">
                  {tr("Back", "رجوع")}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
