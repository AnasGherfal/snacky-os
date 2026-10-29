import {
  ARCHIVE_MAX_RECEIPT_BYTES, PhotoArchiveError, decodeArchiveReceipt, photoContentKey,
  photoContentType, photoSha256, receiptKey, validateReviewedPhoto, verifyArchivedBytes,
  type PhotoArchiveReceipt, type PrivateArchiveStore, type ReviewedArchivePhoto,
} from "./photo-archive-core.ts";

export type PhotoSourceSnapshot = { bytes: number; updatedAt: string; etag: string };
export type ReadOnlyPhotoSource = {
  stat: (photo: ReviewedArchivePhoto) => Promise<PhotoSourceSnapshot>;
  /** Must send If-Match; never return a newer source version silently. */
  read: (photo: ReviewedArchivePhoto, etag: string) => Promise<Uint8Array>;
};
export function sourceMatches(a: PhotoSourceSnapshot, b: PhotoSourceSnapshot): boolean {
  return a.bytes === b.bytes && a.etag === b.etag && a.updatedAt === b.updatedAt;
}
function ensureSnapshot(photo: ReviewedArchivePhoto, s: PhotoSourceSnapshot) {
  if (s.bytes !== photo.bytes || !s.etag || s.etag.startsWith("W/") || /[\r\n]/.test(s.etag)
      || !Number.isFinite(Date.parse(s.updatedAt))
      // HTTP Last-Modified has second precision; the approved export can contain microseconds.
      || Math.floor(Date.parse(s.updatedAt) / 1000) !== Math.floor(Date.parse(photo.sourceUpdatedAt) / 1000)) {
    throw new PhotoArchiveError("archive_source_changed");
  }
}
function sameCopy(a: PhotoArchiveReceipt, b: PhotoArchiveReceipt): boolean {
  return a.projectRef === b.projectRef && a.bucket === b.bucket && a.path === b.path
    && a.bytes === b.bytes && a.sha256 === b.sha256 && a.contentType === b.contentType
    && a.contentKey === b.contentKey && a.sourceEtag === b.sourceEtag
    && a.sourceUpdatedAt === b.sourceUpdatedAt;
}

/**
 * Copy-only: exact bytes, archive readback, source-version recheck, then immutable receipt.
 * No database writes, no source remove function, no source-deletion flag, no scheduled work.
 */
export async function copyReviewedPhoto(
  photo: ReviewedArchivePhoto,
  manifestSha256: string,
  source: ReadOnlyPhotoSource,
  archive: PrivateArchiveStore,
  now = new Date(),
) {
  validateReviewedPhoto(photo, now);
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw new PhotoArchiveError("archive_manifest_invalid");
  const before = await source.stat(photo);
  ensureSnapshot(photo, before);
  const bytes = await source.read(photo, before.etag);
  if (bytes.byteLength !== before.bytes) throw new PhotoArchiveError("archive_source_changed");
  const sha256 = photoSha256(bytes);
  const receipt: PhotoArchiveReceipt = {
    version: 1, state: "copy_verified_source_retained", projectRef: photo.projectRef,
    bucket: photo.bucket, path: photo.path, bytes: bytes.byteLength, sha256,
    contentType: photoContentType(bytes), contentKey: photoContentKey(photo, sha256),
    sourceEtag: before.etag, sourceUpdatedAt: before.updatedAt, verifiedAt: now.toISOString(), manifestSha256,
  };
  const existing = await archive.get(receiptKey(photo), ARCHIVE_MAX_RECEIPT_BYTES);
  if (existing !== null && !sameCopy(decodeArchiveReceipt(existing, photo), receipt)) {
    throw new PhotoArchiveError("archive_version_conflict");
  }
  if (existing === null) await archive.putIfAbsent(receipt.contentKey, bytes, receipt.contentType);
  const readback = await archive.get(receipt.contentKey, receipt.bytes);
  if (readback === null) throw new PhotoArchiveError("archive_content_missing");
  verifyArchivedBytes(readback, receipt);
  const after = await source.stat(photo);
  if (!sourceMatches(before, after)) throw new PhotoArchiveError("archive_source_changed");

  if (existing === null) {
    const encoded = new TextEncoder().encode(JSON.stringify(receipt));
    await archive.putIfAbsent(receiptKey(photo), encoded, "application/json");
  }
  const committed = await archive.get(receiptKey(photo), ARCHIVE_MAX_RECEIPT_BYTES);
  if (committed === null || !sameCopy(decodeArchiveReceipt(committed, photo), receipt)) {
    throw new PhotoArchiveError("archive_receipt_not_confirmed");
  }
  return { state: "copy_verified_source_retained" as const, replayed: existing !== null, receipt: decodeArchiveReceipt(committed, photo) };
}
