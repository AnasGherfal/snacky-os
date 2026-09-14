"use client";

import Image from "next/image";
import Link, { useLinkStatus } from "next/link";
import { useEffect, useRef, useState } from "react";
import { Banknote, BarChart3, Boxes, ClipboardList, HandCoins, LayoutDashboard, MessagesSquare, ShieldCheck, UserCircle, Warehouse, X, type LucideIcon } from "lucide-react";
import { useLanguage } from "@/components/I18nProvider";
import { useAppNavigation } from "@/components/NavigationProvider";
import type { NavigationModuleId } from "@/components/module-tabs-config";

const icons: Record<NavigationModuleId, LucideIcon> = {
  dashboard: LayoutDashboard, operations: ClipboardList, crm: MessagesSquare,
  machines: Boxes, inventory: Warehouse, cash: HandCoins, finance: Banknote,
  reports: BarChart3, admin: ShieldCheck, investor: HandCoins, account: UserCircle,
};

function NavPendingIndicator() {
  const { pending } = useLinkStatus();
  return <span aria-hidden="true" className={`ms-auto h-1.5 w-1.5 shrink-0 rounded-full bg-current ${pending ? "animate-pulse opacity-80" : "opacity-0"}`} />;
}

function SidebarContent({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const { modules, location, homeHref } = useAppNavigation();
  const { dictionary, locale } = useLanguage();
  return (
    <>
      <Link href={homeHref} prefetch={false} onClick={onNavigate} className={`mb-5 flex shrink-0 items-center gap-3 rounded-lg ${compact ? "justify-center" : "px-2"}`} aria-label="Snacky OS">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-slate-200 bg-white">
          <Image src="/brand/snacky-logo.png" alt="" fill sizes="40px" className="object-contain" />
        </div>
        {!compact ? <div className="min-w-0"><div className="truncate text-base font-bold text-slate-950">{dictionary.app.name}</div><div className="truncate text-xs text-slate-500">{locale === "ar" ? "إدارة التشغيل والأعمال" : "Operations & business"}</div></div> : null}
      </Link>
      <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain" aria-label={dictionary.shell.navigation}>
        {[false, true].map((utility) => {
          const items = modules.filter((module) => Boolean(module.utility) === utility);
          if (!items.length) return null;
          return (
            <div key={String(utility)} className={utility ? "border-t border-slate-200 pt-4" : ""}>
              {!compact ? <div className="mb-2 px-3 text-[11px] font-semibold text-slate-400">{utility ? locale === "ar" ? "شخصي" : "Personal" : locale === "ar" ? "مساحات العمل" : "Workspaces"}</div> : null}
              <div className="space-y-1">
                {items.map((module) => {
                  const Icon = icons[module.id];
                  const label = locale === "ar" ? module.nameAr : module.name;
                  const active = location?.module.id === module.id;
                  return (
                    <Link key={module.id} href={module.href || module.sections[0].tabs[0].href} prefetch={false}
                      onClick={(event) => {
                        if (!event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) onNavigate?.();
                      }}
                      title={compact ? label : undefined} aria-current={active ? "page" : undefined} data-navigation-module={module.id}
                      className={`${active ? "nav-link-active" : "nav-link"} flex min-h-11 items-center gap-3 ${compact ? "justify-center !px-2" : ""}`}>
                      <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                      <span className={compact ? "sr-only" : "min-w-0 flex-1 text-sm font-medium"}>{label}</span>
                      {!compact ? <NavPendingIndicator /> : null}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
    </>
  );
}

export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose: () => void }) {
  const { dictionary, locale } = useLanguage();
  const { pathname, search } = useAppNavigation();
  const [collapsed, setCollapsed] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const lastLocation = useRef(`${pathname}?${search}`);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem("snacky-sidebar-collapsed") === "true"); } catch { /* Storage is optional. */ }
  }, []);

  useEffect(() => {
    const current = `${pathname}?${search}`;
    if (lastLocation.current !== current) { lastLocation.current = current; onMobileClose(); }
  }, [pathname, search, onMobileClose]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onMobileClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? []).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!first || !last) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const resize = () => { if (window.matchMedia("(min-width: 1024px)").matches) onMobileClose(); };
    document.addEventListener("keydown", keydown);
    window.addEventListener("resize", resize);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      window.removeEventListener("resize", resize);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) requestAnimationFrame(() => previousFocus.focus());
    };
  }, [mobileOpen, onMobileClose]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem("snacky-sidebar-collapsed", String(next)); } catch { /* Navigation still works without storage. */ }
  }

  return (
    <>
      <aside className={`app-sidebar hidden h-dvh shrink-0 flex-col overflow-hidden border-e border-slate-200 bg-white lg:flex ${collapsed ? "w-20" : "w-64"}`}>
        <div className={`flex min-h-0 flex-1 flex-col py-5 ${collapsed ? "px-2" : "px-3"}`}><SidebarContent compact={collapsed} /></div>
        <button type="button" onClick={toggleCollapsed} className="m-3 flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50"
          aria-label={collapsed ? locale === "ar" ? "توسيع القائمة" : "Expand sidebar" : locale === "ar" ? "طي القائمة" : "Collapse sidebar"}>
          <span aria-hidden="true">{collapsed ? locale === "ar" ? "‹" : "›" : locale === "ar" ? "›" : "‹"}</span>
          {!collapsed ? <span>{locale === "ar" ? "طي القائمة" : "Collapse sidebar"}</span> : null}
        </button>
      </aside>
      {mobileOpen ? (
        <div id="snacky-mobile-navigation" ref={dialogRef} className="fixed inset-0 z-[80] lg:hidden" role="dialog" aria-modal="true" aria-label={dictionary.shell.navigation}>
          <button type="button" tabIndex={-1} className="absolute inset-0 bg-slate-950/40" onClick={onMobileClose} aria-label={dictionary.shell.closeNavigationOverlay} />
          <aside className="app-sidebar absolute inset-y-0 start-0 flex w-[min(20rem,90vw)] min-w-0 flex-col overflow-hidden border-e border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-4 flex shrink-0 items-center justify-between gap-3">
              <div className="text-xs font-semibold text-slate-500">{dictionary.shell.navigation}</div>
              <button ref={closeRef} type="button" onClick={onMobileClose} className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 text-slate-700" aria-label={dictionary.shell.closeNavigation}><X className="h-5 w-5" aria-hidden="true" /></button>
            </div>
            <SidebarContent onNavigate={onMobileClose} />
          </aside>
        </div>
      ) : null}
    </>
  );
}
