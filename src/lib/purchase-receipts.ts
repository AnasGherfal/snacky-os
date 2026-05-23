import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { privateStorageObjectUrl, RECEIPT_IMAGE_BUCKET } from "@/lib/storage-buckets";

export const RECEIPT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
export const RECEIPT_MAX_SIZE = 5 * 1024 * 1024;

type PurchaseReceiptUploadError = "invalid_file" | "storage_unavailable";

type PurchaseReceiptUploadResult = {
  receiptUrl: string | null;
  receiptFileName: string | null;
  receiptContentType: string | null;
  receiptStoragePath: string | null;
  uploadUnavailable: boolean;
  uploadError?: PurchaseReceiptUploadError;
};

async function ensureReceiptBucket(supabase: SupabaseClient) {
  const config = {
    public: false,
    fileSizeLimit: "5MB",
    allowedMimeTypes: RECEIPT_MIME_TYPES,
  };

  const { error: getError } = await supabase.storage.getBucket(RECEIPT_IMAGE_BUCKET);
  if (!getError) {
    const { error: updateError } = await supabase.storage.updateBucket(RECEIPT_IMAGE_BUCKET, config);
    if (updateError) console.warn("[purchases] Could not update receipt bucket settings", updateError);
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(RECEIPT_IMAGE_BUCKET, config);
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw createError;
  }
}

export async function resolvePurchaseReceiptUrl(supabase: SupabaseClient, fd: FormData): Promise<PurchaseReceiptUploadResult> {
  const manualUrl = String(fd.get("receipt_url") || "").trim();
  const file = fd.get("receipt_file");

  if (!(file instanceof File) || file.size === 0) {
    return { receiptUrl: manualUrl || null, receiptFileName: null, receiptContentType: null, receiptStoragePath: null, uploadUnavailable: false };
  }

  if (!RECEIPT_MIME_TYPES.includes(file.type) || file.size > RECEIPT_MAX_SIZE) {
    return { receiptUrl: manualUrl || null, receiptFileName: null, receiptContentType: null, receiptStoragePath: null, uploadUnavailable: false, uploadError: "invalid_file" };
  }

  try {
    const storageClient = getSupabaseAdminClient() ?? supabase;
    await ensureReceiptBucket(storageClient);

    const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const receiptNumber = String(fd.get("receipt_number") || "receipt").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-") || "receipt";
    const path = `${receiptNumber}-${Date.now()}.${extension}`;
    const { error } = await storageClient.storage.from(RECEIPT_IMAGE_BUCKET).upload(path, file, {
      cacheControl: "31536000",
      upsert: true,
    });

    if (error) throw error;

    return {
      receiptUrl: privateStorageObjectUrl(RECEIPT_IMAGE_BUCKET, path),
      receiptFileName: file.name || null,
      receiptContentType: file.type || null,
      receiptStoragePath: path,
      uploadUnavailable: false,
    };
  } catch (error) {
    console.warn("[purchases] Receipt upload unavailable", error);
    return { receiptUrl: manualUrl || null, receiptFileName: null, receiptContentType: null, receiptStoragePath: null, uploadUnavailable: true, uploadError: "storage_unavailable" };
  }
}
