import { createHash, timingSafeEqual } from "node:crypto";

export const SNACKY_BLOB_ARCHIVE_PREFIX = "snacky-photos/v1";
export const SNACKY_BLOB_ARCHIVE_MAX_BYTES = 7 * 1024 * 1024;
const expectedStoreId = "B6WU5UUlCwdX4xRg";
const projectRef = "thrthmeyhuhxnmizjhqx";
const pathPattern = new RegExp("^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/[A-Za-z0-9._/-]{1,800}$", "i");
const shaPattern = /^[0-9a-f]{64}$/;

export type OriginalReceipt = {
  version: 1;
  projectRef: string;
  bucket: "refill-photos";
  path: string;
  originalBytes: number;
  sha256: string;
  sourceUpdatedAt: string;
  sourceEtag: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  contentKey: string;
  verifiedAt: string;
};

export function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}
export function photoArchiveReceiptKey(path: string) {
  validatePath(path);
  return `${SNACKY_BLOB_ARCHIVE_PREFIX}/receipts/${sha256(`refill-photos:\u0000${path}`)}.json`;
}
export function validatePath(path: string) {
  if (typeof path !== "string" || !pathPattern.test(path) || path.includes("//") ||
    path.split("/").some(part => !part || part === "." || part === "..")) throw Error("invalid_photo_path");
  return path;
}
export function photoMime(bytes: Uint8Array): OriginalReceipt["mime"] {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0,4)).toString() === "RIFF" &&
    Buffer.from(bytes.subarray(8,12)).toString() === "WEBP") return "image/webp";
  throw Error("unrecognized_photo_file");
}
export function ensureMatchingReceipt(value: unknown, path: string): OriginalReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("archive_receipt_invalid");
  const r = value as Partial<OriginalReceipt>;
  if (r.version !== 1 || r.projectRef !== projectRef || r.bucket !== "refill-photos" ||
      r.path !== validatePath(path) || !shaPattern.test(String(r.sha256 ?? "")) ||
      !Number.isSafeInteger(r.originalBytes) || Number(r.originalBytes) < 1 ||
      Number(r.originalBytes) > SNACKY_BLOB_ARCHIVE_MAX_BYTES ||
      !["image/jpeg","image/png","image/webp"].includes(String(r.mime)) ||
      r.contentKey !== `${SNACKY_BLOB_ARCHIVE_PREFIX}/originals/${r.sha256}` ||
      !r.sourceUpdatedAt || !r.sourceEtag || !r.verifiedAt) throw Error("archive_receipt_invalid");
  return r as OriginalReceipt;
}
function archiveToken() {
  const token = process.env.BLOB_READ_WRITE_TOKEN || "";
  const parts = token.split("_");
  if (parts.length < 5 || parts[3] !== expectedStoreId || !token.startsWith("vercel_blob_rw_")) {
    throw Error("private_blob_not_configured");
  }
  return token;
}
export type BlobArchiveStore = {
  get: (key: string, limit: number) => Promise<Uint8Array | null>;
  put: (key: string, data: Uint8Array, mime: string) => Promise<boolean>;
};
function archiveUrl(key: string) {
  if (!key.startsWith(`${SNACKY_BLOB_ARCHIVE_PREFIX}/`) || key.includes("//") ||
      key.split("/").some(part => !part || part==="." || part==="..")) throw Error("invalid_archive_key");
  const escaped = key.split("/").map(encodeURIComponent).join("/");
  return `https://${expectedStoreId}.private.blob.vercel-storage.com/${escaped}`;
}
async function responseBytes(response: Response, limit: number) {
  const length = response.headers.get("content-length");
  if (length && (!/^[0-9]+$/.test(length) || Number(length)>limit)) throw Error("archive_size_exceeded");
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > limit || (length && Number(length) !== buffer.byteLength)) throw Error("archive_size_mismatch");
  return buffer;
}
export function createPrivateBlobStore(fetcher: typeof fetch = fetch): BlobArchiveStore {
  const token = archiveToken();
  return {
    async get(key, limit) {
      const response = await fetcher(archiveUrl(key), {
        method: "GET", headers: { Authorization: `Bearer ${token}` },
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(18000),
      });
      if (response.status === 404) { await response.body?.cancel().catch(()=>undefined); return null; }
      if (!response.ok) throw Error(`archive_read_failed_${response.status}`);
      return responseBytes(response, limit);
    },
    async put(key, data, mime) {
      archiveUrl(key);
      const response = await fetcher(`https://vercel.com/api/blob/?pathname=${encodeURIComponent(key)}`,{
        method:"PUT",
        body: Buffer.from(data),
        headers:{
          Authorization: `Bearer ${token}`,
          "x-vercel-blob-store-id":expectedStoreId,
          "x-api-version":"12",
          "x-api-blob-request-id":`${expectedStoreId}-${crypto.randomUUID()}`,
          "x-api-blob-request-attempt":"0",
          "x-vercel-blob-access":"private",
          "x-content-type":mime,
          "x-allow-overwrite":"0",
        },
        redirect:"error", signal:AbortSignal.timeout(25000),
      });
      if (response.status === 409 || response.status === 412) { await response.body?.cancel().catch(()=>undefined); return false; }
      if (!response.ok) { await response.body?.cancel().catch(()=>undefined); throw Error(`archive_write_failed_${response.status}`); }
      const info = await response.json() as {pathname?:string;url?:string};
      if (info.pathname !== key || (!info.url || new URL(info.url).hostname.toLowerCase()!==`${expectedStoreId.toLowerCase()}.private.blob.vercel-storage.com`)) throw Error("archive_put_wrong_path");
      return true;
    }
  };
}
export async function readVerifiedOriginal(path: string, store = createPrivateBlobStore()) {
  const receiptBytes = await store.get(photoArchiveReceiptKey(path), 4096);
  if (!receiptBytes) return null;
  const receipt = ensureMatchingReceipt(JSON.parse(Buffer.from(receiptBytes).toString("utf8")),path);
  const bytes = await store.get(receipt.contentKey,SNACKY_BLOB_ARCHIVE_MAX_BYTES);
  if (!bytes || bytes.byteLength !== receipt.originalBytes || sha256(bytes) !== receipt.sha256 ||
      photoMime(bytes) !== receipt.mime) throw Error("archive_integrity_error");
  return {receipt,bytes};
}
export async function storeVerifiedOriginal(
  path: string, source: Uint8Array,
  info: {size:number;updatedAt:string;etag:string},
  store = createPrivateBlobStore(),
) {
  validatePath(path);
  if (source.byteLength > SNACKY_BLOB_ARCHIVE_MAX_BYTES || source.byteLength !== info.size) throw Error("source_size_mismatch");
  const digest=sha256(source),mime=photoMime(source);
  const contentKey=`${SNACKY_BLOB_ARCHIVE_PREFIX}/originals/${digest}`;
  await store.put(contentKey,source,mime);
  const copied=await store.get(contentKey,SNACKY_BLOB_ARCHIVE_MAX_BYTES);
  if (!copied || copied.byteLength!==source.length || sha256(copied)!==digest) throw Error("archive_copy_integrity_failure");
  const receipt:OriginalReceipt={
    version:1,projectRef,bucket:"refill-photos",path,originalBytes:source.byteLength,
    sha256:digest,sourceUpdatedAt:info.updatedAt,sourceEtag:info.etag,mime,contentKey,verifiedAt:new Date().toISOString()
  };
  const previous=await store.get(photoArchiveReceiptKey(path),4096);
  if (previous) {
    const old=ensureMatchingReceipt(JSON.parse(Buffer.from(previous).toString("utf8")),path);
    if (old.sha256!==digest||old.originalBytes!==info.size||old.sourceEtag!==info.etag) throw Error("archive_source_version_conflict");
    return old;
  }
  const encoded=Buffer.from(JSON.stringify(receipt),"utf8");
  await store.put(photoArchiveReceiptKey(path),encoded,"application/json");
  const final=await readVerifiedOriginal(path,store);
  if (!final||final.receipt.sha256!==digest) throw Error("archive_receipt_verify_failed");
  return final.receipt;
}
export function authorizedSchedulerToken(header:string){
  const bearer=header.startsWith("Bearer ")?header.slice(7).trim():"";
  const received=sha256(bearer), expected="6a8316c2ea6b58c928921ca0c141ff9f683d279eb8e2abbe682c1d7d52167d89";
  return bearer.length>0 && timingSafeEqual(Buffer.from(received),Buffer.from(expected));
}
