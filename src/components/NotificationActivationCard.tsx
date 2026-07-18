"use client";

import { useEffect, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { useLanguage } from "@/components/I18nProvider";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const normalized = (base64String + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = window.atob(normalized);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

type SetupStatus = {
  configured: boolean;
  schemaReady: boolean;
  activeSubscriptions: number;
  publicKey?: string | null;
  source?: "environment" | "database" | null;
  reason?: string | null;
};

export function NotificationActivationCard() {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [browserState, setBrowserState] = useState<"checking" | "unsupported" | "blocked" | "available" | "enabled">("checking");
  const [busy, setBusy] = useState<"enable" | "test" | null>(null);
  const [message, setMessage] = useState("");

  async function refresh() {
    const response = await fetch("/api/notifications/push-status", { cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (response.ok) setStatus(payload as SetupStatus);

    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setBrowserState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setBrowserState("blocked");
      return;
    }
    if (Notification.permission !== "granted") {
      setBrowserState("available");
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration() ?? await navigator.serviceWorker.register("/sw.js");
    const subscription = await registration.pushManager.getSubscription();
    setBrowserState(subscription ? "enabled" : "available");
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function enable() {
    setBusy("enable");
    setMessage("");
    try {
      const publicKey = String(status?.publicKey ?? "").trim();
      if (!status?.configured || !publicKey) throw new Error(ar ? "إعدادات الإشعارات غير مكتملة في الخادم." : "Server notification configuration is incomplete.");
      if (!status.schemaReady) throw new Error(ar ? "جداول الإشعارات غير مثبتة في قاعدة البيانات." : "Notification tables are not installed in the database.");
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error(ar ? "لم يتم السماح بالإشعارات من المتصفح." : "Browser notification permission was not granted.");
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const response = await fetch("/api/push-subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), deviceLabel: navigator.userAgent }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? "Could not save notification subscription.");
      setBrowserState("enabled");
      setMessage(ar ? "تم تفعيل الإشعارات على هذا الجهاز." : "Notifications are enabled on this device.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ar ? "تعذر تفعيل الإشعارات." : "Could not enable notifications.");
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    setBusy("test");
    setMessage("");
    try {
      const response = await fetch("/api/notifications/test-push", { method: "POST" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error ?? "Test notification failed.");
      setMessage(ar ? "تم إرسال إشعار تجريبي. يجب أن يظهر الآن على هذا الجهاز." : "Test notification sent. It should appear on this device now.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ar ? "فشل الإشعار التجريبي." : "Test notification failed.");
    } finally {
      setBusy(null);
    }
  }

  const serverReady = Boolean(status?.configured && status?.schemaReady && status?.publicKey);
  const stateText = browserState === "enabled"
    ? (ar ? "مفعلة على هذا الجهاز" : "Enabled on this device")
    : browserState === "blocked"
      ? (ar ? "محظورة من إعدادات المتصفح" : "Blocked in browser settings")
      : browserState === "unsupported"
        ? (ar ? "هذا المتصفح لا يدعم الإشعارات" : "This browser does not support push")
        : (ar ? "غير مفعلة على هذا الجهاز" : "Not enabled on this device");

  return (
    <section className="surface-card p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-xl bg-sky-100 p-3 text-sky-700"><BellRing className="h-5 w-5" /></div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-slate-950">{ar ? "إشعارات الجهاز" : "Device notifications"}</h2>
          <p className="mt-1 text-sm text-slate-500">{ar ? "استلم تنبيهاً فور إسناد جولة جديدة لك." : "Receive an alert when a new route is assigned to you."}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-2 text-sm">
        <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2"><span>{ar ? "الخادم" : "Server"}</span><strong>{status === null ? "…" : serverReady ? (ar ? "جاهز" : "Ready") : (ar ? "يحتاج إعداد" : "Needs setup")}</strong></div>
        <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2"><span>{ar ? "هذا الجهاز" : "This device"}</span><strong>{stateText}</strong></div>
        <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2"><span>{ar ? "الأجهزة المسجلة" : "Active subscriptions"}</span><strong>{status?.activeSubscriptions ?? 0}</strong></div>
      </div>

      {!serverReady && status ? (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {status.reason === "migration_required"
            ? (ar ? "يلزم تطبيق تحديث إعداد الإشعارات في قاعدة البيانات مرة واحدة." : "Apply the push notification configuration migration once.")
            : (ar ? "يلزم إكمال إعداد الإشعارات قبل التفعيل." : "Notification setup must be completed before activation.")}
        </div>
      ) : null}
      {message ? <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{message}</div> : null}

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <button type="button" onClick={() => void enable()} disabled={busy !== null || !serverReady || browserState === "enabled" || browserState === "blocked" || browserState === "unsupported"} className="btn-primary disabled:cursor-not-allowed disabled:opacity-50">
          {busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : browserState === "enabled" ? (ar ? "مفعلة" : "Enabled") : (ar ? "تفعيل الإشعارات" : "Enable notifications")}
        </button>
        <button type="button" onClick={() => void sendTest()} disabled={busy !== null || browserState !== "enabled" || !serverReady} className="btn-secondary disabled:cursor-not-allowed disabled:opacity-50">
          {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : (ar ? "إرسال إشعار تجريبي" : "Send test notification")}
        </button>
      </div>
    </section>
  );
}
