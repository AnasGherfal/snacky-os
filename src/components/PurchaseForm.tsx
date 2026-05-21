"use client";

import Link from "next/link";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { FormField, FormSection } from "@/components/ui";
import type { PurchaseSubmitResult } from "@/lib/purchase-actions";
import type { ReceiptConfidenceLabel, ReceiptLineAction, ReceiptScanDraft } from "@/lib/receipt-scan-types";

type SupplierOption = { id: string; name: string };
type ProductOption = {
  id: string;
  sku: string | null;
  barcode: string | null;
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
  receiptLineName: string | null;
  suggestedProductId: string | null;
  suggestedProductName: string | null;
  suggestedProductSku: string | null;
  confidenceScore: number | null;
  confidenceLabel: ReceiptConfidenceLabel | null;
  matchAction: ReceiptLineAction;
  newProductName: string;
  newProductSku: string;
  newProductBarcode: string;
  newProductBrand: string;
  newProductCategory: string;
  newProductCaseQuantity: number;
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
  const receiptLineName = line?.receiptLineName ?? null;
  const id = globalThis.crypto?.randomUUID?.() ?? `line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id,
    productId: "",
    boxesQty: 0,
    unitsPerBox: 1,
    looseUnitsQty: 0,
    unitCost: 0,
    lineTotal: 0,
    pricingMode: "unit",
    receiptLineName,
    suggestedProductId: null,
    suggestedProductName: null,
    suggestedProductSku: null,
    confidenceScore: null,
    confidenceLabel: null,
    matchAction: "change",
    newProductName: receiptLineName ?? "",
    newProductSku: "",
    newProductBarcode: "",
    newProductBrand: "",
    newProductCategory: "snack",
    newProductCaseQuantity: 1,
    ...line,
  };
}

function money(value: number) {
  return `LYD ${value.toFixed(2)}`;
}

function confidenceTone(label: ReceiptConfidenceLabel | null) {
  if (label === "high") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (label === "medium") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function parseNumericText(value: string, integer: boolean) {
  const raw = value.trim();
  const cleaned = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw.replace(/,/g, "");
  if (!cleaned) return 0;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return 0;
  return integer ? Math.max(0, Math.floor(parsed)) : Math.max(0, parsed);
}

function formatNumericValue(value: number, precision?: number, emptyWhenZero = true) {
  if (!Number.isFinite(value) || (emptyWhenZero && value === 0)) return "";
  if (precision !== undefined) return Number(value.toFixed(precision)).toString();
  return String(value);
}

function PurchaseNumberInput({
  value,
  onChange,
  integer = false,
  precision,
  min = 0,
  prefix,
  suffix,
  placeholder,
  disabled,
  align = "right",
}: {
  value: number;
  onChange: (value: number) => void;
  integer?: boolean;
  precision?: number;
  min?: number;
  prefix?: string;
  suffix?: string;
  placeholder?: string;
  disabled?: boolean;
  align?: "left" | "right" | "center";
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => formatNumericValue(value, precision, min === 0));

  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setText(formatNumericValue(value, precision, min === 0));
    }
  }, [value, precision, min]);

  const padding = `${prefix ? "pl-12" : "pl-3"} ${suffix ? "pr-12" : "pr-3"}`;
  const textAlign = align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";

  return (
    <div className="relative">
      {prefix ? <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-500">{prefix}</span> : null}
      <input
        ref={inputRef}
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          if (!/^\d*([.,]\d*)?$/.test(next)) return;
          setText(next);
          onChange(parseNumericText(next, integer));
        }}
        onBlur={() => {
          const parsed = Math.max(min, parseNumericText(text, integer));
          onChange(parsed);
          setText(formatNumericValue(parsed, precision, min === 0));
        }}
        className={`field-input ${padding} ${textAlign} font-medium tabular-nums`}
      />
      {suffix ? <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-500">{suffix}</span> : null}
    </div>
  );
}

function confidenceText(label: ReceiptConfidenceLabel | null, score: number | null) {
  const display = label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Low";
  return score === null ? display : `${display} ${(score * 100).toFixed(0)}%`;
}

export function PurchaseForm({
  action,
  suppliers,
  products,
  initialPurchase,
  initialLines,
  receiptScan,
  canAddProducts = false,
  submitLabel = "Save draft",
}: {
  action: (formData: FormData) => Promise<PurchaseSubmitResult>;
  suppliers: SupplierOption[];
  products: ProductOption[];
  initialPurchase?: InitialPurchase;
  initialLines?: Partial<PurchaseLine>[];
  receiptScan?: ReceiptScanDraft | null;
  canAddProducts?: boolean;
  submitLabel?: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const submittingRef = useRef(false);
  const [lines, setLines] = useState<PurchaseLine[]>(() => initialLines?.length ? initialLines.map((line) => newLine(line)) : [newLine()]);
  const [manualTotal, setManualTotal] = useState<string>(() => initialPurchase?.manualTotalLyd === null || initialPurchase?.manualTotalLyd === undefined ? "" : String(initialPurchase.manualTotalLyd));
  const [searchByLine, setSearchByLine] = useState<Record<string, string>>({});
  const [submitIntent, setSubmitIntent] = useState<"draft" | "received" | null>(null);
  const [submitMessage, setSubmitMessage] = useState<{ type: "success" | "error"; text: string; debug?: string } | null>(null);
  const deferredSearch = useDeferredValue(searchByLine);
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);

  const enrichedLines = useMemo(
    () =>
      lines.map((line) => {
        const totalUnits = Math.max(0, Math.floor(line.boxesQty)) * Math.max(1, Math.floor(line.unitsPerBox)) + Math.max(0, Math.floor(line.looseUnitsQty));
        const lineTotal = line.pricingMode === "total" ? Math.max(0, Number(line.lineTotal || 0)) : totalUnits * Math.max(0, Number(line.unitCost || 0));
        const unitCost = line.pricingMode === "total" && totalUnits > 0 ? lineTotal / totalUnits : Math.max(0, Number(line.unitCost || 0));
        return { ...line, unitCost, totalUnits, lineTotal, product: productById.get(line.productId), included: line.matchAction !== "ignore" && (line.productId || line.matchAction === "create") };
      }),
    [lines, productById],
  );

  const purchaseTotal = enrichedLines.reduce((sum, line) => sum + (line.included ? line.lineTotal : 0), 0);
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
    receiptLineName: line.receiptLineName,
    matchAction: line.matchAction,
    matchConfidence: line.confidenceScore,
    newProduct: line.matchAction === "create" ? {
      name: line.newProductName || line.receiptLineName || "",
      sku: line.newProductSku,
      barcode: line.newProductBarcode,
      brand: line.newProductBrand,
      category: line.newProductCategory || "snack",
      caseQuantity: line.newProductCaseQuantity || 1,
    } : null,
  })));

  const updateLine = (id: string, patch: Partial<PurchaseLine>) => {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  };

  const selectProduct = (line: PurchaseLine, product: ProductOption) => {
    updateLine(line.id, {
      productId: product.id,
      unitsPerBox: Math.max(1, Number(product.caseQuantity || 1)),
      matchAction: line.receiptLineName && line.matchAction !== "accept" ? "change" : line.matchAction,
    });
    setSearchByLine((current) => ({ ...current, [line.id]: product.name }));
  };

  const setLineAction = (line: PurchaseLine, action: ReceiptLineAction) => {
    if (action === "accept") {
      if (!line.suggestedProductId) return;
      updateLine(line.id, { matchAction: "accept", productId: line.suggestedProductId });
      setSearchByLine((current) => ({ ...current, [line.id]: line.suggestedProductName ?? "" }));
      return;
    }

    if (action === "create") {
      if (!canAddProducts) {
        setSubmitMessage({ type: "error", text: "Only owner/admin can create products from purchase lines." });
        return;
      }
      updateLine(line.id, {
        matchAction: "create",
        productId: "",
        newProductName: line.newProductName || line.receiptLineName || "",
        newProductCaseQuantity: Math.max(1, line.newProductCaseQuantity || line.unitsPerBox || 1),
      });
      return;
    }

    if (action === "ignore") {
      updateLine(line.id, { matchAction: "ignore", productId: "" });
      return;
    }

    updateLine(line.id, { matchAction: "change" });
  };

  const productOptionsForLine = (line: PurchaseLine) => {
    const query = String(deferredSearch[line.id] ?? "").trim().toLowerCase();
    if (!query) {
      const selected = productById.get(line.productId);
      return selected ? [selected] : [];
    }
    return products.filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand].some((value) => String(value ?? "").toLowerCase().includes(query))).slice(0, 8);
  };

  const renderProductPicker = (line: PurchaseLine & { product?: ProductOption }) => {
    const options = productOptionsForLine(line);
    const query = String(deferredSearch[line.id] ?? "").trim();
    return (
      <div>
        <label className="mb-1 block text-sm font-medium text-slate-800">Product</label>
        <input
          value={searchByLine[line.id] ?? line.product?.name ?? ""}
          onChange={(event) => {
            setSearchByLine((current) => ({ ...current, [line.id]: event.target.value }));
            if (line.receiptLineName) updateLine(line.id, { matchAction: "change" });
          }}
          className="field-input"
          placeholder="Search product"
          disabled={line.matchAction === "ignore"}
        />
        <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-slate-200 bg-white">
          {options.length ? options.map((product) => (
            <button
              key={product.id}
              type="button"
              onClick={() => selectProduct(line, product)}
              className={`block min-h-14 w-full px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50 ${line.productId === product.id ? "brand-selected" : ""}`}
              disabled={line.matchAction === "ignore"}
            >
              <span className={`block font-medium ${line.productId === product.id ? "text-white" : "text-slate-900"}`}>{product.name}</span>
              <span className={`text-xs ${line.productId === product.id ? "text-white/80" : "text-slate-500"}`}>
                {product.sku ?? "No SKU"} - {product.barcode ?? "No barcode"} - case {product.caseQuantity || 1}
              </span>
            </button>
          )) : (
            <div className="p-3 text-sm text-slate-500">
              {query ? (
                canAddProducts ? (
                  <Link href="/products/new" className="link-secondary">Product not found. Add product</Link>
                ) : (
                  "Product not found. Ask an admin to add it."
                )
              ) : (
                "Start typing to search products."
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const validateBeforeSubmit = () => {
    const included = enrichedLines.filter((line) => line.included);
    if (!included.length) return "Add at least one purchased item.";
    const missingProduct = included.find((line) => line.matchAction !== "create" && !line.productId);
    if (missingProduct) return "Select a Snacky product for every included line, or ignore the line.";
    const missingCreatedProduct = included.find((line) => line.matchAction === "create" && !line.newProductName.trim());
    if (missingCreatedProduct) return "Enter a product name for every product you create from a receipt line.";
    const emptyQuantity = included.find((line) => line.totalUnits <= 0);
    if (emptyQuantity) return "Quantity must be greater than zero for every included line.";
    return "";
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current) return;

    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = submitter?.value === "received" ? "received" : "draft";
    const validationError = validateBeforeSubmit();
    if (validationError) {
      setSubmitMessage({ type: "error", text: validationError });
      return;
    }

    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    formData.set("submit_action", intent);

    setSubmitIntent(intent);
    submittingRef.current = true;
    setSubmitMessage(null);
    try {
      const result = await action(formData);
      if (!result.ok) {
        setSubmitMessage({ type: "error", text: result.message || "Could not save purchase.", debug: result.debugMessage });
        return;
      }
      setSubmitMessage({ type: "success", text: result.message });
      if (result.redirectTo) {
        router.push(result.redirectTo);
        router.refresh();
      }
    } catch (error) {
      console.error("[purchases] Client submit failed", error);
      setSubmitMessage({ type: "error", text: "Could not save purchase.", debug: error instanceof Error ? error.message : undefined });
    } finally {
      submittingRef.current = false;
      setSubmitIntent(null);
    }
  };

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-5" noValidate>
      {initialPurchase?.id ? <input type="hidden" name="id" value={initialPurchase.id} /> : null}
      <input type="hidden" name="receipt_scan_result_id" value={receiptScan?.scanResultId ?? ""} />
      <input type="hidden" name="current_receipt_url" value={initialPurchase?.receiptUrl ?? ""} />
      <input type="hidden" name="lines_json" value={linesJson} />
      {submitMessage ? (
        <div className={`rounded-lg border p-4 text-sm font-medium ${submitMessage.type === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          <div>{submitMessage.text}</div>
          {process.env.NODE_ENV !== "production" && submitMessage.debug ? (
            <details className="mt-3 rounded-lg bg-white/70 p-3 text-xs font-normal">
              <summary className="cursor-pointer font-semibold">Debug details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">{submitMessage.debug}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

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

      {receiptScan ? (
        <FormSection title="Receipt line review" description="AI extraction may be wrong. Review before receiving purchase. Low confidence matches are ignored until you approve them.">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
            AI extraction may be wrong. Review before receiving purchase.
          </div>
          <div className="space-y-4">
            {enrichedLines.map((line, index) => (
              <div key={line.id} className={`rounded-lg border p-4 ${line.matchAction === "ignore" ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"}`}>
                <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">Receipt line {index + 1}</h3>
                    <p className="text-xs text-slate-500">{line.included ? "Included in purchase draft" : "Ignored or waiting for a product match"}</p>
                  </div>
                  <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))} disabled={lines.length === 1}>
                    Remove
                  </button>
                </div>

                <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr_1fr]">
                  <FormField label="Receipt item name">
                    <input
                      value={line.receiptLineName ?? ""}
                      onChange={(event) => updateLine(line.id, { receiptLineName: event.target.value, newProductName: line.newProductName || event.target.value })}
                      className="field-input"
                      placeholder="Printed item name"
                    />
                  </FormField>
                  <div>
                    <div className="mb-1 text-sm font-medium text-slate-800">Suggested Snacky product</div>
                    <div className="min-h-11 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
                      <div className="font-medium text-slate-900">{line.suggestedProductName ?? "No suggestion"}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>{line.suggestedProductSku ?? "No SKU"}</span>
                        <span className={`inline-flex rounded-full border px-2 py-1 font-semibold ${confidenceTone(line.confidenceLabel)}`}>
                          {confidenceText(line.confidenceLabel, line.confidenceScore)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <FormField label="Action">
                    <select value={line.matchAction} onChange={(event) => setLineAction(line, event.target.value as ReceiptLineAction)} className="field-input">
                      <option value="accept" disabled={!line.suggestedProductId}>Accept suggested match</option>
                      <option value="change">Change product</option>
                      <option value="create" disabled={!canAddProducts}>Create product</option>
                      <option value="ignore">Ignore line</option>
                    </select>
                  </FormField>
                </div>

                <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_repeat(3,minmax(120px,1fr))]">
                  {line.matchAction === "create" ? (
                    <div className="space-y-3">
                      <FormField label="New product name" required>
                        <input value={line.newProductName} onChange={(event) => updateLine(line.id, { newProductName: event.target.value })} className="field-input" />
                      </FormField>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <FormField label="SKU">
                          <input value={line.newProductSku} onChange={(event) => updateLine(line.id, { newProductSku: event.target.value })} className="field-input" placeholder="Auto if blank" />
                        </FormField>
                        <FormField label="Barcode">
                          <input value={line.newProductBarcode} onChange={(event) => updateLine(line.id, { newProductBarcode: event.target.value })} className="field-input" />
                        </FormField>
                        <FormField label="Brand">
                          <input value={line.newProductBrand} onChange={(event) => updateLine(line.id, { newProductBrand: event.target.value })} className="field-input" />
                        </FormField>
                        <FormField label="Category">
                          <select value={line.newProductCategory} onChange={(event) => updateLine(line.id, { newProductCategory: event.target.value })} className="field-input">
                            <option>drink</option>
                            <option>snack</option>
                            <option>chocolate</option>
                            <option>biscuit</option>
                            <option>coffee</option>
                            <option>other</option>
                          </select>
                        </FormField>
                      </div>
                    </div>
                  ) : line.matchAction === "ignore" ? (
                    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-500">This receipt line will not be added to the purchase.</div>
                  ) : (
                    renderProductPicker(line)
                  )}

                  <FormField label="Quantity">
                    <PurchaseNumberInput
                      value={line.looseUnitsQty}
                      onChange={(value) => updateLine(line.id, { boxesQty: 0, unitsPerBox: 1, looseUnitsQty: value })}
                      integer
                      suffix="units"
                      placeholder="24"
                      disabled={line.matchAction === "ignore"}
                    />
                  </FormField>
                  <FormField label="Unit cost">
                    <PurchaseNumberInput
                      value={line.unitCost}
                      onChange={(value) => updateLine(line.id, { unitCost: value, pricingMode: "unit" })}
                      precision={4}
                      prefix="LYD"
                      placeholder="1.2500"
                      disabled={line.matchAction === "ignore"}
                    />
                  </FormField>
                  <FormField label="Line total">
                    <PurchaseNumberInput
                      value={line.lineTotal}
                      onChange={(value) => updateLine(line.id, { lineTotal: value, pricingMode: "total" })}
                      precision={2}
                      prefix="LYD"
                      placeholder="30.00"
                      disabled={line.matchAction === "ignore"}
                    />
                  </FormField>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" className="btn-secondary" onClick={() => setLines((current) => [...current, newLine({ matchAction: "change" })])}>Add manual line</button>
            <div className="text-right">
              <div className="text-sm text-slate-500">Included line total: {money(purchaseTotal)}</div>
              <div className="text-lg font-semibold text-slate-900">Display total: {money(displayTotal)}</div>
            </div>
          </div>
        </FormSection>
      ) : (
        <FormSection title="Purchased items" description="Add every product from the receipt. Box, case, and loose quantities are converted into total received units.">
          <div className="space-y-4">
            {enrichedLines.map((line, index) => (
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
                  {renderProductPicker(line)}
                  <FormField label="Boxes / cases" hint="Full cartons or cases.">
                    <PurchaseNumberInput value={line.boxesQty} onChange={(boxesQty) => updateLine(line.id, { boxesQty })} integer suffix="boxes" placeholder="2" />
                  </FormField>
                  <FormField label="Units / box" hint="Case pack size.">
                    <PurchaseNumberInput value={line.unitsPerBox} onChange={(unitsPerBox) => updateLine(line.id, { unitsPerBox: Math.max(1, unitsPerBox) })} integer min={1} suffix="units" placeholder="24" />
                  </FormField>
                  <FormField label="Loose units" hint="Extra single units.">
                    <PurchaseNumberInput value={line.looseUnitsQty} onChange={(looseUnitsQty) => updateLine(line.id, { looseUnitsQty })} integer suffix="units" placeholder="6" />
                  </FormField>
                  <FormField label="Unit cost">
                    <PurchaseNumberInput value={line.unitCost} onChange={(unitCost) => updateLine(line.id, { unitCost, pricingMode: "unit" })} precision={4} prefix="LYD" placeholder="1.2500" />
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
                      <PurchaseNumberInput value={line.lineTotal} onChange={(lineTotal) => updateLine(line.id, { lineTotal, pricingMode: "total" })} precision={2} prefix="LYD" placeholder="30.00" />
                    </FormField>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-3 border-t border-slate-200 pt-4 sm:flex-row sm:items-center sm:justify-between">
            <button type="button" className="btn-secondary" onClick={() => setLines((current) => [...current, newLine()])}>Add item</button>
            <div className="text-right">
              <div className="text-sm text-slate-500">Calculated line total: {money(purchaseTotal)}</div>
              <div className="text-lg font-semibold text-slate-900">Display total: {money(displayTotal)}</div>
            </div>
          </div>
        </FormSection>
      )}

      <FormSection title="Receipt total" description="Compare the calculated product total with the supplier receipt total so rounding, discounts, or delivery adjustments are visible.">
        <div className="grid gap-4 md:grid-cols-[1fr_1fr] md:items-start">
          <FormField label="Receipt Total LYD" hint="Use receipt total if the supplier invoice total differs because of discounts, rounding, delivery, or mixed pricing.">
            <input type="hidden" name="manual_total_lyd" value={manualTotal} />
            <PurchaseNumberInput
              value={manualTotalNumber !== null && Number.isFinite(manualTotalNumber) ? manualTotalNumber : 0}
              onChange={(value) => setManualTotal(value > 0 ? String(value) : "")}
              precision={2}
              prefix="LYD"
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
        <button className="btn-secondary" name="submit_action" value="draft" disabled={Boolean(submitIntent)}>
          {submitIntent === "draft" ? "Saving draft..." : submitLabel}
        </button>
        <button className="btn-primary" name="submit_action" value="received" disabled={Boolean(submitIntent)}>
          {submitIntent === "received" ? "Receiving..." : "Save and receive"}
        </button>
      </div>
    </form>
  );
}
