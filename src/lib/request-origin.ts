import { cashSameOrigin } from "./cash-handover.ts";

/** Shared CSRF guard for Snacky actions behind Railway HTTPS reverse proxy.
 * The Origin must exactly match the browser-visible Host and protocol (or the
 * directly routed request URL); it must never be a cross-site fetch.
 */
export function strictSameOrigin(request: Request): boolean {
  return cashSameOrigin(request);
}

/** Legacy authenticated clients that omit Origin may continue working.
 * They still cannot claim a cross-site browser fetch. If Origin exists it
 * must match the current public deployment, including a Railway proxy.
 */
export function optionalSameOrigin(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  return request.headers.get("origin") ? strictSameOrigin(request) : true;
}
