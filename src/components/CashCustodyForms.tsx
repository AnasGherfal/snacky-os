"use client";

import { LocalDraftForm } from "@/components/LocalDraft";
import { FormField } from "@/components/ui";

type FormAction = (formData: FormData) => void | Promise<void>;

function libyaNow() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

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
      <FormField label="Storage receipt photo" required hint="Show the readable seal ID and the bag at the storage location.">
        <input name="evidence_file" type="file" accept="image/png,image/jpeg,image/webp" capture="environment" required className="field-input" />
      </FormField>
      <FormField label="Handoff notes" hint="Required if the seal is broken or mismatched.">
        <textarea name="notes" rows={3} className="field-input" />
      </FormField>
      <button className="btn-primary w-full">Receive bag into storage</button>
    </LocalDraftForm>
  );
}

export function CashCountForm({
  action,
  id,
  clientSubmissionId,
  defaultPeriodEnd,
}: {
  action: FormAction;
  id: string;
  clientSubmissionId: string;
  defaultPeriodEnd: string;
}) {
  return (
    <LocalDraftForm action={action} formType="cash-total-count" draftKeyParts={[id]} className="mt-5 space-y-4">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="client_submission_id" value={clientSubmissionId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Cash period from" required>
          <input name="period_start" type="date" required max={defaultPeriodEnd} className="field-input" />
        </FormField>
        <FormField label="Cash period to" required>
          <input name="period_end" type="date" required defaultValue={defaultPeriodEnd} max={defaultPeriodEnd} className="field-input" />
        </FormField>
      </div>
      <FormField label="Total cash counted (LYD)" required hint="Enter one combined total for the whole bag. Do not split it by denomination or machine.">
        <input name="total_amount_lyd" type="number" inputMode="decimal" min="0" step="0.01" required className="field-input text-2xl font-semibold" placeholder="0.00" />
      </FormField>
      <p className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">Save the count now. The VMS comparison is a separate step and can be completed later.</p>
      <button className="btn-primary w-full">Save cash total</button>
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
        <button className="btn-secondary w-full">Calculate VMS total for this period</button>
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
        <button className="btn-primary w-full">Save VMS comparison</button>
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
