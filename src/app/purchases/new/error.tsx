"use client";

import Link from "next/link";

export default function NewPurchaseError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="surface-card border-rose-200">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-slate-950">Purchase form needs a refresh</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The form state hit a problem, but no purchase was received and no inventory movement was created. Retry the form, or go back to purchases.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={reset} className="btn-primary">Retry form</button>
          <Link href="/purchases" className="btn-secondary">Back to purchases</Link>
        </div>
      </div>
    </div>
  );
}
