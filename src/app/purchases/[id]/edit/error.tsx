"use client";

import Link from "next/link";

export default function EditPurchaseError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="surface-card border-rose-200">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-slate-950">Could not keep editing this purchase</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          The draft edit form hit a problem. No receive action was completed from this screen unless you already confirmed it.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={reset} className="btn-primary">Retry form</button>
          <Link href="/purchases" className="btn-secondary">Back to purchases</Link>
        </div>
      </div>
    </div>
  );
}
