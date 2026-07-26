const CACHE_NAME = "snacky-os-offline-v2";
const OFFLINE_URL = "/offline.html";
const CORE_ASSETS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/brand/snacky-logo.png",
  "/icons/favicon-32.png",
  "/icons/apple-touch-icon.png",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-icon-512.png"
];

function getNotificationTargetUrl(data) {
  if (!data || typeof data !== "object") return "/operator/routes";
  const target = typeof data.url === "string" && data.url.trim() ? data.url.trim() : "";
  if (target) return target;
  const routeId = typeof data.routeId === "string" && data.routeId.trim() ? data.routeId.trim() : "";
  return routeId ? `/operator/routes/${routeId}` : "/operator/routes";
}

function getNotificationPayload(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return {};
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (CORE_ASSETS.includes(requestUrl.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        return cachedResponse || fetch(event.request);
      })
    );
  }
});

self.addEventListener("push", (event) => {
  const payload = getNotificationPayload(event);
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "Snacky OS";
  const body = typeof payload.body === "string" && payload.body.trim() ? payload.body.trim() : typeof payload.message === "string" ? payload.message.trim() : "";
  const data = {
    url: getNotificationTargetUrl(payload),
    routeId: typeof payload.routeId === "string" ? payload.routeId : null,
    type: typeof payload.type === "string" ? payload.type : null,
  };

  const notificationTag = typeof payload.type === "string" && typeof data.routeId === "string"
    ? `${payload.type}:${data.routeId}`
    : "";
  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/favicon-32.png",
    data,
  };

  // Chromium rejects renotify when there is no tag. Test pushes intentionally
  // have no route ID, so add both options only for tagged route notifications.
  if (notificationTag) {
    options.tag = notificationTag;
    options.renotify = true;
  }

  event.waitUntil(
    self.registration.showNotification(title, options).catch((error) => {
      console.error("[notifications] Could not display rich notification", error);
      return self.registration.showNotification(title, { body, data });
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = getNotificationTargetUrl(event.notification.data);

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        if (!("focus" in client)) continue;

        try {
          const clientUrl = new URL(client.url);
          const target = new URL(targetUrl, self.location.origin);
          if (clientUrl.origin === target.origin) {
            await client.focus();
            if ("navigate" in client && clientUrl.href !== target.href) {
              await client.navigate(target.href);
            }
            return;
          }
        } catch {
          // Fall through to open a new window.
        }
      }

      await self.clients.openWindow(targetUrl);
    })()
  );
});
