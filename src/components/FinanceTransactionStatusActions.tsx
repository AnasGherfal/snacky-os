"use client";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { updateFinancialTransactionStatus } from "@/lib/finance-actions";

export function FinanceTransactionStatusActions({ id, status }: { id: string; status: string | null | undefined }) {
  const isActive = (status ?? "active") === "active";

  if (!isActive) {
    return <p className="text-sm text-slate-500">This transaction is {status}; it no longer affects the finance balance.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <ConfirmDialog
          action={updateFinancialTransactionStatus}
          triggerLabel="Void transaction"
          title="Void financial transaction?"
          description="Voided transactions stay in the ledger but no longer affect the finance balance."
          confirmLabel="Void transaction"
          buttonClassName="btn-danger"
          confirmButtonClassName="btn-danger"
          reasonName="status_reason"
          hiddenFields={[
            { name: "id", value: id },
            { name: "transaction_status", value: "voided" },
            { name: "confirm_balance_removal", value: "yes" },
          ]}
        />
        <ConfirmDialog
          action={updateFinancialTransactionStatus}
          triggerLabel="Archive transaction"
          title="Archive financial transaction?"
          description="Archived transactions stay in history but are removed from active finance balance calculations."
          confirmLabel="Archive transaction"
          buttonClassName="btn-secondary"
          confirmButtonClassName="btn-primary"
          reasonName="status_reason"
          hiddenFields={[
            { name: "id", value: id },
            { name: "transaction_status", value: "archived" },
            { name: "confirm_balance_removal", value: "yes" },
          ]}
        />
      </div>
    </div>
  );
}
