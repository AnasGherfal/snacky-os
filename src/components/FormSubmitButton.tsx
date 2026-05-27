"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

type FormSubmitButtonProps = {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
  disabled?: boolean;
};

export function FormSubmitButton({ children, pendingLabel = "Saving...", className = "btn-primary", disabled = false }: FormSubmitButtonProps) {
  const { pending } = useFormStatus();
  const [clickedPending, setClickedPending] = useState(false);
  const activePending = pending || clickedPending;

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
        <span className="inline-flex items-center gap-2">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
          {pendingLabel}
        </span>
      ) : children}
    </button>
  );
}
