"use client";

import { useEffect, useState } from "react";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const storageKey = (ownerUserId: string) => `snacky:team-create-request:v1:${ownerUserId}`;

/** An owner-scoped, tab-local operation ID — never store passwords here. */
export function TeamCreateRequestIdField({
  ownerUserId, initialRequestId,
}: { ownerUserId: string; initialRequestId: string }) {
  const [requestId, setRequestId] = useState(initialRequestId);
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    let id = initialRequestId;
    let previous = false;
    try {
      const key = storageKey(ownerUserId);
      const saved = window.sessionStorage.getItem(key);
      if (saved && uuid.test(saved)) { id = saved; previous = true; }
      window.sessionStorage.setItem(key, id);
    } catch {
      // This form still submits its initial server-generated UUID in this tab.
    }
    const timer = window.setTimeout(() => {
      setRequestId(id);
      setRestored(previous);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ownerUserId, initialRequestId]);

  const beginAnother = () => {
    if (!window.confirm("Check the Team list for the previous employee before starting a different request. This will not delete an existing staff member.")) return;
    const next = globalThis.crypto?.randomUUID?.();
    if (!next || !uuid.test(next)) return;
    try { window.sessionStorage.setItem(storageKey(ownerUserId), next); }
    catch { /* Keep the unique ID in this form. */ }
    setRequestId(next);
    setRestored(false);
  };

  return (
    <>
      <input type="hidden" name="client_create_id" value={requestId} />
      {restored ? (
        <section role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          <p className="font-semibold">A previous team-member save may still be pending.</p>
          <p className="mt-1">Submitting this form reuses its original ID, not a second employee record. Check Team if a previous save may have succeeded.</p>
          <button type="button" className="btn-secondary mt-2" onClick={beginAnother}>
            Start a different member after checking Team
          </button>
        </section>
      ) : null}
    </>
  );
}

/** Clear only an operation that the server explicitly confirmed as created. */
export function TeamCreateReceiptClear({ownerUserId, createdMemberId}: {
  ownerUserId:string; createdMemberId:string;
}) {
  useEffect(() => {
    if (!uuid.test(createdMemberId)) return;
    try {
      const key = storageKey(ownerUserId);
      if (window.sessionStorage.getItem(key) === createdMemberId)
        window.sessionStorage.removeItem(key);
    } catch { /* No browser storage is not a failure to create a team member. */ }
  }, [ownerUserId,createdMemberId]);
  return null;
}
