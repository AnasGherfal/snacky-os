const CACHE_NAME = "snacky-os-offline-v4";
const OFFLINE_URL = "/offline.html";
const CORE_ASSETS = [OFFLINE_URL, "/manifest.webmanifest", "/brand/snacky-logo.png", "/icons/favicon-32.png", "/icons/apple-touch-icon.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-icon-512.png"];

function getNotificationTargetUrl(data) {
  const fallback = "/account";
  if (!data || typeof data !== "object") return fallback;
  const value = typeof data.url === "string" && data.url.trim() ? data.url.trim()
    : typeof data.routeId === "string" && data.routeId.trim() ? `/operator/routes/${encodeURIComponent(data.routeId.trim())}` : fallback;
  try {
    const target = new URL(value, self.location.origin);
    if (target.origin !== self.location.origin || target.username || target.password || !/^\/(account|operator\/routes|routes|company|issues|follow-ups|my-work|locations-pipeline|relationships|inventory)(\/|$)/.test(target.pathname)) return fallback;
    return target.pathname + target.search + target.hash;
  } catch { return fallback; }
}

function getNotificationPayload(event) {
  try {
    const payload = event.data ? event.data.json() : {};
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  } catch { return {}; }
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("snacky-os-offline-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL))); return;
  }
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (CORE_ASSETS.includes(url.pathname)) event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
self.addEventListener("push", (event) => {
  const payload = getNotificationPayload(event);
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Snacky OS";
  const body = typeof payload.body === "string" ? payload.body : typeof payload.message === "string" ? payload.message : "";
  const data = { url: getNotificationTargetUrl(payload), routeId: typeof payload.routeId === "string" ? payload.routeId : null, type: typeof payload.type === "string" ? payload.type : null };
  const notificationTag = typeof payload.notificationId === "string" && /^[0-9a-f-]{36}$/i.test(payload.notificationId) ? `work:${payload.notificationId}`
    : typeof payload.type === "string" && typeof data.routeId === "string" ? `${payload.type}:${data.routeId}` : "";
  const options = { body, icon: "/icons/icon-192.png", badge: "/icons/favicon-32.png", data, lang: payload.lang === "ar" ? "ar" : "en", dir: payload.dir === "rtl" ? "rtl" : "ltr" };
  if (notificationTag) { options.tag = notificationTag; options.renotify = !payload.notificationId; }
  event.waitUntil(self.registration.showNotification(title, options).catch((error) => {
    console.error("[notifications] Could not display rich notification", error);
    return self.registration.showNotification(title, { body, data });
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = getNotificationTargetUrl(event.notification.data);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL(targetUrl, self.location.origin);
    for (const client of windows) {
      try {
        if (!("focus" in client) || new URL(client.url).origin !== target.origin) continue;
        if (client.url === target.href) { await client.focus(); return; }
        if ("navigate" in client) {
          const navigated = await client.navigate(target.href);
          if (navigated) { await navigated.focus(); return; }
        }
      } catch { /* Try another client or open a new app window. */ }
    }
    await self.clients.openWindow(target.href);
  })());
});
