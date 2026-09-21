// The invitation is UI only: permission and subscription changes require a tap.
export const NOTIFICATION_PROMPT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;
export const BLOCKED_PROMPT_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
const PREFIX = "snacky.notification-invite.v1";
const DEVICE_DISABLED_KEY = `${PREFIX}.device-disabled`;
const seenInMemory = new Set<string>();
const snoozedInMemory = new Map<string, number>();
let disabledInMemory = false;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type PromptStores = { local?: StorageLike; session?: StorageLike };

function browserStores(): PromptStores {
  if (typeof window === "undefined") return {};
  const stores: PromptStores = {};
  try { stores.local = window.localStorage; } catch { /* Private/restricted browser. */ }
  try { stores.session = window.sessionStorage; } catch { /* In-memory fallback. */ }
  return stores;
}

function read(store: StorageLike | undefined, key: string) {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function write(store: StorageLike | undefined, key: string, value: string) {
  try { store?.setItem(key, value); } catch { /* Never block work on storage failures. */ }
}

export function notificationPromptKeys(userId: string) {
  return { seen: `${PREFIX}.${userId}.seen`, until: `${PREFIX}.${userId}.until` };
}

export function shouldOfferNotificationPrompt(state: string, serverReady: boolean) {
  return serverReady && ["available", "install", "blocked"].includes(state);
}

export function notificationPromptRouteAllowed(pathname: string | null) {
  if (!pathname) return false;
  return !["/login", "/unauthorized", "/account", "/notifications"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function canShowNotificationPrompt(userId: string, now = Date.now(), stores = browserStores()) {
  if (!userId || disabledInMemory || read(stores.local, DEVICE_DISABLED_KEY) === "1") return false;
  const keys = notificationPromptKeys(userId);
  if (seenInMemory.has(userId) || read(stores.session, keys.seen) === "1") return false;
  const until = Number(read(stores.local, keys.until));
  return !(Number.isFinite(until) && until > now) && !((snoozedInMemory.get(userId) ?? 0) > now);
}

export function markNotificationPromptShown(userId: string, stores = browserStores()) {
  seenInMemory.add(userId);
  write(stores.session, notificationPromptKeys(userId).seen, "1");
}

export function snoozeNotificationPrompt(userId: string, blocked = false, now = Date.now(), stores = browserStores()) {
  const until = now + (blocked ? BLOCKED_PROMPT_SNOOZE_MS : NOTIFICATION_PROMPT_SNOOZE_MS);
  snoozedInMemory.set(userId, until);
  write(stores.local, notificationPromptKeys(userId).until, String(until));
  markNotificationPromptShown(userId, stores);
}

// Respect a deliberate disable in Account; only a later explicit enable clears it.
export function rememberNotificationDeviceDisabled(stores = browserStores()) {
  disabledInMemory = true;
  write(stores.local, DEVICE_DISABLED_KEY, "1");
}
export function clearNotificationDeviceDisabled(stores = browserStores()) {
  disabledInMemory = false;
  try { stores.local?.removeItem(DEVICE_DISABLED_KEY); } catch { /* In-memory fallback. */ }
}
