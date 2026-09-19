/** Only accept known browser push services; subscriptions must never become an SSRF proxy. */
export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname;
    return host === "fcm.googleapis.com" ||
      host.endsWith(".push.apple.com") ||
      host.endsWith(".push.services.mozilla.com") ||
      host.endsWith(".notify.windows.com");
  } catch { return false; }
}

export type DeviceSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

function base64Bytes(value: unknown, size: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length !== Math.ceil(size * 4 / 3)) return false;
  try { return atob(unpadded.replace(/-/g, "+").replace(/_/g, "/")).length === size; }
  catch { return false; }
}

export function parseDeviceSubscription(value: unknown): DeviceSubscription | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (!isPushEndpoint(row.endpoint) || !base64Bytes(row.keys?.p256dh, 65) || !base64Bytes(row.keys?.auth, 16)) return null;
  const publicBytes = atob(row.keys.p256dh.replace(/-/g, "+").replace(/_/g, "/"));
  if (publicBytes.charCodeAt(0) !== 4) return null;
  return { endpoint: row.endpoint, keys: { p256dh: row.keys.p256dh, auth: row.keys.auth } };
}

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get("origin");
  // Older clients/non-browser API callers can omit Origin; cookie-authenticated
  // cross-site browser requests always supply it or Sec-Fetch-Site.
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  return !origin || origin === new URL(request.url).origin;
}
