"use client";

import { useState } from "react";
import { LocalDraftForm } from "@/components/LocalDraft";
import { PurchaseForm } from "@/components/PurchaseForm";
import { FormField, FormSection } from "@/components/ui";
import type { PurchaseSubmitResult } from "@/lib/purchase-actions";
import type { ReceiptConfidenceLabel, ReceiptScanDraft } from "@/lib/receipt-scan-types";

type SupplierOption = { id: string; name: string };
type ProductOption = {
  id: string;
  sku: string | null;
  barcode: string | null;
  imageUrl: string | null;
  name: string;
  category: string | null;
  brand: string | null;
  caseQuantity: number;
  case_quantity: number;
  unitsPerBox: number | null;
  units_per_box: number | null;
  costPrice: number;
  currentCostPrice: number | null;
  current_cost_price_lyd: number | null;
  lastPurchaseCost: number | null;
  last_purchase_cost_lyd: number | null;
  lastPurchaseDate?: string | null;
  last_purchase_date?: string | null;
  lastSupplierId?: string | null;
  last_supplier_id?: string | null;
  lastSupplierName?: string | null;
  last_supplier_name?: string | null;
  currentStorageQty: number;
  vmsNames: string[];
};

function money(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `LYD ${Number(value).toFixed(2)}`;
}

function confidenceText(label: ReceiptConfidenceLabel | null | undefined, score: number | null | undefined) {
  const display = label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Low";
  return score === null || score === undefined ? display : `${display} ${(score * 100).toFixed(0)}%`;
}

function canApplyScan(scan: ReceiptScanDraft | null) {
  if (!scan) return false;
  if (scan.status !== "completed") return false;
  return Boolean(scan.supplierId || scan.receiptDate || scan.receiptNumber || scan.fileUrl || scan.totalAmount !== null || scan.lines.length);
}

export function NewPurchaseWithReceiptScan({
  action,
  suppliers,
  products,
  canAddProducts = false,
  prefillSource,
}: {
  action: (formData: FormData) => Promise<PurchaseSubmitResult>;
  suppliers: SupplierOption[];
  products: ProductOption[];
  canAddProducts?: boolean;
  prefillSource?: string | null;
}) {
  const [pendingScan, setPendingScan] = useState<ReceiptScanDraft | null>(null);
  const [appliedScan, setAppliedScan] = useState<ReceiptScanDraft | null>(null);
  const [appliedScanKey, setAppliedScanKey] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [uploadWarning, setUploadWarning] = useState<string>("");
  const [isScanning, setIsScanning] = useState(false);

  async function handleScan(formData: FormData) {
    setIsScanning(true);
    setError("");
    setUploadWarning("");
    try {
      const response = await fetch("/api/purchases/receipt-scan", {
        method: "POST",
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : "Could not scan receipt. You can still enter the purchase manually.");
      const draft = payload.draft as ReceiptScanDraft | null | undefined;
      if (!draft) throw new Error("Could not scan receipt. You can still enter the purchase manually.");
      setPendingScan(draft);
      setUploadWarning(payload.uploadWarning || "");
      if (draft.status === "failed") {
        setError("Could not scan this receipt with AI. You can still enter the purchase manually.");
      }
    } catch (scanError) {
      console.error("[purchases] Receipt scan failed", scanError);
      setError(scanError instanceof Error ? scanError.message : "Could not scan receipt. You can still enter the purchase manually.");
    } finally {
      setIsScanning(false);
    }
  }

  return (
    <div className="space-y-5">
      <PurchaseForm
        action={action}
        suppliers={suppliers}
        products={products}
        receiptScan={appliedScan}
        appliedScanKey={appliedScanKey}
        canAddProducts={canAddProducts}
        prefillSource={prefillSource}
      />

      <FormSection title="Scan receipt with AI" description="Optional helper. It previews extracted fields first, then you choose whether to apply them to the manual form.">
        <LocalDraftForm action={handleScan} formType="purchase-receipt-scan" draftKeyParts={["new"]} className="grid gap-4 lg:grid-cols-[1fr_280px]">
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-900">
              AI extraction may be wrong. Review before receiving purchase.
            </div>
            <FormField label="Receipt image or PDF">
              <input
                name="receipt_file"
                type="file"
                accept="image/png,image/jpeg,image/webp,application/pdf"
                required
                className="field-input"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setFileName(file?.name ?? "");
                  setPreviewType(file?.type ?? null);
                  setPreviewUrl((current) => {
                    if (current) URL.revokeObjectURL(current);
                    return file ? URL.createObjectURL(file) : null;
                  });
                }}
              />
            </FormField>
            <button className="btn-primary w-full sm:w-auto" disabled={isScanning}>
              {isScanning ? "Scanning..." : "Scan receipt with AI"}
            </button>
            {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
            {uploadWarning ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{uploadWarning}</div> : null}
            {pendingScan?.message && pendingScan.status !== "failed" ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{pendingScan.message}</div>
            ) : null}
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Receipt preview</div>
            {previewUrl && previewType?.startsWith("image/") ? (
              <img src={previewUrl} alt={fileName || "Receipt preview"} className="max-h-72 w-full rounded-lg object-contain" />
            ) : previewUrl && previewType === "application/pdf" ? (
              <object data={previewUrl} type="application/pdf" className="h-72 w-full rounded-lg bg-white">
                <span className="text-sm text-slate-500">{fileName || "PDF receipt selected"}</span>
              </object>
            ) : pendingScan?.fileUrl ? (
              <a href={pendingScan.fileUrl} target="_blank" rel="noreferrer" className="link-secondary">Open uploaded receipt</a>
            ) : (
              <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-center text-sm text-slate-500">
                Upload a receipt to preview it here.
              </div>
            )}
          </div>
        </LocalDraftForm>

        {pendingScan ? (
          <div className="space-y-4 border-t border-slate-200 pt-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Supplier</div><div className="mt-1 font-medium text-slate-900">{pendingScan.supplierName ?? "-"}</div></div>
              <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Date</div><div className="mt-1 font-medium text-slate-900">{pendingScan.receiptDate ?? "-"}</div></div>
              <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Receipt #</div><div className="mt-1 font-medium text-slate-900">{pendingScan.receiptNumber ?? "-"}</div></div>
              <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Total</div><div className="mt-1 font-medium text-slate-900">{money(pendingScan.totalAmount)}</div></div>
            </div>

            {pendingScan.lines.length ? (
              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="grid grid-cols-[1.5fr_1fr_90px_90px] gap-3 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 max-sm:hidden">
                  <div>Receipt item</div>
                  <div>Suggested product</div>
                  <div>Qty</div>
                  <div>Total</div>
                </div>
                <div className="divide-y divide-slate-100">
                  {pendingScan.lines.map((line) => (
                    <div key={line.id} className="grid gap-2 px-3 py-3 text-sm sm:grid-cols-[1.5fr_1fr_90px_90px] sm:items-center">
                      <div>
                        <div className="font-medium text-slate-900">{line.receiptItemName}</div>
                        <div className="text-xs text-slate-500">{confidenceText(line.confidenceLabel, line.confidenceScore)} | Needs review</div>
                      </div>
                      <div className="text-slate-700">{line.suggestedProductName ?? "Needs product match"}</div>
                      <div className="text-slate-700">{line.quantity}</div>
                      <div className="font-medium text-slate-900">{money(line.lineTotal)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                No receipt line items were extracted. Manual line entry below is still available.
              </div>
            )}

            {canApplyScan(pendingScan) ? (
              <button
                type="button"
                className="btn-secondary w-full sm:w-auto"
                onClick={() => {
                  setAppliedScan(pendingScan);
                  setAppliedScanKey((key) => key + 1);
                  window.requestAnimationFrame(() => {
                    document.getElementById("manual-purchase-entry")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  });
                }}
              >
                Apply extracted lines
              </button>
            ) : null}
          </div>
        ) : null}
      </FormSection>
    </div>
  );
}
