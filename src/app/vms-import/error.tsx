"use client";

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
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-amber-950 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">VMS admin section</p>
            <h1 className="mt-1 text-xl font-semibold">Failed section: VMS admin</h1>
            <p className="mt-2 text-sm text-amber-900">
              Snacky OS caught a VMS render error instead of showing the generic production error page.
            </p>
          </div>
          <button type="button" onClick={reset} className="btn-primary w-fit">
            Retry
          </button>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div className="rounded-lg border border-amber-200 bg-white p-3">
            <dt className="font-semibold text-slate-900">Digest</dt>
            <dd className="mt-1 break-words text-slate-700">{error.digest || "Not provided"}</dd>
          </div>
          <div className="rounded-lg border border-amber-200 bg-white p-3">
            <dt className="font-semibold text-slate-900">Message</dt>
            <dd className="mt-1 break-words text-slate-700">{error.message || "No message available"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
