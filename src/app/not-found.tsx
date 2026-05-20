import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 px-4 py-10">
      <div className="w-full max-w-xl rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">404</div>
        <h1 className="mt-4 text-xl font-semibold text-slate-900">Page not found</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
          This page is not part of the current Snacky OS workflow, or the record may have been removed.
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link href="/dashboard" className="btn-primary">Back to dashboard</Link>
          <Link href="/admin" className="btn-secondary">Open admin</Link>
        </div>
      </div>
    </main>
  );
}
