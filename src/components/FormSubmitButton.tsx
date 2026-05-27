"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
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
  timeoutLabel = "Save took too long. Please check your connection and retry.",
  timeoutMs = 30000,
  className = "btn-primary",
  disabled = false,
}: FormSubmitButtonProps) {
  const { pending } = useFormStatus();
  const [optimisticPending, setOptimisticPending] = useState(false);
  const [showSlowLabel, setShowSlowLabel] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const activePending = !timedOut && (pending || optimisticPending);

  useEffect(() => {
    if (!activePending || !slowLabel) {
      setShowSlowLabel(false);
      return;
    }
    const timer = setTimeout(() => setShowSlowLabel(true), slowAfterMs);
    return () => clearTimeout(timer);
  }, [activePending, slowAfterMs, slowLabel]);

  useEffect(() => {
    if (!optimisticPending || pending) return;
    const timer = setTimeout(() => setOptimisticPending(false), 1500);
    return () => clearTimeout(timer);
  }, [optimisticPending, pending]);

  useEffect(() => {
    if (!pending) {
      setTimedOut(false);
      return;
    }
    const timer = setTimeout(() => {
      setTimedOut(true);
      setOptimisticPending(false);
      setShowSlowLabel(false);
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [optimisticPending, pending, timeoutMs]);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (disabled || activePending) return;
    const form = event.currentTarget.form;
    if (form && !form.checkValidity()) return;
    setTimedOut(false);
    setOptimisticPending(true);
  }

  return (
    <button
      type="submit"
      className={`${className} disabled:cursor-not-allowed disabled:opacity-60`}
      disabled={disabled || activePending}
      aria-busy={activePending}
      onClick={handleClick}
    >
      {activePending ? (
        <span className="inline-flex flex-col items-center justify-center gap-1 text-center">
          <span className="inline-flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
            {pendingLabel}
          </span>
          {showSlowLabel ? <span className="text-xs font-medium opacity-80">{slowLabel}</span> : null}
        </span>
      ) : timedOut ? (
        <span className="inline-flex flex-col items-center justify-center gap-1 text-center">
          <span>{children}</span>
          <span className="text-xs font-medium opacity-80">{timeoutLabel}</span>
        </span>
      ) : children}
    </button>
  );
}
