type StoredClientOperation = {
  id: string;
  payload: string;
};

function newOperationId() {
  return globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function encodedPayload(payload: unknown) {
  return JSON.stringify(payload);
}

/**
 * Claims an operation id for one immutable browser request. The receipt lives
 * in local storage so a remount, navigation back, app restart, or lost HTTP response can
 * resend the exact payload with the exact same id. Editing any immutable input
 * produces a new id instead of aliasing a different request onto the old one.
 */
export function claimDurableClientOperation(storageKey: string, payload: unknown) {
  const serializedPayload = encodedPayload(payload);
  if (typeof window === "undefined") {
    throw new Error("This operation can only be submitted from an active browser page.");
  }

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<StoredClientOperation>;
      if (typeof parsed.id === "string" && parsed.id && parsed.payload === serializedPayload) {
        return parsed.id;
      }
    }

    const id = newOperationId();
    window.localStorage.setItem(storageKey, JSON.stringify({ id, payload: serializedPayload } satisfies StoredClientOperation));
    return id;
  } catch {
    throw new Error("Snacky OS could not safely persist this operation id. Enable browser storage, then retry; nothing was submitted.");
  }
}

/** Clears only the receipt that produced the confirmed response. */
export function completeDurableClientOperation(storageKey: string, operationId: string) {
  if (typeof window === "undefined") return;
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (!saved) return;
    const parsed = JSON.parse(saved) as Partial<StoredClientOperation>;
    if (parsed.id === operationId) window.localStorage.removeItem(storageKey);
  } catch {
    // Storage is an availability enhancement; the database remains the
    // authority for idempotency when browser storage is unavailable.
  }
}
