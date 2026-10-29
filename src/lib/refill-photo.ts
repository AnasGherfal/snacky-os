/** Ordinary machine/compressor camera photos only; never use for receipts or XY text screenshots. */
export const REFILL_PHOTO_TARGET_BYTES = 400 * 1024;
export const REFILL_PHOTO_UPLOAD_MAX_BYTES = 900 * 1024;
export const REFILL_PHOTO_INPUT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
const STORED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const INPUT_TYPES = new Set([...STORED_TYPES, "image/heic", "image/heif"]);
const prepared = new WeakMap<File, Promise<File>>();
const attempts = [
  { dimension: 2000, quality: 0.84 },
  { dimension: 2000, quality: 0.78 },
  { dimension: 1600, quality: 0.78 },
] as const;

function failure(ar: boolean) {
  return new Error(ar
    ? "تعذر تجهيز صورة واضحة بحجم مناسب. أعد التقاطها بصيغة JPG أو اختر صورة أصغر؛ لم يتم حفظ صورة جديدة."
    : "Could not prepare a clear, smaller photo. Retake it as JPG or choose a smaller image; no new photo was saved.");
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  // Modern browsers apply EXIF orientation. Fall back to a native Image on iOS/HEIC decode failures.
  if (typeof createImageBitmap === "function") {
    try {
      const image = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: image, width: image.width, height: image.height, close: () => image.close() };
    } catch { /* Try the native decoder before reporting a failed preparation. */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("image_decode"));
      image.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(resolve, type, quality); } catch (error) { reject(error); }
  });
}

async function optimize(file: File, ar: boolean): Promise<File> {
  let image: Awaited<ReturnType<typeof decode>> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    image = await decode(file);
    const { width, height } = image;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > MAX_PIXELS) throw failure(ar);
    const longest = Math.max(width, height);
    if (file.size <= REFILL_PHOTO_TARGET_BYTES && longest <= 2000 && STORED_TYPES.has(file.type)) return file;

    canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw failure(ar);
    // Keep a small existing image when re-encoding would increase its size.
    let best: Blob | null = longest <= 2000 && STORED_TYPES.has(file.type) ? file : null;
    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.dimension / longest);
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      // No crop, no upscaling: preserve the whole machine and compressor controls.
      context.drawImage(image.source, 0, 0, canvas.width, canvas.height);
      let blob = await encode(canvas, "image/webp", attempt.quality);
      // Browsers can silently return PNG when a requested encoder is unsupported.
      if (!blob || blob.type !== "image/webp") blob = await encode(canvas, "image/jpeg", attempt.quality);
      if (!blob || !["image/webp", "image/jpeg"].includes(blob.type) || blob.size <= 0) continue;
      if (!best || blob.size < best.size) best = blob;
      if (best.size <= REFILL_PHOTO_TARGET_BYTES) break;
    }
    if (!best || best.size > REFILL_PHOTO_UPLOAD_MAX_BYTES) throw failure(ar);
    if (best === file) return file;
    const extension = best.type === "image/webp" ? "webp" : "jpg";
    const name = file.name.replace(/\.[^.]+$/, "") || "refill-proof";
    return new File([best], `${name}.${extension}`, { type: best.type, lastModified: file.lastModified });
  } catch {
    // Do not quietly upload the 5–10 MB original after a failed compression.
    throw failure(ar);
  } finally {
    image?.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

/** Reuse exactly the prepared bytes during a same-file retry or concurrent submission. */
export function prepareRefillPhoto(file: File, ar = false): Promise<File> {
  if (!INPUT_TYPES.has(file.type) || file.size <= 0 || file.size > REFILL_PHOTO_INPUT_MAX_BYTES) return Promise.reject(failure(ar));
  const cached = prepared.get(file);
  if (cached) return cached;
  const promise = optimize(file, ar).catch((error: unknown) => { prepared.delete(file); throw error; });
  prepared.set(file, promise);
  return promise;
}
