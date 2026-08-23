"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { useLanguage } from "@/components/I18nProvider";
import { recordAdminMissedRoutePickup } from "@/lib/admin-route-pickup-actions";

export type MissedPickupStorageOption = {
  id: string;
  name: string;
};

export type MissedPickupProductOption = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string | null;
  brand: string | null;
  imageUrl: string | null;
  quantityByStorageId: Record<string, number>;
};

function tr(locale: "ar" | "en", en: string, ar: string) {
  return locale === "ar" ? ar : en;
}

function unitQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function newSubmissionId() {
  return globalThis.crypto?.randomUUID?.() ?? "";
}

export function AdminMissedPickupRecorder({
  routeId,
  operatorName,
  storages,
  products,
}: {
  routeId: string;
  operatorName: string;
  storages: MissedPickupStorageOption[];
  products: MissedPickupProductOption[];
}) {
  const router = useRouter();
  const { locale } = useLanguage();
  const [storageLocationId, setStorageLocationId] = useState(storages[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  const [selectedQuantities, setSelectedQuantities] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [missingSearch, setMissingSearch] = useState("");
  const [isPending, startTransition] = useTransition();
  const deferredQuery = useDeferredValue(query);
  const submissionIdRef = useRef("");
  const submittingRef = useRef(false);

  useEffect(() => {
    submissionIdRef.current ||= newSubmissionId();
  }, []);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const selectedItems = useMemo(() => Object.entries(selectedQuantities)
    .map(([productId, quantity]) => ({ product: productById.get(productId), quantity: unitQuantity(quantity) }))
    .filter((row): row is { product: MissedPickupProductOption; quantity: number } => Boolean(row.product) && row.quantity > 0)
    .sort((a, b) => a.product.name.localeCompare(b.product.name)), [productById, selectedQuantities]);
  const selectedUnits = selectedItems.reduce((sum, row) => sum + row.quantity, 0);
  const stockOverages = selectedItems.filter((row) => row.quantity > unitQuantity(row.product.quantityByStorageId[storageLocationId]));

  const visibleProducts = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const matching = products.filter((product) => !needle || [product.name, product.sku, product.barcode, product.category, product.brand]
      .some((value) => String(value ?? "").toLowerCase().includes(needle)));
    return matching
      .sort((a, b) => {
        const stockDifference = unitQuantity(b.quantityByStorageId[storageLocationId]) - unitQuantity(a.quantityByStorageId[storageLocationId]);
        return stockDifference || a.name.localeCompare(b.name);
      })
      .slice(0, needle ? 30 : 12);
  }, [deferredQuery, products, storageLocationId]);

  const setQuantity = (productId: string, nextValue: number) => {
    const next = Math.min(10000, unitQuantity(nextValue));
    setSelectedQuantities((current) => {
      if (next <= 0) {
        const updated = { ...current };
        delete updated[productId];
        return updated;
      }
      return { ...current, [productId]: next };
    });
    setError("");
    setSuccess("");
  };

  const addProduct = (product: MissedPickupProductOption) => {
    const available = unitQuantity(product.quantityByStorageId[storageLocationId]);
    if (available <= 0) {
      setError(tr(locale, "This product has no available stock at the selected storage location.", "لا يوجد مخزون متاح لهذا المنتج في موقع التخزين المحدد."));
      return;
    }
    setQuantity(product.id, unitQuantity(selectedQuantities[product.id]) + 1);
    setMissingSearch("");
  };

  const findBarcode = () => {
    const needle = barcode.trim().toLowerCase();
    if (!needle) return;
    const product = products.find((item) => String(item.barcode ?? "").toLowerCase() === needle || String(item.sku ?? "").toLowerCase() === needle);
    if (product) {
      addProduct(product);
      setQuery(product.name);
      setBarcode("");
    } else {
      setMissingSearch(barcode.trim());
    }
  };

  const submit = () => {
    if (submittingRef.current || isPending) return;
    setError("");
    setSuccess("");
    if (!storageLocationId) {
      setError(tr(locale, "Choose the storage location the products came from.", "اختر موقع التخزين الذي أُخذت منه المنتجات."));
      return;
    }
    if (!selectedItems.length) {
      setError(tr(locale, "Add at least one product the operator physically took.", "أضف منتجًا واحدًا على الأقل أخذه المشغّل فعليًا."));
      return;
    }
    if (stockOverages.length) {
      setError(tr(locale, "One or more quantities exceed current storage stock. Correct them before saving.", "كمية منتج واحد أو أكثر تتجاوز مخزون التخزين الحالي. صححها قبل الحفظ."));
      return;
    }
    if (!reason.trim()) {
      setError(tr(locale, "Enter why the operator did not record this pickup.", "أدخل سبب عدم تسجيل المشغّل لهذه الكمية."));
      return;
    }

    submittingRef.current = true;
    const submissionId = submissionIdRef.current || newSubmissionId();
    submissionIdRef.current = submissionId;
    startTransition(async () => {
      try {
        const result = await recordAdminMissedRoutePickup({
          routeId,
          storageLocationId,
          submissionId,
          reason: reason.trim(),
          items: selectedItems.map(({ product, quantity }) => ({
            productId: product.id,
            productName: product.name,
            quantity,
          })),
        });
        if (!result.success) {
          setError(result.error);
          return;
        }
        setSelectedQuantities({});
        setReason("");
        setQuery("");
        setBarcode("");
        submissionIdRef.current = newSubmissionId();
        setSuccess(tr(
          locale,
          `${result.recordedUnits} units across ${result.recordedItems} products were added to ${operatorName}'s operator bag and linked to this route.`,
          `تمت إضافة ${result.recordedUnits} وحدة من ${result.recordedItems} منتجات إلى حقيبة المشغّل ${operatorName} وربطها بهذه الجولة.`,
        ));
        router.refresh();
      } catch {
        setError(tr(locale, "Could not record the missed pickup. Check your connection and try again.", "تعذر تسجيل الكمية المنسية. تحقق من الاتصال وحاول مرة أخرى."));
      } finally {
        submittingRef.current = false;
      }
    });
  };

  return (
    <section className="surface-card overflow-hidden border-amber-200">
      <div className="border-b border-amber-200 bg-amber-50 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">{tr(locale, "Owner / admin correction", "تصحيح المالك / الإدارة")}</div>
            <h2 className="mt-1 text-lg font-semibold text-slate-950">{tr(locale, "Record products the operator took but forgot to enter", "سجّل منتجات أخذها المشغّل ولم يُدخلها في النظام")}</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-700">
              {tr(
                locale,
                `Use this only when ${operatorName} physically took products from storage for this route. Snacky OS moves them from Storage to the assigned Operator Bag, updates route stock and the confirmed pick list, and keeps an audit trail.`,
                `استخدم هذا فقط عندما أخذ ${operatorName} منتجات فعليًا من المخزن لهذه الجولة. ينقل Snacky OS الكمية من المخزن إلى حقيبة المشغّل المسند، ويحدّث مخزون الجولة وقائمة التحميل المؤكدة، ويحفظ سجل تدقيق.`,
              )}
            </p>
          </div>
          <div className="shrink-0 rounded-lg border border-amber-300 bg-white px-3 py-2 text-xs font-medium text-amber-950">
            {tr(locale, "No sale or finance entry is created", "لا يتم إنشاء عملية بيع أو قيد مالي")}
          </div>
        </div>
      </div>

      <div className="space-y-5 p-4 sm:p-5">
        {success ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-900" role="status">{success}</div> : null}
        {error ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-900" role="alert">{error}</div> : null}

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-800">{tr(locale, "Taken from storage", "تم الأخذ من المخزن")}</span>
          <select
            value={storageLocationId}
            onChange={(event) => {
              setStorageLocationId(event.target.value);
              setError("");
              setSuccess("");
            }}
            className="field-input"
            disabled={isPending}
          >
            {storages.map((storage) => <option key={storage.id} value={storage.id}>{storage.name}</option>)}
          </select>
        </label>

        <div>
          <div className="mb-2">
            <div className="text-sm font-medium text-slate-800">{tr(locale, "Add the forgotten products", "أضف المنتجات المنسية")}</div>
            <div className="text-xs text-slate-500">{tr(locale, "Search the full active catalog by name, SKU, barcode, category, or brand.", "ابحث في كامل المنتجات النشطة بالاسم أو SKU أو الباركود أو الفئة أو العلامة.")}</div>
          </div>
          <div className="grid gap-2 lg:grid-cols-[1fr_320px]">
            <input value={query} onChange={(event) => setQuery(event.target.value)} className="field-input" placeholder={tr(locale, "Search products", "ابحث عن المنتجات")} disabled={isPending} />
            <div className="flex gap-2">
              <input
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    findBarcode();
                  }
                }}
                className="field-input"
                placeholder={tr(locale, "Scan barcode / SKU", "مسح الباركود / SKU")}
                disabled={isPending}
              />
              <button type="button" onClick={findBarcode} className="btn-secondary" disabled={isPending}>{tr(locale, "Add", "إضافة")}</button>
            </div>
          </div>
          {missingSearch ? <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">{tr(locale, `No active product matched “${missingSearch}”.`, `لا يوجد منتج نشط يطابق «${missingSearch}».`)}</div> : null}
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {visibleProducts.map((product) => {
              const available = unitQuantity(product.quantityByStorageId[storageLocationId]);
              const selected = unitQuantity(selectedQuantities[product.id]);
              return (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => addProduct(product)}
                  disabled={isPending || available <= 0}
                  className={`rounded-xl border p-3 text-start transition ${selected > 0 ? "border-emerald-300 bg-emerald-50" : "border-slate-200 bg-white hover:border-slate-400"} disabled:cursor-not-allowed disabled:opacity-55`}
                >
                  <div className="flex gap-3">
                    <ProductThumbnail imageUrl={product.imageUrl} name={product.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-slate-950">{product.name}</div>
                      <div className="truncate text-xs text-slate-500">{product.sku ?? tr(locale, "No SKU", "بدون SKU")} {product.category ? `· ${product.category}` : ""}</div>
                      <div className={`mt-1 text-xs font-medium ${available > 0 ? "text-emerald-700" : "text-rose-700"}`}>
                        {tr(locale, `Storage available: ${available}`, `المتاح في المخزن: ${available}`)}
                        {selected > 0 ? tr(locale, ` · selected ${selected}`, ` · المحدد ${selected}`) : ""}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {!visibleProducts.length ? <div className="mt-3 rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">{tr(locale, "No active products match this search.", "لا توجد منتجات نشطة تطابق هذا البحث.")}</div> : null}
        </div>

        <div>
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-800">{tr(locale, "Products to record", "المنتجات المطلوب تسجيلها")}</div>
              <div className="text-xs text-slate-500">{tr(locale, "Enter the exact physical unit count that left storage.", "أدخل العدد الفعلي الدقيق للوحدات التي خرجت من المخزن.")}</div>
            </div>
            <div className="text-sm font-semibold text-slate-800">{tr(locale, `${selectedItems.length} products · ${selectedUnits} units`, `${selectedItems.length} منتجات · ${selectedUnits} وحدة`)}</div>
          </div>
          {selectedItems.length ? (
            <div className="space-y-2">
              {selectedItems.map(({ product, quantity }) => {
                const available = unitQuantity(product.quantityByStorageId[storageLocationId]);
                const over = quantity > available;
                return (
                  <div key={product.id} className={`rounded-xl border p-3 ${over ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white"}`}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-950">{product.name}</div>
                        <div className={`text-xs ${over ? "font-medium text-rose-700" : "text-slate-500"}`}>{tr(locale, `Available here: ${available}`, `المتاح هنا: ${available}`)}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button type="button" className="btn-secondary h-10 w-10 justify-center p-0" onClick={() => setQuantity(product.id, quantity - 1)} disabled={isPending} aria-label={tr(locale, `Decrease ${product.name}`, `تقليل ${product.name}`)}>−</button>
                        <input
                          type="number"
                          min={1}
                          max={10000}
                          value={quantity}
                          onChange={(event) => setQuantity(product.id, Number(event.target.value))}
                          className="field-input h-10 w-24 text-center font-semibold"
                          disabled={isPending}
                          aria-label={tr(locale, `${product.name} quantity`, `كمية ${product.name}`)}
                        />
                        <button type="button" className="btn-secondary h-10 w-10 justify-center p-0" onClick={() => setQuantity(product.id, quantity + 1)} disabled={isPending || quantity >= available} aria-label={tr(locale, `Increase ${product.name}`, `زيادة ${product.name}`)}>+</button>
                        <button type="button" className="btn-secondary h-10 px-3 text-rose-700" onClick={() => setQuantity(product.id, 0)} disabled={isPending}>{tr(locale, "Remove", "حذف")}</button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">{tr(locale, "No forgotten products added yet.", "لم تتم إضافة منتجات منسية بعد.")}</div>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-slate-800">{tr(locale, "Required audit reason", "سبب التصحيح المطلوب")}</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value.slice(0, 500))}
            rows={3}
            className="field-input min-h-24"
            placeholder={tr(locale, "Example: Operator loaded these products but missed them when confirming the pick list.", "مثال: حمّل المشغّل هذه المنتجات لكنه نسيها عند تأكيد قائمة التحميل.")}
            disabled={isPending}
          />
          <span className="text-xs text-slate-500">{reason.length}/500</span>
        </label>

        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950">
          <span className="font-semibold">{tr(locale, "On save:", "عند الحفظ:")}</span>{" "}
          {tr(
            locale,
            `Storage decreases, ${operatorName}'s Operator Bag and route picked stock increase, and the confirmed pick list gains an admin correction row. Existing route entries are not replaced.`,
            `ينخفض المخزون، وتزداد حقيبة المشغّل ${operatorName} ومخزون الجولة المسحوب، ويُضاف سطر تصحيح إداري إلى قائمة التحميل المؤكدة. لا يتم استبدال قيود الجولة الحالية.`,
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" className="btn-secondary justify-center" onClick={() => { setSelectedQuantities({}); setReason(""); setError(""); setSuccess(""); submissionIdRef.current = newSubmissionId(); }} disabled={isPending || (!selectedItems.length && !reason)}>{tr(locale, "Clear", "مسح")}</button>
          <button type="button" className="btn-primary justify-center" onClick={submit} disabled={isPending || !selectedItems.length || !reason.trim() || Boolean(stockOverages.length)}>
            {isPending ? tr(locale, "Recording pickup…", "جارٍ تسجيل الكمية…") : tr(locale, `Record ${selectedUnits} units`, `تسجيل ${selectedUnits} وحدة`)}
          </button>
        </div>
      </div>
    </section>
  );
}
