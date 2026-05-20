"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { QuantityStepper } from "@/components/QuantityStepper";
import { FormField, FormSection } from "@/components/ui";

type SupplierOption = { id: string; name: string };
type ProductOption = {
  id: string;
  sku: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  caseQuantity: number;
  costPrice: number;
};
type PurchaseLine = {
  id: string;
  productId: string;
  boxesQty: number;
  unitsPerBox: number;
  looseUnitsQty: number;
  unitCost: number;
  lineTotal: number;
  pricingMode: "unit" | "total";
};
type InitialPurchase = {
  id?: string;
  supplierId?: string | null;
  purchaseDate?: string | null;
  receiptNumber?: string | null;
  paymentMethod?: string | null;
  paymentStatus?: string | null;
  receiptUrl?: string | null;
  notes?: string | null;
  manualTotalLyd?: number | null;
};

function newLine(line?: Partial<PurchaseLine>): PurchaseLine {
  return { id: crypto.randomUUID(), productId: "", boxesQty: 0, unitsPerBox: 1, looseUnitsQty: 0, unitCost: 0, lineTotal: 0, pricingMode: "unit", ...line };
}

function money(value: number) {
  return `LYD ${value.toFixed(2)}`;
}

function UnitStepper({
  label,
  value,
  min = 0,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
}) {
  return (
    <FormField label={label}>
      <QuantityStepper value={value} min={min} onChange={onChange} inputLabel={label} />
    </FormField>
  );
}

export function PurchaseForm({
  action,
  suppliers,
  products,
  initialPurchase,
  initialLines,
  submitLabel = "Save draft",
}: {
  action: (formData: FormData) => void;
  suppliers: SupplierOption[];
  products: ProductOption[];
  initialPurchase?: InitialPurchase;
  initialLines?: Partial<PurchaseLine>[];
  submitLabel?: string;
}) {
  const [lines, setLines] = useState<PurchaseLine[]>(() => initialLines?.length ? initialLines.map((line) => newLine(line)) : [newLine()]);
  const [manualTotal, setManualTotal] = useState<string>(() => initialPurchase?.manualTotalLyd === null || initialPurchase?.manualTotalLyd === undefined ? "" : String(initialPurchase.manualTotalLyd));
  const [searchByLine, setSearchByLine] = useState<Record<string, string>>({});
  const deferredSearch = useDeferredValue(searchByLine);
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const enrichedLines = useMemo(
    () =>
      lines.map((line) => {
        const totalUnits = Math.max(0, Math.floor(line.boxesQty)) * Math.max(1, Math.floor(line.unitsPerBox)) + Math.max(0, Math.floor(line.looseUnitsQty));
        const lineTotal = line.pricingMode === "total" ? Math.max(0, Number(line.lineTotal || 0)) : totalUnits * Math.max(0, Number(line.unitCost || 0));
        const unitCost = line.pricingMode === "total" && totalUnits > 0 ? lineTotal / totalUnits : Math.max(0, Number(line.unitCost || 0));
        return { ...line, unitCost, totalUnits, lineTotal, product: productById.get(line.productId) };
      }),
    [lines, productById],
  );

  const purchaseTotal = enrichedLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const manualTotalNumber = manualTotal.trim() === "" ? null : Number(manualTotal);
  const displayTotal = manualTotalNumber !== null && Number.isFinite(manualTotalNumber) && manualTotalNumber >= 0 ? manualTotalNumber : purchaseTotal;
  const totalAdjustment = manualTotalNumber !== null && Number.isFinite(manualTotalNumber) ? manualTotalNumber - purchaseTotal : 0;
  const linesJson = JSON.stringify(enrichedLines.map((line) => ({
    productId: line.productId,
    boxesQty: line.boxesQty,
    unitsPerBox: line.unitsPerBox,
    looseUnitsQty: line.looseUnitsQty,
    unitCost: line.unitCost,
    lineTotal: line.lineTotal,
    pricingMode: line.pricingMode,
  })));

  const updateLine = (id: string, patch: Partial<PurchaseLine>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const selectProduct = (line: PurchaseLine, product: ProductOption) => {
    updateLine(line.id, { productId: product.id, unitsPerBox: Math.max(1, Number(product.caseQuantity || 1)) });
    setSearchByLine((current) => ({ ...current, [line.id]: product.name }));
  };

  return (
    <form action={action} className="space-y-5">
      {initialPurchase?.id ? <input type="hidden" name="id" value={initialPurchase.id} /> : null}
      <input type="hidden" name="current_receipt_url" value={initialPurchase?.receiptUrl ?? ""} />
      <input type="hidden" name="lines_json" value={linesJson} />

      <FormSection title="Purchase details" description="Record the supplier, receipt, payment state, and supporting receipt reference before receiving stock.">
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Supplier">
            <select name="supplier_id" className="field-input" defaultValue={initialPurchase?.supplierId ?? ""}>
              <option value="">Select supplier</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
            </select>
          </FormField>
          <FormField label="Purchase date" required>
            <input name="purchase_date" type="date" required defaultValue={initialPurchase?.purchaseDate ?? new Date().toISOString().slice(0, 10)} className="field-input" />
          </FormField>
          <FormField label="Receipt / invoice number">
            <input name="receipt_number" className="field-input" placeholder="INV-1024" defaultValue={initialPurchase?.receiptNumber ?? ""} />
          </FormField>
          <FormField label="Payment method">
            <select name="payment_method" className="field-input" defaultValue={initialPurchase?.paymentMethod ?? "cash"}>
              <option value="cash">Cash</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="card">Card</option>
              <option value="credit">Credit</option>
              <option value="other">Other</option>
            </select>
          </FormField>
          <FormField label="Payment status" hint="Only paid purchases create a finance money-out transaction when received.">
            <select name="payment_status" className="field-input" defaultValue={initialPurchase?.paymentStatus ?? "paid"}>
              <option value="paid">Paid</option>
              <option value="unpaid">Unpaid / supplier credit</option>
              <option value="partially_paid">Partially paid</option>
            </select>
          </FormField>
          <FormField label="Receipt upload" hint="Stored privately in receipt-images when Supabase Storage is configured. PNG, JPG, WEBP, or PDF. Maximum 5MB.">
            <input name="receipt_file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="field-input" />
          </FormField>
          <FormField label="Receipt URL fallback">
            <input name="receipt_url" type="url" className="field-input" placeholder="https://example.com/receipt.jpg" defaultValue={initialPurchase?.receiptUrl ?? ""} />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Notes">
              <textarea name="notes" rows={3} className="field-input" placeholder="Delivery notes, supplier comments, or payment reference." defaultValue={initialPurchase?.notes ?? ""} />
            </FormField>
          </div>
        </div>
      </FormSection>

      <FormSection title="Purchased items" description="Add every product from the receipt. Box, case, and loose quantities are converted into total received units.">
        <div className="space-y-4">
          {enrichedLines.map((line, index) => {
            const query = String(deferredSearch[line.id] ?? "").trim().toLowerCase();
            const options = (query
              ? products.filter((product) => [product.name, product.sku, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(query))).slice(0, 8)
              : products.slice(0, 6));
            return (
              <div key={line.id} className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Line {index + 1}</h3>
                    <p className="text-xs text-slate-500">{line.product ? `${line.product.sku ?? "No SKU"} - ${line.product.category ?? "Uncategorized"}` : "Search and select a product."}</p>
                  </div>
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} disabled={lines.length === 1}>
                    Remove
                  </button>
                </div>

                <div className="grid gap-3 lg:grid-cols-[1.6fr_repeat(4,minmax(108px,1fr))]">
                  <div>
                    <label className="mb-1 block text-sm font-medium text-slate-800">Product</label>
                    <input
                      value={searchByLine[line.id] ?? line.product?.name ?? ""}
                      onChange={(event) => setSearchByLine((current) => ({ ...current, [line.id]: event.target.value }))}
                      className="field-input"
                      placeholder="Search product"
                    />
                    <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                      {options.map((product) => (
                        <button key={product.id} type="button" onClick={() => selectProduct(line, product)} className={`block min-h-14 w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${line.productId === product.id ? "brand-selected" : ""}`}>
                          <span className={`block font-medium ${line.productId === product.id ? "text-white" : "text-slate-900"}`}>{product.name}</span>
                          <span className={`text-xs ${line.productId === product.id ? "text-white/80" : "text-slate-500"}`}>{product.sku ?? "No SKU"} - case {product.caseQuantity || 1}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <UnitStepper label="Boxes / cases" value={line.boxesQty} onChange={(boxesQty) => updateLine(line.id, { boxesQty })} />
                  <UnitStepper label="Units / box" value={line.unitsPerBox} min={1} onChange={(unitsPerBox) => updateLine(line.id, { unitsPerBox })} />
                  <UnitStepper label="Loose units" value={line.looseUnitsQty} onChange={(looseUnitsQty) => updateLine(line.id, { looseUnitsQty })} />
                  <FormField label="Unit cost">
                    <input type="number" min={0} step="0.0001" value={Number(line.unitCost.toFixed(4))} onChange={(event) => updateLine(line.id, { unitCost: Number(event.target.value) || 0, pricingMode: "unit" })} className="field-input" />
                  </FormField>
                  <div className="rounded-lg bg-slate-50 p-3 text-sm lg:col-span-5">
                    <div className="text-xs font-medium text-slate-500">Calculated</div>
                    <div className="mt-1 grid gap-2 sm:grid-cols-3">
                      <div><span className="font-semibold text-slate-900">{line.totalUnits}</span> units</div>
                      <div className="text-slate-700">{money(line.lineTotal)}</div>
                      <div className="text-slate-500">{money(line.unitCost)} / unit</div>
                    </div>
                  </div>
                  <div className="lg:col-span-5">
                    <FormField label="Override line total">
                      <input type="number" min={0} step="0.01" value={Number(line.lineTotal.toFixed(2))} onChange={(event) => updateLine(line.id, { lineTotal: Number(event.target.value) || 0, pricingMode: "total" })} className="field-input" />
                    </FormField>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <button type="button" className="btn-secondary" onClick={() => setLines((current) => [...current, newLine()])}>Add item</button>
          <div className="text-right">
            <div className="text-sm text-slate-500">Calculated line total: {money(purchaseTotal)}</div>
            <div className="text-lg font-semibold text-slate-900">Display total: {money(displayTotal)}</div>
          </div>
        </div>
      </FormSection>

      <FormSection title="Receipt total" description="Compare the calculated product total with the supplier receipt total so rounding, discounts, or delivery adjustments are visible.">
        <div className="grid gap-4 md:grid-cols-[1fr_1fr] md:items-start">
          <FormField label="Receipt Total LYD" hint="Use receipt total if the supplier invoice total differs because of discounts, rounding, delivery, or mixed pricing.">
            <input
              name="manual_total_lyd"
              type="number"
              min={0}
              step="0.01"
              value={manualTotal}
              onChange={(event) => setManualTotal(event.target.value)}
              className="field-input"
              placeholder={purchaseTotal.toFixed(2)}
            />
          </FormField>
          <div className="rounded-lg bg-slate-50 p-4 text-sm">
            <div className="flex justify-between gap-3"><span className="text-slate-500">Calculated total</span><span className="font-medium">{money(purchaseTotal)}</span></div>
            <div className="mt-2 flex justify-between gap-3"><span className="text-slate-500">Receipt total</span><span className="font-medium">{manualTotal.trim() ? money(displayTotal) : "-"}</span></div>
            {manualTotal.trim() && Math.abs(totalAdjustment) >= 0.01 ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 font-medium text-amber-900">
                Receipt total differs from line items by {totalAdjustment.toFixed(2)} LYD.
              </div>
            ) : null}
          </div>
        </div>
      </FormSection>

      <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-3 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
        <button className="btn-secondary" name="submit_action" value="draft">{submitLabel}</button>
        {!initialPurchase?.id ? <button className="btn-primary" name="submit_action" value="received">Save and receive</button> : null}
      </div>
    </form>
  );
}
