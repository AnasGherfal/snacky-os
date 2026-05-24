"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function NewRouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[routes:new:error-boundary] Create route render failed", {
      message: error.message,
      digest: error.digest ?? null,
      stack: error.stack ?? null,
    });
  }, [error]);

  return (
    <ErrorState
      title="Create route could not load"
      body="Route planning data or reservations could not be loaded. Refresh the form; if it repeats, check the route_status migration and route reservation query in Supabase."
      action={
        <>
          <button type="button" className="btn-primary" onClick={() => reset()}>Retry create route</button>
          <Link href="/routes" className="btn-secondary">Back to routes</Link>
        </>
      }
    />
  );
}
