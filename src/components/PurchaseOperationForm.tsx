"use client";

import type { ComponentProps, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  isPurchaseOperationId,
  purchaseOperationStorageKey,
  resolvePurchaseOperationId,
} from "@/lib/purchase-operation-id";

type PurchaseOperationIdentity = {
  purchaseId: string;
  operation: "receive" | "payment" | "cancel" | "void" | `payment-void:${string}`;
  initialSubmissionId: string;
  confirmedSubmissionId?: string;
};

function usePersistentPurchaseOperationId({
  purchaseId,
  operation,
  initialSubmissionId,
  confirmedSubmissionId = "",
}: PurchaseOperationIdentity) {
  const storageKey = useMemo(
    () => purchaseOperationStorageKey(purchaseId, operation),
    [operation, purchaseId],
  );
  const [submissionId, setSubmissionId] = useState(initialSubmissionId);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let storedId = "";
    try {
      storedId = window.localStorage.getItem(storageKey) ?? "";
    } catch {
      // Private browsing or storage policy can make localStorage unavailable.
      // The server-rendered UUID remains safe for this mounted page.
    }

    const resolved = resolvePurchaseOperationId({
      storedId,
      initialId: initialSubmissionId,
      confirmedId: confirmedSubmissionId,
      createId: () => globalThis.crypto?.randomUUID?.() ?? "",
    });

    if (resolved.id) {
      try {
        window.localStorage.setItem(storageKey, resolved.id);
      } catch {
        // Keep the in-memory UUID when browser storage is unavailable.
      }
    }
    const timer = window.setTimeout(() => {
      setSubmissionId(resolved.id || initialSubmissionId);
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [confirmedSubmissionId, initialSubmissionId, storageKey]);

  return {
    submissionId,
    ready: ready && isPurchaseOperationId(submissionId),
  };
}

export function PurchaseOperationForm({
  action,
  className,
  children,
  visible = true,
  ...identity
}: PurchaseOperationIdentity & {
  action: (formData: FormData) => void | Promise<void>;
  className?: string;
  children: ReactNode;
  visible?: boolean;
}) {
  const { submissionId, ready } = usePersistentPurchaseOperationId(identity);
  if (!visible) return null;

  return (
    <form action={action} className={className} aria-busy={!ready}>
      <input type="hidden" name="client_submission_id" value={submissionId} />
      <fieldset disabled={!ready} className="min-w-0 border-0 p-0">
        {children}
      </fieldset>
    </form>
  );
}

type ConfirmDialogProps = ComponentProps<typeof ConfirmDialog>;

export function PersistentPurchaseConfirmDialog({
  purchaseId,
  operation,
  initialSubmissionId,
  confirmedSubmissionId,
  visible = true,
  hiddenFields = [],
  ...dialogProps
}: PurchaseOperationIdentity & ConfirmDialogProps & { visible?: boolean }) {
  const { submissionId, ready } = usePersistentPurchaseOperationId({
    purchaseId,
    operation,
    initialSubmissionId,
    confirmedSubmissionId,
  });
  if (!visible) return null;
  if (!ready) {
    return (
      <button type="button" className={dialogProps.buttonClassName ?? "btn-secondary"} disabled>
        {dialogProps.triggerLabel}
      </button>
    );
  }

  return (
    <ConfirmDialog
      {...dialogProps}
      hiddenFields={[
        ...hiddenFields.filter((field) => field.name !== "client_submission_id"),
        { name: "client_submission_id", value: submissionId },
      ]}
    />
  );
}
