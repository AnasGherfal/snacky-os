"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type SessionState = {
  authenticated: boolean;
  expiresAt: number | null;
  secondsUntilExpiry: number;
};

const warningThresholdSeconds = 5 * 60;
const activityRefreshThresholdSeconds = 10 * 60;
const activityRefreshCooldownMs = 60 * 1000;
const recentRefreshWarningSuppressMs = 60 * 1000;

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
  const lastSessionRefreshAt = useRef(0);
  const sessionRef = useRef<SessionState | null>(null);
  const warningOpenRef = useRef(false);
  const warningTimerRef = useRef<number | null>(null);
  const logoutTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
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
    if (logoutTimerRef.current !== null) {
      window.clearTimeout(logoutTimerRef.current);
      logoutTimerRef.current = null;
    }
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (redirectTimerRef.current !== null) {
      window.clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
  }, []);

  const setWarningVisible = useCallback((visible: boolean) => {
    warningOpenRef.current = visible;
    setWarningOpen(visible);
  }, []);

  const startCountdown = useCallback((expiresAt: number) => {
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
    }

    const tick = () => {
      const nextSeconds = secondsUntil(expiresAt);
      setSession((current) => {
        if (!current || current.expiresAt !== expiresAt) return current;
        return { ...current, secondsUntilExpiry: nextSeconds };
      });
    };

    tick();
    countdownIntervalRef.current = window.setInterval(tick, 1000);
  }, []);

  const scheduleSessionTimers = useCallback((nextSession: SessionState | null) => {
    clearSessionTimers();

    if (!nextSession?.authenticated || !nextSession.expiresAt) {
      setWarningVisible(false);
      return;
    }

    const expiresAt = nextSession.expiresAt;
    const msUntilExpiry = expiresAt - Date.now();
    if (msUntilExpiry <= 0) {
      setSession((current) => (current ? { ...current, secondsUntilExpiry: 0 } : current));
      setErrorMessage("Your session expired. Sign in again and Snacky OS will reopen this page.");
      setWarningVisible(true);
      redirectTimerRef.current = window.setTimeout(loginAgain, 1200);
      return;
    }

    const openWarning = () => {
      warningTimerRef.current = null;
      const current = sessionRef.current;
      if (!current?.authenticated || current.expiresAt !== expiresAt) return;

      const suppressForMs = recentRefreshWarningSuppressMs - (Date.now() - lastSessionRefreshAt.current);
      if (suppressForMs > 0) {
        warningTimerRef.current = window.setTimeout(openWarning, suppressForMs);
        return;
      }

      if (warningOpenRef.current) return;
      setErrorMessage("");
      setWarningVisible(true);
      startCountdown(expiresAt);
    };

    warningTimerRef.current = window.setTimeout(openWarning, Math.max(0, msUntilExpiry - warningThresholdSeconds * 1000));
    logoutTimerRef.current = window.setTimeout(() => {
      logoutTimerRef.current = null;
      if (countdownIntervalRef.current !== null) {
        window.clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
      setSession((current) => (current ? { ...current, secondsUntilExpiry: 0 } : current));
      setErrorMessage("Your session expired. Sign in again and Snacky OS will reopen this page.");
      setWarningVisible(true);
      redirectTimerRef.current = window.setTimeout(loginAgain, 1200);
    }, msUntilExpiry);
  }, [clearSessionTimers, loginAgain, setWarningVisible, startCountdown]);

  const applySession = useCallback((nextSession: SessionState | null) => {
    sessionRef.current = nextSession;
    setSession(nextSession);
    scheduleSessionTimers(nextSession);
  }, [scheduleSessionTimers]);

  const loadSession = useCallback(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) return;
    const payload = await response.json().catch(() => null);
    const nextSession = sessionFromPayload(payload);
    if (!nextSession) return;
    applySession(nextSession);
  }, [applySession]);

  const continueSession = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    setRefreshing(true);
    setErrorMessage("");
    try {
      const response = await fetch("/api/auth/session", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        clearSessionTimers();
        setErrorMessage("Could not continue session. Please save your work and log in again.");
        setWarningVisible(true);
        return;
      }
      const refreshedSession = sessionFromPayload(payload);
      if (!refreshedSession?.authenticated || !refreshedSession.expiresAt) {
        clearSessionTimers();
        setErrorMessage("Could not continue session. Please save your work and log in again.");
        setWarningVisible(true);
        return;
      }

      lastSessionRefreshAt.current = Date.now();
      lastActivityRefreshAt.current = Date.now();
      setWarningVisible(false);
      applySession(refreshedSession);
      if (!silent) router.refresh();
    } catch {
      clearSessionTimers();
      setErrorMessage("Could not continue session. Please save your work and log in again.");
      setWarningVisible(true);
    } finally {
      setRefreshing(false);
    }
  }, [applySession, clearSessionTimers, router, setWarningVisible]);

  useEffect(() => {
    const initialLoadTimer = window.setTimeout(() => void loadSession(), 0);
    return () => {
      window.clearTimeout(initialLoadTimer);
      clearSessionTimers();
    };
  }, [clearSessionTimers, loadSession]);

  useEffect(() => {
    const onActivity = () => {
      if (warningOpenRef.current) return;
      const currentSession = sessionRef.current;
      if (!currentSession?.authenticated || !currentSession.expiresAt) return;
      const seconds = secondsUntil(currentSession.expiresAt);
      if (seconds <= 0 || seconds > activityRefreshThresholdSeconds) return;
      const now = Date.now();
      if (now - lastActivityRefreshAt.current < activityRefreshCooldownMs) return;
      lastActivityRefreshAt.current = now;
      void continueSession({ silent: true });
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
        <button type="button" onClick={() => continueSession()} disabled={refreshing} className="btn-primary">
          {refreshing ? "Continuing..." : "Continue Session"}
        </button>
        {errorMessage || (session && session.secondsUntilExpiry <= 30) ? (
          <button type="button" onClick={loginAgain} className="btn-secondary">Sign in again</button>
        ) : null}
      </div>
    </div>
  );
}
