"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, CheckCheck, X } from "lucide-react";
import { CompanyNoticesPanel, useCompanyNotices } from "@/components/CompanyNotices";
import { NotificationActivationCard } from "@/components/NotificationActivationCard";
import { useLanguage } from "@/components/I18nProvider";

type NotificationRow = { id: string; title: string; message: string; action_url: string | null; related_route_id: string | null; read_at: string | null; created_at: string };
type NotificationCenterProps = { compact?: boolean; routeAlerts?: boolean; companyUpdates?: boolean; label?: string; className?: string };

function safeLink(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 33 || character === "\\") ? value : "/account";
}

export function NotificationCenter({ compact = false, label = "Notifications", className = "", routeAlerts = true, companyUpdates = false }: NotificationCenterProps) {
  const { locale } = useLanguage();
  const ar = locale === "ar";
  const company = useCompanyNotices(companyUpdates);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const totalBadgeCount = (routeAlerts ? unreadCount : 0) + (companyUpdates ? company.data?.attention_count ?? 0 : 0);
  const loadNotifications = useCallback(async () => {
    if (!routeAlerts) return;
    setLoading(true);
    try {
      const response = await fetch("/api/notifications?limit=6", { cache: "no-store" });
      if (!response.ok) throw new Error("notifications_unavailable");
      const payload = await response.json();
      if (!Array.isArray(payload.notifications)) throw new Error("invalid_notifications");
      setNotifications(payload.notifications); setUnreadCount(Number(payload.unreadCount ?? 0)); setFailed(false);
    } catch { setFailed(true); }
    finally { setLoading(false); }
  }, [routeAlerts]);
  async function markAllRead() {
    try {
      const response = await fetch("/api/notifications", { method: "PATCH" });
      if (!response.ok) throw new Error("mark_read_failed");
      setUnreadCount(0); setNotifications((rows) => rows.map((row) => ({ ...row, read_at: row.read_at ?? new Date().toISOString() })));
    } catch { setFailed(true); }
  }
  useEffect(() => {
    const initial = window.setTimeout(() => { void loadNotifications(); }, 0);
    const interval = window.setInterval(() => { if (!document.hidden) void loadNotifications(); }, 30000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [loadNotifications]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => { void loadNotifications(); }, 0);
    const outside = (event: MouseEvent | TouchEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside); document.addEventListener("touchstart", outside); document.addEventListener("keydown", escape);
    return () => { window.clearTimeout(timer); document.removeEventListener("mousedown", outside); document.removeEventListener("touchstart", outside); document.removeEventListener("keydown", escape); };
  }, [open, loadNotifications]);
  return <div ref={rootRef} className={`relative inline-flex ${className}`}>
    <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={ar ? "الإشعارات" : label}
      className={`relative inline-flex h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 shadow-sm ${compact ? "w-11 px-0" : ""}`}>
      <Bell className="h-5 w-5" />{!compact ? <span className="hidden sm:inline">{ar ? "الإشعارات" : label}</span> : null}
      {totalBadgeCount > 0 ? <span className="absolute -end-1 -top-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">{totalBadgeCount > 9 ? "9+" : totalBadgeCount}</span> : null}
    </button>
    {open ? <div className="absolute end-0 top-full z-50 mt-2 max-h-[calc(100dvh-6rem)] w-[min(24rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 text-start shadow-2xl">
      <div className="mb-4 flex items-start justify-between gap-3"><h2 className="text-sm font-semibold text-slate-900">{ar ? "الإشعارات" : "Notifications"}</h2><button type="button" onClick={() => setOpen(false)} aria-label={ar ? "إغلاق" : "Close notifications"} className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200"><X className="h-4 w-4" /></button></div>
      {companyUpdates ? <CompanyNoticesPanel data={company.data} failed={company.failed} ar={ar} close={() => setOpen(false)} /> : null}
      <div className="mt-3"><NotificationActivationCard compact /></div>
      {routeAlerts ? <>
        <div className="mt-4 flex items-center justify-between gap-2"><span className="text-xs text-slate-500">{ar ? "تنبيهات الجولات" : "Route alerts"}</span>{unreadCount > 0 ? <button type="button" onClick={() => void markAllRead()} className="inline-flex items-center gap-1 text-xs font-semibold"><CheckCheck className="h-4 w-4" />{ar ? "تحديد الكل كمقروء" : "Mark all read"}</button> : null}</div>
        {failed ? <button type="button" onClick={() => void loadNotifications()} className="mt-3 w-full rounded-lg border border-amber-200 bg-amber-50 p-3 text-start text-sm text-amber-900">{ar ? "تعذر تحميل الإشعارات. اضغط لإعادة المحاولة." : "Could not load notifications. Tap to retry."}</button> : loading ? <p className="py-5 text-center text-sm text-slate-500">{ar ? "جارٍ التحميل…" : "Loading…"}</p> : notifications.length ? <div className="mt-3 space-y-2">{notifications.map((notification) => <Link key={notification.id} href={safeLink(notification.action_url || (notification.related_route_id ? `/operator/routes/${encodeURIComponent(notification.related_route_id)}` : null))} onClick={() => setOpen(false)} className={`block rounded-xl border p-3 ${notification.read_at ? "border-slate-200 bg-slate-50" : "border-slate-300 bg-white"}`}><div className="text-sm font-semibold text-slate-900">{notification.title}</div><p className="mt-1 text-sm leading-6 text-slate-600">{notification.message}</p><time className="mt-2 block text-xs text-slate-500" dateTime={notification.created_at}>{new Date(notification.created_at).toLocaleString(locale)}</time></Link>)}</div> : <p className="py-5 text-center text-sm text-slate-500">{ar ? "لا توجد إشعارات بعد." : "No notifications yet."}</p>}
      </> : null}
    </div> : null}
  </div>;
}
