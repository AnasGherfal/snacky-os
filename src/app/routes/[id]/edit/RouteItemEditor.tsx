"use client";

import { useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import { useLanguage } from "@/components/I18nProvider";
import { saveRouteItemEdits } from "@/lib/route-item-edit-actions";

function newClientId() {
  return globalThis.crypto?.randomUUID?.() ?? `row-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function productLabel(product: { name: string; sku?: string | null; category?: string | null }, locale: "ar" | "en") {
  const category = product.category ? product.category : (locale === "ar" ? "غير مصنف" : "Uncategorized");
  const sku = product.sku ? ` · ${product.sku}` : "";
  return `${product.name} · ${category}${sku}`;
}

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase();
}

type RouteStopOption = {
  id: string;
  machineId: string;
  label: string;
  stopOrder: number;
};

type ProductOption = {
  id: string;
  name: string;
  sku?: string | null;
  category?: string | null;
};

type RouteItemRow = {
  clientKey: string;
  routeStopItemId: string | null;
  routeStopId: string;
  productId: string;
  quantity: number;
  notes: string;
  source: string;
  createdAt: string | null;
  checkedAt: string | null;
  isChecked: boolean;
};

type RouteItemEditorProps = {
  routeId: string;
  routeStatus: string;
  routeStartedAt: string | null;
  readOnly: boolean;
  stops: RouteStopOption[];
  products: ProductOption[];
  initialRows: RouteItemRow[];
  warningMessage?: string | null;
  preparationMode?: boolean;
};

type ProductPickerProps = {
  products: ProductOption[];
  value: string;
  locale: "ar" | "en";
  onChange: (productId: string) => void;
  placeholder: string;
  disabled?: boolean;
  clearAfterSelect?: boolean;
};

function rowSortValue(row: RouteItemRow, productName: string) {
  return [row.quantity > 0 ? 0 : 1, productName.toLowerCase(), row.createdAt ?? "", row.clientKey].join("|");
}

function tr(locale: "ar" | "en", en: string, ar: string) {
  return locale === "ar" ? ar : en;
}

function serializeRows(routeId: string, items: RouteItemRow[]) {
  return JSON.stringify({
    routeId,
    items: items.map((row) => ({
      id: row.routeStopItemId,
      routeStopId: row.routeStopId,
      productId: row.productId,
      quantity: row.quantity,
      notes: row.notes,
    })),
  });
}

function ProductPicker({
  products,
  value,
  locale,
  onChange,
  placeholder,
  disabled = false,
  clearAfterSelect = false,
}: ProductPickerProps) {
  const selectedProduct = products.find((product) => product.id === value) ?? null;
  const [query, setQuery] = useState(selectedProduct ? productLabel(selectedProduct, locale) : "");
  const [open, setOpen] = useState(false);
  const normalizedQuery = normalizeSearch(query);

  const filteredProducts = useMemo(() => {
    return products
      .map((product) => {
        const name = normalizeSearch(product.name);
        const sku = normalizeSearch(product.sku ?? "");
        const category = normalizeSearch(product.category ?? "");
        const searchable = `${name} ${sku} ${category}`;
        const score = !normalizedQuery
          ? 3
          : name.startsWith(normalizedQuery)
            ? 0
            : sku.startsWith(normalizedQuery)
              ? 1
              : searchable.includes(normalizedQuery)
                ? 2
                : 99;
        return { product, score };
      })
      .filter(({ score }) => score < 99)
      .sort((left, right) => left.score - right.score || left.product.name.localeCompare(right.product.name))
      .slice(0, 12)
      .map(({ product }) => product);
  }, [normalizedQuery, products]);

  const chooseProduct = (product: ProductOption) => {
    onChange(product.id);
    setQuery(clearAfterSelect ? "" : productLabel(product, locale));
    setOpen(false);
  };

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOpen(false);
        if (!clearAfterSelect) setQuery(selectedProduct ? productLabel(selectedProduct, locale) : "");
      }}
    >
      <div className="relative">
        <input
          type="search"
          className="field-input w-full pe-10"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (selectedProduct && !clearAfterSelect) setQuery("");
            setOpen(true);
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          aria-expanded={open}
          aria-label={placeholder}
        />
        <span className="pointer-events-none absolute inset-y-0 end-3 flex items-center text-slate-400" aria-hidden="true">
          ⌕
        </span>
      </div>

      {open && !disabled ? (
        <div className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
          {filteredProducts.length ? (
            filteredProducts.map((product) => (
              <button
                key={product.id}
                type="button"
                className="flex w-full items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-start hover:bg-emerald-50 focus:bg-emerald-50 focus:outline-none"
                onPointerDown={(event) => {
                  // Keep the search input focused until selection is committed.
                  // Mobile Safari/Chrome can fire blur before click and unmount this list.
                  event.preventDefault();
                  chooseProduct(product);
                }}
                onClick={(event) => {
                  // Keyboard activation does not always produce pointerdown.
                  if (event.detail === 0) chooseProduct(product);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-slate-900">{product.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-slate-500">
                    {product.category || tr(locale, "Uncategorized", "غير مصنف")}
                  </span>
                </span>
                {product.sku ? <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-600">{product.sku}</span> : null}
              </button>
            ))
          ) : (
            <div className="px-3 py-5 text-center text-sm text-slate-500">
              {tr(locale, "No matching products", "لا توجد منتجات مطابقة")}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function SaveControls({
  routeId,
  locale,
  preparationMode,
  hasChanges,
}: {
  routeId: string;
  locale: "ar" | "en";
  preparationMode: boolean;
  hasChanges: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <div className="sticky bottom-3 z-20 rounded-2xl border border-slate-200 bg-white/95 p-3 shadow-lg backdrop-blur">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-h-5 text-sm" aria-live="polite">
          {pending ? (
            <span className="font-medium text-emerald-700">
              {tr(locale, "Saving changes… Please keep this page open.", "جارٍ حفظ التعديلات… يرجى إبقاء الصفحة مفتوحة.")}
            </span>
          ) : hasChanges ? (
            <span className="font-medium text-amber-700">{tr(locale, "You have unsaved changes", "لديك تعديلات غير محفوظة")}</span>
          ) : (
            <span className="text-slate-500">{tr(locale, "No unsaved changes", "لا توجد تعديلات غير محفوظة")}</span>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <a
            href={`/routes/${routeId}`}
            className={`btn-secondary inline-flex items-center justify-center ${pending ? "pointer-events-none opacity-50" : ""}`}
            aria-disabled={pending}
          >
            {tr(locale, "Cancel", "إلغاء")}
          </a>
          <button type="submit" className="btn-primary min-w-48 disabled:cursor-wait disabled:opacity-70" disabled={pending}>
            {pending ? (
              <span className="inline-flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                {tr(locale, "Saving…", "جارٍ الحفظ…")}
              </span>
            ) : preparationMode ? (
              tr(locale, "Save products and build pick list", "حفظ المنتجات وبناء قائمة التحميل")
            ) : (
              tr(locale, "Save route changes", "حفظ تعديلات الجولة")
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function RouteItemEditor({
  routeId,
  routeStatus,
  routeStartedAt,
  readOnly,
  stops,
  products,
  initialRows,
  warningMessage,
  preparationMode = false,
}: RouteItemEditorProps) {
  const { locale } = useLanguage();
  const [rows, setRows] = useState<RouteItemRow[]>(initialRows);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const groupedRows = useMemo(() => {
    const byStop = new Map<string, RouteItemRow[]>();
    rows.forEach((row) => {
      byStop.set(row.routeStopId, [...(byStop.get(row.routeStopId) ?? []), row]);
    });

    return stops.map((stop) => {
      const stopRows = (byStop.get(stop.id) ?? []).slice().sort((left, right) => {
        const leftName = productById.get(left.productId)?.name ?? "";
        const rightName = productById.get(right.productId)?.name ?? "";
        return rowSortValue(left, leftName).localeCompare(rowSortValue(right, rightName));
      });
      return { stop, rows: stopRows };
    });
  }, [productById, rows, stops]);

  const payload = useMemo(() => serializeRows(routeId, rows), [routeId, rows]);
  const initialPayload = useMemo(() => serializeRows(routeId, initialRows), [initialRows, routeId]);
  const hasChanges = payload !== initialPayload;

  const updateRow = (clientKey: string, patch: Partial<RouteItemRow>) => {
    setRows((current) => current.map((row) => (row.clientKey === clientKey ? { ...row, ...patch } : row)));
  };

  const addProductToStop = (routeStopId: string, productId: string) => {
    if (readOnly || !productId) return;
    setRows((current) => {
      const existing = current.find((row) => row.routeStopId === routeStopId && row.productId === productId);
      if (existing) {
        return current.map((row) => row.clientKey === existing.clientKey ? { ...row, quantity: Math.max(1, row.quantity) } : row);
      }
      return [
        ...current,
        {
          clientKey: newClientId(),
          routeStopItemId: null,
          routeStopId,
          productId,
          quantity: 1,
          notes: "",
          source: "manual_admin_assignment",
          createdAt: null,
          checkedAt: null,
          isChecked: false,
        },
      ];
    });
  };

  const removeRow = (row: RouteItemRow) => {
    if (readOnly) return;
    setRows((current) =>
      row.routeStopItemId
        ? current.map((item) => item.clientKey === row.clientKey ? { ...item, quantity: 0 } : item)
        : current.filter((item) => item.clientKey !== row.clientKey),
    );
  };

  const changeQuantity = (clientKey: string, value: string | number) => {
    const nextQuantity = Math.max(0, Math.floor(Number(value ?? 0) || 0));
    updateRow(clientKey, { quantity: nextQuantity });
  };

  return (
    <form action={saveRouteItemEdits} className="space-y-5">
      <input type="hidden" name="id" value={routeId} />
      <input type="hidden" name="payload" value={payload} />

      {preparationMode ? (
        <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          <div className="font-semibold">{tr(locale, "Add exact quantities at storage", "أضف الكميات الدقيقة في المخزن")}</div>
          <p className="mt-1 leading-6">{tr(locale, "Search for each product under its machine, set the exact quantity, then save once to build the route pick list.", "ابحث عن كل منتج تحت الجهاز الخاص به، وحدد الكمية الدقيقة، ثم احفظ مرة واحدة لبناء قائمة تحميل الجولة.")}</p>
        </div>
      ) : null}
      {warningMessage ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{warningMessage}</div>
      ) : null}
      {readOnly ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          {tr(locale, "Route already started or completed. This screen is read only.", "بدأت الجولة أو اكتملت بالفعل. هذه الشاشة للقراءة فقط.")}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="font-semibold text-slate-700">
          {stops.length} {tr(locale, "machine stops", "مواقع أجهزة")}
          <span className="mx-2 text-slate-300">·</span>
          {rows.filter((row) => row.quantity > 0).length} {tr(locale, "products", "منتجات")}
        </div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          {tr(locale, "Route status:", "حالة الجولة:")} <span className="text-slate-900">{routeStatus}</span>
        </div>
      </div>

      <div className="space-y-4">
        {groupedRows.map(({ stop, rows: stopRows }) => {
          const activeProductIds = new Set(stopRows.filter((row) => row.quantity > 0).map((row) => row.productId));
          const addableProducts = products.filter((product) => !activeProductIds.has(product.id));
          const activeRows = stopRows.filter((row) => row.quantity > 0);
          const removedRows = stopRows.filter((row) => row.quantity === 0 && Boolean(row.routeStopItemId));
          const stopUnits = activeRows.reduce((sum, row) => sum + row.quantity, 0);

          return (
            <section key={stop.id} className="overflow-visible rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="grid gap-4 border-b border-slate-200 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,420px)] lg:items-center">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {tr(locale, "Stop", "الموقع")} {stop.stopOrder}
                  </div>
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">{stop.label}</h2>
                  <p className="mt-1 text-sm text-slate-500">
                    {activeRows.length} {tr(locale, "products", "منتجات")} · {stopUnits} {tr(locale, "units", "وحدة")}
                  </p>
                </div>
                {!readOnly ? (
                  <div>
                    <label className="mb-1.5 block text-sm font-semibold text-slate-800">
                      {tr(locale, "Find and add a product", "ابحث عن منتج وأضفه")}
                    </label>
                    {addableProducts.length ? (
                      <ProductPicker
                        products={addableProducts}
                        value=""
                        locale={locale}
                        onChange={(productId) => addProductToStop(stop.id, productId)}
                        placeholder={tr(locale, "Search name, SKU, or category…", "ابحث بالاسم أو الرمز أو التصنيف…")}
                        clearAfterSelect
                      />
                    ) : (
                      <div className="rounded-xl bg-slate-100 px-3 py-2.5 text-sm text-slate-500">
                        {tr(locale, "All products are already added", "تمت إضافة جميع المنتجات")}
                      </div>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="space-y-3 p-4">
                {activeRows.length ? (
                  activeRows.map((row) => {
                    const currentProduct = productById.get(row.productId);
                    const isNewAfterStart = Boolean(row.source === "manual_admin_assignment" && routeStartedAt && row.createdAt && new Date(row.createdAt).getTime() > new Date(routeStartedAt).getTime());
                    return (
                      <article key={row.clientKey} className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                        <div className="grid gap-3 lg:grid-cols-[minmax(240px,1.4fr)_minmax(230px,1fr)_auto] lg:items-end">
                          <label className="block">
                            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{tr(locale, "Product", "المنتج")}</span>
                            <ProductPicker
                              products={products}
                              value={row.productId}
                              locale={locale}
                              onChange={(productId) => updateRow(row.clientKey, { productId })}
                              placeholder={tr(locale, "Search for a product…", "ابحث عن منتج…")}
                              disabled={readOnly}
                            />
                          </label>

                          <label className="block">
                            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{tr(locale, "Quantity", "الكمية")}</span>
                            <div className="grid grid-cols-[44px_minmax(72px,1fr)_44px] overflow-hidden rounded-xl border border-slate-300 bg-white">
                              <button
                                type="button"
                                className="min-h-11 border-e border-slate-200 text-xl font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                                onClick={() => changeQuantity(row.clientKey, row.quantity - 1)}
                                disabled={readOnly || row.quantity <= 0}
                                aria-label={tr(locale, "Decrease quantity", "تقليل الكمية")}
                              >
                                −
                              </button>
                              <input
                                type="number"
                                min="0"
                                step="1"
                                className="min-h-11 w-full border-0 bg-white px-2 text-center text-base font-semibold text-slate-900 outline-none"
                                value={row.quantity}
                                onChange={(event) => changeQuantity(row.clientKey, event.target.value)}
                                disabled={readOnly}
                                aria-label={tr(locale, "Quantity", "الكمية")}
                              />
                              <button
                                type="button"
                                className="min-h-11 border-s border-slate-200 text-xl font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                                onClick={() => changeQuantity(row.clientKey, row.quantity + 1)}
                                disabled={readOnly}
                                aria-label={tr(locale, "Increase quantity", "زيادة الكمية")}
                              >
                                +
                              </button>
                            </div>
                          </label>

                          {!readOnly ? (
                            <button
                              type="button"
                              className="min-h-11 rounded-xl border border-rose-200 bg-white px-4 text-sm font-semibold text-rose-700 hover:bg-rose-50"
                              onClick={() => removeRow(row)}
                            >
                              {tr(locale, "Remove", "إزالة")}
                            </button>
                          ) : null}
                        </div>

                        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,0.55fr)]">
                          <label className="block">
                            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{tr(locale, "Notes", "الملاحظات")}</span>
                            <input
                              className="field-input"
                              value={row.notes}
                              onChange={(event) => updateRow(row.clientKey, { notes: event.target.value })}
                              disabled={readOnly}
                              placeholder={tr(locale, "Optional note", "ملاحظة اختيارية")}
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">{tr(locale, "Machine stop", "موقع الجهاز")}</span>
                            <select
                              className="field-input"
                              value={row.routeStopId}
                              onChange={(event) => updateRow(row.clientKey, { routeStopId: event.target.value })}
                              disabled={readOnly}
                            >
                              {stops.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.stopOrder}. {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium">
                          <span className="rounded-full bg-slate-200 px-2.5 py-1 text-slate-700">
                            {row.source === "manual_admin_assignment" ? tr(locale, "Manual assignment", "تعيين يدوي") : tr(locale, "Refill recommendation", "توصية تعبئة")}
                          </span>
                          {isNewAfterStart ? (
                            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800">{tr(locale, "New added item", "عنصر مضاف جديدًا")}</span>
                          ) : null}
                          {row.isChecked ? (
                            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-700">{tr(locale, "Picked before start", "تم تحميله قبل البدء")}</span>
                          ) : null}
                          {currentProduct?.category ? (
                            <span className="rounded-full bg-white px-2.5 py-1 text-slate-500">{currentProduct.category}</span>
                          ) : null}
                        </div>
                      </article>
                    );
                  })
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-5 text-center text-sm text-slate-500">
                    {tr(locale, "No products yet. Use the search above to add the first product.", "لا توجد منتجات بعد. استخدم البحث أعلاه لإضافة أول منتج.")}
                  </div>
                )}

                {removedRows.length ? (
                  <details className="rounded-xl border border-rose-100 bg-rose-50/60 px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium text-rose-700">
                      {removedRows.length} {tr(locale, "products marked for removal", "منتجات محددة للإزالة")}
                    </summary>
                    <div className="mt-2 space-y-2">
                      {removedRows.map((row) => (
                        <div key={row.clientKey} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3 py-2 text-sm">
                          <span className="truncate text-slate-700">{productById.get(row.productId)?.name ?? tr(locale, "Unknown product", "منتج غير معروف")}</span>
                          {!readOnly ? (
                            <button type="button" className="shrink-0 font-semibold text-emerald-700" onClick={() => changeQuantity(row.clientKey, 1)}>
                              {tr(locale, "Restore", "استعادة")}
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>

      {!readOnly ? (
        <SaveControls routeId={routeId} locale={locale} preparationMode={preparationMode} hasChanges={hasChanges} />
      ) : (
        <div className="flex">
          <a href={`/routes/${routeId}`} className="btn-secondary inline-flex items-center justify-center">
            {tr(locale, "Back to route", "العودة إلى الجولة")}
          </a>
        </div>
      )}
    </form>
  );
}
