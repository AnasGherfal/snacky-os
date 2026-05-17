"use client";

import Link from "next/link";

export default function InventoryMovementsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <div className="mx-auto max-w-3xl rounded-lg border border-rose-200 bg-rose-50 p-6 text-center">
        <h1 className="text-lg font-semibold text-rose-950">Could not load inventory movement log</h1>
        <p className="mt-2 text-sm text-rose-800">The page only shows real inventory_movements data, and the request failed before the log could be rendered.</p>
        <div className="mt-5 flex justify-center gap-3">
          <button type="button" className="btn-primary" onClick={() => reset()}>Try again</button>
          <Link href="/inventory" className="btn-secondary">Back to inventory</Link>
        </div>
      </div>
    </main>
  );
}
