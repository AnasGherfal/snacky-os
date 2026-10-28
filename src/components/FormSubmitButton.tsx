"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

type FormSubmitButtonProps = {
  children: ReactNode;
  pendingLabel?: string;
  slowLabel?: string;
  slowAfterMs?: number;
  timeoutLabel?: string;
  timeoutMs?: number;
  className?: string;
  disabled?: boolean;
};

export function FormSubmitButton({
  children,
  pendingLabel = "Saving...",
  slowLabel,
  slowAfterMs = 12000,
  timeoutLabel = "Still saving. Do not submit again; check the saved record before attempting a new request.",
  timeoutMs = 30000,
  className = "btn-primary",
  disabled = false,
}: FormSubmitButtonProps) {
  const { pending } = useFormStatus();
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [showSlowLabel, setShowSlowLabel] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const duplicateGuardRef = useRef(false);
  const activePending = pending || optimisticPending;

  useEffect(() => {
    if (!activePending || !slowLabel) {
      // Reset after the effect rather than synchronously cascading renders.
      const reset = setTimeout(() => setShowSlowLabel(false), 0);
      return () => clearTimeout(reset);
    }
    const timer = setTimeout(() => setShowSlowLabel(true), slowAfterMs);
    return () => clearTimeout(timer);
  }, [activePending, slowAfterMs, slowLabel]);

  useEffect(() => {
    if (!optimisticPending || pending) return;
    const timer = setTimeout(() => {
      setOptimisticPending(false);
      duplicateGuardRef.current = false;
    }, 1500);
    return () => clearTimeout(timer);
  }, [optimisticPending, pending]);

  useEffect(() => {
    if (!pending) {
      if (!optimisticPending) duplicateGuardRef.current = false;
      const reset = setTimeout(() => setTimedOut(false), 0);
      return () => clearTimeout(reset);
    }
    duplicateGuardRef.current = true;
    const resetOptimistic = setTimeout(() => setOptimisticPending(false), 0);
    const timer = setTimeout(() => {
      // Slow network is NOT a failed write. Never unlock while the server
      // action is still pending: a second click could create a duplicate.
      setTimedOut(true);
    }, timeoutMs);
    return () => {
      clearTimeout(timer);
      clearTimeout(resetOptimistic);
    };
  }, [optimisticPending, pending, timeoutMs]);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (disabled || pending || optimisticPending) {
      event.preventDefault();
      return;
    }
    const form = event.currentTarget.form;
    if (form && !form.checkValidity()) return;
    if (duplicateGuardRef.current) {
      event.preventDefault();
      return;
    }
    duplicateGuardRef.current = true;
    setTimedOut(false);
    window.setTimeout(() => setOptimisticPending(true), 0);
  }

  return (
    <button
      type="submit"
      className={`${className} disabled:cursor-not-allowed disabled:opacity-60`}
      disabled={disabled || pending || optimisticPending}
      aria-busy={activePending}
      onClick={handleClick}
    >
      {activePending ? (
        <span className="inline-flex flex-col items-center justify-center gap-1 text-center">
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
            {pendingLabel}
          </span>
          {timedOut ? <span role="status" className="text-xs font-medium opacity-90">{timeoutLabel}</span>
            : showSlowLabel ? <span className="text-xs font-medium opacity-80">{slowLabel}</span> : null}
        </span>
      ) : children}
    </button>
  );
}
