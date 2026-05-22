"use client";

import { useDeferredValue, useMemo, useState, useTransition } from "react";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { FormField, FormSection, SecondaryButton, StatusBadge } from "@/components/ui";
import { createQuickProduct, createStockMovement, createStorageAdjustment } from "@/lib/inventory-actions";

type ProductOption = {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  imageUrl?: string | null;
  sellingPrice: number;
  storageQty: number;
};

type NamedOption = { id: string; name: string };
type RouteOption = { id: string; route_date: string; operator_id: string | null; status: string };

const movementTypes = [
  { value: "storage_to_operator_bag", label: "Storage to operator bag", helper: "Take stock out of storage for a route or operator." },
  { value: "operator_bag_to_storage", label: "Operator bag to storage", helper: "Return unused operator stock back to storage." },
  { value: "storage_adjustment", label: "Storage adjustment", helper: "Record a stock count adjustment through the ledger." },
  { value: "damaged", label: "Damaged", helper: "Move damaged stock to waste." },
  { value: "expired", label: "Expired", helper: "Move expired stock to waste." },
  { value: "manual_correction", label: "Manual correction", helper: "Owner/admin correction entry. Old movements stay untouched." },
  { value: "product_substitution", label: "Product substitution", helper: "Record stock impact from an operator-approved route substitution." },
] as const;

function optionValue(type: string, id?: string | null) {
  return `${type}:${id ?? ""}`;
}

export function StockMovementForm({
  products,
  recentProductIds,
  storages,
  operators,
  routes,
  operatorById,
  canSeeSellingPrice,
  canAdminOverride,
  canQuickAddProduct,
}: {
  products: ProductOption[];
  recentProductIds: string[];
  storages: NamedOption[];
  operators: { id: string; full_name: string }[];
  routes: RouteOption[];
  operatorById: Record<string, string>;
  canSeeSellingPrice: boolean;
  canAdminOverride: boolean;
  canQuickAddProduct: boolean;
}) {
  const [mode, setMode] = useState<"simple" | "advanced">("simple");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [query, setQuery] = useState("");
  const [barcode, setBarcode] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [simpleQuantity, setSimpleQuantity] = useState(0);
  const [adjustmentType, setAdjustmentType] = useState<"set_exact" | "add" | "remove">("set_exact");
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [missingProduct, setMissingProduct] = useState("");
  const [isPending, startTransition] = useTransition();
  const deferredQuery = useDeferredValue(query);

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

  const selectProduct = (product: ProductOption) => {
    setSelectedProductId(product.id);
    setQuery(product.name);
    setMissingProduct("");
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

  const setSafeQuantity = (next: number) => {
    const max = selectedProduct?.storageQty ?? Number.MAX_SAFE_INTEGER;
    setQuantity(Math.max(1, Math.min(next, max || next)));
  };

  const quickAddAction = (formData: FormData) => {
    startTransition(async () => {
      await createQuickProduct(formData);
      setShowQuickAdd(false);
    });
  };

  return (
    <form action={mode === "simple" ? createStorageAdjustment : createStockMovement} className="space-y-6">
      <input type="hidden" name="product_id" value={selectedProductId} />
      <input type="hidden" name="quantity" value={mode === "simple" ? simpleQuantity : quantity} />

      <div className="grid gap-2 rounded-lg border border-slate-200 bg-white p-1 sm:grid-cols-2">
        <button type="button" onClick={() => setMode("simple")} className={mode === "simple" ? "btn-primary justify-center" : "btn-secondary justify-center"}>
          Simple Adjustment
        </button>
        <button type="button" onClick={() => setMode("advanced")} className={mode === "advanced" ? "btn-primary justify-center" : "btn-secondary justify-center"}>
          Transfer / Advanced Movement
        </button>
      </div>

      <FormSection title={mode === "simple" ? "Simple storage adjustment" : "Movement details"} description={mode === "simple" ? "Correct storage counts without choosing from/to locations. Snacky OS creates the audit movement automatically." : "Choose the product, quantity, reason, and optional route context for this ledger movement."}>
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
                        Storage {product.storageQty}
                        {canSeeSellingPrice ? ` - Selling LYD ${product.sellingPrice.toFixed(2)}` : ""}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {mode === "simple" ? (
            <>
              <FormField label="Adjustment type" required>
                <select name="adjustment_type" required className="field-input" value={adjustmentType} onChange={(event) => setAdjustmentType(event.target.value as typeof adjustmentType)}>
                  <option value="set_exact">Set exact count</option>
                  <option value="add">Add quantity</option>
                  <option value="remove">Remove quantity</option>
                </select>
              </FormField>
              <FormField label={adjustmentType === "set_exact" ? "Actual counted quantity" : "Quantity"} required>
                <input type="number" min={adjustmentType === "set_exact" ? "0" : "1"} value={simpleQuantity} onChange={(event) => setSimpleQuantity(Math.max(0, Math.floor(Number(event.target.value) || 0)))} className="field-input" />
                {selectedProduct ? <p className="mt-1 text-xs text-slate-500">System storage quantity: {selectedProduct.storageQty}</p> : null}
                {selectedProduct && adjustmentType === "set_exact" ? <p className="mt-1 text-xs font-medium text-slate-700">Adjustment will be {simpleQuantity - selectedProduct.storageQty > 0 ? "+" : ""}{simpleQuantity - selectedProduct.storageQty}.</p> : null}
              </FormField>
              <FormField label="Reason" required>
                <select name="adjustment_reason" required className="field-input" defaultValue="stock_count_correction">
                  <option value="stock_count_correction">Stock count correction</option>
                  <option value="damaged_expired_item">Damaged/expired item</option>
                  <option value="missing_item">Missing item</option>
                  <option value="found_item">Found item</option>
                  <option value="manual_correction">Manual correction</option>
                  <option value="other">Other</option>
                </select>
              </FormField>
              <FormField label="Date">
                <input name="adjustment_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} className="field-input" />
              </FormField>
            </>
          ) : (
            <>
              <FormField label="Quantity" required>
                <div className="flex flex-wrap items-center gap-2">
                  {[-1, 1, 5, 10].map((delta) => (
                    <button key={delta} type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setSafeQuantity(quantity + delta)}>
                      {delta > 0 ? `+${delta}` : delta}
                    </button>
                  ))}
                  <input type="number" min="1" value={quantity} onChange={(event) => setSafeQuantity(Number(event.target.value) || 1)} className="field-input w-28" />
                </div>
                {selectedProduct ? <p className="mt-1 text-xs text-slate-500">Current storage quantity: {selectedProduct.storageQty}</p> : null}
              </FormField>
              <FormField label="Reason" required>
                <select name="movement_type" required className="field-input" defaultValue="storage_to_operator_bag">
                  {movementTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </FormField>
              <FormField label="Related route optional">
                <select name="related_route_id" className="field-input">
                  <option value="">No route</option>
                  {routes.map((route) => <option key={route.id} value={route.id}>{route.route_date} - {route.status} - {operatorById[route.operator_id ?? ""] ?? "Unassigned"}</option>)}
                </select>
              </FormField>
            </>
          )}
        </div>
      </FormSection>

      {mode === "advanced" ? <FormSection title="From and to" description="Stock must move between explicit locations so balances remain audit-friendly.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="From location/type" required>
            <select name="from_location" required className="field-input">
              <option value="">Select source</option>
              <optgroup label="Storage">{storages.map((storage) => <option key={storage.id} value={optionValue("storage", storage.id)}>Storage - {storage.name}</option>)}</optgroup>
              <optgroup label="Operator bags">{operators.map((operator) => <option key={operator.id} value={optionValue("operator_bag", operator.id)}>Operator bag - {operator.full_name}</option>)}</optgroup>
              <option value={optionValue("adjustment")}>Adjustment account</option>
            </select>
          </FormField>
          <FormField label="To location/type" required>
            <select name="to_location" required className="field-input">
              <option value="">Select destination</option>
              <optgroup label="Storage">{storages.map((storage) => <option key={storage.id} value={optionValue("storage", storage.id)}>Storage - {storage.name}</option>)}</optgroup>
              <optgroup label="Operator bags">{operators.map((operator) => <option key={operator.id} value={optionValue("operator_bag", operator.id)}>Operator bag - {operator.full_name}</option>)}</optgroup>
              <option value={optionValue("waste")}>Waste</option>
              <option value={optionValue("adjustment")}>Adjustment account</option>
            </select>
          </FormField>
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {movementTypes.map((type) => <div key={type.value} className="rounded-lg border border-slate-200 bg-white p-3"><div className="mb-2"><StatusBadge status={type.value} /></div><p className="text-sm text-slate-600">{type.helper}</p></div>)}
        </div>
      </FormSection> : null}

      <FormSection title={mode === "simple" ? "Note" : "Notes and override"} description={mode === "simple" ? "Optional count reference, shelf note, or supervisor context." : "Use notes for count references, supervisor context, or correction reasons."}>
        <FormField label="Notes">
          <textarea name="notes" rows={4} className="field-input" placeholder="Reason, count reference, route handoff notes, or supervisor approval." />
        </FormField>
        {mode === "advanced" && canAdminOverride ? (
          <label className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <input name="admin_override" type="checkbox" className="mt-1" />
            <span><span className="block font-semibold">Owner/admin override</span>Allow this movement to take more than currently available storage.</span>
          </label>
        ) : mode === "advanced" ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">You cannot override available storage.</div> : null}
      </FormSection>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button className="btn-primary" disabled={!selectedProductId}>{mode === "simple" ? "Save adjustment" : "Create movement"}</button>
        <SecondaryButton href="/inventory">Cancel</SecondaryButton>
      </div>

      {showQuickAdd ? (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-4">
          <div className="ml-auto h-full max-w-md overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Quick add product</h2>
              <button type="button" className="btn-secondary" onClick={() => setShowQuickAdd(false)}>Close</button>
            </div>
            <div className="space-y-4">
              <form action={quickAddAction} className="space-y-4">
                <FormField label="SKU" hint="Product code will be generated automatically if left blank. SKU is the internal/VMS product code used for matching and reports."><input name="sku" className="field-input" placeholder="Auto if blank" /></FormField>
                <FormField label="Product name" required><input name="name" required className="field-input" /></FormField>
                <FormField label="Barcode"><input name="barcode" className="field-input" /></FormField>
                <FormField label="Category"><select name="category" className="field-input"><option>drink</option><option>snack</option><option>chocolate</option><option>biscuit</option><option>coffee</option><option>other</option></select></FormField>
                <FormField label="Brand"><input name="brand" className="field-input" /></FormField>
                <FormField label="Selling price"><input name="selling_price" type="number" step="0.01" className="field-input" /></FormField>
                <button className="btn-primary" disabled={isPending}>{isPending ? "Adding..." : "Add product"}</button>
              </form>
            </div>
          </div>
        </div>
      ) : null}
    </form>
  );
}
