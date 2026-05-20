"use client";

import Link from "next/link";
import { ErrorState } from "@/components/ui";

export default function InventoryMovementsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="Could not load inventory movement log"
      body="The page only shows real inventory_movements data, and the request failed before the log could be rendered."
      action={
        <>
          <button type="button" className="btn-primary" onClick={() => reset()}>Try again</button>
          <Link href="/inventory" className="btn-secondary">Back to inventory</Link>
        </>
      }
    />
  );
}
