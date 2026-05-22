"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

type FormSubmitButtonProps = {
  children: ReactNode;
  pendingLabel?: string;
  className?: string;
};

export function FormSubmitButton({ children, pendingLabel = "Saving...", className = "btn-primary" }: FormSubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
