"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function VmsAdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[vms-import] VMS admin error boundary caught a render error", {
      failedSection: "VMS admin section",
      digest: error.digest ?? null,
      message: error.message || null,
    });
  }, [error]);

  return (
    <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-xl border border-slate-200 bg-white p-5 text-slate-950 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Snacky OS</p>
            <h1 className="mt-1 text-xl font-semibold">Something did not load</h1>
            <p className="mt-2 text-sm text-slate-600">
              Snacky OS hit an unexpected error while loading VMS Import. Please try again or return to the dashboard.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={reset} className="btn-primary w-fit">
              Try again
            </button>
            <Link href="/dashboard" className="btn-secondary w-fit">
              Back to dashboard
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
