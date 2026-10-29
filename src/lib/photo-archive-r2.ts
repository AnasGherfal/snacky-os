import { createHmac } from "node:crypto";
import { PhotoArchiveError, photoSha256, type PrivateArchiveStore } from "./photo-archive-core.ts";

type Credentials = { accessKeyId: string; secretAccessKey: string };
export type PhotoArchiveConfig = Credentials & { accountId: string; archiveBucket: string; projectRef: string };
const rfc3986 = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Minimal GET/HEAD/PUT-only SigV4 implementation, verified against the AWS published test vector. */
export function signedS3Headers(
  method: "GET" | "PUT" | "HEAD", url: URL, credentials: Credentials, body: Uint8Array = new Uint8Array(),
  extra: Record<string, string> = {}, now = new Date(), region = "auto",
): Record<string, string> {
  if (url.search || url.hash || !Number.isFinite(now.getTime())) throw new PhotoArchiveError("archive_request_invalid");
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0,8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const headers: Record<string, string> = { ...extra, host: url.host, "x-amz-content-sha256": photoSha256(body), "x-amz-date": date };
  const names = Object.keys(headers).sort();
  if (names.some(name => name !== name.toLowerCase() || /[\r\n]/.test(headers[name]))) throw new PhotoArchiveError("archive_request_invalid");
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonical = [method, url.pathname, "", canonicalHeaders, signedHeaders, photoSha256(body)].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", date, scope, photoSha256(canonical)].join("\n");
  const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), "s3"), "aws4_request");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${hmac(key, toSign).toString("hex")}`;
  return headers;
}

/** No configurable arbitrary endpoint: credentials can only be sent to the configured R2 account. */
export function r2ObjectUrl(config: PhotoArchiveConfig, key: string): URL {
  if (!/^[a-f0-9]{32}$/.test(config.accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.archiveBucket)
      || !/^[a-z0-9]{20}$/.test(config.projectRef)
      || !key.startsWith(`snacky-photo-archive/v1/${config.projectRef}/refill-photos/`)
      || key.split("/").some(part => !part || part === "." || part === "..") || /[\\\u0000-\u001f]/.test(key)) {
    throw new PhotoArchiveError("archive_config_invalid");
  }
  return new URL(`https://${config.accountId}.r2.cloudflarestorage.com/${config.archiveBucket}/${key.split("/").map(rfc3986).join("/")}`);
}
export function photoArchiveConfig(env: Record<string, string | undefined>, writer = false): PhotoArchiveConfig | null {
  if (!writer && env.SNACKY_PHOTO_ARCHIVE_READ_ENABLED !== "true") return null;
  const keyPrefix = writer ? "SNACKY_PHOTO_ARCHIVE_WRITE_" : "SNACKY_PHOTO_ARCHIVE_";
  const config: PhotoArchiveConfig = {
    accountId: env.SNACKY_PHOTO_ARCHIVE_ACCOUNT_ID ?? "",
    archiveBucket: env.SNACKY_PHOTO_ARCHIVE_BUCKET ?? "",
    projectRef: env.SNACKY_PHOTO_ARCHIVE_PROJECT_REF ?? "",
    accessKeyId: env[`${keyPrefix}ACCESS_KEY_ID`] ?? "",
    secretAccessKey: env[`${keyPrefix}SECRET_ACCESS_KEY`] ?? "",
  };
  r2ObjectUrl(config, `snacky-photo-archive/v1/${config.projectRef}/refill-photos/config-check`);
  if (!config.accessKeyId || !config.secretAccessKey || /[\r\n]/.test(config.accessKeyId + config.secretAccessKey)) {
    throw new PhotoArchiveError("archive_config_invalid");
  }
  let url: URL;
  try { url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL ?? ""); }
  catch { throw new PhotoArchiveError("archive_project_mismatch"); }
  if (url.origin !== `https://${config.projectRef}.supabase.co` || url.username || url.password) throw new PhotoArchiveError("archive_project_mismatch");
  return config;
}
export async function boundedResponseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel(); throw new PhotoArchiveError("archive_download_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PhotoArchiveError("archive_empty_response");
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > limit) throw new PhotoArchiveError("archive_download_too_large");
      parts.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  if (declared && Number(declared) !== length) throw new PhotoArchiveError("archive_truncated_response");
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

/** Credentials stay server-side. Redirects are never followed and network failures expose no provider secrets. */
export function createR2PhotoStore(config: PhotoArchiveConfig, fetcher: typeof fetch = fetch): PrivateArchiveStore {
  return {
    async get(key, maxBytes) {
      try {
        const url = r2ObjectUrl(config, key);
        const response = await fetcher(url, { method: "GET", headers: signedS3Headers("GET", url, config), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000) });
        if (response.status === 404) { await response.body?.cancel(); return null; }
        if (response.status !== 200) { await response.body?.cancel(); throw new PhotoArchiveError("archive_read_failed"); }
        return await boundedResponseBytes(response, maxBytes);
      } catch (error) { if (error instanceof PhotoArchiveError) throw error; throw new PhotoArchiveError("archive_read_failed"); }
    },
    async putIfAbsent(key, bytes, contentType) {
      try {
        const url = r2ObjectUrl(config, key);
        const extra = { "content-type": contentType, "if-none-match": "*" };
        const response = await fetcher(url, { method: "PUT", headers: signedS3Headers("PUT", url, config, bytes, extra), body: new Blob([new Uint8Array(bytes)], { type: contentType }), redirect: "error", signal: AbortSignal.timeout(20000) });
        await response.body?.cancel();
        if (response.status === 412) return false;
        if (!response.ok) throw new PhotoArchiveError("archive_copy_failed");
        return true;
      } catch (error) { if (error instanceof PhotoArchiveError) throw error; throw new PhotoArchiveError("archive_copy_failed"); }
    },
  };
}
