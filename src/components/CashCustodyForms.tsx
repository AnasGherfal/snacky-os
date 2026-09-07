"use client";

import { useMemo, useState } from "react";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField } from "@/components/ui";
import {
  CASH_DENOMINATIONS,
  calculateDenominationTotal,
  denominationFieldName,
  denominationKey,
} from "@/lib/cash-custody";

type FormAction = (formData: FormData) => void | Promise<void>;

export type CountWitnessOption = {
  id: string;
  label: string;
};

function libyaNow() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

const evidenceAccept = "image/png,image/jpeg,image/webp,application/pdf";

export function CashStorageReceiptForm({ action, id, clientSubmissionId }: { action: FormAction; id: string; clientSubmissionId: string }) {
  return (
    <LocalDraftForm action={action} formType="cash-storage-receipt" draftKeyParts={[id]} className="mt-5 space-y-4">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="client_submission_id" value={clientSubmissionId} />
      <FormField label="Received date and time" required>
        <input name="received_at" type="datetime-local" required defaultValue={libyaNow()} className="field-input" />
      </FormField>
      <FormField label="Safe / storage location" required hint="Be specific enough to locate the sealed bag without asking the collector.">
        <input name="storage_location" required className="field-input" placeholder="Example: Office safe — shelf B" />
      </FormField>
      <FormField label="Seal condition at handoff" required>
        <select name="seal_condition" required defaultValue="intact" className="field-input">
          <option value="intact">Intact — ID matches</option>
          <option value="broken">Broken / opened</option>
          <option value="mismatch">ID does not match</option>
        </select>
      </FormField>
      <FormField label="Handoff photo" required hint="Show the readable seal ID and the bag at the storage location.">
        <input name="evidence_file" type="file" accept="image/png,image/jpeg,image/webp" capture="environment" required className="field-input" />
      </FormField>
      <FormField label="Handoff notes" hint="Required if the seal is broken or mismatched.">
        <textarea name="notes" rows={3} className="field-input" />
      </FormField>
      <button className="btn-primary w-full">Acknowledge into storage</button>
    </LocalDraftForm>
  );
}

export function CashCountForm({
  action,
  id,
  clientSubmissionId,
  witnesses,
}: {
  action: FormAction;
  id: string;
  clientSubmissionId: string;
  witnesses: CountWitnessOption[];
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [otherAmount, setOtherAmount] = useState(0);
  const total = useMemo(() => calculateDenominationTotal(counts, otherAmount), [counts, otherAmount]);

  return (
    <LocalDraftForm action={action} formType="cash-denomination-count" draftKeyParts={[id]} className="mt-5 space-y-4">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="client_submission_id" value={clientSubmissionId} />
      <FormField label="Counted date and time" required>
        <input name="counted_at" type="datetime-local" required defaultValue={libyaNow()} className="field-input" />
      </FormField>
      <FormField label="Seal condition before opening" required>
        <select name="seal_condition" required defaultValue="intact" className="field-input">
          <option value="intact">Intact — ID matches</option>
          <option value="broken">Broken / opened</option>
          <option value="mismatch">ID does not match</option>
        </select>
      </FormField>
      <FormField label="Count witness" required hint="A second active team member must watch the physical count and confirm the total.">
        <select name="count_witness_id" required defaultValue="" className="field-input">
          <option value="" disabled>Select the witness</option>
          {witnesses.map((witness) => <option key={witness.id} value={witness.id}>{witness.label}</option>)}
        </select>
      </FormField>
      <div>
        <div className="text-sm font-medium text-slate-800">Count every denomination</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {CASH_DENOMINATIONS.map((denomination) => {
            const key = denominationKey(denomination);
            const quantity = counts[key] ?? 0;
            return (
              <label key={key} className="grid grid-cols-[1fr_90px] items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
                <span><span className="font-semibold">{denomination} LYD</span><span className="ms-2 text-xs text-slate-500">= {(quantity * denomination).toFixed(2)}</span></span>
                <input
                  name={denominationFieldName(denomination)}
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  value={quantity || ""}
                  onChange={(event) => setCounts((current) => ({ ...current, [key]: Math.max(0, Math.trunc(Number(event.target.value) || 0)) }))}
                  className="field-input text-end"
                  placeholder="Qty"
                />
              </label>
            );
          })}
        </div>
      </div>
      <FormField label="Other verified cash amount LYD" hint="Only for a valid denomination not listed above; explain it in notes.">
        <input name="other_amount_lyd" type="number" min="0" step="0.01" value={otherAmount || ""} onChange={(event) => setOtherAmount(Math.max(0, Number(event.target.value) || 0))} className="field-input" />
      </FormField>
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="text-xs font-semibold uppercase tracking-wide text-emerald-800">Combined physical total</div>
        <div className="mt-1 text-3xl font-semibold text-emerald-950">{total.toFixed(2)} LYD</div>
        <p className="mt-1 text-xs text-emerald-800">One total for the whole sealed bag—even if cash boxes from several machines were mixed.</p>
      </div>
      <FormField label="Count sheet / cash photo" required>
        <input name="evidence_file" type="file" accept={evidenceAccept} capture="environment" required className="field-input" />
      </FormField>
      <FormField label="Count notes" hint="Required for a broken seal, mismatched seal, zero count, or other amount.">
        <textarea name="notes" rows={4} className="field-input" />
      </FormField>
      <button className="btn-primary w-full">Confirm denomination count</button>
    </LocalDraftForm>
  );
}

export function CashReconciliationForms({
  calculateAction,
  reconcileAction,
  id,
  calculateSubmissionId,
  reconcileSubmissionId,
}: {
  calculateAction: FormAction;
  reconcileAction: FormAction;
  id: string;
  calculateSubmissionId: string;
  reconcileSubmissionId: string;
}) {
  return (
    <div className="mt-5 space-y-5">
      <form action={calculateAction}>
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="client_submission_id" value={calculateSubmissionId} />
        <button className="btn-secondary w-full">1. Calculate exact VMS intervals</button>
      </form>
      <LocalDraftForm action={reconcileAction} formType="cash-reconciliation" draftKeyParts={[id]} className="space-y-4 border-t border-slate-200 pt-5">
        <input type="hidden" name="id" value={id} />
        <input type="hidden" name="client_submission_id" value={reconcileSubmissionId} />
        <FormField label="Verified combined VMS cash total LYD" hint="Leave blank to use the exact automatic total. If exact transaction data is unavailable, enter one total for the whole batch—never invent machine splits.">
          <input name="manual_expected_cash_lyd" type="number" min="0" step="0.01" className="field-input" />
        </FormField>
        <FormField label="Manual total source / reason" hint="Required when entering a verified total. Include report name and date range.">
          <textarea name="override_reason" rows={3} className="field-input" placeholder="Example: XY VMS cash sales export, 15–31 Aug 2026, verified by…" />
        </FormField>
        <FormField label="Reconciliation notes">
          <textarea name="notes" rows={3} className="field-input" />
        </FormField>
        <button className="btn-primary w-full">2. Reconcile combined total</button>
      </LocalDraftForm>
    </div>
  );
}

export function CashVarianceResolutionForm({ action, id, clientSubmissionId }: { action: FormAction; id: string; clientSubmissionId: string }) {
  return (
    <LocalDraftForm action={action} formType="cash-variance-resolution" draftKeyParts={[id]} className="mt-5 space-y-4">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="client_submission_id" value={clientSubmissionId} />
      <FormField label="Resolution category" required>
        <select name="resolution" required defaultValue="" className="field-input">
          <option value="" disabled>Select the verified cause</option>
          <option value="counting_error">Counting error</option>
          <option value="vms_timing">VMS timing / date boundary</option>
          <option value="cash_left_in_machine">Cash left inside machine</option>
          <option value="vms_data_gap">VMS data gap</option>
          <option value="documented_business_use">Documented business use</option>
          <option value="custody_loss">Confirmed custody loss</option>
          <option value="other">Other verified cause</option>
        </select>
      </FormField>
      <FormField label="Evidence-based resolution" required hint="State what was checked, the proof, and who is responsible for any corrective action.">
        <textarea name="reason" rows={5} required className="field-input" />
      </FormField>
      <button className="btn-primary w-full">Approve resolution</button>
    </LocalDraftForm>
  );
}
