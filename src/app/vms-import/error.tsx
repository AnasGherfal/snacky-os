"use client";

import Link from "next/link";
import { useEffect } from "react";
import { LocalDraftForm } from "@/components/LocalDraft";
import { FormSubmitButton } from "@/components/FormSubmitButton";
import { prepareVmsImport } from "@/lib/vms-import-actions";

function summarizeError(error: Error & { digest?: string }) {
  return {
    message: error.message || "Unknown VMS import error",
    digest: error.digest ?? null,
  };
}

export default function VmsImportError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[vms-import:error-boundary] VMS Import render failed", {
      ...summarizeError(error),
      stack: error.stack ?? null,
    });
  }, [error]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-6 flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">VMS Import</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
            Upload and review VMS files. If one file fails, the rest of the page stays available.
          </p>
        </div>
        <div className="w-full shrink-0 sm:w-auto [&>*]:w-full sm:[&>*]:w-auto">
          <Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>
        </div>
      </div>

      <div className="space-y-6">
        <section className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-slate-950 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-wide text-rose-700">Import failed</p>
              <h1 className="mt-1 text-xl font-semibold text-slate-950">Could not load this VMS file</h1>
              <p className="mt-2 text-sm leading-6 text-slate-700">
                Snacky OS could not finish loading the VMS import page for this file. You can try the upload again below, or return to the dashboard and come back later.
              </p>
              <p className="mt-3 text-xs text-slate-500">
                Technical reference: {summarizeError(error).message}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={reset} className="btn-primary w-fit">
                Try again
              </button>
              <Link href="/vms-import" className="btn-secondary w-fit">
                Reload import page
              </Link>
            </div>
          </div>
        </section>

        <section className="surface-card">
          <LocalDraftForm action={prepareVmsImport} formType="vms-import" draftKeyParts={["error-recovery"]} className="space-y-4 p-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Reupload file</h2>
              <p className="mt-1 text-sm text-slate-500">
                This lets you retry the import without leaving the VMS workflow.
              </p>
            </div>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">VMS file <span className="text-rose-600">*</span></span>
              <input
                name="file"
                type="file"
                accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                required
                className="field-input"
              />
              <span className="block text-xs leading-5 text-slate-500">Accepted: .xlsx, .xls, .csv</span>
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-800">Report type</span>
              <select name="report_type" defaultValue="" className="field-input">
                <option value="">Auto-detect</option>
                <option value="vms_order_details_weekly">Detailed Order Details - Recommended</option>
                <option value="monthly_transaction_details">Monthly Transaction Report</option>
                <option value="monthly_product_profit">Monthly Profit Report</option>
                <option value="machine_stock_snapshot">Machine Stock Snapshot</option>
                <option value="stock">Machine Goods / Stock</option>
                <option value="sales">General / Summary Sales Report</option>
              </select>
              <span className="block text-xs leading-5 text-slate-500">Leave on auto-detect unless you know the file type.</span>
            </label>
            <FormSubmitButton className="btn-primary w-full" pendingLabel="Reading file and preparing preview...">
              Upload again
            </FormSubmitButton>
          </LocalDraftForm>
        </section>
      </div>
    </main>
  );
}
