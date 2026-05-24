"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function InventoryError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[inventory:error-boundary] Inventory render failed", {
      message: error.message,
      digest: error.digest ?? null,
      stack: error.stack ?? null,
    });
  }, [error]);

  return (
    <ErrorState
      title="Could not load inventory"
      body="Snacky OS could not load storage, ledger movements, or reservations. Refresh this page; if it repeats, check inventory_movements and route reservation access."
      action={
        <>
          <button type="button" className="btn-primary" onClick={() => reset()}>Try again</button>
          <Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>
        </>
      }
    />
  );
}
