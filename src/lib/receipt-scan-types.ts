export type ReceiptConfidenceLabel = "high" | "medium" | "low";

export type ReceiptLineAction = "accept" | "change" | "create" | "ignore";

export type ReceiptExtractedLine = {
  itemName: string;
  quantity: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
};

export type ReceiptExtraction = {
  supplierName: string | null;
  receiptDate: string | null;
  receiptNumber: string | null;
  totalAmount: number | null;
  currency: string | null;
  rawText: string | null;
  lines: ReceiptExtractedLine[];
};

export type ReceiptScanDraftLine = {
  id: string;
  receiptItemName: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  suggestedProductId: string | null;
  suggestedProductName: string | null;
  suggestedProductSku: string | null;
  confidenceScore: number | null;
  confidenceLabel: ReceiptConfidenceLabel;
  action: ReceiptLineAction;
};

export type ReceiptScanDraft = {
  scanResultId: string | null;
  fileUrl: string | null;
  fileName: string | null;
  fileType: string | null;
  supplierName: string | null;
  supplierId: string | null;
  supplierConfidenceLabel: ReceiptConfidenceLabel | null;
  receiptDate: string | null;
  receiptNumber: string | null;
  totalAmount: number | null;
  currency: string | null;
  rawText: string | null;
  status: "completed" | "not_configured" | "failed";
  message: string | null;
  lines: ReceiptScanDraftLine[];
};
