import { createHash } from "node:crypto";

/** Versioned private archive. This module has NO source-deletion capability. */
export const ARCHIVE_MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_RECEIPT_BYTES = 16 * 1024;
export const ARCHIVE_MIN_AGE_DAYS = 30;
const shaPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/avif", "image/heic", "image/heif"]);

export class PhotoArchiveError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "PhotoArchiveError"; this.code = code; }
}
export type ArchiveObject = { projectRef: string; bucket: "refill-photos"; path: string };
export type ReviewedArchivePhoto = ArchiveObject & { bytes: number; sourceUpdatedAt: string; reviewed: true };
export type PhotoArchiveReceipt = ArchiveObject & {
  version: 1;
  state: "copy_verified_source_retained";
  bytes: number;
  sha256: string;
  contentType: string;
  contentKey: string;
  sourceEtag: string;
  sourceUpdatedAt: string;
  verifiedAt: string;
  manifestSha256: string;
};
export type PrivateArchiveStore = {
  get: (key: string, maxBytes: number) => Promise<Uint8Array | null>;
  /** Atomic create only. False means an object already exists; never overwrite it. */
  putIfAbsent: (key: string, bytes: Uint8Array, contentType: string) => Promise<boolean>;
};

export function photoSha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function validateArchiveObject(value: ArchiveObject): ArchiveObject {
  if (!/^[a-z0-9]{20}$/.test(value.projectRef) || value.bucket !== "refill-photos"
      || typeof value.path !== "string" || value.path.length > 1024
      || /[\\\u0000-\u001f\u007f%?#]/.test(value.path)) throw new PhotoArchiveError("archive_path_invalid");
  const parts = value.path.split("/");
  if (!uuidPattern.test(parts[0]) || parts.length < 2
      || parts.some(part => !part || part === "." || part === ".." || part.trim() !== part)) {
    throw new PhotoArchiveError("archive_path_invalid");
  }
  return value;
}
export function receiptKey(object: ArchiveObject): string {
  validateArchiveObject(object);
  return `snacky-photo-archive/v1/${object.projectRef}/${object.bucket}/receipts/${photoSha256(object.path)}.json`;
}
export function photoContentKey(object: ArchiveObject, sha256: string): string {
  validateArchiveObject(object);
  if (!shaPattern.test(sha256)) throw new PhotoArchiveError("archive_hash_invalid");
  return `snacky-photo-archive/v1/${object.projectRef}/${object.bucket}/objects/${sha256}`;
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}
export function validateReviewedPhoto(value: ReviewedArchivePhoto, now = new Date()): ReviewedArchivePhoto {
  validateArchiveObject(value);
  if (value.reviewed !== true || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > ARCHIVE_MAX_PHOTO_BYTES
      || !validDate(value.sourceUpdatedAt) || !Number.isFinite(now.getTime())
      || Date.parse(value.sourceUpdatedAt) > now.getTime() - ARCHIVE_MIN_AGE_DAYS * 86400000) {
    throw new PhotoArchiveError("archive_review_or_age_invalid");
  }
  return value;
}

export function decodeArchiveReceipt(bytes: Uint8Array, object: ArchiveObject): PhotoArchiveReceipt {
  validateArchiveObject(object);
  if (bytes.byteLength > ARCHIVE_MAX_RECEIPT_BYTES) throw new PhotoArchiveError("archive_receipt_invalid");
  let r: PhotoArchiveReceipt;
  try { r = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new PhotoArchiveError("archive_receipt_invalid"); }
  if (!r || r.version !== 1 || r.state !== "copy_verified_source_retained"
      || r.projectRef !== object.projectRef || r.bucket !== object.bucket || r.path !== object.path
      || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || r.bytes > ARCHIVE_MAX_PHOTO_BYTES
      || !shaPattern.test(r.sha256) || !shaPattern.test(r.manifestSha256)
      || !mimeTypes.has(r.contentType) || !validDate(r.sourceUpdatedAt) || !validDate(r.verifiedAt)
      || typeof r.sourceEtag !== "string" || !r.sourceEtag || r.sourceEtag.length > 256 || /[\r\n]/.test(r.sourceEtag)
      || r.contentKey !== photoContentKey(object, r.sha256)) throw new PhotoArchiveError("archive_receipt_invalid");
  return r;
}
/** Do not trust a supplied MIME type or serve active HTML/SVG from the app's origin. */
export function photoContentType(bytes: Uint8Array): string {
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) return "image/png";
  if (bytes.length >= 12 && text(0,4) === "RIFF" && text(8,12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && text(4,8) === "ftyp") {
    if (["avif", "avis"].includes(text(8,12))) return "image/avif";
    if (["heic", "heix", "hevc", "hevx"].includes(text(8,12))) return "image/heic";
    if (["mif1", "msf1"].includes(text(8,12))) return "image/heif";
  }
  throw new PhotoArchiveError("archive_photo_type_invalid");
}
export function verifyArchivedBytes(bytes: Uint8Array, receipt: PhotoArchiveReceipt): void {
  if (bytes.byteLength !== receipt.bytes || photoSha256(bytes) !== receipt.sha256
      || photoContentType(bytes) !== receipt.contentType) throw new PhotoArchiveError("archive_integrity_failed");
}
/** Caller must authorize the ORIGINAL bucket/path BEFORE calling this function. */
export async function readVerifiedArchivedPhoto(store: Pick<PrivateArchiveStore, "get">, object: ArchiveObject) {
  const raw = await store.get(receiptKey(object), ARCHIVE_MAX_RECEIPT_BYTES);
  if (raw === null) return null;
  const receipt = decodeArchiveReceipt(raw, object);
  const bytes = await store.get(receipt.contentKey, receipt.bytes);
  if (bytes === null) throw new PhotoArchiveError("archive_content_missing");
  verifyArchivedBytes(bytes, receipt);
  return { bytes, receipt };
}
/** Supabase may use a legacy 400 for missing objects. Never treat permission/network errors as missing. */
export function isMissingStorageObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: string; status?: number; statusCode?: string | number; message?: string };
  const status = Number(e.statusCode ?? e.status);
  if (status !== 400 && status !== 404) return false;
  return e.code === "NoSuchKey" || e.code === "not_found" || e.message === "Object not found";
}
