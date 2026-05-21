"use client";

import { useMemo, useState } from "react";
import { PurchaseForm } from "@/components/PurchaseForm";
import { FormField, FormSection } from "@/components/ui";
import type { PurchaseSubmitResult } from "@/lib/purchase-actions";
import type { ReceiptScanDraft } from "@/lib/receipt-scan-types";

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

function money(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `LYD ${Number(value).toFixed(2)}`;
}

function draftLines(scan: ReceiptScanDraft | null) {
  if (!scan?.lines.length) return undefined;
  return scan.lines.map((line) => {
    const quantity = Math.max(0, Math.round(Number(line.quantity || 0)));
    const productId = line.action === "accept" ? line.suggestedProductId ?? "" : "";
    return {
      productId,
      boxesQty: 0,
      unitsPerBox: 1,
      looseUnitsQty: quantity,
      unitCost: Number(line.unitCost || 0),
      lineTotal: Number(line.lineTotal || 0),
      pricingMode: line.lineTotal > 0 ? ("total" as const) : ("unit" as const),
      receiptLineName: line.receiptItemName,
      suggestedProductId: line.suggestedProductId,
      suggestedProductName: line.suggestedProductName,
      suggestedProductSku: line.suggestedProductSku,
      confidenceScore: line.confidenceScore,
      confidenceLabel: line.confidenceLabel,
      matchAction: line.action,
      newProductName: line.receiptItemName,
      newProductCaseQuantity: 1,
    };
  });
}

export function NewPurchaseWithReceiptScan({
  action,
  suppliers,
  products,
  canAddProducts = false,
}: {
  action: (formData: FormData) => Promise<PurchaseSubmitResult>;
  suppliers: SupplierOption[];
  products: ProductOption[];
  canAddProducts?: boolean;
}) {
  const [scan, setScan] = useState<ReceiptScanDraft | null>(null);
  const [scanVersion, setScanVersion] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [uploadWarning, setUploadWarning] = useState<string>("");
  const [isScanning, setIsScanning] = useState(false);

  const initialPurchase = useMemo(() => {
    if (!scan) return undefined;
    return {
      supplierId: scan.supplierId,
      purchaseDate: scan.receiptDate,
      receiptNumber: scan.receiptNumber,
      receiptUrl: scan.fileUrl,
      manualTotalLyd: scan.totalAmount,
    };
  }, [scan]);

  async function handleScan(formData: FormData) {
    setIsScanning(true);
    setError("");
    setUploadWarning("");
    try {
      const response = await fetch("/api/purchases/receipt-scan", {
        method: "POST",
        body: formData,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not scan receipt.");
      setScan(payload.draft);
      setUploadWarning(payload.uploadWarning || "");
      setScanVersion((version) => version + 1);
    } catch (scanError) {
      setError(scanError instanceof Error ? scanError.message : "Could not scan receipt.");
    } finally {
      setIsScanning(false);
    }
  }

  return (
    <div className="space-y-5">
      <FormSection title="Receipt scanning" description="Upload a receipt image or PDF to draft purchase fields for review. No inventory or finance movement is created by scanning.">
        <form action={handleScan} className="grid gap-4 lg:grid-cols-[1fr_280px]">
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
              {isScanning ? "Scanning..." : "Scan Receipt"}
            </button>
            {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{error}</div> : null}
            {uploadWarning ? <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{uploadWarning}</div> : null}
            {scan?.message ? <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{scan.message}</div> : null}
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Receipt preview</div>
            {previewUrl && previewType?.startsWith("image/") ? (
              <img src={previewUrl} alt={fileName || "Receipt preview"} className="max-h-72 w-full rounded-lg object-contain" />
            ) : previewUrl && previewType === "application/pdf" ? (
              <object data={previewUrl} type="application/pdf" className="h-72 w-full rounded-lg bg-white">
                <span className="text-sm text-slate-500">{fileName || "PDF receipt selected"}</span>
              </object>
            ) : scan?.fileUrl ? (
              <a href={scan.fileUrl} target="_blank" rel="noreferrer" className="link-secondary">Open uploaded receipt</a>
            ) : (
              <div className="flex h-44 items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white text-center text-sm text-slate-500">
                Upload a receipt to preview it here.
              </div>
            )}
          </div>
        </form>

        {scan ? (
          <div className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Supplier</div><div className="mt-1 font-medium text-slate-900">{scan.supplierName ?? "-"}</div></div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Date</div><div className="mt-1 font-medium text-slate-900">{scan.receiptDate ?? "-"}</div></div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Receipt #</div><div className="mt-1 font-medium text-slate-900">{scan.receiptNumber ?? "-"}</div></div>
            <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs font-medium uppercase text-slate-500">Total</div><div className="mt-1 font-medium text-slate-900">{money(scan.totalAmount)}</div></div>
          </div>
        ) : null}
      </FormSection>

      <PurchaseForm
        key={`purchase-${scanVersion}`}
        action={action}
        suppliers={suppliers}
        products={products}
        initialPurchase={initialPurchase}
        initialLines={draftLines(scan)}
        receiptScan={scan}
        canAddProducts={canAddProducts}
      />
    </div>
  );
}
