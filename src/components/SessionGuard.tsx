"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type SessionState = {
  authenticated: boolean;
  secondsUntilExpiry: number;
};

const warningThresholdSeconds = 5 * 60;
const activityRefreshThresholdSeconds = 10 * 60;
const activityRefreshCooldownMs = 60 * 1000;

export function SessionGuard() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<SessionState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const lastActivityRefreshAt = useRef(0);
  const latestSeconds = useRef<number | null>(null);

  const loginAgain = useCallback(() => {
    router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    router.refresh();
  }, [pathname, router]);

  const loadSession = useCallback(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json().catch(() => null);
    if (!payload) return;
    const next = {
      authenticated: Boolean(payload.authenticated),
      secondsUntilExpiry: Number(payload.secondsUntilExpiry ?? 0),
    };
    latestSeconds.current = next.secondsUntilExpiry;
    setSession(next);
  }, []);

  const continueSession = useCallback(async () => {
    setRefreshing(true);
    setMessage("");
    try {
      const response = await fetch("/api/auth/session", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        setMessage("Your session expired. Sign in again and Snacky OS will reopen this page.");
        window.setTimeout(loginAgain, 1200);
        return;
      }
      const secondsUntilExpiry = Number(payload.secondsUntilExpiry ?? 0);
      latestSeconds.current = secondsUntilExpiry;
      setSession({ authenticated: true, secondsUntilExpiry });
      setMessage("Session continued.");
    } finally {
      setRefreshing(false);
    }
  }, [loginAgain]);

  useEffect(() => {
    const initialTimer = window.setTimeout(loadSession, 0);
    const intervalTimer = window.setInterval(loadSession, 60 * 1000);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalTimer);
    };
  }, [loadSession]);

  useEffect(() => {
    const onActivity = () => {
      const seconds = latestSeconds.current;
      if (seconds === null || seconds > activityRefreshThresholdSeconds) return;
      const now = Date.now();
      if (now - lastActivityRefreshAt.current < activityRefreshCooldownMs) return;
      lastActivityRefreshAt.current = now;
      void continueSession();
    };

    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("input", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("input", onActivity);
    };
  }, [continueSession]);

  const showWarning = session?.authenticated && session.secondsUntilExpiry <= warningThresholdSeconds;
  if (!showWarning && !message) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-amber-200 bg-white p-4 text-sm shadow-xl">
      <div className="font-semibold text-slate-950">Your session will expire soon.</div>
      <p className="mt-1 text-slate-600">Click Continue to stay logged in. Unsaved purchase drafts are also saved locally on this device.</p>
      {message ? <p className="mt-2 text-xs font-medium text-slate-700">{message}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={continueSession} disabled={refreshing} className="btn-primary">
          {refreshing ? "Continuing..." : "Continue Session"}
        </button>
        {session && session.secondsUntilExpiry <= 30 ? (
          <button type="button" onClick={loginAgain} className="btn-secondary">Sign in again</button>
        ) : null}
      </div>
    </div>
  );
}
