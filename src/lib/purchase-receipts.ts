import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase-server";

const PURCHASE_RECEIPT_BUCKET = "purchase-receipts";
const RECEIPT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "application/pdf"];
const RECEIPT_MAX_SIZE = 5 * 1024 * 1024;

async function ensureReceiptBucket(supabase: SupabaseClient) {
  const config = {
    public: true,
    fileSizeLimit: "5MB",
    allowedMimeTypes: RECEIPT_MIME_TYPES,
  };

  const { error: getError } = await supabase.storage.getBucket(PURCHASE_RECEIPT_BUCKET);
  if (!getError) {
    const { error: updateError } = await supabase.storage.updateBucket(PURCHASE_RECEIPT_BUCKET, config);
    if (updateError) console.warn("[purchases] Could not update receipt bucket settings", updateError);
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(PURCHASE_RECEIPT_BUCKET, config);
  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw createError;
  }
}

export async function resolvePurchaseReceiptUrl(supabase: SupabaseClient, fd: FormData) {
  const manualUrl = String(fd.get("receipt_url") || "").trim();
  const file = fd.get("receipt_file");

  if (!(file instanceof File) || file.size === 0) {
    return { receiptUrl: manualUrl || null, uploadUnavailable: false };
  }

  if (!RECEIPT_MIME_TYPES.includes(file.type) || file.size > RECEIPT_MAX_SIZE) {
    return { receiptUrl: manualUrl || null, uploadUnavailable: true };
  }

  try {
    const storageClient = getSupabaseAdminClient() ?? supabase;
    await ensureReceiptBucket(storageClient);

    const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const receiptNumber = String(fd.get("receipt_number") || "receipt").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-") || "receipt";
    const path = `${receiptNumber}-${Date.now()}.${extension}`;
    const { error } = await storageClient.storage.from(PURCHASE_RECEIPT_BUCKET).upload(path, file, {
      cacheControl: "31536000",
      upsert: true,
    });

    if (error) throw error;

    const { data } = storageClient.storage.from(PURCHASE_RECEIPT_BUCKET).getPublicUrl(path);
    return { receiptUrl: data.publicUrl || manualUrl || null, uploadUnavailable: false };
  } catch (error) {
    console.warn("[purchases] Receipt upload unavailable", error);
    return { receiptUrl: manualUrl || null, uploadUnavailable: true };
  }
}
