export const PRODUCT_IMAGE_BUCKET = "product-images";
export const RECEIPT_IMAGE_BUCKET = "receipt-images";
export const MACHINE_PHOTO_BUCKET = "machine-photos";
export const REFILL_PHOTO_BUCKET = "refill-photos";
export const ISSUE_PHOTO_BUCKET = "issue-photos";
export const VMS_IMPORT_BUCKET = "vms-imports";

export const PRIVATE_STORAGE_BUCKETS = new Set([
  RECEIPT_IMAGE_BUCKET,
  MACHINE_PHOTO_BUCKET,
  REFILL_PHOTO_BUCKET,
  ISSUE_PHOTO_BUCKET,
  VMS_IMPORT_BUCKET,
]);

export function privateStorageObjectUrl(bucket: string, objectPath: string | null | undefined) {
  const cleanPath = String(objectPath ?? "").trim().replace(/^\/+/, "");
  if (!bucket || !cleanPath) return null;

  const encodedPath = cleanPath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");

  return encodedPath ? `/api/storage/${encodeURIComponent(bucket)}/${encodedPath}` : null;
}
