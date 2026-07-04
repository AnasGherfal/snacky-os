"use client";

import { useMemo, useRef, useState } from "react";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { StatusBadge } from "@/components/ui";
import { useLanguage } from "@/components/I18nProvider";
import {
  manualRouteSalePaymentMethodLabel,
  manualRouteSalePriceSourceLabel,
  manualRouteSaleStatusLabel,
  normalizeRouteManualSale,
  parseRouteManualSalePaymentMethod,
  resolveManualRouteSaleSuggestedPrice,
  routeManualSaleTotal,
  type ManualRouteSalePriceCandidate,
  type NormalizedRouteManualSale,
  type RouteManualSaleRow,
} from "@/lib/manual-route-sales";

export type ManualRouteSaleProductOption = {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  imageUrl?: string | null;
  availableQty: number;
  sourceLabel?: string | null;
  currentSellingPriceLyd?: number | null;
  sellingPrice?: number | null;
  vmsSellingPriceLyd?: number | null;
  lastKnownSalePriceLyd?: number | null;
};

type ManualRouteSalesSectionProps = {
  routeId: string;
  stopId: string;
  machineId: string;
  machineName: string;
  locationName: string;
  routeStatus: string;
  preferredProducts: ManualRouteSaleProductOption[];
  allProducts: ManualRouteSaleProductOption[];
  sales: NormalizedRouteManualSale[];
  onSaved: (sale: NormalizedRouteManualSale, options: { inventoryMovementCreated: boolean; warning: string | null }) => void;
  onCancelled: (sale: NormalizedRouteManualSale, options: { inventoryReversed: boolean; warning: string | null }) => void;
  loadError?: boolean;
};

type ParsedPayload = {
  success?: boolean;
  sale?: unknown;
  error?: string;
  message?: string;
  warning?: string;
  inventoryMovementCreated?: boolean;
  inventoryReversed?: boolean;
  [key: string]: unknown;
};

function newClientId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function money(value: number | null | undefined) {
  const safe = Number(value ?? 0);
  return `${safe.toLocaleString("en-US", { minimumFractionDigits: safe % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })} LYD`;
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

async function parseResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text().catch(() => "");
  let payload: ParsedPayload | null = null;
  if (contentType.toLowerCase().includes("application/json") && text.trim()) {
    try {
      payload = JSON.parse(text) as ParsedPayload;
    } catch {
      payload = null;
    }
  }
  return { payload, text };
}

function payloadMessage(payload: ParsedPayload | null, fallbackText: string) {
  return cleanText(payload?.error ?? payload?.message) || fallbackText;
}

function isRouteLocked(routeStatus: string) {
  const normalized = cleanText(routeStatus).toLowerCase();
  return normalized === "completed" || normalized === "cancelled" || normalized === "canceled";
}

export function ManualRouteSalesSection({
  routeId,
  stopId,
  machineId,
  machineName,
  locationName,
  routeStatus,
  preferredProducts,
  allProducts,
  sales,
  onSaved,
  onCancelled,
  loadError,
}: ManualRouteSalesSectionProps) {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const [expanded, setExpanded] = useState(Boolean(loadError));
  const [showForm, setShowForm] = useState(false);
  const [sourceMode, setSourceMode] = useState<"preferred" | "all">("preferred");
  const [productId, setProductId] = useState("");
  const [fallbackProductName, setFallbackProductName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [unitSalePriceLyd, setUnitSalePriceLyd] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "card" | "other">("cash");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [warning, setWarning] = useState("");
  const [priceSourceLabel, setPriceSourceLabel] = useState<string | null>(null);
  const submissionIdRef = useRef(newClientId());
  const routeLocked = isRouteLocked(routeStatus);

  const productChoices = sourceMode === "preferred" ? preferredProducts : allProducts;
  const selectedProduct = useMemo(
    () => allProducts.find((product) => product.id === productId) ?? preferredProducts.find((product) => product.id === productId) ?? null,
    [allProducts, preferredProducts, productId],
  );

  const confirmedSales = useMemo(() => sales.filter((sale) => cleanText(sale.status).toLowerCase() === "confirmed"), [sales]);
  const confirmedCount = confirmedSales.length;
  const confirmedTotal = confirmedSales.reduce((sum, sale) => sum + numberValue(sale.totalAmountLyd), 0);
  const confirmedCashTotal = confirmedSales
    .filter((sale) => sale.paymentMethod === "cash")
    .reduce((sum, sale) => sum + numberValue(sale.totalAmountLyd), 0);
  const confirmedCardTotal = confirmedSales
    .filter((sale) => sale.paymentMethod === "card")
    .reduce((sum, sale) => sum + numberValue(sale.totalAmountLyd), 0);

  function resetForm() {
    setProductId("");
    setFallbackProductName("");
    setQuantity(1);
    setUnitSalePriceLyd(0);
    setPaymentMethod("cash");
    setNotes("");
    setPriceSourceLabel(null);
    submissionIdRef.current = newClientId();
  }

  function handleSelectProduct(nextProductId: string) {
    setProductId(nextProductId);
    const nextProduct = allProducts.find((product) => product.id === nextProductId) ?? preferredProducts.find((product) => product.id === nextProductId) ?? null;
    const suggestion = nextProduct ? resolveManualRouteSaleSuggestedPrice(nextProduct as ManualRouteSalePriceCandidate) : null;
    if (suggestion) {
      setUnitSalePriceLyd(suggestion.price);
      setPriceSourceLabel(manualRouteSalePriceSourceLabel(suggestion.source));
    } else {
      setUnitSalePriceLyd(0);
      setPriceSourceLabel(manualRouteSalePriceSourceLabel("manual_input"));
    }
    if (nextProduct?.name) {
      setFallbackProductName("");
    }
  }

  async function handleSave() {
    const fallbackName = cleanText(fallbackProductName);
    if (!productId && !fallbackName) {
      setError("Choose a product or type a product name.");
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Quantity must be greater than 0.");
      return;
    }
    if (!Number.isFinite(unitSalePriceLyd) || unitSalePriceLyd <= 0) {
      setError("Unit sale price must be greater than 0.");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");
    setWarning("");
    try {
      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/manual-sales`, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          productId: productId || null,
          productName: productId ? selectedProduct?.name ?? null : fallbackName,
          quantity,
          unitSalePriceLyd,
          paymentMethod,
          notes,
          machineId,
          clientSubmissionId: submissionIdRef.current,
        }),
      });
      const parsed = await parseResponse(response);
      if (!response.ok || parsed.payload?.success === false || !parsed.payload?.sale) {
        throw new Error(payloadMessage(parsed.payload, parsed.text || "Could not save manual sale."));
      }

      const sale = normalizeRouteManualSale(parsed.payload.sale as RouteManualSaleRow);
      const responseWarning = cleanText(parsed.payload.warning);
      onSaved(sale, {
        inventoryMovementCreated: Boolean(parsed.payload.inventoryMovementCreated),
        warning: responseWarning || null,
      });
      resetForm();
      setExpanded(true);
      setShowForm(false);
      setSuccess("Manual sale saved.");
      if (responseWarning) setWarning(responseWarning);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save manual sale.");
    } finally {
      setSaving(false);
    }
  }

  async function handleCancelSale(saleId: string) {
    setCancellingId(saleId);
    setError("");
    setSuccess("");
    setWarning("");
    try {
      const response = await fetch(`/api/operator/routes/${routeId}/stops/${stopId}/manual-sales`, {
        method: "PATCH",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ saleId, cancellationReason: "Cancelled from route stop" }),
      });
      const parsed = await parseResponse(response);
      if (!response.ok || parsed.payload?.success === false || !parsed.payload?.sale) {
        throw new Error(payloadMessage(parsed.payload, parsed.text || "Could not cancel manual sale."));
      }

      const sale = normalizeRouteManualSale(parsed.payload.sale as RouteManualSaleRow);
      const responseWarning = cleanText(parsed.payload.warning);
      onCancelled(sale, {
        inventoryReversed: Boolean(parsed.payload.inventoryReversed),
        warning: responseWarning || null,
      });
      setExpanded(true);
      setSuccess("Manual sale cancelled.");
      if (responseWarning) setWarning(responseWarning);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Could not cancel manual sale.");
    } finally {
      setCancellingId(null);
    }
  }

  const totalAmount = routeManualSaleTotal(quantity, unitSalePriceLyd);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div>
          <h2 className="text-lg font-semibold">{tr("Manual Route Sales", "??? ???? ????? ??????")}</h2>
          <p className="mt-1 text-sm text-slate-500">{t("Optional sales recorded during filling without blocking stop completion.", "Optional sales recorded during filling without blocking stop completion.")}</p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={confirmedCount ? "confirmed" : "pending"} label={confirmedCount ? String(confirmedCount) : tr("Optional", "???????")} />
          <span className="text-sm font-medium text-slate-600">{expanded ? tr("Hide", "?????") : tr("Show", "???")}</span>
        </div>
      </button>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs text-slate-500">{tr("Manual sales", "?????? ?????")}</div>
          <div className="mt-1 text-lg font-semibold text-slate-900">{confirmedCount}</div>
        </div>
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="text-xs text-emerald-700">{tr("Manual cash sales", "?????? ????? ???")}</div>
          <div className="mt-1 text-lg font-semibold text-emerald-950">{money(confirmedCashTotal)}</div>
        </div>
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3">
          <div className="text-xs text-sky-700">{tr("Manual sales total", "?????? ???????? ???????")}</div>
          <div className="mt-1 text-lg font-semibold text-sky-950">{money(confirmedTotal)}</div>
          {confirmedCardTotal > 0 ? <div className="mt-1 text-xs text-sky-800">{t("Card", "Card")}: {money(confirmedCardTotal)}</div> : null}
        </div>
      </div>

      {expanded ? (
        <div className="mt-4 space-y-4 border-t border-slate-200 pt-4">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            <span className="font-medium text-slate-900">{t("Machine", "Machine")}: </span>
            {machineName}
            {locationName ? <span className="text-slate-500"> - {locationName}</span> : null}
          </div>

          {routeLocked ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {t("This route is completed or cancelled, so new manual sales cannot be added here.", "This route is completed or cancelled, so new manual sales cannot be added here.")}
            </div>
          ) : null}

          {loadError ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">
              {t("manualSales.loadError", "Manual sales could not load. The rest of the route is still available.")}
            </div>
          ) : null}

          {!routeLocked ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => setShowForm((current) => !current)} className={showForm ? "btn-primary" : "btn-secondary"}>
                {showForm ? tr("Hide form", "????? ???????") : tr("Add manual sale", "????? ??? ????")}
              </button>
            </div>
          ) : null}

          {showForm && !routeLocked ? (
            <div className="space-y-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setSourceMode("preferred")} className={sourceMode === "preferred" ? "btn-primary" : "btn-secondary"}>
                  {tr("Priority products", "?????? ??????") }
                </button>
                <button type="button" onClick={() => setSourceMode("all")} className={sourceMode === "all" ? "btn-primary" : "btn-secondary"}>
                  {tr("Other storage products", "?????? ???? ?? ??????")}
                </button>
              </div>

              <ManualSaleProductPicker
                products={productChoices}
                value={productId}
                onChange={handleSelectProduct}
                label={sourceMode === "preferred" ? tr("Product", "??????") : tr("Other storage products", "?????? ???? ?? ??????")}
              />

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Product name if not found", "??? ?????? ??? ?? ??? ???????")}</span>
                <input
                  value={fallbackProductName}
                  onChange={(event) => setFallbackProductName(event.target.value)}
                  className="field-input"
                  placeholder={tr("Use only if the product is not in the list", "??????? ??? ??? ?? ??? ?????? ??????? ?? ???????")}
                />
              </label>

              {selectedProduct ? (
                <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
                  <div>
                    <span className="font-medium text-slate-900">{selectedProduct.name}</span>
                    {selectedProduct.sku ? <span className="text-slate-500"> - {selectedProduct.sku}</span> : null}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {tr("Bag available", "?????? ?? ???????")}: {selectedProduct.availableQty}
                    {selectedProduct.sourceLabel ? ` - ${t(selectedProduct.sourceLabel, selectedProduct.sourceLabel)}` : ""}
                  </div>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-[180px_1fr_1fr]">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Quantity", "??????")}</span>
                  <QuantityStepper value={quantity} max={999} onChange={setQuantity} inputLabel={tr("Quantity", "??????")} />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Unit price", "??? ??????")}</span>
                  <input
                    value={unitSalePriceLyd}
                    onChange={(event) => {
                      setUnitSalePriceLyd(numberValue(event.target.value));
                      setPriceSourceLabel(manualRouteSalePriceSourceLabel("manual_input"));
                    }}
                    type="number"
                    min="0"
                    step="0.01"
                    className="field-input"
                  />
                  <span className="mt-1 block text-xs text-slate-500">{priceSourceLabel ? t(priceSourceLabel, priceSourceLabel) : tr("Manual input", "????? ????")}</span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Payment method", "????? ?????")}</span>
                  <select value={paymentMethod} onChange={(event) => setPaymentMethod(parseRouteManualSalePaymentMethod(event.target.value))} className="field-input">
                    <option value="cash">{tr("Cash", "???")}</option>
                    <option value="card">{tr("Card", "?????")}</option>
                    <option value="other">{tr("Other", "????")}</option>
                  </select>
                </label>
              </div>

              <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">
                <span className="font-medium text-slate-900">{tr("Total", "????????")}: </span>
                {money(totalAmount)}
              </div>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Notes", "???????")}</span>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  className="field-input"
                  rows={3}
                  placeholder={t("Optional context for this sale", "Optional context for this sale")}
                />
              </label>

              {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{t(error, error)}</div> : null}
              {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-900">{t(success, success)}</div> : null}
              {warning ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">{t(warning, warning)}</div> : null}

              <button type="button" onClick={handleSave} disabled={saving} className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60">
                {saving ? `${tr("Saving", "???? ?????")}...` : tr("Save sale", "??? ?????")}
              </button>
            </div>
          ) : null}

          <div>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-semibold text-slate-900">{tr("Saved manual sales", "???????? ??????? ????????")}</h3>
                <p className="text-sm text-slate-500">{t("Manual sales entered for this stop appear here immediately.", "Manual sales entered for this stop appear here immediately.")}</p>
              </div>
            </div>

            {sales.length ? (
              <div className="space-y-3">
                {sales.map((sale) => {
                  const canCancel = !routeLocked && cleanText(sale.status).toLowerCase() === "confirmed";
                  return (
                    <article key={sale.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <StatusBadge status={sale.status} label={t(manualRouteSaleStatusLabel(sale.status), manualRouteSaleStatusLabel(sale.status))} />
                            <span className="font-semibold text-slate-900">{sale.productName || t("Unknown product", "Unknown product")}</span>
                            <span className="text-sm text-slate-500">x{sale.quantity}</span>
                            <span className="text-sm font-medium text-slate-700">{money(sale.totalAmountLyd)}</span>
                          </div>
                          <p className="mt-1 text-sm text-slate-600">
                            {money(sale.unitSalePriceLyd)} - {t(manualRouteSalePaymentMethodLabel(sale.paymentMethod), manualRouteSalePaymentMethodLabel(sale.paymentMethod))}
                          </p>
                          {sale.notes ? <p className="mt-1 text-sm text-slate-500">{sale.notes}</p> : null}
                          {sale.cancellationReason ? <p className="mt-1 text-sm text-amber-700">{sale.cancellationReason}</p> : null}
                        </div>
                        <div className="flex flex-col items-start gap-2 text-xs text-slate-500 sm:items-end">
                          <div>{sale.saleTime ? new Date(sale.saleTime).toLocaleString("en-US") : t("Just now", "Just now")}</div>
                          {canCancel ? (
                            <button
                              type="button"
                              onClick={() => void handleCancelSale(sale.id)}
                              disabled={cancellingId === sale.id}
                              className="text-sm font-medium text-rose-700 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {cancellingId === sale.id ? `${tr("Saving", "???? ?????")}...` : tr("Cancel sale", "????? ?????")}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : loadError ? null : (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
                {t("manualSales.empty", "No manual sales have been recorded yet.")}
              </p>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ManualSaleProductPicker({
  products,
  value,
  onChange,
  label,
}: {
  products: ManualRouteSaleProductOption[];
  value: string;
  onChange: (productId: string) => void;
  label: string;
}) {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.id === value) ?? null;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return products.slice(0, 8);
    return products.filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((field) => String(field ?? "").toLowerCase().includes(needle))).slice(0, 8);
  }, [products, query]);

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-slate-800">{label}</span>
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-h-12 w-full rounded-md border-0 px-2 py-2 text-base outline-none ring-0 md:text-sm"
          placeholder={selected ? `${selected.name} - ${selected.sku ?? t("No SKU", "No SKU")}` : t("Search name, SKU, barcode, category, or brand", "Search name, SKU, barcode, category, or brand")}
        />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {selected && !query.trim() ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              {t("Selected", "Selected")}: {selected.name} - {tr("Bag available", "?????? ?? ???????")}: {selected.availableQty}
            </div>
          ) : null}
          {filtered.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => {
                onChange(product.id);
                setQuery("");
              }}
              className={`min-h-14 w-full rounded-md px-3 py-2 text-left text-sm transition ${product.id === value ? "brand-selected" : "hover:bg-slate-100"}`}
            >
              <span className="flex items-center gap-3">
                <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{product.name}</span>
                  <span className={`block truncate ${product.id === value ? "text-white/80" : "text-slate-500"}`}>
                    {product.sku ?? t("No SKU", "No SKU")} - {tr("Bag available", "?????? ?? ???????")}: {product.availableQty}
                    {product.sourceLabel ? ` - ${t(product.sourceLabel, product.sourceLabel)}` : ""}
                  </span>
                </span>
              </span>
            </button>
          ))}
          {!filtered.length ? <p className="px-3 py-2 text-sm text-slate-500">{t("No products found", "No products found")}</p> : null}
        </div>
      </div>
    </div>
  );
}
