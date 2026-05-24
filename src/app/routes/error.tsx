"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function RoutesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[routes:error-boundary] Route workspace render failed", {
      message: error.message,
      digest: error.digest ?? null,
      stack: error.stack ?? null,
    });
  }, [error]);

  return (
    <ErrorState
      title="Could not load routes"
      body="Snacky OS could not load route data. Refresh this page; if it repeats, ask an admin to check route status migrations and Supabase permissions."
      action={
        <>
          <button type="button" className="btn-primary" onClick={() => reset()}>Try again</button>
          <Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>
        </>
      }
    />
  );
}
