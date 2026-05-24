"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function OperatorRoutesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[operator:routes:error-boundary] Operator route render failed", {
      message: error.message,
      digest: error.digest ?? null,
      stack: error.stack ?? null,
    });
  }, [error]);

  return (
    <ErrorState
      title="Operator route could not load"
      body="Snacky OS could not load the assigned route workflow. Refresh this page; if it repeats, ask a supervisor to check your route assignment and role access."
      action={
        <>
          <button type="button" className="btn-primary" onClick={() => reset()}>Try again</button>
          <Link href="/operator" className="btn-secondary">Back to operator home</Link>
        </>
      }
    />
  );
}
