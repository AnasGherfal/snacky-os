"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { LocalDraftForm } from "@/components/LocalDraft";
import {
  confirmedFinanceCreateOperationId,
  financeCreateOperationStorageKey,
  isFinanceOperationId,
  resolveFinanceCreateOperationId,
} from "@/lib/finance-operation-id";

export function FinanceTransactionCreateForm({
  action,
  userId,
  initialSubmissionId,
  className,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  userId: string;
  initialSubmissionId: string;
  className?: string;
  children: ReactNode;
}) {
  const storageKey = useMemo(() => financeCreateOperationStorageKey(userId), [userId]);
  const [submissionId, setSubmissionId] = useState(initialSubmissionId);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let storedId = "";
    try {
      storedId = window.localStorage.getItem(storageKey) ?? "";
    } catch {
      // The server-rendered UUID remains stable for this mounted form.
    }
    const resolved = resolveFinanceCreateOperationId({
      storedId,
      initialId: initialSubmissionId,
      createId: () => globalThis.crypto?.randomUUID?.() ?? "",
    });
    if (resolved) {
      try {
        window.localStorage.setItem(storageKey, resolved);
      } catch {
        // Keep the in-memory UUID if browser storage is unavailable.
      }
    }
    const timer = window.setTimeout(() => {
      setSubmissionId(resolved || initialSubmissionId);
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialSubmissionId, storageKey]);

  const persistentAction = useCallback(async (formData: FormData) => {
    try {
      await action(formData);
    } catch (error) {
      const confirmedId = confirmedFinanceCreateOperationId(error);
      if (confirmedId && confirmedId === submissionId) {
        const replacement = globalThis.crypto?.randomUUID?.() ?? "";
        if (isFinanceOperationId(replacement)) {
          try {
            window.localStorage.setItem(storageKey, replacement);
          } catch {
            // Navigation still confirms success; the durable DB receipt is safe.
          }
          setSubmissionId(replacement);
        }
      }
      throw error;
    }
  }, [action, storageKey, submissionId]);

  return (
    <LocalDraftForm action={persistentAction} formType="finance-transaction" draftKeyParts={["new"]} userId={userId} className={className}>
      <input type="hidden" name="client_submission_id" value={submissionId} />
      <fieldset disabled={!ready} aria-busy={!ready} className="min-w-0 space-y-5 border-0 p-0">
        {children}
      </fieldset>
    </LocalDraftForm>
  );
}
