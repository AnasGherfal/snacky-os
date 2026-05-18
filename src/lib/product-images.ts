import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase-server";
import { PRODUCT_IMAGE_BUCKET } from "@/lib/storage-buckets";

const PRODUCT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const PRODUCT_IMAGE_MAX_SIZE = 5 * 1024 * 1024;

async function ensureProductImageBucket(supabase: SupabaseClient) {
  const { error: getError } = await supabase.storage.getBucket(PRODUCT_IMAGE_BUCKET);
  if (!getError) {
    const { error: updateError } = await supabase.storage.updateBucket(PRODUCT_IMAGE_BUCKET, {
      public: true,
      fileSizeLimit: "5MB",
      allowedMimeTypes: PRODUCT_IMAGE_MIME_TYPES,
    });

    if (updateError) {
      console.warn("[products] Could not update product image bucket settings", updateError);
    }
    return;
  }

  const { error: createError } = await supabase.storage.createBucket(PRODUCT_IMAGE_BUCKET, {
    public: true,
    fileSizeLimit: "5MB",
    allowedMimeTypes: PRODUCT_IMAGE_MIME_TYPES,
  });

  if (createError && !createError.message.toLowerCase().includes("already exists")) {
    throw createError;
  }
}

export async function resolveProductImageUrl(supabase: SupabaseClient, fd: FormData) {
  const manualUrl = String(fd.get("image_url") || "").trim();
  const file = fd.get("image_file");

  if (!(file instanceof File) || file.size === 0) {
    return { imageUrl: manualUrl || null, uploadUnavailable: false };
  }

  if (!PRODUCT_IMAGE_MIME_TYPES.includes(file.type) || file.size > PRODUCT_IMAGE_MAX_SIZE) {
    return { imageUrl: manualUrl || null, uploadUnavailable: true };
  }

  try {
    const storageClient = getSupabaseAdminClient() ?? supabase;
    await ensureProductImageBucket(storageClient);

    const extension = file.name.split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const safeSku = String(fd.get("sku") || "product").trim().toLowerCase().replace(/[^a-z0-9-]/g, "-") || "product";
    const path = `${safeSku}-${Date.now()}.${extension}`;
    const { error } = await storageClient.storage.from(PRODUCT_IMAGE_BUCKET).upload(path, file, {
      cacheControl: "3600",
      upsert: true,
    });

    if (error) throw error;

    const { data } = storageClient.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path);
    return { imageUrl: data.publicUrl || manualUrl || null, uploadUnavailable: false };
  } catch (error) {
    console.warn("[products] Image upload unavailable", error);
    return { imageUrl: manualUrl || null, uploadUnavailable: true };
  }
}
