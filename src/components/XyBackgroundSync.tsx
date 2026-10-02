"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { refreshXyRoutePlanningDataAction } from "@/lib/xy-vms-actions";

const XY_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const XY_SHARED_COOLDOWN_MS = 20 * 60 * 1000;
const XY_RUNNING_RETRY_MS = 15 * 1000;
const XY_SHARED_ATTEMPT_KEY = "snacky:xy-vms:last-background-attempt";
const XY_DATA_PATHS = ["/dashboard", "/refills", "/machines", "/machines-dashboard", "/inventory-dashboard"];

export function XyBackgroundSync({ enabled }: { enabled: boolean }) {
  const running = useRef(false);
  const pathname = usePathname();
  const router = useRouter();
  const pathnameRef = useRef(pathname);
  const routerRef = useRef(router);
  pathnameRef.current = pathname;
  routerRef.current = router;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let retryId: number | null = null;

    const displaysXyData = () => XY_DATA_PATHS
      .some((path) => pathnameRef.current === path || pathnameRef.current.startsWith(`${path}/`));

    const sharedCooldownActive = () => {
      try {
        const last=Number(window.localStorage.getItem(XY_SHARED_ATTEMPT_KEY)??0);
        return Number.isFinite(last)&&last>0&&Date.now()-last<XY_SHARED_COOLDOWN_MS;
      } catch { return false; }
    };
    const claimSharedAttempt = () => {
      try { window.localStorage.setItem(XY_SHARED_ATTEMPT_KEY,String(Date.now())); } catch {}
    };

    const refresh = async (waitingForAnotherRun = false) => {
      if (running.current || document.visibilityState !== "visible") return;
      if (!waitingForAnotherRun && sharedCooldownActive()) return;
      claimSharedAttempt();
      running.current = true;
      try {
        const result = await refreshXyRoutePlanningDataAction();
        if (result.outcome === "in_progress") {
          if (retryId !== null) window.clearTimeout(retryId);
          retryId = window.setTimeout(() => void refresh(true), XY_RUNNING_RETRY_MS);
          return;
        }
        if (!stopped && displaysXyData() && (result.outcome === "refreshed" || (waitingForAnotherRun && result.outcome === "already_fresh"))) {
          routerRef.current.refresh();
        }
      } catch (error) {
        console.warn("[xy-background-sync] Automatic XY refresh failed; the last verified snapshot remains active.", error);
      } finally {
        running.current = false;
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    void refresh();
    const intervalId = window.setInterval(() => void refresh(), XY_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      if (retryId !== null) window.clearTimeout(retryId);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled]);

  return null;
}
