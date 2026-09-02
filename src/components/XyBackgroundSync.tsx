"use client";

import { useEffect, useRef } from "react";
import { refreshXyRoutePlanningDataAction } from "@/lib/xy-vms-actions";

const XY_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export function XyBackgroundSync({ enabled }: { enabled: boolean }) {
  const running = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const refresh = async () => {
      if (running.current || document.visibilityState !== "visible") return;
      running.current = true;
      try {
        await refreshXyRoutePlanningDataAction();
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
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled]);

  return null;
}
