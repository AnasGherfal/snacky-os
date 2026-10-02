import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { CASH_EVIDENCE_BUCKET, privateStorageObjectUrl } from "@/lib/storage-buckets";

const CASH_EVIDENCE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const CASH_EVIDENCE_MAX_SIZE = 10 * 1024 * 1024;

function safeSegment(value: string, fallback: string) {
  const clean = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || fallback;
}

async function ensureCashEvidenceBucket() {
  const storage = getSupabaseAdminClient();
  if (!storage) throw new Error("Secure cash evidence storage is not configured.");

  const config = {
    public: false,
    fileSizeLimit: "10MB",
    allowedMimeTypes: CASH_EVIDENCE_MIME_TYPES,
  };
  const { error: readError } = await storage.storage.getBucket(CASH_EVIDENCE_BUCKET);
  if (!readError) {
    const { error: updateError } = await storage.storage.updateBucket(CASH_EVIDENCE_BUCKET, config);
    if (updateError) throw updateError;
    return storage;
  }

  const { error: createError } = await storage.storage.createBucket(CASH_EVIDENCE_BUCKET, config);
  if (createError && !createError.message.toLowerCase().includes("already exists")) throw createError;
  return storage;
}

export type CashEvidenceUpload = {
  path: string;
  fileName: string;
  contentType: string;
  url: string;
};

export async function uploadCashEvidence(
  fileValue: FormDataEntryValue | null,
  options: { scopeId: string; stage: "removed" | "stored" | "counted"; required?: boolean },
): Promise<CashEvidenceUpload | null> {
  const required = options.required ?? false;
  if (!(fileValue instanceof File) || fileValue.size === 0) {
    if (required) throw new Error("Required cash evidence photo or receipt is missing.");
    return null;
  }
  if (!CASH_EVIDENCE_MIME_TYPES.includes(fileValue.type) || fileValue.size > CASH_EVIDENCE_MAX_SIZE) {
    throw new Error("Cash evidence must be PNG, JPG, WEBP, or PDF and under 10MB.");
  }

  const storage = await ensureCashEvidenceBucket();
  const originalName = fileValue.name || `${options.stage}-evidence`;
  const extension = safeSegment(originalName.split(".").pop() || (fileValue.type === "application/pdf" ? "pdf" : "jpg"), "jpg");
  const objectName = `${options.stage}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
  const objectPath = `${safeSegment(options.scopeId, "cash")}/${objectName}`;
  const { error } = await storage.storage.from(CASH_EVIDENCE_BUCKET).upload(objectPath, fileValue, {
    cacheControl: "31536000",
    contentType: fileValue.type,
    upsert: false,
  });
  if (error) throw error;

  return {
    path: objectPath,
    fileName: originalName,
    contentType: fileValue.type,
    url: privateStorageObjectUrl(CASH_EVIDENCE_BUCKET, objectPath) ?? "",
  };
}

export async function removeCashEvidence(upload: CashEvidenceUpload | null) {
  if (!upload?.path) return;
  const storage = getSupabaseAdminClient();
  if (!storage) return;
  const { error } = await storage.storage.from(CASH_EVIDENCE_BUCKET).remove([upload.path]);
  if (error) console.error("[cash-evidence] Failed to remove unused evidence", error);
}
