import "server-only";
import { readVerifiedArchivedPhoto } from "./photo-archive-core.ts";
import { createR2PhotoStore, photoArchiveConfig } from "./photo-archive-r2.ts";

/** Called only after existing original-object authorization. Never redirects to a public R2 URL. */
export async function archivedPhotoResponse(bucket: string, path: string): Promise<Response | null> {
  if (bucket !== "refill-photos") return null;
  const config = photoArchiveConfig(process.env);
  if (!config) return null;
  const photo = await readVerifiedArchivedPhoto(createR2PhotoStore(config), { projectRef: config.projectRef, bucket, path });
  if (!photo) return null;
  return new Response(new Uint8Array(photo.bytes), {
    headers: {
      "Content-Type": photo.receipt.contentType,
      "Content-Length": String(photo.bytes.byteLength),
      "Cache-Control": "private, no-store",
      "Vary": "Cookie, Authorization",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Snacky-Photo-Source": "verified-private-archive",
      "X-Snacky-Photo-SHA256": photo.receipt.sha256,
    },
  });
}
