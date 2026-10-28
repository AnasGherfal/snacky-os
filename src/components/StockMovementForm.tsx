"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DraftRestoreBanner, DraftSaveStatus, useDraftKey, useLocalDraft } from "@/components/LocalDraft";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { FormField, FormSection, SecondaryButton } from "@/components/ui";
import { createQuickProduct, createStorageAdjustment } from "@/lib/inventory-actions";

type ProductOption = {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  imageUrl?: string | null;
  sellingPrice: number;
  storageQtyByLocationId: Record<string, number>;
};

type NamedOption = { id: string; name: string };
type StockMovementDraft = {
  clientSubmissionId: string;
  selectedProductId: string;
  query: string;
  barcode: string;
  simpleQuantity: number;
  simpleStorageLocationId: string;
  adjustmentType: "set_exact" | "add" | "remove";
  adjustmentReason: string;
  adjustmentDate: string;
  notes: string;
  showQuickAdd: boolean;
  missingProduct: string;
};

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function redirectTarget(error: unknown) {
  const digest = String((error as { digest?: unknown } | null)?.digest ?? "");
  if (!digest.startsWith("NEXT_REDIRECT")) return "";
  return digest.split(";")[2] ?? "";
}

export function StockMovementForm({
  userId,
  initialClientSubmissionId,
  products,
  recentProductIds,
  storages,
  canSeeSellingPrice,
  canQuickAddProduct,
}: {
  userId: string;
  initialClientSubmissionId: string;
  products: ProductOption[];
  recentProductIds: string[];
  storages: NamedOption[];
  canSeeSellingPrice: boolean;
  canQuickAddProduct: boolean;
}) {
  const router = useRouter();
  const quickAddStorageKey = `snacky:stock-quick-product:v1:${userId}`;
  const [clientSubmissionId, setClientSubmissionId] = useState(initialClientSubmissionId);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  const [simpleQuantity, setSimpleQuantity] = useState(0);
  const [simpleStorageLocationId, setSimpleStorageLocationId] = useState("");
  const [adjustmentType, setAdjustmentType] = useState<"set_exact" | "add" | "remove">("set_exact");
  const [adjustmentReason, setAdjustmentReason] = useState("stock_count_correction");
  const [adjustmentDate, setAdjustmentDate] = useState(todayDate);
  const [notes, setNotes] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [missingProduct, setMissingProduct] = useState("");
  const [isPending, startTransition] = useTransition();
  const quickAddInFlightRef = useRef(false);
  const quickAddFrozenRequestRef = useRef<FormData | null>(null);
  const [quickAddError, setQuickAddError] = useState("");
  const [quickAddRecoveryBlocked, setQuickAddRecoveryBlocked] = useState(false);
  const adjustmentInFlightRef = useRef(false);
  const adjustmentCompletedRef = useRef(false);
  const [adjustmentSaving, setAdjustmentSaving] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const draftKey = useDraftKey("inventory-movement", ["new"]);

  // Recover an unconfirmed product creation after a tab reload. A fresh UUID
  // would bypass the server's duplicate protection, so keep the ORIGINAL
  // immutable request in tab-scoped, account-scoped session storage.
  useEffect(() => {
    if (!canQuickAddProduct) return;
    let raw: string | null;
    try { raw = window.sessionStorage.getItem(quickAddStorageKey); }
    catch { return; }
    if (!raw) return;
    let blocked = false;
    let message = "A product save from this tab was interrupted. Check Products, then retry the SAME saved request.";
    try {
      const saved = JSON.parse(raw) as { id?: unknown; fields?: unknown };
      const id = String(saved?.id ?? "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
        || !saved.fields || typeof saved.fields !== "object" || Array.isArray(saved.fields)) {
        throw new Error("Bad saved request metadata");
      }
      const fields = saved.fields as Record<string, unknown>;
      const immutable = new FormData();
      for (const name of ["sku", "name", "barcode", "category", "brand", "selling_price"]) {
        if (typeof fields[name] !== "string" || fields[name].length > 1000) {
          throw new Error("Incomplete saved product request");
        }
        immutable.set(name, fields[name]);
      }
      if (!String(immutable.get("name") ?? "").trim()) throw new Error("Missing saved product name");
      immutable.set("client_product_id", id);
      quickAddFrozenRequestRef.current = immutable;
    } catch {
      // Do not silently generate a different UUID when we cannot read the
      // earlier request. Require manual review before starting a new one.
      blocked = true;
      message = "Saved product request could not be recovered. Check Products before starting another.";
    }
    // Defer UI state updates until after this effect so product form hydration
    // and initial draft restoration do not race the recovery banner.
    const timer = window.setTimeout(() => {
      setQuickAddRecoveryBlocked(blocked);
      setQuickAddError(message);
      setShowQuickAdd(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [canQuickAddProduct, quickAddStorageKey]);
  const movementDraft = useMemo<StockMovementDraft>(() => ({
    clientSubmissionId,
    selectedProductId,
    query,
    barcode,
    simpleQuantity,
    simpleStorageLocationId,
    adjustmentType,
    adjustmentReason,
    adjustmentDate,
    notes,
    showQuickAdd,
    missingProduct,
  }), [
    adjustmentDate,
    adjustmentReason,
    adjustmentType,
    barcode,
    clientSubmissionId,
    missingProduct,
    notes,
    query,
    selectedProductId,
    showQuickAdd,
    simpleQuantity,
    simpleStorageLocationId,
  ]);
  const shouldSaveMovementDraft = useCallback((draft: StockMovementDraft) => (
    Boolean(draft.selectedProductId) ||
    Boolean(draft.query.trim()) ||
    Boolean(draft.barcode.trim()) ||
    draft.simpleQuantity !== 0 ||
    Boolean(draft.simpleStorageLocationId) ||
    draft.adjustmentType !== "set_exact" ||
    draft.adjustmentReason !== "stock_count_correction" ||
    draft.adjustmentDate !== todayDate() ||
    Boolean(draft.notes.trim()) ||
    draft.showQuickAdd ||
    Boolean(draft.missingProduct.trim())
  ), []);
  const localDraft = useLocalDraft<StockMovementDraft>({
    key: draftKey,
    value: movementDraft,
    shouldSave: shouldSaveMovementDraft,
    onRestore: (draft) => {
      setClientSubmissionId(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draft.clientSubmissionId ?? "")
          ? draft.clientSubmissionId
          : initialClientSubmissionId,
      );
      setSelectedProductId(draft.selectedProductId ?? "");
      setQuery(draft.query ?? "");
      setBarcode(draft.barcode ?? "");
      setSimpleQuantity(Math.max(0, Number(draft.simpleQuantity ?? 0)));
      setSimpleStorageLocationId(draft.simpleStorageLocationId ?? "");
      setAdjustmentType(["set_exact", "add", "remove"].includes(draft.adjustmentType) ? draft.adjustmentType : "set_exact");
      setAdjustmentReason(draft.adjustmentReason ?? "stock_count_correction");
      setAdjustmentDate(draft.adjustmentDate ?? todayDate());
      setNotes(draft.notes ?? "");
      setShowQuickAdd(Boolean(draft.showQuickAdd));
      setMissingProduct(draft.missingProduct ?? "");
    },
  });

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const selectedProduct = selectedProductId ? productById.get(selectedProductId) : null;
  const recentProducts = useMemo(() => {
    const recent = recentProductIds.map((id) => productById.get(id)).filter(Boolean) as ProductOption[];
    return recent.length ? recent.slice(0, 8) : products.slice(0, 8);
  }, [productById, products, recentProductIds]);
  const filteredProducts = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    if (!needle) return recentProducts;
    return products
      .filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(needle)))
      .slice(0, 30);
  }, [products, deferredQuery, recentProducts]);

  const selectedStorageLocationId = simpleStorageLocationId;
  const selectedStorage = selectedStorageLocationId
    ? storages.find((storage) => storage.id === selectedStorageLocationId) ?? null
    : null;
  const storageQuantityFor = (product: ProductOption | null | undefined, storageLocationId = selectedStorageLocationId) => {
    if (!product || !storageLocationId) return null;
    const quantityAtLocation = Number(product.storageQtyByLocationId[storageLocationId] ?? 0);
    return Number.isFinite(quantityAtLocation) ? Math.max(0, Math.floor(quantityAtLocation)) : 0;
  };
  const selectedProductStorageQty = storageQuantityFor(selectedProduct);

  const selectProduct = (product: ProductOption) => {
    setSelectedProductId(product.id);
    setQuery(product.name);
    setMissingProduct("");
    setSimpleQuantity(adjustmentType === "set_exact" ? storageQuantityFor(product, simpleStorageLocationId) ?? 0 : 1);
  };

  const handleBarcode = () => {
    const needle = barcode.trim().toLowerCase();
    if (!needle) return;
    const product = products.find((item) => String(item.barcode ?? "").toLowerCase() === needle || String(item.sku ?? "").toLowerCase() === needle);
    if (product) {
      selectProduct(product);
      setBarcode("");
    } else {
      setMissingProduct(barcode.trim());
    }
  };

  const quickAddAction = (formData: FormData) => {
    // Disabling after React paints is too late for rapid double-taps. Keep
    // both a synchronous lock and the exact first request across uncertain
    // network outcomes. The server verifies its UUID before returning a replay.
    if (quickAddInFlightRef.current || quickAddRecoveryBlocked) return;
    if (!quickAddFrozenRequestRef.current) {
      const clientProductId = globalThis.crypto?.randomUUID?.();
      if (!clientProductId) {
        setQuickAddError("Could not create a safe request ID. Reload this page before adding a product.");
        return;
      }
      formData.set("client_product_id", clientProductId);
      quickAddFrozenRequestRef.current = formData;
      try {
        window.sessionStorage.setItem(quickAddStorageKey, JSON.stringify({
          id: clientProductId,
          fields: Object.fromEntries(
            ["sku", "name", "barcode", "category", "brand", "selling_price"]
              .map((name) => [name, String(formData.get(name) ?? "")]),
          ),
        }));
      } catch { /* The in-memory frozen request still protects this mounted form. */ }
    }
    quickAddInFlightRef.current = true;
    setQuickAddError("");
    startTransition(async () => {
      try {
        await createQuickProduct(quickAddFrozenRequestRef.current!);
        quickAddFrozenRequestRef.current = null;
        try { window.sessionStorage.removeItem(quickAddStorageKey); }
        catch { /* Browser storage unavailable. */ }
        setQuickAddError("");
        setShowQuickAdd(false);
        router.refresh();
      } catch (error) {
        console.error("[stock] Could not confirm quick product creation", error);
        setQuickAddError("Save not confirmed. Check Products, then retry this SAME request. A new product will not be created on an identical retry.");
      } finally {
        quickAddInFlightRef.current = false;
      }
    });
  };

  const submitMovementAction = async (formData: FormData) => {
    if (adjustmentInFlightRef.current || adjustmentCompletedRef.current) return;
    adjustmentInFlightRef.current = true;
    setAdjustmentSaving(true);
    const nextDraft = movementDraft;
    localDraft.saveNow(nextDraft);
    try {
      await createStorageAdjustment(formData);
      adjustmentCompletedRef.current = true;
      localDraft.clearDraft();
    } catch (error) {
      localDraft.saveNow(nextDraft);
      const target = redirectTarget(error);
      if (target && !target.includes("error=")) {
        adjustmentCompletedRef.current = true;
        localDraft.clearDraft();
      }
      throw error;
    } finally {
      adjustmentInFlightRef.current = false;
      setAdjustmentSaving(false);
    }
  };

  return (
    <>
      <form action={submitMovementAction} onSubmitCapture={(event) => {
        if (adjustmentInFlightRef.current || adjustmentCompletedRef.current) {
          event.preventDefault();
          return;
        }
        localDraft.saveNow(movementDraft);
      }} className="space-y-6" aria-busy={adjustmentSaving}>
      {adjustmentSaving ? <p role="status" className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm font-medium text-sky-950">
        Saving storage adjustment… / جارٍ حفظ تعديل المخزون… Do not submit again.
      </p> : null}
      <input type="hidden" name="client_submission_id" value={clientSubmissionId} />
      <input type="hidden" name="product_id" value={selectedProductId} />
      <input type="hidden" name="quantity" value={simpleQuantity} />
      <DraftRestoreBanner pendingDraft={localDraft.pendingDraft} onRestore={localDraft.restoreDraft} onDiscard={localDraft.discardDraft} />
      {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}

      <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
        <div className="font-semibold">Use the source workflow for custody movements</div>
        <p className="mt-1 leading-6">Route pickup, machine fill, return, damage, and substitution inventory must be recorded from the related route or stop. This page is only for an owner/admin physical storage count correction.</p>
        <div className="mt-3"><SecondaryButton href="/routes">Open routes</SecondaryButton></div>
      </div>

      <FormSection title="Storage count adjustment" description="Correct one physical storage count. Snacky OS creates an immutable audit movement automatically.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="md:col-span-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <label className="text-sm font-medium text-slate-800">Product</label>
                <p className="text-xs text-slate-500">Search by name, SKU, barcode, category, or brand.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={() => setShowQuickAdd(true)} disabled={!canQuickAddProduct}>
                Product not found? Add product
              </button>
            </div>
            <div className="grid gap-3 lg:grid-cols-[1fr_280px]">
              <input value={query} onChange={(event) => setQuery(event.target.value)} className="field-input" placeholder="Search product" />
              <div className="flex gap-2">
                <input value={barcode} onChange={(event) => setBarcode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); handleBarcode(); } }} className="field-input" placeholder="Scan barcode / SKU" />
                <button type="button" className="btn-secondary" onClick={handleBarcode}>Scan</button>
              </div>
            </div>
            {missingProduct ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Product missing from list: <span className="font-medium">{missingProduct}</span>
                {canQuickAddProduct ? null : <span className="ml-1">Report it to an admin before creating a full product.</span>}
              </div>
            ) : null}
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {filteredProducts.map((product) => (
                <button key={product.id} type="button" onClick={() => selectProduct(product)} className={`rounded-lg border p-3 text-left transition ${selectedProductId === product.id ? "brand-selected border-transparent" : "border-slate-200 bg-white hover:border-slate-400"}`}>
                  <div className="flex gap-3">
                    <ProductThumbnail imageUrl={product.imageUrl} name={product.name} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate font-medium ${selectedProductId === product.id ? "text-white" : "text-slate-900"}`}>{product.name}</div>
                      <div className={`text-xs ${selectedProductId === product.id ? "text-white/80" : "text-slate-500"}`}>{product.sku ?? "No SKU"} - {product.category ?? "Uncategorized"} {product.brand ? `- ${product.brand}` : ""}</div>
                      <div className={`mt-1 text-xs ${selectedProductId === product.id ? "text-white/90" : "text-slate-600"}`}>
                        {selectedStorage
                          ? `Quantity at ${selectedStorage.name}: ${storageQuantityFor(product) ?? 0}`
                          : "Select a storage location to see its quantity"}
                        {canSeeSellingPrice ? ` - Selling LYD ${product.sellingPrice.toFixed(2)}` : ""}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <FormField label="Adjustment type" required>
            <select name="adjustment_type" required className="field-input" value={adjustmentType} onChange={(event) => {
              const nextType = event.target.value as typeof adjustmentType;
              setAdjustmentType(nextType);
              setSimpleQuantity(nextType === "set_exact" ? selectedProductStorageQty ?? 0 : 1);
            }}>
              <option value="set_exact">Set exact count</option>
              <option value="add">Add quantity</option>
              <option value="remove">Remove quantity</option>
            </select>
          </FormField>
          <FormField label="Storage location" required>
            <select
              name="storage_location_id"
              required
              className="field-input"
              value={simpleStorageLocationId}
              onChange={(event) => {
                const nextStorageLocationId = event.target.value;
                setSimpleStorageLocationId(nextStorageLocationId);
                if (adjustmentType === "set_exact") {
                  setSimpleQuantity(storageQuantityFor(selectedProduct, nextStorageLocationId) ?? 0);
                }
              }}
            >
              <option value="">Select storage</option>
              {storages.map((storage) => <option key={storage.id} value={storage.id}>{storage.name}</option>)}
            </select>
          </FormField>
          <FormField label={adjustmentType === "set_exact" ? "Actual counted quantity" : "Quantity"} required>
            <input type="number" min={adjustmentType === "set_exact" ? "0" : "1"} value={simpleQuantity} onChange={(event) => setSimpleQuantity(Math.max(0, Math.floor(Number(event.target.value) || 0)))} className="field-input" />
            {selectedProduct && selectedStorage ? <p className="mt-1 text-xs text-slate-500">System quantity at {selectedStorage.name}: {selectedProductStorageQty ?? 0}</p> : null}
            {selectedProduct && !selectedStorage ? <p className="mt-1 text-xs font-medium text-amber-700">Select the storage location before entering its physical count.</p> : null}
            {selectedProduct && selectedStorage && adjustmentType === "set_exact" ? <p className="mt-1 text-xs font-medium text-slate-700">Adjustment will be {simpleQuantity - (selectedProductStorageQty ?? 0) > 0 ? "+" : ""}{simpleQuantity - (selectedProductStorageQty ?? 0)}.</p> : null}
          </FormField>
          <FormField label="Reason" required>
            <select name="adjustment_reason" required className="field-input" value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)}>
              <option value="stock_count_correction">Stock count correction</option>
              <option value="damaged_expired_item">Damaged/expired item</option>
              <option value="missing_item">Missing item</option>
              <option value="found_item">Found item</option>
              <option value="manual_correction">Manual correction</option>
              <option value="other">Other</option>
            </select>
          </FormField>
          <FormField label="Date">
            <input name="adjustment_date" type="date" value={adjustmentDate} onChange={(event) => setAdjustmentDate(event.target.value)} className="field-input" />
          </FormField>
        </div>
      </FormSection>

      <FormSection title="Note" description="Optional count reference, shelf note, or supervisor context.">
        <FormField label="Notes">
          <textarea name="notes" rows={4} className="field-input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Reason, count reference, route handoff notes, or supervisor approval." />
        </FormField>
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button className="btn-primary disabled:opacity-50" disabled={adjustmentSaving || adjustmentCompletedRef.current || !selectedProductId || !simpleStorageLocationId || (adjustmentType !== "set_exact" && simpleQuantity < 1)}>
          {adjustmentSaving ? "Saving adjustment…" : adjustmentCompletedRef.current ? "Saved" : "Save adjustment"}
        </button>
        <SecondaryButton href="/inventory">Cancel</SecondaryButton>
      </div>
      </form>

      {showQuickAdd ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="quick-add-product-title">
          <div className="ml-auto h-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 id="quick-add-product-title" className="text-lg font-semibold">Quick add product</h2>
              <button type="button" className="btn-secondary" onClick={() => setShowQuickAdd(false)}>Close</button>
            </div>
            <div className="space-y-4">
              <form action={quickAddAction} className="space-y-4" aria-busy={isPending}>
                <fieldset disabled={isPending || Boolean(quickAddFrozenRequestRef.current)} className="min-w-0 space-y-4 border-0 p-0">
                <FormField label="SKU" hint="Product code will be generated automatically if left blank. SKU is the internal/VMS product code used for matching and reports."><input name="sku" className="field-input" placeholder="Auto if blank" /></FormField>
                <FormField label="Product name" required><input name="name" required className="field-input" /></FormField>
                <FormField label="Barcode"><input name="barcode" className="field-input" /></FormField>
                <FormField label="Category"><select name="category" className="field-input"><option>drink</option><option>snack</option><option>chocolate</option><option>biscuit</option><option>coffee</option><option>other</option></select></FormField>
                <FormField label="Brand"><input name="brand" className="field-input" /></FormField>
                <FormField label="Selling price"><input name="selling_price" type="number" step="0.01" className="field-input" /></FormField>
                </fieldset>
                {quickAddFrozenRequestRef.current ? (
                  <p role="status" className="text-sm text-amber-900">
                    This retry uses your original saved product details for <strong>{String(quickAddFrozenRequestRef.current.get("name") ?? "the product")}</strong>.
                    Check Products before starting a different item.
                  </p>
                ) : null}
                {quickAddError ? <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{quickAddError}</p> : null}
                <button className="btn-primary" disabled={isPending || quickAddInFlightRef.current || quickAddRecoveryBlocked}>{isPending ? "Adding…" : quickAddFrozenRequestRef.current ? "Retry saved product request" : "Add product"}</button>
                {(quickAddFrozenRequestRef.current || quickAddRecoveryBlocked) && !isPending ? (
                  <button type="button" className="btn-secondary" onClick={() => {
                    if (!window.confirm("Check Products for the earlier item before starting a different request. Have you confirmed no duplicate will be created?")) return;
                    quickAddFrozenRequestRef.current = null;
                    setQuickAddRecoveryBlocked(false);
                    try { window.sessionStorage.removeItem(quickAddStorageKey); }
                    catch { /* Browser storage unavailable. */ }
                    setQuickAddError("");
                  }}>
                    Start a different product request
                  </button>
                ) : null}
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
