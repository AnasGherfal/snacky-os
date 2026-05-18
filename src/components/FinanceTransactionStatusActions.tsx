"use client";

import { useState } from "react";
import { updateFinancialTransactionStatus } from "@/lib/finance-actions";

type PendingStatus = "voided" | "archived";

export function FinanceTransactionStatusActions({ id, status }: { id: string; status: string | null | undefined }) {
  const [pendingStatus, setPendingStatus] = useState<PendingStatus | null>(null);
  const isActive = (status ?? "active") === "active";

  if (!isActive) {
    return <p className="text-sm text-slate-500">This transaction is {status}; it no longer affects the finance balance.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn-danger" onClick={() => setPendingStatus("voided")}>Void transaction</button>
        <button type="button" className="btn-secondary" onClick={() => setPendingStatus("archived")}>Archive transaction</button>
      </div>

      {pendingStatus ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-950">ConfirmDialog</h2>
            <p className="mt-2 text-sm text-slate-600">This will remove the transaction from balance calculations. Continue?</p>
            <form action={updateFinancialTransactionStatus} className="mt-4 space-y-4">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="transaction_status" value={pendingStatus} />
              <input type="hidden" name="confirm_balance_removal" value="yes" />
              <label className="block space-y-1">
                <span className="text-sm font-medium text-slate-800">Reason optional</span>
                <textarea name="status_reason" rows={3} className="field-input" />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setPendingStatus(null)}>Cancel</button>
                <button className={pendingStatus === "voided" ? "btn-danger" : "btn-primary"}>Continue</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
