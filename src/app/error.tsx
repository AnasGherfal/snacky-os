"use client";

import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const message = error?.message && error.message !== "[object Object]" ? error.message : "Snacky OS hit an unexpected error while loading this page.";

  return (
    <ErrorState
      title="Something did not load"
      body={message}
      action={
        <>
          <button type="button" onClick={reset} className="btn-primary">Try again</button>
          <Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>
        </>
      }
    />
  );
}
