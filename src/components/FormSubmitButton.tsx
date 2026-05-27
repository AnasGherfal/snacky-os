"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

type FormSubmitButtonProps = {
  children: ReactNode;
  pendingLabel?: string;
  slowLabel?: string;
  slowAfterMs?: number;
  className?: string;
  disabled?: boolean;
};

export function FormSubmitButton({
  children,
  pendingLabel = "Saving...",
  slowLabel,
  slowAfterMs = 12000,
  className = "btn-primary",
  disabled = false,
}: FormSubmitButtonProps) {
  const { pending } = useFormStatus();
  const [clickedPending, setClickedPending] = useState(false);
  const [showSlowLabel, setShowSlowLabel] = useState(false);
  const activePending = pending || clickedPending;

  useEffect(() => {
    if (!activePending || !slowLabel) {
      setShowSlowLabel(false);
      return;
    }
    const timer = setTimeout(() => setShowSlowLabel(true), slowAfterMs);
    return () => clearTimeout(timer);
  }, [activePending, slowAfterMs, slowLabel]);

  function handleClick(event: MouseEvent<HTMLButtonElement>) {
    if (disabled || activePending) return;
    const form = event.currentTarget.form;
    if (form && !form.checkValidity()) return;
    setClickedPending(true);
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
      ) : children}
    </button>
  );
}
