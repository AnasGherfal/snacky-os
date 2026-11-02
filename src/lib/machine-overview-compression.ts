import sharp from "sharp";

/**
 * Server-side guard for ordinary machine overview camera uploads, including
 * older clients that skipped browser preparation. This is NOT applied to
 * quantity screenshots, safety/compressor proof, cash, receipts or issue photos.
 *
 * It never crops. The full photographic frame remains available at >=1600px
 * along its original long side when the source itself is that large.
 */
const MAX_CAMERA_BYTES = 10 * 1024 * 1024;
export const OVERVIEW_PREPARED_LIMIT_BYTES = 900 * 1024;
export const OVERVIEW_MAX_STORED_BYTES = 2 * 1024 * 1024;
const ATTEMPTS = [
  { edge: 2000, quality: 82 },
  { edge: 1800, quality: 80 },
  { edge: 1600, quality: 78 },
] as const;

export async function compactMachineOverview(original: Uint8Array): Promise<Uint8Array> {
  if (!original.length || original.length > MAX_CAMERA_BYTES) throw Error("overview_source_size_invalid");
  const source = Buffer.from(original);
  const meta = await sharp(source, { failOn: "error", limitInputPixels: 45_000_000 }).metadata();
  if (!meta.width || !meta.height || !["jpeg", "png", "webp"].includes(String(meta.format))) {
    throw Error("overview_image_invalid");
  }

  // Modern clients already prepare <=900 KiB images. Do not re-encode them:
  // it costs CPU, may lose legibility, and would change their SHA-named path.
  if (source.length <= OVERVIEW_PREPARED_LIMIT_BYTES) return new Uint8Array(source);

  let chosen: Buffer | null = null;
  for (const { edge, quality } of ATTEMPTS) {
    const output = await sharp(source, { failOn: "error", limitInputPixels: 45_000_000 })
      .rotate()
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
      .webp({ quality, effort: 5, smartSubsample: true })
      .toBuffer();
    if (!chosen || output.length < chosen.length) chosen = output;
    if (output.length <= OVERVIEW_PREPARED_LIMIT_BYTES) break;
  }
  if (!chosen || chosen.length >= source.length || chosen.length > OVERVIEW_MAX_STORED_BYTES) {
    throw Error("overview_could_not_be_compacted");
  }
  const result = await sharp(chosen).metadata();
  const sourceLong = Math.max(meta.width, meta.height);
  const resultLong = Math.max(result.width ?? 0, result.height ?? 0);
  if (result.format !== "webp" || !result.width || !result.height ||
      resultLong > Math.min(sourceLong, 2000) ||
      resultLong < Math.min(sourceLong, 1600)) {
    throw Error("overview_compacted_dimensions_invalid");
  }
  return new Uint8Array(chosen);
}
