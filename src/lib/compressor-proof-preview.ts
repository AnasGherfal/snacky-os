import sharp from "sharp";

/**
 * Ultra-small read-only display derivative for a *verified, separately archived*
 * compressor power indicator photograph. Never change the source's bytes or
 * SHA-named object path. No crop; retain orientation, aspect and frame.
 */
export const COMPRESSOR_PREVIEW_TARGET_BYTES = 60 * 1024;
export const COMPRESSOR_PREVIEW_MAX_BYTES = 120 * 1024;
const SOURCE_MAX_BYTES = 10 * 1024 * 1024;
const ATTEMPTS = [
  { edge: 800, quality: 43 },
  { edge: 720, quality: 37 },
  { edge: 640, quality: 31 },
  { edge: 512, quality: 25 },
] as const;

export async function compactCompressorIndicator(original: Uint8Array): Promise<Uint8Array> {
  if (!original.byteLength || original.byteLength > SOURCE_MAX_BYTES) throw Error("compressor_source_size_invalid");
  const source = Buffer.from(original);
  const input = sharp(source, { failOn: "error", limitInputPixels: 45_000_000 });
  const meta = await input.metadata();
  if (!meta.width || !meta.height || !["jpeg", "png", "webp"].includes(meta.format)) throw Error("compressor_image_invalid");
  // Archive fallback also serves proofs that were already stored as tiny WebP.
  // Preserve their original bytes rather than re-encoding or returning a false 503.
  if (meta.format === "webp" && meta.width <= 800 && meta.height <= 800 && source.length <= COMPRESSOR_PREVIEW_MAX_BYTES) {
    return new Uint8Array(source);
  }
  let chosen: Buffer | null = null;
  for (const attempt of ATTEMPTS) {
    const output = await sharp(source, { failOn: "error", limitInputPixels: 45_000_000 })
      .rotate().resize({ width: attempt.edge, height: attempt.edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality: attempt.quality, effort: 5, smartSubsample: true }).toBuffer();
    if (!chosen || output.length < chosen.length) chosen = output;
    if (output.length <= COMPRESSOR_PREVIEW_TARGET_BYTES) break;
  }
  if (!chosen || chosen.length > COMPRESSOR_PREVIEW_MAX_BYTES || chosen.length >= source.length) {
    throw Error("compressor_preview_too_large");
  }
  const result = await sharp(chosen).metadata();
  if (!result.width || !result.height || result.format !== "webp" || result.width > 800 || result.height > 800) {
    throw Error("compressor_preview_invalid");
  }
  return new Uint8Array(chosen);
}
