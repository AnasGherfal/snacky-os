"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * Do not let global dashboard shortcuts interrupt an active machine refill.
 * Navigation remains available from the operator home page / menu.
 */
export function OperatorHomeShortcuts({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  if (/^\/operator\/routes\/[^/]+\/stops\/[^/]+(?:\/|$)/.test(pathname)) return null;
  return <>{children}</>;
}
