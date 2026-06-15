"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DraftRestoreBanner, DraftSaveStatus, useDraftKey, useLocalDraft } from "@/components/LocalDraft";
import { ProductThumbnail } from "@/components/ProductThumbnail";
import { QuantityStepper } from "@/components/QuantityStepper";
import { EmptyState, ErrorState, LoadingState, PageHeader, SecondaryButton } from "@/components/ui";
import { markStopInProgress, uploadRefillProofPhoto } from "@/lib/operator-actions";
import { ROUTE_STOP_COMPLETED_STATUS, ROUTE_STOP_IN_PROGRESS_STATUS, ROUTE_STOP_PICKED_STATUS } from "@/lib/route-workflow";

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
  return serverMessage || "Could not complete this stop. Your refill draft is saved. Technical details are in the console.";
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
  const [missingReports, setMissingReports] = useState<MissingProductReport[]>([]);
  const [showCleaningChecklist, setShowCleaningChecklist] = useState(false);
  const [cleaningDone, setCleaningDone] = useState(false);
  const [finalPhotoName, setFinalPhotoName] = useState("");
  const [finalPhotoFile, setFinalPhotoFile] = useState<File | null>(null);
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
      setExtraProducts((draft.extraProducts ?? []).map((line) => ({ ...line, id: line.id || newClientId() })));
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
      proofReady: Boolean(finalPhotoFile || stopData.hasCompletionPhoto),
    };
  }, [extraProducts, filledQtys, finalPhotoFile, missingReports, stopData, unavailableProducts]);

  useEffect(() => {
    const fetchStopData = async () => {
      if (!routeId || !stopId) {
        setLoadError({
          title: "Stop link incomplete",
          body: "Route or stop id is missing. Go back to your route and open the stop again.",
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
          const details = process.env.NODE_ENV === "development" && data.details ? ` ${data.details}` : "";
          const debug = data.debug as StopDebugDetails | undefined;

          if (response.status === 403 || responseCode(data) === "UNAUTHORIZED") {
            setLoadError({ title: "Unauthorized", body: `${serverMessage}${details}`, debug });
            return;
          }

          if (responseCode(data) === "STOP_NOT_FOUND") {
            setLoadError({ title: "Stop unavailable", body: "This stop no longer exists.", debug });
            return;
          }

          setLoadError({
            title: responseCode(data) === "STOP_ROUTE_MISMATCH" ? "Stop route mismatch" : "Stop could not be loaded",
            body: `${serverMessage}${details}`,
            debug,
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
        const initialExtraProducts = (stopPayload.extraItems ?? []).map((item: ExtraProductLine) => ({ ...item, id: newClientId() }));
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

  const setAssignedQty = (item: StopRefillItem, quantity: number) => {
    const current = filledQtys[item.productId] ?? 0;
    const max = remainingBagQty(item.productId, current);
    setFilledQtys((prev) => ({ ...prev, [item.productId]: Math.max(0, Math.min(max, quantity)) }));
    if (quantity > max) setError("Actual filled quantity cannot exceed what is available in the operator bag.");
  };

  const addExtraProduct = () => {
    setExtraProducts((prev) => [...prev, { id: newClientId(), productId: "", quantity: 0, reason: "Customer demand", notes: "" }]);
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
    const canReuseCompletedProof = stopData.stopStatus === ROUTE_STOP_COMPLETED_STATUS && stopData.hasCompletionPhoto;
    if (!cleaningDone && stopData.stopStatus !== ROUTE_STOP_COMPLETED_STATUS) {
      setError("Please complete the cleaning checklist before finishing.");
      return;
    }
    if (!finalPhotoFile && !canReuseCompletedProof) {
      setError("Please take or upload the final machine photo before completing the stop.");
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
          quantity: filledQtys[item.productId] || 0,
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
      const stopSuccessMessage = stopData.stopStatus === ROUTE_STOP_COMPLETED_STATUS
        ? "Stop changes saved successfully."
        : "Stop completed successfully.";
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
            title={loadError?.title ?? "Stop could not be loaded"}
            body={loadError?.body ?? "Failed to load machine stop details."}
            action={<SecondaryButton href={routeHref}>Back to route</SecondaryButton>}
          />
          {loadError?.debug ? <DebugDetails debug={loadError.debug} /> : null}
        </div>
      </>
    );
  }

  const isEditingCompletedStop = stopData.stopStatus === ROUTE_STOP_COMPLETED_STATUS;
  const canSubmitStop = !submitting && (cleaningDone || isEditingCompletedStop);

  return (
    <>
      <div className="max-w-5xl space-y-6">
        <PageHeader
          title={stopData.machineName}
          subtitle={`${stopData.machineCode} - ${stopData.location}`}
          action={<SecondaryButton href={routeHref}>Back</SecondaryButton>}
        />

        <DraftRestoreBanner pendingDraft={localDraft.pendingDraft} onRestore={localDraft.restoreDraft} onDiscard={localDraft.discardDraft} />
        {!localDraft.pendingDraft ? <DraftSaveStatus status={localDraft.status} /> : null}
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            <p>{error}</p>
            <button type="button" onClick={() => void refreshMobileApp()} className="mt-3 rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700">
              Refresh App
            </button>
          </div>
        )}

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <Metric label="Assigned units" value={stopExecutionSummary.assignedUnits} />
          <Metric label="Filled now" value={stopExecutionSummary.filledUnits} />
          <Metric label="Shortage to explain" value={stopExecutionSummary.shortageUnits} tone={stopExecutionSummary.shortageUnits > 0 ? "warn" : "neutral"} />
          <Metric label="Extra units added" value={stopExecutionSummary.extraUnits} />
          <Metric label="Proof photo" value={stopExecutionSummary.proofReady ? "Ready" : "Needed"} tone={stopExecutionSummary.proofReady ? "neutral" : "warn"} />
        </section>

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          Record what you actually filled, then finish the stop. Leftovers are handled later on the route leftovers screen, so you do not need to invent fake leftover numbers here.
        </div>

        <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 bg-slate-50 p-4 md:p-6">
            <h2 className="text-lg font-semibold">Assigned products</h2>
            <p className="mt-1 text-sm text-slate-500">Record actual quantities. Differences from the plan are tracked for review.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Metric label="Unavailable lines" value={stopExecutionSummary.unavailableCount} tone={stopExecutionSummary.unavailableCount > 0 ? "warn" : "neutral"} />
              <Metric label="Missing product reports" value={stopExecutionSummary.missingReportCount} tone={stopExecutionSummary.missingReportCount > 0 ? "warn" : "neutral"} />
              <Metric label="Cash status" value={cashCollected ? "Collected" : "No cash"} />
              <Metric label="Refill result" value={fillStatusPreview === "full" ? "Full refill" : "Partial refill"} tone={fillStatusPreview === "full" ? "neutral" : "warn"} />
            </div>
          </div>

          {stopData.refillItems.length === 0 ? (
            <div className="p-4 md:p-6">
              <EmptyState title="No refill items assigned to this stop." body="You can still add extra products, collect cash, report issues, and complete the stop." />
            </div>
          ) : (
            <div className="divide-y divide-slate-200">
              {stopData.refillItems.map((item) => {
                const assignedQty = Number(item.assignedQty ?? item.parQty ?? 0);
                const actualQty = filledQtys[item.productId] || 0;
                const difference = actualQty - assignedQty;
                const maxQty = remainingBagQty(item.productId, actualQty);
                return (
                  <div key={`${item.refillOrderLineId ?? item.productId}-${item.slotCode}`} className="space-y-4 p-4 md:p-6">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      <div className="min-w-0 sm:col-span-2 lg:col-span-2">
                        <p className="text-xs text-slate-500">Product</p>
                        <p className="break-words font-semibold text-slate-900">{item.productName}</p>
                        <p className="text-sm text-slate-500">Slot {item.slotCode}</p>
                      </div>
                      <Metric label="Assigned" value={assignedQty} />
                      <Metric label="Bag available" value={item.availableQty ?? 0} />
                      <Metric label="Difference" value={difference > 0 ? `+${difference}` : difference} tone={difference === 0 ? "neutral" : "warn"} />
                    </div>
                    <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">Actual filled qty</span>
                        <QuantityStepper
                          value={actualQty}
                          max={maxQty}
                          onChange={(quantity) => setAssignedQty(item, quantity)}
                          disabled={unavailableProducts[item.productId]}
                          inputLabel={`${item.productName} actual filled quantity`}
                        />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium text-slate-800">Notes for change</span>
                        <input
                          value={lineNotes[item.productId] ?? ""}
                          onChange={(event) => setLineNotes((prev) => ({ ...prev, [item.productId]: event.target.value }))}
                          className="field-input"
                          placeholder="Explain shortage, overfill, or condition"
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
                      Mark assigned product as unavailable
                    </label>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Products added at machine</h2>
              <p className="mt-1 text-sm text-slate-500">Add unplanned products from the operator bag. These lines are saved when you complete the stop.</p>
            </div>
            <div className="grid gap-2 sm:flex sm:flex-wrap">
              <button type="button" onClick={addExtraProduct} className="btn-secondary w-full sm:w-auto">Add product</button>
              <button type="button" onClick={addMissingReport} className="btn-secondary w-full sm:w-auto">Report missing</button>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {extraProducts.map((line) => {
              const selected = productById.get(line.productId);
              const maxQty = line.productId ? remainingBagQty(line.productId, line.quantity) : 0;
              return (
                <div key={line.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="grid gap-3 md:grid-cols-[1fr_160px_1fr]">
                    <ProductPicker products={stopData.productOptions} value={line.productId} onChange={(productId) => updateExtra(line.id, { productId, quantity: 0 })} label="Extra product" />
                    <QuantityInput value={line.quantity} max={maxQty} onChange={(quantity) => updateExtra(line.id, { quantity })} />
                    <ReasonSelect value={line.reason} onChange={(reason) => updateExtra(line.id, { reason })} />
                  </div>
                  <input value={line.notes} onChange={(event) => updateExtra(line.id, { notes: event.target.value })} className="field-input mt-3" placeholder={`Notes${selected ? ` for ${selected.name}` : ""}`} />
                  <button type="button" onClick={() => setExtraProducts((prev) => prev.filter((item) => item.id !== line.id))} className="mt-2 text-sm font-medium text-rose-700">Remove</button>
                </div>
              );
            })}

            {missingReports.map((line) => (
              <div key={line.id} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-slate-800">Missing product name</span>
                    <input value={line.productName} onChange={(event) => updateMissingReport(line.id, { productName: event.target.value })} className="field-input" placeholder="Type product name from machine" />
                  </label>
                  <ReasonSelect value={line.reason} onChange={(reason) => updateMissingReport(line.id, { reason })} />
                </div>
                <input value={line.notes} onChange={(event) => updateMissingReport(line.id, { notes: event.target.value })} className="field-input mt-3" placeholder="Notes" />
                <button type="button" onClick={() => setMissingReports((prev) => prev.filter((item) => item.id !== line.id))} className="mt-2 text-sm font-medium text-rose-700">Remove</button>
              </div>
            ))}

            {!extraProducts.length && !missingReports.length ? (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No extra products or missing product reports added.</p>
            ) : null}
          </div>
        </section>

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

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Refill proof</h2>
              <p className="mt-1 text-sm text-slate-500">Take the photo after filling the machine and cleaning the glass.</p>
            </div>
            <div className={fillStatusPreview === "full" ? "rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-semibold text-green-800" : "rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800"}>
              {fillStatusPreview === "full" ? "Full refill" : "Partial refill"}
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
              {finalPhotoFile ? <p className="mt-2 text-sm text-slate-600">Selected: {finalPhotoFile.name}</p> : null}
              {!finalPhotoFile && stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-slate-600">A completion photo is already saved for this stop. Add a new photo only if you want to replace it.</p> : null}
              {!finalPhotoFile && !stopData.hasCompletionPhoto ? <p className="mt-2 text-sm text-amber-700">Final photo is required before completion.</p> : null}
            </div>
            <div className={stopExecutionSummary.proofReady ? "rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" : "rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"}>
              <div className="text-xs font-semibold uppercase tracking-wide">{stopExecutionSummary.proofReady ? "Photo ready" : "Photo still needed"}</div>
              <div className="mt-2 font-semibold">
                {finalPhotoFile ? "New proof photo will upload with this save." : stopData.hasCompletionPhoto ? "Existing proof photo is already attached." : "Take a completion photo before finishing this stop."}
              </div>
              <div className="mt-2 text-xs">
                Completion photos stay visible later from the route details page.
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-4 text-lg font-semibold">Cleaning and final check</h2>
          <button type="button" onClick={() => setShowCleaningChecklist(!showCleaningChecklist)} className="w-full rounded-lg border border-slate-200 bg-slate-50 p-4 text-left transition hover:bg-slate-100">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-900">Checklist</span>
              <span className={cleaningDone ? "font-semibold text-green-600" : "text-slate-600"}>{cleaningDone ? "Completed" : "Open"}</span>
            </div>
          </button>
          {showCleaningChecklist && (
            <div className="mt-4 space-y-3 border-t border-slate-200 pt-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={cleaningDone} onChange={(event) => setCleaningDone(event.target.checked)} className="mt-1" />
                <div>
                  <p className="font-medium text-slate-900">I have completed all checks:</p>
                  <ul className="mt-2 ml-2 list-disc space-y-1 text-sm text-slate-600">
                    <li>Machine exterior is clean</li>
                    <li>Display screen is working</li>
                    <li>All items are stocked correctly</li>
                    <li>No damaged or expired items visible</li>
                    <li>Machine is operating properly</li>
                  </ul>
                </div>
              </label>
            </div>
          )}
        </section>

        <div className="sticky bottom-3 z-10 -mx-3 flex flex-col gap-2 border-t border-slate-200 bg-slate-100/95 px-3 py-3 backdrop-blur sm:mx-0 sm:flex-row sm:border-0 sm:bg-transparent sm:p-0">
          <button onClick={handleCompleteStop} disabled={!canSubmitStop} className="btn-primary w-full flex-1 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? "Saving..." : isEditingCompletedStop ? "Save Stop Changes" : "Complete Stop"}
          </button>
          <SecondaryButton href={routeHref} type="button">Cancel</SecondaryButton>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          <strong>Reminder:</strong> This page is for physical execution at the machine: actual filled quantities, shortage reasons, cash, issues, and the final photo after cleaning. Leftovers are returned later from the dedicated leftovers screen.
        </div>

        {stopData.debug ? <DebugDetails debug={stopData.debug} /> : null}
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

function ProductPicker({ products, value, onChange, label = "Existing product" }: { products: ProductOption[]; value: string; onChange: (productId: string) => void; label?: string }) {
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.id === value);
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
          placeholder={selected ? `${selected.name} - ${selected.sku ?? "No SKU"}` : "Search name, SKU, barcode, category, or brand"}
        />
        <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
          {selected && !query.trim() ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
              Selected: {selected.name} - Bag {selected.availableQty}
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
                <span className={`block truncate ${product.id === value ? "text-white/80" : "text-slate-500"}`}>{product.sku ?? "No SKU"} - Bag {product.availableQty}</span>
              </span>
            </span>
          </button>
        ))}
          {!filtered.length ? <p className="px-3 py-2 text-sm text-slate-500">No products found.</p> : null}
        </div>
      </div>
    </div>
  );
}

function QuantityInput({ value, max, onChange }: { value: number; max: number; onChange: (quantity: number) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-800">Quantity</span>
      <QuantityStepper value={value} max={max} onChange={onChange} inputLabel="Quantity" />
      <span className="mt-1 block text-xs text-slate-500">Bag available: {max}</span>
    </label>
  );
}

function ReasonSelect({ value, onChange }: { value: string; onChange: (reason: string) => void }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-800">Reason</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="field-input">
        {reasonOptions.map((reason) => <option key={reason} value={reason}>{reason}</option>)}
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
  return (
    <>
      <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="mb-4 text-lg font-semibold">Cash Collection</h2>
        <div className="space-y-4">
          <div>
            <span className="mb-2 block text-sm font-medium text-slate-800">Cash collected from machine</span>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setCashCollected(true)} className={cashCollected ? "btn-primary" : "btn-secondary"}>
                Yes
              </button>
              <button type="button" onClick={() => setCashCollected(false)} className={!cashCollected ? "btn-primary" : "btn-secondary"}>
                No
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-500">Operators only mark collection. Finance counts the envelope later.</p>
          </div>
          <div className={cashCollected ? "rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" : "rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700"}>
            {cashCollected
              ? "Cash is marked as collected. If you have an envelope or bag ID, enter it below so Finance can reconcile it faster."
              : "No cash collected at this stop. Leave the envelope field blank unless you are carrying a cash bag anyway."}
          </div>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Cash bag / envelope ID</span>
            <input value={cashBagId} onChange={(event) => setCashBagId(event.target.value)} className="field-input" placeholder="Envelope ID optional" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Stop notes</span>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} className="field-input" rows={3} placeholder="Any notes about this stop?" />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
        <h2 className="mb-4 text-lg font-semibold">Issue Report</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Issue type</span>
            <input value={issueType} onChange={(event) => setIssueType(event.target.value)} className="field-input" placeholder="e.g. cash jam, display error, cooling issue" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-800">Priority</span>
            <select value={issuePriority} onChange={(event) => setIssuePriority(event.target.value as typeof issuePriority)} className="field-input">
              <option value="normal">Normal</option>
              <option value="low">Low</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="mb-1 block text-sm font-medium text-slate-800">Description</span>
            <textarea value={issueDescription} onChange={(event) => setIssueDescription(event.target.value)} className="field-input" rows={3} placeholder="Describe the problem only if there is an issue to report." />
          </label>
        </div>
      </section>
    </>
  );
}

function DebugDetails({ debug }: { debug: StopDebugDetails }) {
  if (process.env.NODE_ENV !== "development") return null;

  const rows = [
    ["auth user id", debug.authUserId],
    ["matched team_member id", debug.matchedTeamMemberId],
    ["route id", debug.routeId],
    ["stop id", debug.stopId],
    ["route.operator_id", debug.routeOperatorId],
    ["route_stop.route_id", debug.routeStopRouteId],
  ];

  return (
    <section className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Development debug</h2>
      <dl className="grid gap-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium text-slate-700">{label}</dt>
            <dd className="break-all font-mono">{value ?? "none"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
