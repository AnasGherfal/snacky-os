"use client";

import { useState } from "react";
import { FormSubmitButton } from "@/components/FormSubmitButton";

type HiddenField = {
  name: string;
  value: string | number | boolean | null | undefined;
};

type ConfirmDialogProps = {
  action: (formData: FormData) => void | Promise<void>;
  triggerLabel: string;
  title: string;
  description: string;
  confirmLabel?: string;
  pendingConfirmLabel?: string;
  cancelLabel?: string;
  buttonClassName?: string;
  confirmButtonClassName?: string;
  hiddenFields?: HiddenField[];
  confirmName?: string;
  confirmValue?: string;
  reasonName?: string;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  requireReason?: boolean;
};

export function ConfirmDialog({
  action,
  triggerLabel,
  title,
  description,
  confirmLabel = "Confirm",
  pendingConfirmLabel,
  cancelLabel = "Cancel",
  buttonClassName = "btn-secondary",
  confirmButtonClassName = "btn-danger",
  hiddenFields = [],
  confirmName = "confirm_action",
  confirmValue = "yes",
  reasonName = "reason",
  reasonLabel = "Reason",
  reasonPlaceholder = "Explain why this action is needed.",
  requireReason = true,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const reasonMissing = requireReason && !reason.trim();

  return (
    <>
      <button type="button" className={buttonClassName} onClick={() => setOpen(true)}>
        {triggerLabel}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
            </div>
            <form action={action} className="mt-4 space-y-4">
              <input type="hidden" name={confirmName} value={confirmValue} />
              {hiddenFields.map((field) => (
                <input key={`${field.name}:${String(field.value ?? "")}`} type="hidden" name={field.name} value={String(field.value ?? "")} />
              ))}
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-800">
                  {reasonLabel}
                  {requireReason ? <span className="text-rose-600"> *</span> : null}
                </span>
                <textarea
                  name={reasonName}
                  rows={4}
                  required={requireReason}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="field-input"
                  placeholder={reasonPlaceholder}
                />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>
                  {cancelLabel}
                </button>
                <FormSubmitButton className={confirmButtonClassName} disabled={reasonMissing} pendingLabel={pendingConfirmLabel ?? `${confirmLabel}...`}>
                  {confirmLabel}
                </FormSubmitButton>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
