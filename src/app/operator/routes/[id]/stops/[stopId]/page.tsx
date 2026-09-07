"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DraftRestoreBanner, DraftSaveStatus, useDraftKey, useLocalDraft } from "@/components/LocalDraft";
import { CompressorSafetyProofCard } from "@/components/operator/CompressorSafetyProofCard";
import { ManualRouteSalesSection, type ManualRouteSaleProductOption } from "@/components/operator/ManualRouteSalesSection";
import { RouteStopQuickActions } from "@/components/operator/RouteStopQuickActions";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { EmptyState, ErrorState, LoadingState, PageHeader, SecondaryButton, StatusBadge } from "@/components/ui";
import { useLanguage } from "@/components/I18nProvider";
import { claimDurableClientOperation, completeDurableClientOperation } from "@/lib/durable-client-operation";
import { markStopInProgress, uploadInventoryAdjustmentPhoto, uploadRefillProofPhoto } from "@/lib/operator-actions";
import type { NormalizedRouteManualSale } from "@/lib/manual-route-sales";
import { isRouteStopDoneStatus, ROUTE_STOP_COMPLETED_STATUS, ROUTE_STOP_IN_PROGRESS_STATUS, ROUTE_STOP_PICKED_STATUS } from "@/lib/route-workflow";

const STOP_REQUEST_TIMEOUT_MS = 45_000;
const SESSION_REQUEST_TIMEOUT_MS = 15_000;
const PROOF_PHOTO_TARGET_BYTES = 850 * 1024;
const PROOF_PHOTO_MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
const SUPPORTED_PROOF_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const reasonOptions = [
  "Product not available in storage",
  "Product not in operator bag",
  "Machine slot changed",
  "Product expired/damaged",
  "Customer demand",
  "Other",
];

const machineStorageReasonOptions = [
  "extra_stock_left_at_machine",
  "avoid_return_to_storage",
  "small_quantity",
  "next_refill_backup",
  "other",
] as const;

type InventoryAdjustmentType = "damaged" | "returned_from_machine";

function formatReasonLabel(value: string) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.includes("_") || text.includes("-")) {
    return text
      .replaceAll("_", " ")
      .replaceAll("-", " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => (word.length <= 2 ? word.toUpperCase() : `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`))
      .join(" ");
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const adjustmentReasonArabicLabels: Record<string, string> = {
  "Damaged during transport": "تالف أثناء النقل",
  "Broken / opened": "مكسور / مفتوح",
  "Melted / heat damage": "ذائب / متضرر من الحرارة",
  "Expired": "منتهي الصلاحية",
  "Customer returned damaged": "أرجعه العميل تالفاً",
  "Machine issue damaged product": "تلف بسبب عطل في الجهاز",
  "Removed from machine": "تمت إزالته من الجهاز",
  "Product replaced": "تم استبدال المنتج",
  "Slow moving item removed": "إزالة منتج بطيء البيع",
  "Expired soon": "قريب من انتهاء الصلاحية",
  "Wrong product in slot": "منتج خاطئ في الخانة",
  "Machine reset / re-layout": "إعادة ضبط / ترتيب الجهاز",
  "Customer complaint": "شكوى عميل",
  "Other": "أخرى",
};

function localizedAdjustmentReasonLabel(value: string, locale: string) {
  const label = formatReasonLabel(value);
  return locale === "ar" ? adjustmentReasonArabicLabels[label] ?? label : label;
}

const damagedReasonOptions = [
  "Damaged during transport",
  "Broken / opened",
  "Melted / heat damage",
  "Expired",
  "Customer returned damaged",
  "Machine issue damaged product",
  "Other",
];

const returnedReasonOptions = [
  "Removed from machine",
  "Product replaced",
  "Slow moving item removed",
  "Expired soon",
  "Wrong product in slot",
  "Machine reset / re-layout",
  "Customer complaint",
  "Other",
];

const defaultAdjustmentReasonByType: Record<InventoryAdjustmentType, string> = {
  damaged: "Damaged during transport",
  returned_from_machine: "Removed from machine",
};

interface StopRefillItem {
  refillOrderLineId?: string | null;
  machineSlotId: string | null;
  slotCode: string;
  productId: string;
  productName: string;
  currentQty: number;
  assignedQty?: number;
  parQty: number;
  availableQty?: number;
  filledQty: number | null;
  reason?: string | null;
  notes?: string | null;
  sourceLabel?: string | null;
}

interface ProductOption {
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
}

interface InventoryAdjustmentRow {
  id: string;
  adjustmentType: InventoryAdjustmentType | string;
  productId: string | null;
  productName: string;
  quantity: number;
  reason: string;
  notes: string;
  photoUrl: string | null;
  status: string;
  createdAt: string | null;
}

interface MachineStorageStockRow {
  id: string;
  machineId: string | null;
  locationId: string | null;
  productId: string | null;
  productName: string | null;
  quantity: number;
  notes: string | null;
  updatedAt: string | null;
  createdAt: string | null;
}

interface StopData {
  stopId: string;
  routeId: string;
  machineId: string;
  machineName: string;
  machineCode: string;
  location: string;
  stopStatus: string;
  routeStatus: string;
  refillItems: StopRefillItem[];
  extraItems?: ExtraProductLine[];
  productOptions: ProductOption[];
  machineProductOptions?: ProductOption[];
  machineStorageProductOptions?: ProductOption[];
  manualSaleProductOptions?: ManualRouteSaleProductOption[];
  machineStorageStock?: MachineStorageStockRow[];
  manualSales?: NormalizedRouteManualSale[];
  manualSalesLoadError?: boolean;
  adjustments?: InventoryAdjustmentRow[];
  hasCompletionPhoto?: boolean;
  debug?: StopDebugDetails;
}

interface StopDebugDetails {
  authUserId: string | null;
  matchedTeamMemberId: string | null;
  routeId: string;
  stopId: string;
  routeOperatorId: string | null;
  routeStopRouteId: string | null;
}

interface StopLoadError {
  title: string;
  body: string;
  debug?: StopDebugDetails;
}

interface ExtraProductLine {
  id: string;
  productId: string;
  quantity: number;
  reason: string;
  notes: string;
}

interface MissingProductReport {
  id: string;
  productName: string;
  reason: string;
  notes: string;
}

type StopDraft = {
  filledQtys: Record<string, number>;
  lineNotes: Record<string, string>;
  unavailableProducts: Record<string, boolean>;
  extraProducts: ExtraProductLine[];
  missingReports: MissingProductReport[];
  cashCollected: boolean;
  cashBagId: string;
  notes: string;
  issueType: string;
  issuePriority: "critical" | "high" | "normal" | "low";
  issueDescription: string;
  showCleaningChecklist: boolean;
  cleaningDone: boolean;
  finalPhotoName: string;
  hasFinalPhotoMetadata: boolean;
};
function newClientId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function defaultAdjustmentReason(adjustmentType: InventoryAdjustmentType, options: string[]) {
  const preferred = defaultAdjustmentReasonByType[adjustmentType];
  if (options.includes(preferred)) return preferred;
  return options[0] ?? "Other";
}


function adjustmentSubmitErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Could not save inventory adjustment.";
}

type ApiResponsePayload = {
  success?: boolean;
  authenticated?: boolean;
  secondsUntilExpiry?: number;
  error?: string;
  message?: string;
  code?: string;
  error_code?: string;
  details?: string;
  debug?: StopDebugDetails;
  [key: string]: unknown;
};

type ParsedServerResponse = {
  payload: ApiResponsePayload | null;
  text: string;
  contentType: string;
  isJson: boolean;
};

function payloadString(value: unknown) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

function responseCode(payload: ApiResponsePayload | null) {
  return payloadString(payload?.code ?? payload?.error_code).toUpperCase();
}

function responseMessage(payload: ApiResponsePayload | null) {
  return payloadString(payload?.error ?? payload?.message).trim();
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = STOP_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function readServerResponse(response: Response, context: Record<string, unknown>): Promise<ParsedServerResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("application/json");
  let text = "";
  let payload: ApiResponsePayload | null = null;

  try {
    text = await response.text();
  } catch (error) {
    console.warn("[operator:stop-mobile] Could not read server response body", {
      ...context,
      response_status_code: response.status,
      response_content_type: contentType || null,
      error,
    });
  }

  if (isJson && text.trim()) {
    try {
      payload = JSON.parse(text) as ApiResponsePayload;
    } catch (error) {
      console.warn("[operator:stop-mobile] Server claimed JSON but body could not be parsed", {
        ...context,
        response_status_code: response.status,
        response_content_type: contentType || null,
        response_body_text: text.slice(0, 2000),
        error,
      });
    }
  }

  if (!isJson || !response.ok || payload?.success === false) {
    console.warn("[operator:stop-mobile] Server response", {
      ...context,
      response_status_code: response.status,
      response_content_type: contentType || null,
      response_body_text: text.slice(0, 2000),
      response_code: responseCode(payload),
      response_message: responseMessage(payload),
    });
  }

  return { payload, text, contentType, isJson };
}

function stopSubmitErrorMessage(response: Response, parsed: ParsedServerResponse) {
  const code = responseCode(parsed.payload);
  const serverMessage = responseMessage(parsed.payload);
  const lowerMessage = serverMessage.toLowerCase();

  if (response.status === 401 || code.includes("SESSION")) {
    return "Your session expired. Your refill draft is saved. Please sign in again and retry.";
  }
  if (response.status === 403 || code === "UNAUTHORIZED" || lowerMessage.includes("permission") || lowerMessage.includes("authorized")) {
    return "Permission denied. Your refill draft is saved. Ask an admin to check your route access.";
  }
  if (response.status === 415 || code.includes("CONTENT") || code.includes("JSON")) {
    return "Invalid refill payload. Your refill draft is saved. Refresh the app and retry.";
  }
  if (response.status === 409) {
    return serverMessage || "This route stop was already changed. Your refill draft is saved; refresh the route before retrying.";
  }
  if (response.status === 400) {
    return serverMessage || "Invalid refill payload. Your refill draft is saved. Check quantities and required fields, then retry.";
  }
  if (!parsed.isJson) {
    return "Server returned a non-JSON response while completing the stop. Your refill draft is saved. Refresh the app and retry.";
  }
  return serverMessage || "Could not complete this stop. Your refill draft is saved. Please contact admin.";
}

function normalizeClientSubmitError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Connection problem. Your refill draft is saved. Please retry.";
  }
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (message.toLowerCase().includes("unexpected response")) {
    return "Server returned an unexpected response. Your refill draft is saved. Tap Refresh App, then retry.";
  }
  if (message.toLowerCase().includes("failed to fetch") || message.toLowerCase().includes("network")) {
    return "Connection problem. Your refill draft is saved. Please retry.";
  }
  return message || "Could not complete this stop. Your refill draft is saved.";
}

async function ensureFreshSession() {
  const checkResponse = await fetchWithTimeout("/api/auth/session", {
    cache: "no-store",
    headers: { Accept: "application/json" },
  }, SESSION_REQUEST_TIMEOUT_MS);
  const check = await readServerResponse(checkResponse, { operation: "operator_stop_session_check" });
  const secondsUntilExpiry = Number(check.payload?.secondsUntilExpiry ?? 0);

  if (checkResponse.ok && check.payload?.authenticated === true && secondsUntilExpiry > 60) return;

  const refreshResponse = await fetchWithTimeout("/api/auth/session", {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json" },
  }, SESSION_REQUEST_TIMEOUT_MS);
  const refresh = await readServerResponse(refreshResponse, { operation: "operator_stop_session_refresh" });

  if (!refreshResponse.ok || refresh.payload?.authenticated !== true) {
    throw new Error("Your session expired. Your refill draft is saved. Please sign in again and retry.");
  }
}

async function refreshMobileApp() {
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch (error) {
    console.warn("[operator:stop-mobile] Could not clear app cache", error);
  }

  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)));
    }
  } catch (error) {
    console.warn("[operator:stop-mobile] Could not refresh service worker", error);
  }

  window.location.reload();
}

function loadImageElement(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not load the proof photo."));
    };
    image.src = url;
  });
}

async function jpegBlobFromImage(file: File, maxDimension: number, quality: number) {
  let source: ImageBitmap | HTMLImageElement;
  let width = 0;
  let height = 0;

  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file);
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
    } catch {
      const image = await loadImageElement(file);
      source = image;
      width = image.naturalWidth || image.width;
      height = image.naturalHeight || image.height;
    }
  } else {
    const image = await loadImageElement(file);
    source = image;
    width = image.naturalWidth || image.width;
    height = image.naturalHeight || image.height;
  }

  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) {
    if ("close" in source) source.close();
    throw new Error("Could not prepare the proof photo.");
  }
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  if ("close" in source) source.close();
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function prepareProofPhoto(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Proof photo must be an image.");
  }
  if (file.size <= PROOF_PHOTO_TARGET_BYTES && SUPPORTED_PROOF_PHOTO_TYPES.has(file.type)) return file;

  let bestBlob: Blob | null = null;
  const attempts = [
    { maxDimension: 1600, quality: 0.82 },
    { maxDimension: 1280, quality: 0.74 },
    { maxDimension: 1024, quality: 0.68 },
    { maxDimension: 900, quality: 0.62 },
  ];

  try {
    for (const attempt of attempts) {
      const blob = await jpegBlobFromImage(file, attempt.maxDimension, attempt.quality);
      if (!blob) continue;
      if (!bestBlob || blob.size < bestBlob.size) bestBlob = blob;
      if (blob.size <= PROOF_PHOTO_TARGET_BYTES) break;
    }
  } catch (error) {
    console.warn("[operator:stop-mobile] Proof photo compression failed", {
      original_size: file.size,
      original_type: file.type,
      error,
    });
    throw new Error("This phone photo could not be prepared for upload. Please retake it as a smaller JPEG photo.");
  }

  if (!bestBlob) throw new Error("This phone photo could not be prepared for upload. Please retake it as a smaller JPEG photo.");
  if (bestBlob.size > PROOF_PHOTO_MAX_ORIGINAL_BYTES) {
    throw new Error("The proof photo is too large. Please retake it as a smaller photo and retry.");
  }

  console.info("[operator:stop-mobile] Proof photo prepared", {
    original_size: file.size,
    prepared_size: bestBlob.size,
    original_type: file.type,
    prepared_type: bestBlob.type,
  });

  const baseName = file.name.replace(/\.[^.]+$/, "") || "refill-proof";
  return new File([bestBlob], `${baseName}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
}

function comparableStopDraft(draft: StopDraft) {
  return JSON.stringify({
    ...draft,
    extraProducts: draft.extraProducts.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      reason: item.reason,
      notes: item.notes,
    })),
    missingReports: draft.missingReports.map((item) => ({
      productName: item.productName,
      reason: item.reason,
      notes: item.notes,
    })),
  });
}

export default function MachineStopPage() {
  const router = useRouter();
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const params = useParams<{ id?: string | string[]; stopId?: string | string[] }>();
  const rawRouteId = params?.id;
  const rawStopId = params?.stopId;
  const routeId = Array.isArray(rawRouteId) ? rawRouteId[0] ?? "" : rawRouteId ?? "";
  const stopId = Array.isArray(rawStopId) ? rawStopId[0] ?? "" : rawStopId ?? "";
  const routeHref = routeId ? `/operator/routes/${routeId}` : "/operator";

  const [stopData, setStopData] = useState<StopData | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState<StopLoadError | null>(null);
  const [cashCollected, setCashCollected] = useState(false);
  const [cashBagId, setCashBagId] = useState("");
  const [notes, setNotes] = useState("");
  const [issueType, setIssueType] = useState("");
  const [issuePriority, setIssuePriority] = useState<"critical" | "high" | "normal" | "low">("normal");
  const [issueDescription, setIssueDescription] = useState("");
  const [filledQtys, setFilledQtys] = useState<Record<string, number>>({});
  const [lineNotes, setLineNotes] = useState<Record<string, string>>({});
  const [unavailableProducts, setUnavailableProducts] = useState<Record<string, boolean>>({});
  const [extraProducts, setExtraProducts] = useState<ExtraProductLine[]>([]);
  const [machineStorageOpen, setMachineStorageOpen] = useState(false);
  const [missingReports, setMissingReports] = useState<MissingProductReport[]>([]);
  const [showCleaningChecklist, setShowCleaningChecklist] = useState(false);
  const [cleaningDone, setCleaningDone] = useState(false);
  const [finalPhotoName, setFinalPhotoName] = useState("");
  const [finalPhotoFile, setFinalPhotoFile] = useState<File | null>(null);
  const [compressorSafetyInstalled, setCompressorSafetyInstalled] = useState(false);
  const [compressorProofReady, setCompressorProofReady] = useState(false);
  const [persistedMachinePhotoReady, setPersistedMachinePhotoReady] = useState(false);

  useEffect(() => {
    const handlePersistedMachinePhoto = (event: Event) => {
      const detail = (event as CustomEvent<{ saved?: boolean }>).detail;
      setPersistedMachinePhotoReady(Boolean(detail?.saved));
    };
    window.addEventListener("snacky:machine-photo-persisted", handlePersistedMachinePhoto);
    return () => window.removeEventListener("snacky:machine-photo-persisted", handlePersistedMachinePhoto);
  }, []);
  const initialStopDraftRef = useRef<string>("");
  const clientSubmissionIdRef = useRef(newClientId());
  const draftKey = useDraftKey("route-stop", [routeId || "missing-route", stopId || "missing-stop"]);
  const stopDraft = useMemo<StopDraft>(() => ({
    filledQtys,
    lineNotes,
    unavailableProducts,
    extraProducts,
    missingReports,
    cashCollected,
    cashBagId,
    notes,
    issueType,
    issuePriority,
    issueDescription,
    showCleaningChecklist,
    cleaningDone,
    finalPhotoName,
    hasFinalPhotoMetadata: Boolean(finalPhotoName),
  }), [
    cashBagId,
    cashCollected,
    cleaningDone,
    extraProducts,
    filledQtys,
    finalPhotoName,
    issueDescription,
    issuePriority,
    issueType,
    lineNotes,
    missingReports,
    notes,
    showCleaningChecklist,
    unavailableProducts,
  ]);
  const shouldSaveStopDraft = useCallback((draft: StopDraft) => {
    if (!routeId || !stopId || !initialStopDraftRef.current || submitting) return false;
    return comparableStopDraft(draft) !== initialStopDraftRef.current;
  }, [routeId, stopId, submitting]);
  const localDraft = useLocalDraft<StopDraft>({
    key: draftKey,
    value: stopDraft,
    shouldSave: shouldSaveStopDraft,
    onRestore: (draft) => {
      setFilledQtys(draft.filledQtys ?? {});
      setLineNotes(draft.lineNotes ?? {});
      setUnavailableProducts(draft.unavailableProducts ?? {});
      setExtraProducts((draft.extraProducts ?? []).map((line) => ({ ...line, id: line.id || newClientId(), reason: line.reason || "extra_stock_left_at_machine" })));
      setMissingReports((draft.missingReports ?? []).map((line) => ({ ...line, id: line.id || newClientId() })));
      setCashCollected(Boolean(draft.cashCollected));
      setCashBagId(draft.cashBagId ?? "");
      setNotes(draft.notes ?? "");
      setIssueType(draft.issueType ?? "");
      setIssuePriority(draft.issuePriority ?? "normal");
      setIssueDescription(draft.issueDescription ?? "");
      setShowCleaningChecklist(Boolean(draft.showCleaningChecklist));
      setCleaningDone(Boolean(draft.cleaningDone));
      setFinalPhotoFile(null);
      setFinalPhotoName(draft.finalPhotoName ? `${draft.finalPhotoName} (re-select before saving)` : "");
    },
  });

  const productById = useMemo(() => new Map((stopData?.productOptions ?? []).map((product) => [product.id, product])), [stopData]);
  const machineStorageStockRows = stopData?.machineStorageStock ?? [];
  const machineStorageProducts = stopData?.machineStorageProductOptions ?? stopData?.productOptions ?? [];
  const machineStorageStockUnits = machineStorageStockRows.reduce((sum, row) => sum + Number(row.quantity ?? 0), 0);
  const assignedByProduct = useMemo(() => new Map((stopData?.refillItems ?? []).map((item) => [item.productId, item])), [stopData]);
  const reservedByProduct = useMemo(() => {
    const reserved = new Map<string, number>();
    Object.entries(filledQtys).forEach(([productId, quantity]) => reserved.set(productId, (reserved.get(productId) ?? 0) + Number(quantity ?? 0)));
    extraProducts.forEach((line) => reserved.set(line.productId, (reserved.get(line.productId) ?? 0) + Number(line.quantity ?? 0)));
    return reserved;
  }, [filledQtys, extraProducts]);
  const fillStatusPreview = useMemo(() => {
    if (!stopData) return "full";
    const hasShortage = stopData.refillItems.some((item) => {
      const assignedQty = Number(item.assignedQty ?? item.parQty ?? 0);
      const actualQty = Number(filledQtys[item.productId] ?? 0);
      return Boolean(unavailableProducts[item.productId]) || actualQty < assignedQty;
    });
    return hasShortage || missingReports.some((item) => item.productName.trim()) ? "partial" : "full";
  }, [filledQtys, missingReports, stopData, unavailableProducts]);
  const stopExecutionSummary = useMemo(() => {
    if (!stopData) {
    return {
      assignedUnits: 0,
      filledUnits: 0,
      shortageUnits: 0,
      extraUnits: 0,
      unavailableCount: 0,
      missingReportCount: 0,
      adjustmentCount: 0,
      proofReady: false,
    };
  }

    const assignedSummary = stopData.refillItems.reduce(
      (summary, item) => {
        const assignedQty = Number(item.assignedQty ?? item.parQty ?? 0);
        const actualQty = Number(filledQtys[item.productId] ?? 0);
        summary.assignedUnits += assignedQty;
        summary.filledUnits += actualQty;
        summary.shortageUnits += Math.max(0, assignedQty - actualQty);
        if (unavailableProducts[item.productId]) summary.unavailableCount += 1;
        return summary;
      },
      { assignedUnits: 0, filledUnits: 0, shortageUnits: 0, unavailableCount: 0 },
    );

    return {
      ...assignedSummary,
      extraUnits: extraProducts.reduce((sum, item) => sum + Math.max(0, Number(item.quantity ?? 0)), 0),
      missingReportCount: missingReports.filter((item) => item.productName.trim()).length,
      adjustmentCount: stopData.adjustments?.length ?? 0,
      proofReady: Boolean(finalPhotoFile || persistedMachinePhotoReady || stopData.hasCompletionPhoto),
    };
  }, [extraProducts, filledQtys, finalPhotoFile, persistedMachinePhotoReady, missingReports, stopData, unavailableProducts]);

  useEffect(() => {
    const fetchStopData = async () => {
      if (!routeId || !stopId) {
        setLoadError({
          title: "Stop link incomplete",
          body: "Route or stop information is missing. Go back to your route and open the stop again.",
        });
        setLoading(false);
        return;
      }

      try {
        const response = await fetchWithTimeout(`/api/operator/routes/${routeId}/stops/${stopId}`, {
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const parsed = await readServerResponse(response, {
          operation: "operator_stop_load",
          route_id: routeId,
          route_stop_id: stopId,
          user_agent: navigator.userAgent,
        });
        const data = parsed.payload;
        if (!data) {
          throw new Error(parsed.isJson ? "Stop data could not be read. Please refresh and retry." : "Server returned a non-JSON response while loading this stop.");
        }
        if (!response.ok) {
          const serverMessage = responseMessage(data) || "Failed to load stop data";
          if (response.status === 403 || responseCode(data) === "UNAUTHORIZED") {
            setLoadError({ title: "Unauthorized", body: serverMessage });
            return;
          }

          if (responseCode(data) === "STOP_NOT_FOUND") {
            setLoadError({ title: "Stop unavailable", body: "This stop no longer exists." });
            return;
          }

          setLoadError({
            title: responseCode(data) === "STOP_ROUTE_MISMATCH" ? "Stop route mismatch" : "Stop could not be loaded",
            body: serverMessage,
          });
          return;
        }

        const stopPayload = data as unknown as StopData;
        setStopData(stopPayload);
        if (stopPayload.stopStatus === ROUTE_STOP_PICKED_STATUS) {
          markStopInProgress(routeId, stopId).then((result) => {
            if (result.success) setStopData((current) => current ? { ...current, stopStatus: ROUTE_STOP_IN_PROGRESS_STATUS } : current);
          }).catch((err) => console.warn("[operator:stop] Could not mark stop in progress", err));
        }
        const initialQtys: Record<string, number> = {};
        const initialNotes: Record<string, string> = {};
        const initialUnavailable: Record<string, boolean> = {};
        stopPayload.refillItems?.forEach((item: StopRefillItem) => {
          const assignedQty = Number(item.assignedQty ?? item.parQty ?? 0);
          const hasSavedQty = item.filledQty !== null && item.filledQty !== undefined;
          initialQtys[item.productId] = hasSavedQty ? Number(item.filledQty ?? 0) : Math.min(assignedQty, item.availableQty ?? assignedQty);
          if (item.notes) initialNotes[item.productId] = item.notes;
          if (hasSavedQty && Number(item.filledQty ?? 0) === 0 && assignedQty > 0) initialUnavailable[item.productId] = true;
        });
        setFilledQtys(initialQtys);
        setLineNotes(initialNotes);
        setUnavailableProducts(initialUnavailable);
        const initialExtraProducts = (stopPayload.extraItems ?? []).map((item: ExtraProductLine) => ({ ...item, id: newClientId(), reason: item.reason || "extra_stock_left_at_machine" }));
        setExtraProducts(initialExtraProducts);
        const initialFinalPhotoName = stopPayload.hasCompletionPhoto ? "Existing proof photo saved" : "";
        setFinalPhotoName(initialFinalPhotoName);
        initialStopDraftRef.current = comparableStopDraft({
          filledQtys: initialQtys,
          lineNotes: initialNotes,
          unavailableProducts: initialUnavailable,
          extraProducts: initialExtraProducts,
          missingReports: [],
          cashCollected: false,
          cashBagId: "",
          notes: "",
          issueType: "",
          issuePriority: "normal",
          issueDescription: "",
          showCleaningChecklist: false,
          cleaningDone: false,
          finalPhotoName: initialFinalPhotoName,
          hasFinalPhotoMetadata: Boolean(initialFinalPhotoName),
        });
      } catch (err) {
        setLoadError({
          title: "Stop could not be loaded",
          body: err instanceof Error ? err.message : "Failed to load stop data",
        });
      } finally {
        setLoading(false);
      }
    };
    fetchStopData();
  }, [routeId, stopId]);

  const remainingBagQty = (productId: string, excluding = 0) => {
    const available = productById.get(productId)?.availableQty ?? assignedByProduct.get(productId)?.availableQty ?? 0;
    const reserved = reservedByProduct.get(productId) ?? 0;
    return Math.max(0, available - reserved + excluding);
  };

  const updateProductAvailability = (products: ProductOption[] | undefined, productId: string | null, delta: number) => {
    if (!products?.length || !productId || delta === 0) return products;
    return products.map((product) => product.id === productId
      ? { ...product, availableQty: Math.max(0, Number(product.availableQty ?? 0) + delta) }
      : product);
  };

  const mergeManualSale = (sales: NormalizedRouteManualSale[] | undefined, sale: NormalizedRouteManualSale) => [sale, ...(sales ?? []).filter((existing) => existing.id !== sale.id)]
    .sort((left, right) => new Date(right.saleTime ?? right.id).getTime() - new Date(left.saleTime ?? left.id).getTime());

  const setAssignedQty = (item: StopRefillItem, quantity: number) => {
    const current = filledQtys[item.productId] ?? 0;
    const max = remainingBagQty(item.productId, current);
    setFilledQtys((prev) => ({ ...prev, [item.productId]: Math.max(0, Math.min(max, quantity)) }));
    if (quantity > max) setError("Actual filled quantity cannot exceed what is available in the operator bag.");
  };

  const addExtraProduct = () => {
    setExtraProducts((prev) => [...prev, { id: newClientId(), productId: "", quantity: 0, reason: "extra_stock_left_at_machine", notes: "" }]);
  };

  const addMissingReport = () => {
    setMissingReports((prev) => [...prev, { id: newClientId(), productName: "", reason: "Other", notes: "" }]);
  };

  const updateExtra = (id: string, patch: Partial<ExtraProductLine>) => {
    setExtraProducts((prev) => prev.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const updateMissingReport = (id: string, patch: Partial<MissingProductReport>) => {
    setMissingReports((prev) => prev.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const handleCompleteStop = async () => {
    if (!stopData) return;
    const hasPersistedMachineProof = persistedMachinePhotoReady || Boolean(stopData.hasCompletionPhoto);
    const canReuseCompletedProof = hasPersistedMachineProof;
    if (!cleaningDone && stopData.stopStatus !== ROUTE_STOP_COMPLETED_STATUS) {
      setError(tr("Please complete the cleaning checklist before finishing.", "أكمل قائمة التنظيف والفحص قبل الإنهاء."));
      return;
    }
    if (!finalPhotoFile && !canReuseCompletedProof) {
      setError(tr("Please take or upload the final machine photo before completing the stop.", "التقط أو ارفع الصورة النهائية للجهاز قبل إنهاء الموقع."));
      return;
    }
    if (compressorSafetyInstalled && !compressorProofReady && stopData.stopStatus !== ROUTE_STOP_COMPLETED_STATUS) {
      setError(tr("Save the compressor ON photo before completing this stop.", "احفظ صورة تشغيل الضاغط قبل إنهاء هذا الموقع."));
      document.getElementById("compressor-safety")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }

    localDraft.saveNow();
    setSubmitting(true);
    setError("");
    try {
      await ensureFreshSession();

      let uploadedProof: Awaited<ReturnType<typeof uploadRefillProofPhoto>> | null = null;
      if (finalPhotoFile) {
        const preparedPhoto = await prepareProofPhoto(finalPhotoFile);
        const photoFormData = new FormData();
        photoFormData.append("routeId", routeId);
        photoFormData.append("stopId", stopId);
        photoFormData.append("machineId", stopData.machineId);
        photoFormData.append("photo", preparedPhoto);
        try {
          uploadedProof = await uploadRefillProofPhoto(photoFormData);
        } catch (uploadError) {
          const message = normalizeClientSubmitError(uploadError);
          throw new Error(message.includes("unexpected response")
            ? "Server returned an unexpected response while uploading the proof photo. Your refill draft is saved. Tap Refresh App, then retry."
            : message);
        }
      }

      const payload = {
        clientSubmissionId: clientSubmissionIdRef.current,
        stopId,
        routeId,
        machineId: stopData.machineId,
        filledItems: stopData.refillItems.map((item) => ({
          refillOrderLineId: item.refillOrderLineId ?? null,
          productId: item.productId,
          quantity: filledQtys[item.productId] ?? 0,
          assignedQty: Number(item.assignedQty ?? item.parQty ?? 0),
          reason: unavailableProducts[item.productId] ? "Product not in operator bag" : undefined,
          notes: lineNotes[item.productId] || undefined,
          unavailable: Boolean(unavailableProducts[item.productId]),
        })),
        extraItems: extraProducts
          .filter((item) => item.productId && item.quantity > 0)
          .map((item) => ({ productId: item.productId, quantity: item.quantity, reason: item.reason, notes: item.notes || undefined })),
        missingProducts: missingReports
          .filter((item) => item.productName.trim())
          .map((item) => ({ productName: item.productName.trim(), reason: item.reason, notes: item.notes || undefined })),
        cashCollected,
        cashBagId,
        notes,
        completionPhotoUrl: uploadedProof?.photoUrl,
        completionPhotoPath: uploadedProof?.photoPath,
        completionPhotoOriginalName: uploadedProof?.originalName,
        completionPhotoUploadUnavailable: uploadedProof?.uploadUnavailable,
        issue: issueType && issueDescription ? { issueType, priority: issuePriority, description: issueDescription } : undefined,
      };
      const payloadText = JSON.stringify(payload);
      const submitLog = {
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: stopData.machineId,
        client_submission_id: clientSubmissionIdRef.current,
        request_timestamp: new Date().toISOString(),
        payload_size: new TextEncoder().encode(payloadText).length,
        refill_line_count: payload.filledItems.length,
        extra_item_count: payload.extraItems.length,
        missing_product_count: payload.missingProducts.length,
        session_checked: true,
        user_agent: navigator.userAgent,
      };
      console.info("[operator:stop-mobile] Submitting stop completion", submitLog);

      const response = await fetchWithTimeout(`/api/operator/routes/${routeId}/stops/${stopId}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: payloadText,
      });
      const parsed = await readServerResponse(response, { ...submitLog, operation: "operator_stop_complete" });
      console.info("[operator:stop-mobile] Stop completion response", {
        ...submitLog,
        response_status_code: response.status,
        response_content_type: parsed.contentType || null,
        response_code: responseCode(parsed.payload),
        response_message: responseMessage(parsed.payload),
      });

      if (!response.ok || parsed.payload?.success === false || !parsed.payload) {
        throw new Error(stopSubmitErrorMessage(response, parsed));
      }

      localDraft.clearDraft();
      clientSubmissionIdRef.current = newClientId();
      const stopSuccessMessage = tr("Stop completed successfully.", "تم إنهاء الموقع بنجاح.");
      console.info("[operator:route-nav] Redirecting after stop save", {
        action: "complete_stop",
        routeId,
        stopId,
        machineId: stopData.machineId,
        redirectPath: `${routeHref}?success=${encodeURIComponent(stopSuccessMessage)}`,
      });
      router.push(`${routeHref}?success=${encodeURIComponent(stopSuccessMessage)}`);
    } catch (err) {
      console.warn("[operator:stop-mobile] Stop completion failed", {
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: stopData.machineId,
        client_submission_id: clientSubmissionIdRef.current,
        user_agent: navigator.userAgent,
        error: err,
      });
      setError(normalizeClientSubmitError(err));
      setSubmitting(false);
      window.setTimeout(() => localDraft.saveNow(), 0);
    }
  };

  if (loading) {
    return <LoadingState variant="detail" />;
  }

  if (!stopData) {
    return (
      <>
        <div className="space-y-4">
          <ErrorState
            title={t(loadError?.title ?? "Stop could not be loaded", loadError?.title ?? "Stop could not be loaded")}
            body={t(loadError?.body ?? "Failed to load machine stop details.", loadError?.body ?? "Failed to load machine stop details.")}
            action={<SecondaryButton href={routeHref}>{t("Back to route")}</SecondaryButton>}
          />
        </div>
      </>
    );
  }

  if (isRouteStopDoneStatus(stopData.stopStatus)) {
    const stopWasCompleted = stopData.stopStatus === ROUTE_STOP_COMPLETED_STATUS;
    return (
      <div className="max-w-5xl space-y-6">
        <PageHeader
          title={stopData.machineName}
          subtitle={`${stopData.machineCode} - ${stopData.location}`}
          action={<SecondaryButton href={routeHref}>{t("Back")}</SecondaryButton>}
        />
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-emerald-950">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              {stopWasCompleted
                ? tr("Completed stop — read only", "موقع مكتمل — للعرض فقط")
                : tr("Closed stop — read only", "موقع مغلق — للعرض فقط")}
            </h2>
            <StatusBadge status={stopData.stopStatus} label={t(stopData.stopStatus, stopData.stopStatus)} />
          </div>
          <p className="mt-2 text-sm leading-6">
            {stopWasCompleted
              ? tr(
                  "This stop's inventory, cash, and proof are already committed. To protect the ledger, completed stops cannot be edited from the operator form; any correction must be recorded as a separate audited manager action.",
                  "تم اعتماد مخزون هذا الموقع والنقد والإثبات. لحماية السجل، لا يمكن تعديل المواقع المكتملة من نموذج المشغل؛ ويجب تسجيل أي تصحيح كإجراء إداري منفصل وخاضع للتدقيق.",
                )
              : tr(
                  "This stop was skipped or cancelled and cannot be reopened from the operator form. A manager must use an audited correction workflow if its outcome is wrong.",
                  "تم تخطي هذا الموقع أو إلغاؤه ولا يمكن إعادة فتحه من نموذج المشغل. يجب على المدير استخدام إجراء تصحيح خاضع للتدقيق إذا كانت النتيجة غير صحيحة.",
                )}
          </p>
        </section>
        {stopWasCompleted ? (
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label={t("Assigned units")} value={stopExecutionSummary.assignedUnits} />
            <Metric label={t("Filled now")} value={stopExecutionSummary.filledUnits} />
            <Metric label={tr("Machine storage units", "وحدات مخزن الجهاز")} value={stopExecutionSummary.extraUnits} />
            <Metric label={t("Proof photo")} value={stopExecutionSummary.proofReady ? t("Ready") : t("Needed")} tone={stopExecutionSummary.proofReady ? "neutral" : "warn"} />
          </section>
        ) : null}
        <SecondaryButton href={routeHref}>{tr("View route outcome", "عرض نتيجة الجولة")}</SecondaryButton>
      </div>
    );
  }

  const compressorReadyForSubmit = !compressorSafetyInstalled || compressorProofReady;
  const canSubmitStop = !submitting && cleaningDone && compressorReadyForSubmit;

  return (
    <>
      <div className="max-w-5xl space-y-6">
        <PageHeader
          title={stopData.machineName}
          subtitle={`${stopData.machineCode} - ${stopData.location}`}
          action={<SecondaryButton href={routeHref}>{t("Back")}</SecondaryButton>}
        />

        <DraftRestoreBanner pendingDraft={localDraft.pendingDraft} onRestore={localDraft.restoreDraft} onDiscard={localDraft.discardDraft} />
        {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}
        <RouteStopQuickActions />
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p>{t(error, error)}</p>
            <button type="button" onClick={() => void refreshMobileApp()} className="mt-3 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700">
              {t("Refresh App")}
            </button>
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label={t("Assigned units")} value={stopExecutionSummary.assignedUnits} />
          <Metric label={t("Filled now")} value={stopExecutionSummary.filledUnits} />
          <Metric label={tr("Shortage to explain", "نقص يحتاج توضيحاً")} value={stopExecutionSummary.shortageUnits} tone={stopExecutionSummary.shortageUnits > 0 ? "warn" : "neutral"} />
          <Metric label={tr("Machine storage units", "وحدات مخزن الجهاز")} value={stopExecutionSummary.extraUnits} />
          <Metric label={t("Inventory adjustments")} value={stopExecutionSummary.adjustmentCount} />
          <Metric label={t("Proof photo")} value={stopExecutionSummary.proofReady ? t("Ready") : t("Needed")} tone={stopExecutionSummary.proofReady ? "neutral" : "warn"} />
          <Metric label={tr("Compressor proof", "إثبات الضاغط")} value={!compressorSafetyInstalled ? tr("Setup pending", "الإعداد معلق") : compressorProofReady ? tr("Ready", "جاهز") : tr("Needed", "مطلوب")} tone={compressorSafetyInstalled && !compressorProofReady ? "warn" : "neutral"} />
        </section>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
{t("Record what you actually filled, then finish the stop. Leftovers are handled later on the route leftovers screen, so you do not need to invent fake leftover numbers here.")}
        </div>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 p-4 md:p-6">
            <h2 className="text-lg font-semibold">{t("Assigned products")}</h2>
            <p className="mt-1 text-sm text-slate-500">{t("Record actual quantities. Differences from the plan are tracked for review.")}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label={t("Unavailable lines")} value={stopExecutionSummary.unavailableCount} tone={stopExecutionSummary.unavailableCount > 0 ? "warn" : "neutral"} />
              <Metric label={t("Missing product reports")} value={stopExecutionSummary.missingReportCount} tone={stopExecutionSummary.missingReportCount > 0 ? "warn" : "neutral"} />
              <Metric label={t("Cash status")} value={cashCollected ? t("Collected") : t("No cash")} />
              <Metric label={t("Refill result")} value={fillStatusPreview === "full" ? t("Full refill") : t("Partial refill")} tone={fillStatusPreview === "full" ? "neutral" : "warn"} />
            </div>
          </div>

          {stopData.refillItems.length === 0 ? (
            <div className="p-4 md:p-6">
              <EmptyState title={t("No refill items assigned to this stop")} body={t("You can still add extra products, collect cash, report issues, and complete the stop.")} />
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {stopData.refillItems.map((item) => {
                const assignedQty = Number(item.assignedQty ?? item.parQty ?? 0);
                const actualQty = filledQtys[item.productId] ?? 0;
                const difference = actualQty - assignedQty;
                const maxQty = remainingBagQty(item.productId, actualQty);
                return (
                  <div key={`${item.refillOrderLineId ?? item.productId}-${item.slotCode}`} className="space-y-4 p-4 md:p-6">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      <div className="min-w-0 sm:col-span-2 lg:col-span-2">
                        <p className="text-xs text-slate-500">{tr("Product", "المنتج")}</p>
                        <p className="break-words font-semibold text-slate-900">{item.productName}</p>
                        <p className="text-sm text-slate-500">{tr("Slot", "الخانة")} {item.slotCode}</p>
                        {item.sourceLabel ? (
                          <span className="mt-1 inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">
                            {item.sourceLabel}
                          </span>
                        ) : null}
                      </div>
                      <Metric label={tr("Assigned", "المسند")} value={assignedQty} />
                      <Metric label={tr("Bag available", "المتاح في الحقيبة")} value={item.availableQty ?? 0} />
                      <Metric label={tr("Difference", "الفرق")} value={difference > 0 ? `+${difference}` : difference} tone={difference === 0 ? "neutral" : "warn"} />
                    </div>
                    <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">{t("Filled quantity")}</span>
                        <QuantityStepper
                          value={actualQty}
                          max={maxQty}
                          onChange={(quantity) => setAssignedQty(item, quantity)}
                          disabled={unavailableProducts[item.productId]}
                          inputLabel={`${item.productName} actual filled quantity`}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">{t("Notes for change")}</span>
                        <input
                          value={lineNotes[item.productId] ?? ""}
                          onChange={(event) => setLineNotes((prev) => ({ ...prev, [item.productId]: event.target.value }))}
                          className="field-input"
                          placeholder={t("Explain shortage, overfill, or condition")}
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={Boolean(unavailableProducts[item.productId])}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setUnavailableProducts((prev) => ({ ...prev, [item.productId]: checked }));
                          if (checked) setFilledQtys((prev) => ({ ...prev, [item.productId]: 0 }));
                        }}
                      />
                      {t("Mark assigned product as unavailable")}
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </section>

                <ManualRouteSalesSection
          routeId={routeId}
          stopId={stopId}
          machineId={stopData.machineId}
          machineName={stopData.machineName}
          locationName={stopData.location}
          routeStatus={stopData.routeStatus}
          preferredProducts={stopData.manualSaleProductOptions ?? stopData.machineProductOptions ?? stopData.productOptions}
          allProducts={stopData.productOptions}
          sales={stopData.manualSales ?? []}
          loadError={Boolean(stopData.manualSalesLoadError)}
          onSaved={(sale, options) => {
            setStopData((current) => current ? {
              ...current,
              manualSales: mergeManualSale(current.manualSales, sale),
              productOptions: updateProductAvailability(current.productOptions, sale.productId, options.inventoryMovementCreated ? -sale.quantity : 0) ?? current.productOptions,
              machineProductOptions: updateProductAvailability(current.machineProductOptions, sale.productId, options.inventoryMovementCreated ? -sale.quantity : 0),
              manualSaleProductOptions: updateProductAvailability(current.manualSaleProductOptions as ProductOption[] | undefined, sale.productId, options.inventoryMovementCreated ? -sale.quantity : 0) as ManualRouteSaleProductOption[] | undefined,
            } : current);
          }}
          onCancelled={(sale, options) => {
            setStopData((current) => current ? {
              ...current,
              manualSales: mergeManualSale(current.manualSales, sale),
              productOptions: updateProductAvailability(current.productOptions, sale.productId, options.inventoryReversed ? sale.quantity : 0) ?? current.productOptions,
              machineProductOptions: updateProductAvailability(current.machineProductOptions, sale.productId, options.inventoryReversed ? sale.quantity : 0),
              manualSaleProductOptions: updateProductAvailability(current.manualSaleProductOptions as ProductOption[] | undefined, sale.productId, options.inventoryReversed ? sale.quantity : 0) as ManualRouteSaleProductOption[] | undefined,
            } : current);
          }}
        />

        <section className="rounded-lg border border-slate-200 bg-white">
          <button
            type="button"
            onClick={() => setMachineStorageOpen((current) => !current)}
            className="flex w-full items-center justify-between gap-3 border-b border-slate-200 p-4 text-left transition hover:bg-slate-50 md:p-6"
          >
            <div>
              <h2 className="text-lg font-semibold">{t("Machine storage")}</h2>
              <p className="mt-1 text-sm text-slate-500">
                {t("Keep extra products at the machine instead of returning them to storage.")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className={machineStorageOpen ? "rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700" : "rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-600"}>
                {machineStorageOpen ? t("Open") : t("Collapsed")}
              </span>
              <span className="text-sm font-medium text-slate-600">{machineStorageOpen ? t("Hide") : t("Show")}</span>
            </div>
          </button>

          <div className="grid gap-3 border-b border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 xl:grid-cols-4 md:p-6">
            <Metric label={t("Current stock units")} value={machineStorageStockUnits} />
            <Metric label={t("Draft units")} value={stopExecutionSummary.extraUnits} />
            <Metric label={t("Saved rows")} value={machineStorageStockRows.length} />
            <Metric label={t("Missing reports")} value={stopExecutionSummary.missingReportCount} tone={stopExecutionSummary.missingReportCount > 0 ? "warn" : "neutral"} />
          </div>

          {machineStorageOpen ? (
            <div className="space-y-5 p-4 md:p-6">
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold text-slate-900">{t("Current machine storage")}</h3>
                    <p className="mt-1 text-sm text-slate-500">{t("Read-only machine storage stock is shown here for reference.")}</p>
                  </div>
                  <span className="text-sm text-slate-500">{machineStorageStockRows.length} {t("rows")}</span>
                </div>
                {machineStorageStockRows.length ? (
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {machineStorageStockRows.map((row) => (
                      <div key={row.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="break-words font-semibold text-slate-900">{row.productName ?? t("Unknown product")}</p>
                            <p className="text-xs text-slate-500">{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : t("No update time")}</p>
                          </div>
                          <span className="rounded-full bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white">{row.quantity}</span>
                        </div>
                        {row.notes ? <p className="mt-2 break-words text-sm text-slate-600">{row.notes}</p> : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
                    {t("No machine storage stock has been recorded yet.")}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">{t("Add machine storage lines")}</h3>
                  <p className="mt-1 text-sm text-slate-500">
                    {t("Choose a product from the operator bag first. Search all products only if you need to find a specific item.")}
                  </p>
                </div>
                <div className="grid gap-2 sm:flex sm:flex-wrap">
                  <button type="button" onClick={addExtraProduct} className="btn-secondary w-full sm:w-auto">{t("Add product")}</button>
                  <button type="button" onClick={addMissingReport} className="btn-secondary w-full sm:w-auto">{t("Report missing")}</button>
                </div>
              </div>

              <div className="space-y-3">
                {extraProducts.map((line) => {
                  const selected = machineStorageProducts.find((product) => product.id === line.productId) ?? stopData.productOptions.find((product) => product.id === line.productId);
                  const maxQty = line.productId ? remainingBagQty(line.productId, line.quantity) : 0;
                  const bagAvailable = line.productId ? remainingBagQty(line.productId) : 0;
                  const notInBag = Boolean(line.productId) && bagAvailable <= 0;
                  return (
                    <div key={line.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_160px_1fr]">
                        <ProductPicker products={machineStorageProducts} allProducts={stopData.productOptions} value={line.productId} onChange={(productId) => updateExtra(line.id, { productId, quantity: 0 })} label={t("Machine storage product")} />
                        <QuantityInput value={line.quantity} max={maxQty} onChange={(quantity) => updateExtra(line.id, { quantity })} availabilityLabel={t("Operator bag available")} />
                        <ReasonSelect value={line.reason} onChange={(reason) => updateExtra(line.id, { reason })} options={[...machineStorageReasonOptions]} />
                      </div>
                      {notInBag ? (
                        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                          {t("This product is not currently in the operator bag. Keep the quantity at 0 unless an owner/admin override exists.")}
                        </div>
                      ) : selected ? (
                        <div className="mt-3 text-xs text-slate-500">
                          {t("Selected")}: {selected.name}
                          {selected.sourceLabel ? <span className="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-700">{selected.sourceLabel}</span> : null}
                        </div>
                      ) : null}
                      <input value={line.notes} onChange={(event) => updateExtra(line.id, { notes: event.target.value })} className="field-input mt-3" placeholder={selected ? `${t("Notes")} ${selected.name}` : t("Notes")} />
                      <button type="button" onClick={() => setExtraProducts((prev) => prev.filter((item) => item.id !== line.id))} className="mt-2 text-sm font-medium text-rose-700">{t("Remove")}</button>
                    </div>
                  );
                })}

                {missingReports.length ? (
                  <div className="border-t border-slate-200 pt-4">
                    <div className="mb-3">
                      <h3 className="text-base font-semibold text-slate-900">{t("Missing products")}</h3>
                      <p className="mt-1 text-sm text-slate-500">{t("Use this when the machine is missing a product but there is no extra stock line to keep.")}</p>
                    </div>
                    <div className="space-y-3">
                      {missingReports.map((line) => (
                        <div key={line.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <label className="block">
                              <span className="mb-1 block text-sm font-medium text-slate-800">{t("Missing product name")}</span>
                              <input value={line.productName} onChange={(event) => updateMissingReport(line.id, { productName: event.target.value })} className="field-input" placeholder={t("Type product name from machine")} />
                            </label>
                            <ReasonSelect value={line.reason} onChange={(reason) => updateMissingReport(line.id, { reason })} />
                          </div>
                          <input value={line.notes} onChange={(event) => updateMissingReport(line.id, { notes: event.target.value })} className="field-input mt-3" placeholder={t("Notes")} />
                          <button type="button" onClick={() => setMissingReports((prev) => prev.filter((item) => item.id !== line.id))} className="mt-2 text-sm font-medium text-rose-700">{t("Remove")}</button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {!extraProducts.length && !missingReports.length ? (
                  <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">{t("No machine storage lines or missing product reports added.")}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
        <InventoryAdjustmentsSection
          routeId={routeId}
          stopId={stopId}
          machineId={stopData.machineId}
          machineName={stopData.machineName}
          machineCode={stopData.machineCode}
          machineProducts={stopData.machineProductOptions ?? stopData.productOptions}
          allProducts={stopData.productOptions}
          adjustments={stopData.adjustments ?? []}
          onSaved={(adjustment) => {
            setStopData((current) => current
              ? { ...current, adjustments: [adjustment, ...(current.adjustments ?? [])] }
              : current);
          }}
        />

        <CashAndIssueSections
          cashCollected={cashCollected}
          setCashCollected={setCashCollected}
          cashBagId={cashBagId}
          setCashBagId={setCashBagId}
          notes={notes}
          setNotes={setNotes}
          issueType={issueType}
          setIssueType={setIssueType}
          issuePriority={issuePriority}
          setIssuePriority={setIssuePriority}
          issueDescription={issueDescription}
          setIssueDescription={setIssueDescription}
        />

        <CompressorSafetyProofCard
          routeId={routeId}
          stopId={stopId}
          machineId={stopData.machineId}
          completed={false}
          onStateChange={({ installed, ready }) => {
            setCompressorSafetyInstalled(installed);
            setCompressorProofReady(ready);
          }}
        />

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{tr("Refill proof", "إثبات التعبئة")}</h2>
              <p className="mt-1 text-sm text-slate-500">{tr("Take the photo after filling the machine and cleaning the glass.", "التقط الصورة بعد تعبئة الجهاز وتنظيف الزجاج.")}</p>
            </div>
            <div className={fillStatusPreview === "full" ? "rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-semibold text-green-800" : "rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800"}>
              {fillStatusPreview === "full" ? t("Full refill") : t("Partial refill")}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_260px]">
            <div>
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setFinalPhotoFile(file);
                  setFinalPhotoName(file?.name ?? "");
                }}
                className="field-input"
              />
              {finalPhotoFile ? <p className="mt-2 text-sm text-slate-600">{tr("Selected", "المحدد")}: {finalPhotoFile.name}</p> : null}
              {!finalPhotoFile && (persistedMachinePhotoReady || stopData.hasCompletionPhoto) ? <p className="mt-2 text-sm text-slate-600">{tr("A completion photo is already saved for this stop. Add a new photo only if you want to replace it.", "تم حفظ صورة إنهاء لهذا الموقع بالفعل. أضف صورة جديدة فقط عند الرغبة في استبدالها.")}</p> : null}
              {!finalPhotoFile && !persistedMachinePhotoReady && !stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-amber-700">{tr("Final photo is required before completion.", "الصورة النهائية مطلوبة قبل الإنهاء.")}</p> : null}
            </div>
            <div className={stopExecutionSummary.proofReady ? "rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" : "rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"}>
              <div className="text-xs font-semibold uppercase tracking-wide">{stopExecutionSummary.proofReady ? tr("Photo ready", "الصورة جاهزة") : tr("Photo still needed", "ما زالت الصورة مطلوبة")}</div>
              <div className="mt-2 font-semibold">
                {finalPhotoFile ? tr("New proof photo will upload with this save.", "سيتم رفع صورة إثبات جديدة مع هذا الحفظ.") : persistedMachinePhotoReady || stopData.hasCompletionPhoto ? tr("Existing proof photo is already attached.", "صورة الإثبات الحالية مرفقة بالفعل.") : tr("Take a completion photo before finishing this stop.", "التقط صورة إنهاء قبل إتمام هذا الموقع.")}
              </div>
              <div className="mt-2 text-xs">
                {tr("Completion photos stay visible later from the route details page.", "ستظل صور الإنهاء ظاهرة لاحقاً في صفحة تفاصيل الجولة.")}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-4 text-lg font-semibold">{tr("Cleaning and final check", "التنظيف والفحص النهائي")}</h2>
          <button type="button" onClick={() => setShowCleaningChecklist(!showCleaningChecklist)} className="w-full rounded-lg border border-slate-200 bg-slate-50 p-4 text-left transition hover:bg-slate-100">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-900">{tr("Checklist", "قائمة التحقق")}</span>
              <span className={cleaningDone ? "font-semibold text-green-600" : "text-slate-600"}>{cleaningDone ? tr("Completed", "مكتمل") : tr("Open", "فتح")}</span>
            </div>
          </button>
          {showCleaningChecklist && (
            <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={cleaningDone} onChange={(event) => setCleaningDone(event.target.checked)} className="mt-1" />
                <div>
                  <p className="font-medium text-slate-900">{tr("I have completed all checks:", "أكملت جميع الفحوصات:")}</p>
                  <ul className="mt-2 ml-2 list-disc space-y-1 text-sm text-slate-600">
                    <li>{tr("Machine exterior is clean", "الجزء الخارجي للجهاز نظيف")}</li>
                    <li>{tr("Display screen is working", "شاشة الجهاز تعمل")}</li>
                    <li>{tr("All items are stocked correctly", "جميع المنتجات موضوعة بشكل صحيح")}</li>
                    <li>{tr("No damaged or expired items visible", "لا توجد منتجات تالفة أو منتهية الصلاحية ظاهرة")}</li>
                    <li>{tr("Machine is operating properly", "الجهاز يعمل بشكل سليم")}</li>
                  </ul>
                </div>
              </label>
            </div>
          )}
        </section>

        <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-2 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
          <button onClick={handleCompleteStop} disabled={!canSubmitStop} className="btn-primary w-full flex-1 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? `${t("Saving")}...` : t("Complete Stop")}
          </button>
          <SecondaryButton href={routeHref} type="button">{tr("Cancel", "إلغاء")}</SecondaryButton>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <strong>{tr("Reminder", "تذكير")}:</strong> {tr("This page is for physical execution at the machine: actual filled quantities, shortage reasons, machine storage, cash, issues, and the final photo after cleaning.", "هذه الصفحة للتنفيذ الفعلي عند الجهاز: الكميات المعبأة فعلياً، أسباب النقص، مخزن الجهاز، النقد، الأعطال، والصورة النهائية بعد التنظيف.")}
        </div>

      </div>
    </>
  );
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: number | string; tone?: "neutral" | "warn" }) {
  return (
    <div className={tone === "warn" ? "rounded-lg border border-amber-200 bg-amber-50 p-3" : "rounded-lg border border-slate-200 bg-white p-3"}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function ProductPicker({ products, allProducts, value, onChange, label = "Existing product" }: { products: ProductOption[]; allProducts?: ProductOption[]; value: string; onChange: (productId: string) => void; label?: string }) {
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [sourceMode, setSourceMode] = useState<"priority" | "all">("priority");
  const priorityProducts = products;
  const showAllToggle = Boolean(allProducts?.length);
  const selected = (allProducts ?? priorityProducts).find((product) => product.id === value) ?? priorityProducts.find((product) => product.id === value);
  const activeProducts = showAllToggle && sourceMode === "all" ? (allProducts ?? []) : priorityProducts;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return activeProducts.slice(0, 8);
    return activeProducts
      .filter((product) => [product.name, product.sku, product.barcode, product.category, product.brand, product.sourceLabel].some((field) => String(field ?? "").toLowerCase().includes(needle)))
      .slice(0, 8);
  }, [activeProducts, query]);

  useEffect(() => {
    if (!showAllToggle) {
      setSourceMode("priority");
      return;
    }
    if (!value) return;
    const inPriority = priorityProducts.some((product) => product.id === value);
    if (!inPriority) setSourceMode("all");
  }, [priorityProducts, showAllToggle, value]);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {showAllToggle ? (
          <button
            type="button"
            onClick={() => {
              setSourceMode((current) => current === "priority" ? "all" : "priority");
              setQuery("");
            }}
            className="text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-900"
          >
            {sourceMode === "priority" ? t("Search all products") : t("Priority products")}
          </button>
        ) : null}
      </div>
      {showAllToggle ? (
        <p className="mb-2 text-xs text-slate-500">
          {sourceMode === "priority"
            ? t("Priority order: operator bag, picked up for this route, assigned to this machine/stop.")
            : t("Search the full product catalog if the priority list does not include what you need.")}
        </p>
      ) : null}
      <div className="rounded-lg border border-slate-200 bg-white p-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-h-12 w-full rounded-md border-0 px-2 py-2 text-base outline-none ring-0 md:text-sm"
          placeholder={selected
            ? `${selected.name} - ${selected.sku ?? t("No SKU")}`
            : sourceMode === "priority"
              ? t("Search priority products by name, SKU, barcode, category, or brand")
              : t("Search all products by name, SKU, barcode, category, or brand")}
        />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {selected && !query.trim() ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              {t("Selected")}: {selected.name} - {t("Bag available")}: {selected.availableQty}
              {selected.availableQty <= 0 ? (
                <div className="mt-1 text-xs font-normal text-amber-800">
                  {t("This product is not currently in the operator bag. Keep the quantity at 0 unless an owner/admin override exists.")}
                </div>
              ) : null}
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
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{product.name}</span>
                  <span className={`block truncate ${product.id === value ? "text-white/80" : "text-slate-500"}`}>
                    {product.sku ?? t("No SKU")} - {t("Bag available")}: {product.availableQty}
                  </span>
                  {product.sourceLabel ? (
                    <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${product.id === value ? "bg-white/15 text-white" : "bg-slate-200 text-slate-700"}`}>
                      {product.sourceLabel}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
          ))}
          {!filtered.length ? <p className="px-3 py-2 text-sm text-slate-500">{t("No products found")}</p> : null}
        </div>
      </div>
    </div>
  );
}
function QuantityInput({ value, max, onChange, availabilityLabel = "Bag available" }: { value: number; max: number; onChange: (quantity: number) => void; availabilityLabel?: string }) {
  const { t } = useLanguage();
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-800">{t("Quantity")}</span>
      <QuantityStepper value={value} max={max} onChange={onChange} inputLabel={t("Quantity")} />
      <span className="mt-1 block text-xs text-slate-500">{t(availabilityLabel)}: {max}</span>
    </label>
  );
}

function ReasonSelect({ value, onChange, options = reasonOptions }: { value: string; onChange: (reason: string) => void; options?: readonly string[] }) {
  const { t, locale } = useLanguage();
  const reasonValues = useMemo(() => Array.from(new Set([...(options ?? []), String(value ?? "").trim()].filter(Boolean))), [options, value]);
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-800">{t("Reason")}</span>
      <select value={value || ""} onChange={(event) => onChange(event.target.value)} className="field-input">
        <option value="">{t("Select reason")}</option>
        {reasonValues.map((reason) => <option key={reason} value={reason}>{localizedAdjustmentReasonLabel(reason, locale)}</option>)}
      </select>
    </label>
  );
}
function CashAndIssueSections({
  cashCollected,
  setCashCollected,
  cashBagId,
  setCashBagId,
  notes,
  setNotes,
  issueType,
  setIssueType,
  issuePriority,
  setIssuePriority,
  issueDescription,
  setIssueDescription,
}: {
  cashCollected: boolean;
  setCashCollected: (value: boolean) => void;
  cashBagId: string;
  setCashBagId: (value: string) => void;
  notes: string;
  setNotes: (value: string) => void;
  issueType: string;
  setIssueType: (value: string) => void;
  issuePriority: "critical" | "high" | "normal" | "low";
  setIssuePriority: (value: "critical" | "high" | "normal" | "low") => void;
  issueDescription: string;
  setIssueDescription: (value: string) => void;
}) {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  return (
    <>
      <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="mb-4 text-lg font-semibold">{tr("Cash Collection", "تحصيل النقد")}</h2>
        <div className="space-y-4">
          <div>
            <span className="mb-2 block text-sm font-medium text-slate-800">{t("Cash collected from machine")}</span>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setCashCollected(true)} className={cashCollected ? "btn-primary" : "btn-secondary"}>
                {tr("Yes", "نعم")}
              </button>
              <button type="button" onClick={() => setCashCollected(false)} className={!cashCollected ? "btn-primary" : "btn-secondary"}>
                {tr("No", "لا")}
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">{t("Operators only mark collection. Finance counts the envelope later")}</p>
          </div>
          <div className={cashCollected ? "rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" : "rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"}>
            {cashCollected
              ? tr("Cash is marked as collected. If you have an envelope or bag ID, enter it below so Finance can reconcile it faster.", "تم تحديد النقد كمحصّل. إذا كان لديك رقم ظرف أو كيس، أدخله أدناه لتسريع المطابقة المالية.")
              : tr("No cash collected at this stop. Leave the envelope field blank unless you are carrying a cash bag anyway", "لم يتم جمع نقد في هذا الموقع. اترك حقل الظرف فارغاً إلا إذا كنت تحمل كيس نقد.")}
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">{t("Cash bag / envelope ID")}</span>
            <input value={cashBagId} onChange={(event) => setCashBagId(event.target.value)} className="field-input" placeholder={t("Envelope ID optional")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">{tr("Stop notes", "ملاحظات الموقع")}</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} className="field-input" rows={3} placeholder={tr("Any notes about this stop?", "أي ملاحظات عن هذا الموقع؟")} />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="mb-4 text-lg font-semibold">{tr("Issue Report", "بلاغ عطل")}</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">{t("Issue type")}</span>
            <input value={issueType} onChange={(event) => setIssueType(event.target.value)} className="field-input" placeholder={tr("e.g. cash jam, display error, cooling issue", "مثل: انحشار النقد، عطل الشاشة، مشكلة تبريد")} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">{t("Priority")}</span>
            <select value={issuePriority} onChange={(event) => setIssuePriority(event.target.value as typeof issuePriority)} className="field-input">
              <option value="normal">{t("Normal")}</option>
              <option value="low">{t("Low")}</option>
              <option value="high">{t("High")}</option>
              <option value="critical">{t("Critical")}</option>
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-800">{t("Description")}</span>
            <textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} className="field-input" rows={3} placeholder={tr("Describe the problem only if there is an issue to report.", "صف المشكلة فقط إذا كان هناك عطل للإبلاغ عنه.")} />
          </label>
        </div>
      </section>
    </>
  );
}

function InventoryAdjustmentsSection({

  routeId,
  stopId,
  machineId,
  machineName,
  machineCode,
  machineProducts,
  allProducts,
  adjustments,
  onSaved,
}: {
  routeId: string;
  stopId: string;
  machineId: string;
  machineName: string;
  machineCode: string;
  machineProducts: ProductOption[];
  allProducts: ProductOption[];
  adjustments: InventoryAdjustmentRow[];
  onSaved: (adjustment: InventoryAdjustmentRow) => void;
}) {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const damagedAdjustments = adjustments.filter((adjustment) => adjustment.adjustmentType === "damaged");
  const returnedAdjustments = adjustments.filter((adjustment) => adjustment.adjustmentType === "returned_from_machine");
  const damagedQuantity = damagedAdjustments.reduce((sum, adjustment) => sum + Number(adjustment.quantity ?? 0), 0);
  const returnedQuantity = returnedAdjustments.reduce((sum, adjustment) => sum + Number(adjustment.quantity ?? 0), 0);
  const [activeAdjustmentType, setActiveAdjustmentType] = useState<InventoryAdjustmentType | null>(null);

  useEffect(() => {
    const openAdjustment = (event: Event) => {
      const requested = (event as CustomEvent<{ adjustmentType?: InventoryAdjustmentType }>).detail?.adjustmentType;
      setActiveAdjustmentType(requested === "returned_from_machine" ? "returned_from_machine" : "damaged");
    };
    window.addEventListener("snacky:open-inventory-adjustment", openAdjustment);
    return () => window.removeEventListener("snacky:open-inventory-adjustment", openAdjustment);
  }, []);

  return (
    <section id="inventory-adjustments" className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("Inventory adjustments")}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {tr("Record damaged products and products returned from this machine without leaving the stop screen.", "سجّل المنتجات التالفة والمنتجات الراجعة من هذا الجهاز دون مغادرة شاشة الموقع.")}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {t("Machine")}: <span className="font-medium text-slate-700">{machineName}</span> {machineCode ? `(${machineCode})` : ""}.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric label={t("Damaged units")} value={damagedQuantity} tone={damagedQuantity > 0 ? "warn" : "neutral"} />
        <Metric label={t("Returned units")} value={returnedQuantity} tone={returnedQuantity > 0 ? "neutral" : "neutral"} />
        <Metric label={t("Adjustment rows")} value={adjustments.length} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setActiveAdjustmentType("damaged")} className={activeAdjustmentType === "damaged" ? "btn-primary" : "btn-secondary"}>{tr("Damaged", "تالف")}</button>
        <button type="button" onClick={() => setActiveAdjustmentType("returned_from_machine")} className={activeAdjustmentType === "returned_from_machine" ? "btn-primary" : "btn-secondary"}>{tr("Return from machine", "إرجاع من الجهاز")}</button>
      </div>

      {activeAdjustmentType ? (
        <div className="mt-4">
          <InventoryAdjustmentForm
            key={activeAdjustmentType}
            adjustmentType={activeAdjustmentType}
            title={activeAdjustmentType === "damaged" ? tr("Add damaged product", "إضافة منتج تالف") : tr("Add returned product", "إضافة منتج راجع")}
            description={activeAdjustmentType === "damaged" ? tr("Record items that broke, expired, melted, or cannot be sold.", "سجّل المنتجات المكسورة أو المنتهية أو الذائبة أو غير القابلة للبيع.") : tr("Record products removed from the machine and brought back.", "سجّل المنتجات التي تمت إزالتها من الجهاز وإرجاعها.")}
            routeId={routeId}
            stopId={stopId}
            machineId={machineId}
            machineProducts={machineProducts}
            allProducts={allProducts}
            reasonOptions={activeAdjustmentType === "damaged" ? damagedReasonOptions : returnedReasonOptions}
            submitLabel={activeAdjustmentType === "damaged" ? t("Save damaged product") : t("Save returned product")}
            onSaved={(adjustment) => {
              onSaved(adjustment);
              setActiveAdjustmentType(null);
            }}
          />
        </div>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
          {tr("Choose Damaged or Return from machine. Then search and save only that product.", "اختر تالف أو إرجاع من الجهاز، ثم ابحث عن المنتج واحفظه مباشرة.")}
        </div>
      )}

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{tr("Recent adjustments", "آخر التعديلات")}</h3>
            <p className="text-sm text-slate-500">{tr("Saved adjustments for this stop appear here immediately.", "تظهر هنا فوراً التعديلات المحفوظة لهذا الموقع.")}</p>
          </div>
          <StatusBadge status={adjustments.length ? "confirmed" : "pending"} label={adjustments.length ? t("confirmed", "confirmed") : t("pending", "pending")} />
        </div>
        {adjustments.length ? (
          <div className="space-y-3">
            {adjustments.map((adjustment) => (
              <article key={adjustment.id} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={adjustment.adjustmentType} />
                      <span className="text-sm font-semibold text-slate-900">{adjustment.productName}</span>
                      <span className="text-sm text-slate-500">x{adjustment.quantity}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{localizedAdjustmentReasonLabel(adjustment.reason, locale)}</p>
                    {adjustment.notes ? <p className="mt-1 text-sm text-slate-500">{adjustment.notes}</p> : null}
                  </div>
                  <div className="text-xs text-slate-500">
                    {adjustment.createdAt ? new Date(adjustment.createdAt).toLocaleString(locale === "ar" ? "ar-LY" : "en-US") : t("Just now")}
                    {adjustment.photoUrl ? <div className="mt-1 font-medium text-emerald-700">{t("Photo attached")}</div> : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
            {t("No damaged or returned items have been recorded for this stop yet")}
          </p>
        )}
      </div>
    </section>
  );
}

function InventoryAdjustmentForm({
  adjustmentType,
  title,
  description,
  routeId,
  stopId,
  machineId,
  machineProducts,
  allProducts,
  reasonOptions,
  submitLabel,
  onSaved,
}: {
  adjustmentType: InventoryAdjustmentType;
  title: string;
  description: string;
  routeId: string;
  stopId: string;
  machineId: string;
  machineProducts: ProductOption[];
  allProducts: ProductOption[];
  reasonOptions: string[];
  submitLabel: string;
  onSaved: (adjustment: InventoryAdjustmentRow) => void;
}) {
  const { t, locale } = useLanguage();
  const tr = (en: string, ar: string) => t(en, locale === "ar" ? ar : en);
  const [sourceMode, setSourceMode] = useState<"machine" | "all">("machine");
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const defaultReason = defaultAdjustmentReason(adjustmentType, reasonOptions);
  const [reason, setReason] = useState(defaultReason);
  const [notes, setNotes] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [photoInputKey, setPhotoInputKey] = useState(() => newClientId());
  const operationStorageKey = `snacky:route-adjustment:${routeId}:${stopId}:${adjustmentType}`;
  const productChoices = sourceMode === "machine" ? machineProducts : allProducts;
  const selectedProduct = allProducts.find((product) => product.id === productId) ?? machineProducts.find((product) => product.id === productId) ?? null;
  const selectedReason = reasonOptions.includes(reason) ? reason : defaultReason;


  async function handleSave() {
    if (!productId) {
      setError(tr("Choose a product first.", "اختر منتجاً أولاً."));
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError(tr("Quantity must be greater than 0.", "يجب أن تكون الكمية أكبر من 0."));
      return;
    }
    if (!selectedReason) {
      setError(tr("Choose a reason.", "اختر السبب."));
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const immutableRequest = {
        adjustmentType,
        productId,
        machineId,
        quantity,
        reason: selectedReason,
        notes: notes.trim() || null,
        photo: photoFile
          ? {
              name: photoFile.name,
              size: photoFile.size,
              type: photoFile.type,
              lastModified: photoFile.lastModified,
            }
          : null,
      };
      const clientSubmissionId = claimDurableClientOperation(operationStorageKey, immutableRequest);
      let photoUrl: string | null = null;
      let photoSaved = false;
      if (photoFile) {
        const photoFormData = new FormData();
        photoFormData.append("routeId", routeId);
        photoFormData.append("stopId", stopId);
        photoFormData.append("machineId", machineId);
        photoFormData.append("adjustmentType", adjustmentType);
        photoFormData.append("clientSubmissionId", clientSubmissionId);
        photoFormData.append("photo", photoFile);
        const uploaded = await uploadInventoryAdjustmentPhoto(photoFormData);
        photoUrl = uploaded.photoUrl ?? null;
        photoSaved = !uploaded.uploadUnavailable && Boolean(photoUrl);
      }

      const response = await fetchWithTimeout(`/api/operator/routes/${routeId}/stops/${stopId}/adjustments`, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          adjustmentId: undefined,
          adjustmentType,
          productId,
          machineId,
          quantity,
          reason: selectedReason,
          notes: notes.trim(),
          photoUrl,
          clientSubmissionId,
        }),
      });
      const parsed = await readServerResponse(response, {
        operation: "operator_route_adjustment_save",
        route_id: routeId,
        route_stop_id: stopId,
        machine_id: machineId,
        adjustment_type: adjustmentType,
        client_submission_id: clientSubmissionId,
      });

      if (!response.ok || parsed.payload?.success === false || !parsed.payload) {
        throw new Error(responseMessage(parsed.payload) || tr("Could not save inventory adjustment.", "تعذر حفظ تعديل المخزون."));
      }

      const saved = parsed.payload.adjustment as Record<string, unknown> | undefined;
      if (!saved) {
        throw new Error(tr("The adjustment was saved, but no row was returned.", "تم حفظ التعديل، لكن لم يتم إرجاع السجل.") );
      }

      const savedAdjustment: InventoryAdjustmentRow = {
        id: String(saved.id ?? clientSubmissionId),
        adjustmentType: String(saved.adjustment_type ?? adjustmentType),
        productId: saved.product_id ? String(saved.product_id) : productId,
        productName: saved.product_name ? String(saved.product_name) : (selectedProduct?.name ?? "Unknown product"),
        quantity: Number(saved.quantity ?? quantity),
        reason: saved.reason ? String(saved.reason) : selectedReason,
        notes: saved.notes ? String(saved.notes) : notes.trim(),
        photoUrl: typeof saved.photo_url === "string" ? saved.photo_url : photoUrl,
        status: saved.status ? String(saved.status) : "confirmed",
        createdAt: typeof saved.created_at === "string" ? saved.created_at : new Date().toISOString(),
      };

      onSaved(savedAdjustment);
      completeDurableClientOperation(operationStorageKey, clientSubmissionId);
      setProductId("");
      setQuantity(1);
      setReason(defaultReason);
      setNotes("");
      setPhotoFile(null);
      setPhotoInputKey(newClientId());
      setSuccess(
        adjustmentType === "damaged"
          ? photoSaved
            ? tr("Damaged product saved with a photo.", "تم حفظ المنتج التالف مع صورة.")
            : tr("Damaged product saved.", "تم حفظ المنتج التالف.")
          : photoSaved
            ? tr("Returned product saved with a photo.", "تم حفظ المنتج الراجع مع صورة.")
            : tr("Returned product saved.", "تم حفظ المنتج الراجع."),
      );
    } catch (err) {
      setError(adjustmentSubmitErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="space-y-2">
        <h3 className="text-base font-semibold text-slate-900">{title}</h3>
        <p className="text-sm leading-6 text-slate-500">{description}</p>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setSourceMode("machine")}
          className={sourceMode === "machine" ? "btn-primary" : "btn-secondary"}
        >{tr("Machine products", "منتجات الجهاز")}</button>
        <button
          type="button"
          onClick={() => setSourceMode("all")}
          className={sourceMode === "all" ? "btn-primary" : "btn-secondary"}
        >{tr("Search all products", "البحث في كل المنتجات")}</button>
      </div>

      <div className="mt-4">
        <div className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-800">
          {sourceMode === "machine"
            ? tr("Showing products already linked to this machine first.", "يتم عرض المنتجات المرتبطة بهذا الجهاز أولاً.")
            : tr("Search the full product catalog if the item is not in this machine list.", "ابحث في كل المنتجات إذا لم يكن المنتج موجوداً ضمن قائمة هذا الجهاز.")}
        </div>
      </div>

      <div className="mt-4 space-y-4">
        <ProductPicker
          key={`${adjustmentType}-${sourceMode}`}
          products={productChoices}
          value={productId}
          onChange={setProductId}
          label={sourceMode === "machine" ? tr("Machine products", "منتجات الجهاز") : tr("Search all products", "البحث في كل المنتجات")}
        />

        <div className="grid gap-4 md:grid-cols-[160px_1fr]">
          <QuantityInput value={quantity} max={999} onChange={setQuantity} />
          <ReasonSelect value={selectedReason} onChange={setReason} options={reasonOptions} />
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">{t("Notes")}</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            className="field-input"
            rows={3}
            placeholder={tr("Optional context about this adjustment", "ملاحظات اختيارية عن هذا التعديل")}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">{t("Photo")}</span>
          <input
            key={photoInputKey}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)}
            className="field-input"
          />
          <span className="mt-1 block text-xs text-slate-500">{tr("Optional. Use a photo if the item is damaged or the return needs proof.", "اختياري. أرفق صورة إذا كان المنتج تالفاً أو كان الإرجاع يحتاج إثباتاً.")}</span>
        </label>

        {selectedProduct ? (
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            {tr("Selected", "المحدد")}: <span className="font-medium text-slate-900">{selectedProduct.name}</span>
            {selectedProduct.sku ? <span className="text-slate-500"> - {selectedProduct.sku}</span> : null}
          </div>
        ) : null}

        {error ? <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-800">{t(error, error)}</div> : null}
        {success ? <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-900">{t(success, success)}</div> : null}

        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? `${t("Saving")}...` : submitLabel}
        </button>
      </div>
    </article>
  );
}
