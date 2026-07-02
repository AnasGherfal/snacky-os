"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, CheckCheck, Loader2, X } from "lucide-react";
import { useLanguage } from "@/components/I18nProvider";

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  message: string;
  action_url: string | null;
  related_route_id: string | null;
  read_at: string | null;
  created_at: string;
};

type NotificationsResponse = {
  notifications: NotificationRow[];
  unreadCount: number;
};

type NotificationCenterProps = {
  compact?: boolean;
  label?: string;
  className?: string;
};

function errorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const row = error as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
  return [row.code, row.message, row.details, row.hint]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join(" ");
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const normalized = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
  const rawData = window.atob(normalized);
  const outputArray = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    outputArray[index] = rawData.charCodeAt(index);
  }
  return outputArray;
}

function formatRelativeDateTime(locale: string, iso: string) {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function detectDeviceLabel() {
  if (typeof navigator === "undefined") return null;
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("ipad") || userAgent.includes("tablet")) return "Tablet browser";
  if (userAgent.includes("android") || userAgent.includes("iphone") || userAgent.includes("mobile")) return "Mobile browser";
  return "Desktop browser";
}

export function NotificationCenter({ compact = false, label = "Notifications", className = "" }: NotificationCenterProps) {
  const { locale } = useLanguage();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  const [loadingPush, setLoadingPush] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pushStatus, setPushStatus] = useState<"checking" | "unsupported" | "blocked" | "available" | "enabled">("checking");
  const [message, setMessage] = useState<string | null>(null);
  const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  const supportsPush = typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator && "PushManager" in window && Boolean(vapidPublicKey);
  const buttonLabel = compact ? "Alerts" : label;
  const unreadBadge = unreadCount > 9 ? "9+" : String(unreadCount);

  const closePanel = () => setOpen(false);

  const loadNotifications = async () => {
    setLoadingNotifications(true);
    try {
      const response = await fetch("/api/notifications?limit=6", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as NotificationsResponse;
      setNotifications(Array.isArray(payload.notifications) ? payload.notifications : []);
      setUnreadCount(Number(payload.unreadCount ?? 0));
    } catch (error) {
      console.warn("[notifications] Failed to load in-app notifications", errorText(error));
    } finally {
      setLoadingNotifications(false);
    }
  };

  const refreshPushStatus = async () => {
    if (!supportsPush) {
      setPushStatus("unsupported");
      return;
    }

    if (Notification.permission === "denied") {
      setPushStatus("blocked");
      return;
    }

    if (Notification.permission !== "granted") {
      setPushStatus("available");
      return;
    }

    try {
      const registration = await navigator.serviceWorker.getRegistration() ?? await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.getSubscription();
      setPushStatus(subscription ? "enabled" : "available");
    } catch (error) {
      console.warn("[notifications] Could not inspect push subscription", errorText(error));
      setPushStatus("available");
    }
  };

  const markAllRead = async () => {
    try {
      const response = await fetch("/api/notifications", { method: "PATCH" });
      if (!response.ok) return;
      setUnreadCount(0);
      setNotifications((current) => current.map((notification) => ({ ...notification, read_at: notification.read_at ?? new Date().toISOString() })));
    } catch (error) {
      console.warn("[notifications] Failed to mark notifications read", errorText(error));
    }
  };

  const enablePush = async () => {
    if (!supportsPush) {
      setMessage("Push notifications are not supported in this browser.");
      return;
    }

    if (!vapidPublicKey) {
      setMessage("Push notifications are not configured for this environment.");
      return;
    }

    setLoadingPush(true);
    setMessage(null);
    try {
      if (Notification.permission === "default") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setPushStatus(permission === "denied" ? "blocked" : "available");
          setMessage("Notifications were not allowed.");
          return;
        }
      }

      if (Notification.permission === "denied") {
        setPushStatus("blocked");
        setMessage("Notifications are blocked in this browser. Enable them in browser settings first.");
        return;
      }

      const registration = await navigator.serviceWorker.register("/sw.js");
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });

      const response = await fetch("/api/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          deviceLabel: detectDeviceLabel(),
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error ?? "Could not save the subscription.");
      }

      setPushStatus("enabled");
      setMessage("Push notifications are enabled on this device.");
    } catch (error) {
      console.warn("[notifications] Failed to enable push", errorText(error));
      setMessage(error instanceof Error ? error.message : "Could not enable push notifications.");
      setPushStatus(Notification.permission === "denied" ? "blocked" : "available");
    } finally {
      setLoadingPush(false);
    }
  };

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadNotifications();
      void refreshPushStatus();
    }, 0);
    const interval = window.setInterval(() => {
      if (!document.hidden) {
        void loadNotifications();
        void refreshPushStatus();
      }
    }, 30000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!open) return;
    const refreshTimer = window.setTimeout(() => {
      void loadNotifications();
    }, 0);
    return () => window.clearTimeout(refreshTimer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  const pushStatusLabel = useMemo(() => {
    if (pushStatus === "checking") return "Checking browser support...";
    if (pushStatus === "unsupported") return "Push not supported here.";
    if (pushStatus === "blocked") return "Push notifications are blocked.";
    if (pushStatus === "enabled") return "Push enabled on this device.";
    return "Push available on this device.";
  }, [pushStatus]);

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`relative inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 ${compact ? "w-11 px-0" : ""}`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={buttonLabel}
      >
        <Bell className="h-5 w-5" />
        {!compact ? <span className="hidden sm:inline">{buttonLabel}</span> : null}
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white">
            {unreadBadge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-[min(24rem,calc(100vw-1.5rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">Notifications</div>
              <p className="mt-1 text-xs leading-5 text-slate-500">Route alerts and in-app updates for your account.</p>
            </div>
            <button type="button" onClick={closePanel} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-50" aria-label="Close notifications">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs uppercase tracking-wide text-slate-500">Browser push</div>
                <div className="mt-1 text-sm font-medium text-slate-900">{pushStatusLabel}</div>
              </div>
              <button
                type="button"
                onClick={() => void enablePush()}
                disabled={loadingPush || pushStatus === "enabled"}
                className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadingPush ? <Loader2 className="h-4 w-4 animate-spin" /> : pushStatus === "enabled" ? "Enabled" : "Enable"}
              </button>
            </div>
            {message ? <p className="mt-2 text-xs leading-5 text-slate-600">{message}</p> : null}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              {unreadCount > 0 ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}` : "No unread notifications"}
            </div>
            {unreadCount > 0 ? (
              <button type="button" onClick={() => void markAllRead()} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-100">
                <CheckCheck className="h-3.5 w-3.5" />
                Mark all read
              </button>
            ) : null}
          </div>

          <div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
            {loadingNotifications ? (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">Loading notifications...</div>
            ) : notifications.length ? (
              notifications.map((notification) => {
                const href = notification.action_url || (notification.related_route_id ? `/operator/routes/${notification.related_route_id}` : "#");
                const unread = !notification.read_at;
                const body = (
                  <div className={`rounded-xl border p-3 text-left transition ${unread ? "border-slate-300 bg-white" : "border-slate-200 bg-slate-50"}`}>
                    <div className="flex items-start gap-3">
                      <div className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${unread ? "bg-emerald-500" : "bg-slate-300"}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-slate-900">{notification.title}</div>
                        <p className="mt-1 text-sm leading-6 text-slate-600">{notification.message}</p>
                        <div className="mt-2 text-xs text-slate-500">{formatRelativeDateTime(locale, notification.created_at)}</div>
                      </div>
                    </div>
                  </div>
                );

                if (href === "#") return <div key={notification.id}>{body}</div>;

                return (
                  <Link key={notification.id} href={href} onClick={() => { closePanel(); void markAllRead(); }} className="block rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--snacky-primary)] focus:ring-offset-2">
                    {body}
                  </Link>
                );
              })
            ) : (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
                No notifications yet.
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
