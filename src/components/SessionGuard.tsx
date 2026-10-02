"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type SessionState = {
  authenticated: boolean;
  expiresAt: number | null;
  secondsUntilExpiry: number;
};

const sessionRefreshThresholdSeconds = 5 * 60;
const activityRefreshThresholdSeconds = 10 * 60;
const activityRefreshCooldownMs = 60 * 1000;

function validExpiresAt(value: unknown) {
  const expiresAt = Number(value);
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null;
}

function secondsUntil(expiresAt: number | null) {
  if (!expiresAt) return 0;
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

function sessionFromPayload(payload: unknown): SessionState | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as { authenticated?: unknown; ok?: unknown; expiresAt?: unknown; secondsUntilExpiry?: unknown };
  const authenticated = Boolean(data.authenticated ?? data.ok);
  const expiresAt = validExpiresAt(data.expiresAt);
  const rawFallbackSeconds = Number(data.secondsUntilExpiry ?? 0);
  const fallbackSeconds = Number.isFinite(rawFallbackSeconds) ? Math.max(0, rawFallbackSeconds) : 0;

  return {
    authenticated,
    expiresAt,
    secondsUntilExpiry: expiresAt ? secondsUntil(expiresAt) : fallbackSeconds,
  };
}

export function SessionGuard() {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const [session, setSession] = useState<SessionState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const lastActivityRefreshAt = useRef(0);
  const sessionRef = useRef<SessionState | null>(null);
  const warningTimerRef = useRef<number | null>(null);
  const expiryTimerRef = useRef<number | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const redirectTimerRef = useRef<number | null>(null);

  const loginAgain = useCallback(() => {
    router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    router.refresh();
  }, [pathname, router]);

  const clearSessionTimers = useCallback(() => {
    if (warningTimerRef.current !== null) {
      window.clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
    if (expiryTimerRef.current !== null) {
      window.clearTimeout(expiryTimerRef.current);
      expiryTimerRef.current = null;
    }
    if (redirectTimerRef.current !== null) {
      window.clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
  }, []);

  const loadSession = useCallback(async ({ silent = false, allowError = false }: { silent?: boolean; allowError?: boolean } = {}) => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    const nextSession = sessionFromPayload(payload);

    if (!response.ok || !nextSession?.authenticated || !nextSession.expiresAt) {
      if (allowError) {
        clearSessionTimers();
        sessionRef.current = null;
        setSession(null);
        setErrorMessage("Your session expired. Sign in again and Snacky OS will reopen this page.");
        setWarningOpen(true);
        redirectTimerRef.current = window.setTimeout(loginAgain, 1200);
      }
      return null;
    }

    sessionRef.current = nextSession;
    setSession(nextSession);
    setWarningOpen(false);
    setErrorMessage("");
    if (!silent) router.refresh();
    return nextSession;
  }, [clearSessionTimers, loginAgain, router]);

  const continueSession = useCallback(async () => {
    setRefreshing(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/auth/session", { method: "POST" });
      const payload = await response.json().catch(() => null);
      const refreshedSession = sessionFromPayload(payload);
      if (!response.ok || !payload?.ok || !refreshedSession?.authenticated || !refreshedSession.expiresAt) {
        clearSessionTimers();
        setErrorMessage("Could not continue session. Please save your work and log in again.");
        setWarningOpen(true);
        return;
      }

      lastActivityRefreshAt.current = Date.now();
      sessionRef.current = refreshedSession;
      setSession(refreshedSession);
      setWarningOpen(false);
      setErrorMessage("");
      router.refresh();
    } catch {
      clearSessionTimers();
      setErrorMessage("Could not continue session. Please save your work and log in again.");
      setWarningOpen(true);
    } finally {
      setRefreshing(false);
    }
  }, [clearSessionTimers, router]);

  useEffect(() => {
    sessionRef.current = session;
    clearSessionTimers();

    if (!session?.authenticated || !session.expiresAt) {
      return;
    }

    const msUntilExpiry = session.expiresAt - Date.now();
    if (msUntilExpiry <= 0) {
      window.setTimeout(() => {
        void loadSession({ allowError: true });
      }, 0);
      return;
    }

    warningTimerRef.current = window.setTimeout(() => {
      void loadSession({ silent: true });
    }, Math.max(60 * 1000, msUntilExpiry - sessionRefreshThresholdSeconds * 1000));

    expiryTimerRef.current = window.setTimeout(() => {
      void loadSession({ allowError: true });
    }, msUntilExpiry);

    return () => {
      clearSessionTimers();
    };
  }, [clearSessionTimers, loadSession, session]);

  useEffect(() => {
    const initialLoadTimer = window.setTimeout(() => {
      void loadSession({ silent: true });
    }, 0);

    const onVisibilityChange = () => {
      if (!document.hidden) {
        void loadSession({ silent: true });
      }
    };

    pollTimerRef.current = window.setInterval(() => {
      if (!document.hidden) {
        void loadSession({ silent: true });
      }
    }, 5 * 60 * 1000);

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearTimeout(initialLoadTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (pollTimerRef.current !== null) {
        window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      clearSessionTimers();
    };
  }, [clearSessionTimers, loadSession]);

  useEffect(() => {
    const onActivity = () => {
      const currentSession = sessionRef.current;
      if (!currentSession?.authenticated || !currentSession.expiresAt) return;
      const seconds = secondsUntil(currentSession.expiresAt);
      if (seconds <= 0 || seconds > activityRefreshThresholdSeconds) return;
      const now = Date.now();
      if (now - lastActivityRefreshAt.current < activityRefreshCooldownMs) return;
      lastActivityRefreshAt.current = now;
      void loadSession({ silent: true });
    };

    window.addEventListener("pointerdown", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity);
    window.addEventListener("input", onActivity);
    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("input", onActivity);
    };
  }, [loadSession]);

  if (!warningOpen && !errorMessage) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(26rem,calc(100vw-2rem))] rounded-lg border border-amber-200 bg-white p-4 text-sm shadow-xl">
      <div className="font-semibold text-slate-950">{errorMessage ? "Session could not be continued." : "Your session will expire soon."}</div>
      <p className="mt-1 text-slate-600">
        {errorMessage || "Click Continue to stay logged in. Unsaved purchase drafts are also saved locally on this device."}
      </p>
      {!errorMessage && session?.secondsUntilExpiry ? (
        <p className="mt-2 text-xs font-medium text-slate-700">Time remaining: {Math.floor(session.secondsUntilExpiry / 60)}m {session.secondsUntilExpiry % 60}s</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => void continueSession()} disabled={refreshing} className="btn-primary">
          {refreshing ? "Continuing..." : "Continue Session"}
        </button>
        {errorMessage || (session && session.secondsUntilExpiry <= 30) ? (
          <button type="button" onClick={loginAgain} className="btn-secondary">Sign in again</button>
        ) : null}
      </div>
    </div>
  );
}



