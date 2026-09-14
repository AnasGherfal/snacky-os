"use client";

import Link from "next/link";
import { Menu, UserCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/components/I18nProvider";
import { NotificationCenter } from "@/components/NotificationCenter";
import { useAppNavigation } from "@/components/NavigationProvider";
import { type AppRole, canExecuteRoutes } from "@/lib/authz";

type TopbarProfile = { id: string; full_name: string; role: AppRole; roles?: AppRole[] | null };

export function Topbar({ profile, onMenuClick, mobileNavOpen = false }: { profile: TopbarProfile; onMenuClick?: () => void; mobileNavOpen?: boolean }) {
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);
  const accountRef = useRef<HTMLDetailsElement>(null);
  const { locale, dictionary, setLocale } = useLanguage();
  const { location, pathname, search, homeHref } = useAppNavigation();
  const workspace = location ? locale === "ar" ? location.module.nameAr : location.module.name : dictionary.app.name;
  const currentPage = location ? locale === "ar" ? location.tab.labelAr || location.tab.label : location.tab.label : "";
  const sectionName = location ? locale === "ar" ? location.section.labelAr : location.section.label : "";
  const context = Array.from(new Set([sectionName, currentPage])).filter((label) => label && label !== workspace).join(" / ");
  const canSeeNotifications = canExecuteRoutes(profile);

  useEffect(() => { if (accountRef.current) accountRef.current.open = false; }, [pathname, search]);
  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (accountRef.current?.open && !accountRef.current.contains(event.target as Node)) accountRef.current.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && accountRef.current?.open) {
        accountRef.current.open = false;
        accountRef.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("click", closeOutside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("click", closeOutside); document.removeEventListener("keydown", escape); };
  }, []);

  const logout = async () => {
    setLoggingOut(true);
    try { await fetch("/api/auth/logout", { method: "POST" }); }
    finally { router.replace("/login"); router.refresh(); }
  };

  return (
    <header className="relative z-30 shrink-0 border-b border-slate-200 bg-white px-3 py-3 sm:px-5 lg:px-6">
      <div className="flex min-w-0 items-center justify-between gap-2 sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" onClick={onMenuClick} aria-expanded={mobileNavOpen}
            aria-controls={mobileNavOpen ? "snacky-mobile-navigation" : undefined}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 lg:hidden" aria-label={dictionary.shell.openNavigation}>
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="min-w-0" data-navigation-context={location?.module.id}>
            <Link href={location?.module.href || homeHref} prefetch={false} className="block truncate text-sm font-semibold text-slate-950" title={workspace}>{workspace}</Link>
            <div className="truncate text-xs text-slate-500" title={context || dictionary.app.subtitle}>{context || dictionary.app.subtitle}</div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          {canSeeNotifications ? <NotificationCenter compact /> : null}
          <button type="button" onClick={() => setLocale(locale === "ar" ? "en" : "ar")}
            className="inline-flex h-11 min-w-11 items-center justify-center rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700"
            aria-label={`${dictionary.shell.switchLanguage}: ${locale === "ar" ? dictionary.language.english : dictionary.language.arabic}`}>
            {locale === "ar" ? "EN" : "عربي"}
          </button>
          <details ref={accountRef} className="relative">
            <summary className="flex h-11 min-w-11 cursor-pointer list-none items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-2 text-slate-700 [&::-webkit-details-marker]:hidden" aria-label={dictionary.shell.account}>
              <UserCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="hidden max-w-36 truncate text-sm font-medium xl:block">{profile.full_name}</span>
            </summary>
            <div className="absolute end-0 top-full z-50 mt-2 w-64 max-w-[85vw] rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
              <div className="mb-2 break-words border-b border-slate-100 px-2 pb-3 text-sm font-semibold text-slate-950">{profile.full_name}</div>
              <Link href="/account" prefetch={false} className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-50">{dictionary.shell.account}</Link>
              <button type="button" onClick={logout} disabled={loggingOut} className="flex min-h-11 w-full items-center rounded-lg px-3 text-start text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60">
                {loggingOut ? dictionary.shell.signingOut : dictionary.shell.logout}
              </button>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}
