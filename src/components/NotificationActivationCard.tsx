"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BellRing, Loader2 } from "lucide-react";
import { useLanguage } from "@/components/I18nProvider";
import { getPushRegistration, needsHomeScreenInstall, subscriptionMatchesPublicKey, supportsPush, urlBase64ToUint8Array, withPushTimeout } from "@/lib/push-browser";

type SetupStatus = {
  configured: boolean; schemaReady: boolean; publicKey: string;
  activeSubscriptions: number | null; deviceRegistered: boolean;
};
type BrowserState = "checking" | "unsupported" | "install" | "blocked" | "available" | "enabled" | "error";

async function responseBody(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? "Could not contact the notification service.");
  return body;
}

export function NotificationActivationCard({ compact = false }: { compact?: boolean }) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [browserState, setBrowserState] = useState<BrowserState>("checking");
  const [busy, setBusy] = useState<"enable" | "test" | "disable" | null>(null);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const working = useRef(false);

  const refresh = useCallback(async () => {
    if (working.current) return;
    const current = ++generation.current;
    const live = () => current === generation.current;
    setBrowserState("checking");
    try {
      const payload = await responseBody(await withPushTimeout(fetch("/api/notifications/push-status", { cache: "no-store" })));
      if (!live()) return;
      setStatus(payload);
      if (needsHomeScreenInstall()) { setBrowserState("install"); return; }
      if (!supportsPush()) { setBrowserState("unsupported"); return; }
      if (Notification.permission === "denied") { setBrowserState("blocked"); return; }
      if (Notification.permission !== "granted" || !payload.configured || !payload.schemaReady) { setBrowserState("available"); return; }
      const registration = await withPushTimeout(navigator.serviceWorker.getRegistration("/"));
      const subscription = registration ? await withPushTimeout(registration.pushManager.getSubscription()) : null;
      if (!live()) return;
      if (!subscription || !subscriptionMatchesPublicKey(subscription, payload.publicKey)) { setBrowserState("available"); return; }
      const verified = await responseBody(await withPushTimeout(fetch("/api/notifications/push-status", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      })));
      if (!live()) return;
      setStatus(verified);
      setBrowserState(verified.configured && verified.schemaReady && verified.deviceRegistered ? "enabled" : "available");
    } catch {
      if (live()) { setStatus(null); setBrowserState("error"); }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", visible);
    window.addEventListener("snacky-push-changed", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearTimeout(timer); generation.current += 1;
      window.removeEventListener("focus", visible);
      window.removeEventListener("snacky-push-changed", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  function begin(action: "enable" | "test" | "disable") {
    if (working.current) return false;
    working.current = true; generation.current += 1; setBusy(action); setMessage("");
    return true;
  }
  function finish() {
    working.current = false; setBusy(null);
    window.dispatchEvent(new Event("snacky-push-changed"));
  }

  async function enable() {
    if (!begin("enable")) return;
    try {
      const publicKey = status?.publicKey ?? "";
      if (!supportsPush() || needsHomeScreenInstall() || !status?.configured || !status.schemaReady || !publicKey) throw new Error("Notification setup is not ready.");
      // Keep this request BEFORE any asynchronous setup so iOS retains the tap gesture.
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      if (permission !== "granted") throw new Error(ar ? "لم يتم السماح بالإشعارات. راجع إعدادات الجهاز." : "Notifications were not allowed. Check your device settings.");
      const registration = await getPushRegistration();
      let existing = await withPushTimeout(registration.pushManager.getSubscription());
      if (existing && !subscriptionMatchesPublicKey(existing, publicKey)) {
        if (!await withPushTimeout(existing.unsubscribe())) throw new Error("Could not replace the previous subscription.");
        existing = null;
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const subscription = existing ?? await withPushTimeout(registration.pushManager.subscribe({
          userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
        const response = await withPushTimeout(fetch("/api/push-subscriptions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: subscription.toJSON(), deviceLabel: /Mobile|Android|iPhone|iPad/.test(navigator.userAgent) ? "Phone / tablet" : "Desktop" }),
        }));
        if (response.status === 409 && attempt === 0) {
          if (!await withPushTimeout(subscription.unsubscribe())) throw new Error("Could not replace the previous subscription.");
          existing = null; continue;
        }
        const saved = await responseBody(response);
        if (saved?.saved !== true) throw new Error("The server did not confirm this device.");
        setMessage(ar ? "تم تسجيل هذا الجهاز. جرّب إشعاراً للتأكد من ظهوره." : "This device is registered. Send a test to confirm it appears.");
        break;
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : ar ? "تعذر التفعيل. أعد المحاولة." : "Could not enable notifications. Please retry.");
    } finally { finish(); }
  }

  async function sendTest(delaySeconds: 0 | 15) {
    if (!begin("test")) return;
    try {
      const registration = await withPushTimeout(navigator.serviceWorker.getRegistration("/"));
      const subscription = registration ? await withPushTimeout(registration.pushManager.getSubscription()) : null;
      if (!subscription) throw new Error(ar ? "فعّل الإشعارات أولاً." : "Enable notifications first.");
      const body = await responseBody(await withPushTimeout(fetch("/api/notifications/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint, delaySeconds, locale }),
      }), 20000));
      if (delaySeconds === 15 && body?.scheduled === true) {
        setMessage(ar ? "أغلق سناكي الآن. سيحاول الخادم إرسال الإشعار لهذا الجهاز بعد 15 ثانية." : "Close Snacky OS now. The server will attempt to send this device a notification in 15 seconds.");
      } else if (body?.sent === true && body?.acceptedCount > 0) {
        setMessage(ar ? "قبلت خدمة الإشعارات الطلب. تأكد من ظهور الإشعار؛ قبول الطلب لا يؤكد عرضه." : "The push service accepted the test. Check for the notification; acceptance does not confirm it was displayed.");
      } else throw new Error(ar ? "لم يتم تأكيد إرسال الإشعار." : "The test was not confirmed.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Test failed. Please retry."); }
    finally { finish(); }
  }

  async function disable() {
    if (!begin("disable")) return;
    try {
      const registration = await withPushTimeout(navigator.serviceWorker.getRegistration("/"));
      const subscription = registration ? await withPushTimeout(registration.pushManager.getSubscription()) : null;
      if (subscription) {
        const result = await responseBody(await withPushTimeout(fetch("/api/push-subscriptions", {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }),
        })));
        if (result?.disabled !== true) throw new Error("The server did not confirm disabling this device.");
        // Server deactivation is authoritative, even if browser cleanup fails.
        await withPushTimeout(subscription.unsubscribe()).catch(() => false);
      }
      setMessage(ar ? "تم إيقاف الإشعارات لهذا الجهاز فقط." : "Notifications are disabled for this device only.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not disable this device."); }
    finally { finish(); }
  }

  const serverReady = Boolean(status?.configured && status.schemaReady);
  const enabled = serverReady && browserState === "enabled";
  const stateText: Record<BrowserState, string> = {
    checking: ar ? "جارٍ التحقق…" : "Checking…",
    enabled: ar ? "مسجل ومسموح له بالإشعارات" : "Registered and permission granted",
    available: ar ? "غير مفعلة على هذا الجهاز" : "Not enabled on this device",
    blocked: ar ? "محظورة؛ اسمح بها من إعدادات الإشعارات ثم أعد التحقق." : "Blocked. Allow notifications in device/browser settings, then recheck.",
    install: ar ? "على الآيفون والآيباد: أضف سناكي للشاشة الرئيسية، ثم افتحه من الأيقونة (iOS 16.4 أو أحدث)." : "On iPhone/iPad: Add Snacky OS to the Home Screen, then open its icon (iOS 16.4 or later).",
    unsupported: ar ? "هذا المتصفح لا يدعم الإشعارات هنا. استخدم متصفحاً مدعوماً واتصال HTTPS." : "Push is unavailable in this browser. Use a supported browser over HTTPS.",
    error: ar ? "تعذر التحقق من الجهاز أو الخادم؛ الحالة غير مؤكدة." : "Could not verify this device or server. Status is unknown.",
  };

  return (
    <section className={`${compact ? "rounded-xl border border-slate-200 bg-slate-50 p-3" : "surface-card p-4"} text-start`} aria-label={ar ? "إشعارات الجهاز" : "Device notifications"}>
      <div className="flex items-start gap-3">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-slate-950">{ar ? "إشعارات الجهاز" : "Device notifications"}</h2>
          <p className="mt-1 text-xs leading-5 text-slate-600">{ar ? "تصلك التنبيهات الموصولة بحسابك حتى والتطبيق مغلق. إسناد الجولات مفعّل؛ ليست كل تحديثات النظام إشعارات هاتف بعد." : "Receive connected alerts while the app is closed. Route assignments are connected; not every in-app update sends a phone alert yet."}</p>
        </div>
      </div>
      <p className="mt-3 text-sm font-medium text-slate-800" role="status">{stateText[browserState]}</p>
      {!compact ? <div className="mt-3 grid gap-2 text-sm">
        <div className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"><span>{ar ? "الخادم" : "Server"}</span><strong>{status === null ? "—" : serverReady ? (ar ? "جاهز" : "Ready") : (ar ? "يحتاج إعداد" : "Needs setup")}</strong></div>
        <div className="flex justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"><span>{ar ? "الأجهزة المسجلة لحسابك" : "Registered account devices"}</span><strong>{status?.activeSubscriptions ?? "—"}</strong></div>
      </div> : null}
      {status && !serverReady ? <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{ar ? "إعداد الإشعارات غير مكتمل في الخادم. الإذن في الهاتف وحده لا يكفي." : "Server notification setup is incomplete. Phone permission alone is not enough."}</p> : null}
      {message ? <p className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm leading-6 text-slate-700" role="status">{message}</p> : null}
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {enabled ? <>
          <button type="button" onClick={() => void sendTest(0)} disabled={busy !== null} className="btn-primary disabled:opacity-50">{busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : ar ? "اختبار الآن" : "Test now"}</button>
          <button type="button" onClick={() => void sendTest(15)} disabled={busy !== null} className="btn-secondary disabled:opacity-50">{ar ? "اختبار بعد إغلاق التطبيق" : "Test after closing app"}</button>
          <button type="button" onClick={() => void disable()} disabled={busy !== null} className="btn-secondary disabled:opacity-50">{ar ? "إيقاف لهذا الجهاز" : "Disable this device"}</button>
        </> : <button type="button" onClick={() => void enable()} disabled={busy !== null || !serverReady || !["available", "error"].includes(browserState)} className="btn-primary disabled:opacity-50">{busy === "enable" ? <Loader2 className="h-4 w-4 animate-spin" /> : ar ? "تفعيل الإشعارات" : "Enable notifications"}</button>}
        <button type="button" onClick={() => void refresh()} disabled={busy !== null} className="btn-secondary disabled:opacity-50">{ar ? "إعادة التحقق" : "Recheck"}</button>
      </div>
    </section>
  );
}
