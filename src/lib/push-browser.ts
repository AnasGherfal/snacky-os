export function supportsPush() {
  return typeof window !== "undefined" && window.isSecureContext &&
    "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
}

export function needsHomeScreenInstall() {
  if (typeof navigator === "undefined") return false;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const raw = window.atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function subscriptionMatchesPublicKey(subscription: PushSubscription, publicKey: string) {
  const key = subscription.options.applicationServerKey;
  if (!key) return false;
  const expected = urlBase64ToUint8Array(publicKey);
  const actual = new Uint8Array(key);
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function withPushTimeout<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("Notification setup timed out. Please retry.")), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export async function getPushRegistration() {
  await withPushTimeout(navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }));
  return withPushTimeout(navigator.serviceWorker.ready);
}
